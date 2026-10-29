import { discoverOAuthProtectedResourceMetadata } from "@modelcontextprotocol/sdk/client/auth.js"
import { checkResourceAllowed } from "@modelcontextprotocol/sdk/shared/auth-utils.js"
import type { OAuthProtectedResourceMetadata } from "@modelcontextprotocol/sdk/shared/auth.js"

/**
 * Result of a successful OAuth discovery for an MCP server.
 */
export interface OAuthDiscoveryResult {
	/** The raw OAuth Authorization Server metadata (RFC 8414). */
	authServerMeta: Record<string, any>
	/**
	 * The RFC 8707 resource indicator — the `resource` field from the Protected
	 * Resource Metadata (RFC 9728).  `null` when the server didn't advertise one.
	 *
	 * Must be sent as the `resource` query parameter in authorization requests so
	 * the auth server can scope the issued tokens to this specific resource server.
	 */
	resourceIndicator: string | null
}

/**
 * Fetches the raw OAuth Authorization Server metadata for an MCP server URL.
 *
 * This replaces the SDK's built-in `discoverOAuthMetadata()` because it
 * constructs the RFC 8414 well-known URL incorrectly for auth servers with
 * path components — a known bug tracked in multiple upstream issues:
 *
 *  - https://github.com/modelcontextprotocol/typescript-sdk/issues/545
 *    (URL constructor discards base path with leading-slash well-known)
 *  - https://github.com/modelcontextprotocol/typescript-sdk/issues/762
 *    (uses MCP server URL instead of authorization server URL)
 *  - https://github.com/modelcontextprotocol/typescript-sdk/issues/744
 *    (doesn't respect provided authorization server URL)
 *  - https://github.com/modelcontextprotocol/typescript-sdk/issues/822
 *    (general RFC 8414 compliance — affects Keycloak, Okta, Azure Entra)
 *
 * Performs two discovery steps:
 *  1. RFC 9728 – fetches the Protected Resource Metadata to find the issuer URL
 *     and the RFC 8707 resource indicator.  When the well-known URLs fail, falls
 *     back to the `resource_metadata` URL from the server's 401 `WWW-Authenticate`
 *     header (RFC 9728 §5.1), for servers that host the metadata elsewhere.
 *  2. RFC 8414 §3.1 – constructs the well-known discovery URL by inserting
 *     `/.well-known/oauth-authorization-server` *between* the host and the issuer
 *     path (not appended after the path).
 *
 *     Correct:   https://example.com/.well-known/oauth-authorization-server/auth/public
 *     SDK wrong: https://example.com/auth/public/.well-known/oauth-authorization-server
 *
 * Returns an {@link OAuthDiscoveryResult} on success, or `null` if any step fails.
 */
const DISCOVERY_TIMEOUT_MS = 5_000

export async function fetchOAuthAuthServerMetadata(serverUrl: string): Promise<OAuthDiscoveryResult | null> {
	try {
		// Step 1 – RFC 9728: resolve the authorization server issuer URL and
		// capture the resource indicator for RFC 8707.
		const resourceMeta = await discoverProtectedResourceMetadata(serverUrl)
		const authServers = resourceMeta.authorization_servers
		if (!authServers?.length) return null

		// RFC 8707: the `resource` field from the protected resource metadata is
		// used as the `resource` parameter in the authorization request so the auth
		// server can issue tokens scoped to this specific resource server.
		const resourceIndicator: string | null =
			typeof resourceMeta.resource === "string" && resourceMatches(serverUrl, resourceMeta.resource)
				? resourceMeta.resource
				: null

		// Step 2 – RFC 8414 §3.1: build the well-known URL.
		// For issuer "https://example.com/auth/public"
		//   → "https://example.com/.well-known/oauth-authorization-server/auth/public"
		const parsed = new URL(authServers[0])
		const base = `${parsed.protocol}//${parsed.host}`
		const issuePath = parsed.pathname.replace(/\/$/, "") || ""
		const discoveryUrl = `${base}/.well-known/oauth-authorization-server${issuePath}`

		const response = await fetch(discoveryUrl, {
			headers: { Accept: "application/json" },
			signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
		})
		if (!response.ok) return null
		const authServerMeta = (await response.json()) as Record<string, any>
		return { authServerMeta, resourceIndicator }
	} catch {
		return null
	}
}

async function discoverProtectedResourceMetadata(serverUrl: string): Promise<OAuthProtectedResourceMetadata> {
	try {
		return await withDiscoveryTimeout((fetchFn) =>
			discoverOAuthProtectedResourceMetadata(serverUrl, undefined, fetchFn),
		)
	} catch (wellKnownError) {
		// A lookup that timed out may still be running, so do not start another.
		if (wellKnownError instanceof DiscoveryTimeoutError) throw wellKnownError
		const resourceMetadataUrl = await probeResourceMetadataUrl(serverUrl)
		// Fetch only metadata on the server's own origin, so a 401 header cannot
		// direct the client to another host, such as a loopback or private address.
		if (resourceMetadataUrl?.origin !== new URL(serverUrl).origin) throw wellKnownError
		// A redirect could still lead off-origin, so the metadata fetch does not follow one.
		return withDiscoveryTimeout(
			(fetchFn) => discoverOAuthProtectedResourceMetadata(serverUrl, { resourceMetadataUrl }, fetchFn),
			{ redirect: "manual" },
		)
	}
}

