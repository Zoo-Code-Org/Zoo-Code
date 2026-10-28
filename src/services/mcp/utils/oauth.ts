import {
	discoverOAuthProtectedResourceMetadata,
	extractResourceMetadataUrl,
} from "@modelcontextprotocol/sdk/client/auth.js"
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
		// The SDK does not accept an AbortSignal, so we race it against a timeout.
		const resourceMeta = await Promise.race([
			discoverProtectedResourceMetadata(serverUrl),
			new Promise<never>((_, reject) =>
				setTimeout(() => reject(new Error("OAuth discovery timeout")), DISCOVERY_TIMEOUT_MS),
			),
		])
		const authServers = resourceMeta.authorization_servers
		if (!authServers?.length) return null

		// RFC 8707: the `resource` field from the protected resource metadata is
		// used as the `resource` parameter in the authorization request so the auth
		// server can issue tokens scoped to this specific resource server.
		const resourceIndicator: string | null =
			typeof resourceMeta.resource === "string" ? resourceMeta.resource : null

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
		return await discoverOAuthProtectedResourceMetadata(serverUrl)
	} catch (wellKnownError) {
		const resourceMetadataUrl = await probeResourceMetadataUrl(serverUrl)
		if (!resourceMetadataUrl) throw wellKnownError
		return discoverOAuthProtectedResourceMetadata(serverUrl, { resourceMetadataUrl })
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
		signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
	})
	await response.body?.cancel().catch(() => {})
	return response.status === 401 ? extractResourceMetadataUrl(response) : undefined
}