/**
 * RFC 9728 §3.3: the metadata must describe the resource it was fetched for.
 * Like the SDK, accepts the server URL or a same-origin ancestor of it. A
 * trailing slash on the published resource is ignored, so `https://x/mcp/`
 * matches `https://x/mcp`. A mismatched resource is not sent as the RFC 8707
 * resource indicator, but the server still uses OAuth.
 */
function resourceMatches(serverUrl: string, resource: string): boolean {
	try {
		const configuredResource = new URL(resource)
		configuredResource.pathname = configuredResource.pathname.replace(/\/+$/, "")
		if (checkResourceAllowed({ requestedResource: serverUrl, configuredResource })) return true
	} catch {
		// An invalid resource URL is treated as a mismatch.
	}
	console.warn(`[MCP OAuth] Ignoring resource indicator ${resource}: it does not match ${serverUrl}`)
	return false
}

class DiscoveryTimeoutError extends Error {
	constructor() {
		super("OAuth discovery timeout")
	}
}

/**
 * Gives each lookup its own timeout, so a slow well-known lookup cannot consume
 * the fallback's budget. The timeout aborts the lookup's requests through the
 * SDK fetch hook.
 */
async function withDiscoveryTimeout<T>(
	lookup: (fetchFn: typeof fetch) => Promise<T>,
	requestInit?: RequestInit,
): Promise<T> {
	const controller = new AbortController()
	let timer: ReturnType<typeof setTimeout> | undefined
	try {
		return await Promise.race([
			lookup((input, init) => fetch(input, { ...init, ...requestInit, signal: controller.signal })),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => {
					controller.abort()
					reject(new DiscoveryTimeoutError())
				}, DISCOVERY_TIMEOUT_MS)
			}),
		])
	} finally {
		clearTimeout(timer)
	}
}

/**
 * Sends an unauthenticated MCP `initialize` request and returns the
 * `resource_metadata` URL from the 401 `WWW-Authenticate` header, if any.
 */
async function probeResourceMetadataUrl(serverUrl: string): Promise<URL | undefined> {
	const response = await fetch(serverUrl, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 0,
			method: "initialize",
			params: {
				protocolVersion: "2025-06-18",
				capabilities: {},
				clientInfo: { name: "oauth-discovery", version: "1.0.0" },
			},
		}),
		// The 401 must come from the configured server itself, not a redirect target.
		redirect: "manual",
		signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
	})
	await response.body?.cancel().catch(() => {})
	return response.status === 401 ? extractResourceMetadataUrl(response.headers.get("WWW-Authenticate")) : undefined
}

/** An auth-param, optionally preceded by the auth-scheme that starts its challenge. */
const AUTH_PARAM = /^\s*(?:([^\s="]+)\s+)?([^\s="]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s"]*))\s*$/

/**
 * Reads the `resource_metadata` parameter of a Bearer challenge. Unlike the SDK
 * helper, matches names case-insensitively (RFC 9110 §11.2), finds the Bearer
 * challenge after other challenges, and ignores parameters of other challenges.
 */
function extractResourceMetadataUrl(header: string | null): URL | undefined {
	if (!header) return undefined
	let scheme: string | undefined
	for (const item of splitAuthItems(header)) {
		const param = AUTH_PARAM.exec(item)
		const itemScheme = param ? param[1] : item.trim().split(/\s+/)[0]
		if (itemScheme) scheme = itemScheme.toLowerCase()
		if (scheme === "bearer" && param?.[2].toLowerCase() === "resource_metadata") {
			const value = param[3]?.replace(/\\(.)/g, "$1") ?? param[4]
			if (URL.canParse(value)) return new URL(value)
		}
	}
	return undefined
}

/**
 * Splits a WWW-Authenticate value on commas outside quoted strings. The commas
 * separate challenges and their auth-params. A loop keeps this linear in the
 * header length and handles escapes inside quoted strings (RFC 9110 §5.6.4).
 */
function splitAuthItems(header: string): string[] {
	const items: string[] = []
	let start = 0
	let quoted = false
	for (let i = 0; i < header.length; i++) {
		const char = header[i]
		if (quoted && char === "\\") i++
		else if (char === '"') quoted = !quoted
		else if (char === "," && !quoted) {
			items.push(header.slice(start, i))
			start = i + 1
		}
	}
	items.push(header.slice(start))
	return items
}
