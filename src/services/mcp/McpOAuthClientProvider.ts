import * as http from "http"

import * as vscode from "vscode"
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js"
import type {
	OAuthClientInformation,
	OAuthClientInformationFull,
	OAuthClientMetadata,
	OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js"

import { TOKEN_EXPIRY_BUFFER_MS } from "./constants"
import {
	AUTHORIZATION_CODE_GRANT_TYPE,
	buildMcpOAuthClientMetadata,
	REFRESH_TOKEN_GRANT_TYPE,
	selectMcpOAuthGrantTypes,
	type McpOAuthGrantType,
} from "./oauthMetadata"
import { SecretStorageService } from "./SecretStorageService"
import { startCallbackServer, stopCallbackServer } from "./utils/callbackServer"
import { fetchOAuthAuthServerMetadata } from "./utils/oauth"

export type McpOAuthResource = "auto" | false | string

export interface McpOAuthClientOptions {
	clientId: string
	scope?: string
	redirectUri?: string
	resource?: McpOAuthResource
}

interface McpOAuthProviderOptions extends Partial<McpOAuthClientOptions> {
	skipDiscovery?: boolean
}

/**
 * Implements the MCP SDK's OAuthClientProvider interface for VS Code.
 *
 * Responsibilities:
 *  - Stores/loads OAuth tokens via VS Code SecretStorage
 *  - Runs a local HTTP callback server to receive the authorization code
 *  - Opens the browser for the authorization redirect
 *  - Provides PKCE code verifier round-trip storage
 *
 * Usage pattern in McpHub:
 *  1. `const authProvider = await McpOAuthClientProvider.create(url, secretStorage)`
 *  2. Pass `authProvider` to `StreamableHTTPClientTransport({ authProvider })`
 *  3. `await client.connect(transport)` — may throw `UnauthorizedError`
 *  4. On `UnauthorizedError`: `code = await authProvider.waitForAuthCode()`
 *  5. `await transport.finishAuth(code)` then retry `client.connect(transport)`
 *  6. `await authProvider.close()` when done (success or permanent failure)
 */
export class McpOAuthClientProvider implements OAuthClientProvider {
	// ── Static negative cache ────────────────────────────────────────────────
	// Remembers servers that returned no OAuth metadata so we can skip the
	// discovery probe on subsequent connection attempts (reconnect, restart).
	private static _nonOAuthCache = new Map<string, number>() // serverUrl → timestamp
	private static NON_OAUTH_TTL_MS = 30 * 60 * 1000 // 30 minutes

	static isKnownNonOAuth(serverUrl: string): boolean {
		const ts = McpOAuthClientProvider._nonOAuthCache.get(serverUrl)
		if (ts === undefined) return false
		if (Date.now() - ts > McpOAuthClientProvider.NON_OAUTH_TTL_MS) {
			McpOAuthClientProvider._nonOAuthCache.delete(serverUrl)
			return false
		}
		return true
	}

	static markNonOAuth(serverUrl: string): void {
		McpOAuthClientProvider._nonOAuthCache.set(serverUrl, Date.now())
	}

	static clearNonOAuthCache(serverUrl?: string): void {
		if (serverUrl) {
			McpOAuthClientProvider._nonOAuthCache.delete(serverUrl)
		} else {
			McpOAuthClientProvider._nonOAuthCache.clear()
		}
	}

	// ── Instance fields ──────────────────────────────────────────────────────
	private _codeVerifier?: string
	// Client info is kept in-memory only (not persisted) to avoid stale registrations
	// when the redirect URI port changes between sessions.
	private _clientInfo?: OAuthClientInformationFull
	private _closed = false
	private _refreshPromise: Promise<OAuthTokens> | null = null
	/** Stored by redirectToAuthorization(); opened on-demand via openBrowser(). */
	private _pendingAuthorizationUrl: URL | null = null
	/** Resource used by the authorization request and subsequent token requests. */
	private _effectiveResourceIndicator: string | null
	/** Deduplicates concurrent _ensureCallbackServer() calls. */
	private _ensureServerPromise: Promise<void> | null = null

	private constructor(
		private readonly _serverUrl: string,
		private readonly _secretStorage: SecretStorageService,
		private _server: http.Server | null,
		private _port: number,
		private _authCodePromise: Promise<string> | null,
		private _cancelCallbackServer: (() => void) | null,
		private readonly _tokenEndpointAuthMethod: string,
		private readonly _grantTypes: McpOAuthGrantType[],
		private readonly _scopes: string[],
		private readonly _scopeConfigured: boolean,
		private readonly _state: string,
		private readonly _authServerMeta: Record<string, any> | null,
		private readonly _resourceIndicator: string | null,
		private readonly _resourceDisabled: boolean,
		private readonly _clientName: string,
		private readonly _configuredRedirectUri?: string,
		private readonly _configuredClientId?: string,
	) {
		this._effectiveResourceIndicator = _resourceIndicator
	}

	/**
	 * Factory — discovers OAuth Authorization Server metadata once (RFC 9728 +
	 * RFC 8414), starts the local callback server, and returns a ready provider.
	 *
	 * Discovery and callback-server startup both happen here so that:
	 *  - `redirectUrl` (used by the SDK to build the authorization URL) is
	 *    stable before any connect attempt.
	 *  - The same metadata object is reused for client registration without a
	 *    second network round-trip.
	 */
	static async create(
		serverUrl: string,
		secretStorage: SecretStorageService,
		serverName?: string,
		options?: McpOAuthProviderOptions,
	): Promise<McpOAuthClientProvider> {
		let authServerMeta: Record<string, any> | null = null
		let resourceIndicator: string | null = null

		if (!options?.skipDiscovery) {
			// Fetch auth server metadata once.  Reused for:
			//  - selecting token_endpoint_auth_method / grant_types / scopes
			//  - pre-registering the client (registration_endpoint)
			//  - RFC 8707 resource indicator (injected into authorization URL)
			const discovery = await fetchOAuthAuthServerMetadata(serverUrl)
			authServerMeta = discovery?.authServerMeta ?? null
			resourceIndicator = resolveResourceIndicator(options?.resource, discovery?.resourceIndicator)

			// Cache the result so subsequent connections can skip the probe.
			if (!authServerMeta) {
				McpOAuthClientProvider.markNonOAuth(serverUrl)
			}
		}

		// Extract auth-method preferences.
		// Only pick methods we actually implement: "none" or "client_secret_post".
		const authMethods: string[] = authServerMeta?.token_endpoint_auth_methods_supported ?? []
		const tokenEndpointAuthMethod = authMethods.includes("none") ? "none" : "client_secret_post"
		const grantTypes = selectMcpOAuthGrantTypes(authServerMeta?.grant_types_supported)
		const configuredScope = options?.scope
		const scopeConfigured = configuredScope !== undefined
		const scopes = scopeConfigured
			? configuredScope.split(/\s+/).filter((scope) => scope.length > 0)
			: (authServerMeta?.scopes_supported ?? [])

		const storedData = await secretStorage.getOAuthData(serverUrl, options?.clientId)
		const issuerMatches = typeof storedData?.issuer === "string" && storedData.issuer === authServerMeta?.issuer
		const storedResourceIndicator =
			!resourceIndicator && options?.resource !== false && issuerMatches
				? storedData?.resource_indicator
				: undefined

		// Generate a CSRF state token for the OAuth flow.
		const state = Array.from(crypto.getRandomValues(new Uint8Array(16)))
			.map((b) => b.toString(16).padStart(2, "0"))
			.join("")

		// We start the callback server lazily in `redirectToAuthorization()` or `waitForAuthCode()`.
		// We use a default port (0) initially; it will be updated when the server starts.

		const provider = new McpOAuthClientProvider(
			serverUrl,
			secretStorage,
			null,
			0,
			null,
			null,
			tokenEndpointAuthMethod,
			grantTypes,
			scopes,
			scopeConfigured,
			state,
			authServerMeta,
			resourceIndicator,
			options?.resource === false,
			serverName || "Roo Code",
			options?.redirectUri,
			options?.clientId,
		)
		if (storedResourceIndicator) {
			provider._effectiveResourceIndicator = storedResourceIndicator
		}

		if (options?.clientId) {
			if (options.redirectUri) {
				getCallbackAddress(options.redirectUri)
			} else {
				// A static client skips DCR, which normally starts the callback server.
				// Start it here so the SDK never receives port 0 as redirect_uri.
				await provider._ensureCallbackServer()
			}
			provider._clientInfo = {
				client_id: options.clientId,
				redirect_uris: [provider.redirectUrl],
				token_endpoint_auth_method: "none",
			}
		}

		return provider
	}

	// ── OAuthClientProvider interface ────────────────────────────────────────

	/** Whether this provider was created with OAuth metadata (discovery succeeded). */
	get hasMetadata(): boolean {
		return this._authServerMeta !== null
	}

	get redirectUrl(): string {
		return this._configuredRedirectUri ?? `http://127.0.0.1:${this._port}/callback`
	}

	private _ensureCallbackServer(): Promise<void> {
		// Guard against concurrent callers (e.g. redirectToAuthorization + registerClientIfNeeded
		// called in parallel) both passing the "server not yet started" check and each launching
		// their own startCallbackServer(), which would bind two ports and lose one handle.
		if (this._server && !this._closed) return Promise.resolve()
		if (!this._ensureServerPromise) {
			this._ensureServerPromise = this._doStartCallbackServer().finally(() => {
				this._ensureServerPromise = null
			})
		}
		return this._ensureServerPromise
	}

	private async _doStartCallbackServer(): Promise<void> {
		this._closed = false
		const { port: configuredPort, host, path } = getCallbackAddress(this._configuredRedirectUri)
		const { server, port, result, cancel } = await startCallbackServer(
			configuredPort ?? this._port,
			this._state,
			host,
			path,
		)
		this._server = server
		this._port = port
		this._cancelCallbackServer = cancel
		const authCodePromise = result.then((r) => {
			if (r.error) throw new Error(`OAuth authorization failed: ${r.error}`)
			if (!r.code) throw new Error("No authorization code received in callback")
			return r.code
		})
		this._authCodePromise = authCodePromise

		// Static clients can start this promise before waitForAuthCode() observes it.
		// Observe rejection now to prevent an unhandled rejection, but keep the original
		// promise so waitForAuthCode() still receives the callback error. Stop only this
		// promise's listener before clearing it so a later flow can bind a fresh listener.
		void authCodePromise.catch(async () => {
			if (this._authCodePromise === authCodePromise && this._server === server) {
				await stopCallbackServer(server, cancel).catch(() => {})
				if (this._authCodePromise === authCodePromise && this._server === server) {
					this._server = null
					this._cancelCallbackServer = null
				}
			}
		})
	}

	state(): string {
		return this._state
	}

	get clientMetadata(): OAuthClientMetadata {
		return buildMcpOAuthClientMetadata({
			clientName: this._clientName,
			redirectUrl: this.redirectUrl,
			grantTypes: this._grantTypes,
			tokenEndpointAuthMethod: this._tokenEndpointAuthMethod,
		})
	}

	async clientInformation(): Promise<OAuthClientInformation | undefined> {
		return this._clientInfo
	}

	async saveClientInformation(info: OAuthClientInformationFull): Promise<void> {
		this._clientInfo = info
	}

	/**
	 * Registers this client with the authorization server if a
	 * `registration_endpoint` is present in the pre-fetched auth server
	 * metadata.  No-ops if already registered or if the server doesn't
	 * support dynamic client registration.
	 *
	 * Called by McpHub before the first `client.connect()` attempt so that
	 * `clientInformation()` returns a valid client_id and the SDK skips its
	 * own registration step — which fails for issuers with path components
	 * due to the same metadata discovery bug (see utils/oauth.ts for
	 * upstream issue links).
	 */
	async registerClientIfNeeded(): Promise<void> {
		if (this._clientInfo) return // already registered

		// Check if we have a cached client_id from previous registration
		const cachedData = await this._secretStorage.getOAuthData(this._serverUrl, this._configuredClientId)
		// Reuse the cached registration only for the issuer that created it. Otherwise
		// the stored client_secret would go to an authorization server the MCP server chose.
		if (cachedData?.client_info && cachedData.issuer === this._authServerMeta?.issuer) {
			// Use the full DCR response, override redirect_uris with the
			// current port (which may have changed between sessions).
			this._clientInfo = {
				...cachedData.client_info,
				redirect_uris: [this.redirectUrl],
			}
			return
		}

		if (!this._authServerMeta?.registration_endpoint) return // DCR not supported

		// For Dynamic Client Registration, we MUST have a stable redirect URI.
		// Ensure the callback server is started so we have a real port.
		await this._ensureCallbackServer()

		const response = await fetch(this._authServerMeta.registration_endpoint as string, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json",
			},
			body: JSON.stringify(this.clientMetadata),
		})

		if (!response.ok) {
			throw new Error(`Dynamic client registration failed: HTTP ${response.status}`)
		}

		this._clientInfo = (await response.json()) as OAuthClientInformationFull
	}

	async tokens(): Promise<OAuthTokens | undefined> {
		const data = await this._secretStorage.getOAuthData(this._serverUrl, this._configuredClientId)
		if (!data) return undefined

		// If the access token is still valid (with 5m buffer), return it.
		if (Date.now() < data.expires_at - TOKEN_EXPIRY_BUFFER_MS) {
			return data.tokens
		}

		// Access token is expired or near expiry. Try to refresh if we have a refresh token.
		if (data.tokens.refresh_token) {
			// Never send the refresh token to an authorization server other than the one
			// that issued it. Data without an issuer (saved by older versions) is cleared.
			if (data.issuer !== this._authServerMeta?.issuer) {
				await this._secretStorage.deleteOAuthData(this._serverUrl, this._configuredClientId)
				return undefined
			}

			// Restore the authorization resource after a restart only when the current
			// configuration or discovery did not already select one.
			if (!this._effectiveResourceIndicator && !this._resourceDisabled) {
				this._effectiveResourceIndicator = data.resource_indicator ?? null
			}
			if (this._refreshPromise) {
				return this._refreshPromise
			}

			// Use the client_id stored alongside the tokens — it is the one the
			// auth server bound the refresh token to.  `this._clientInfo.client_id`
			// may differ if a fresh DCR was performed (e.g. after stale token
			// cleanup removed the cached data).
			const clientIdForRefresh = data.client_info?.client_id ?? this._clientInfo?.client_id

			this._refreshPromise = this.refreshAccessToken(data.tokens.refresh_token, clientIdForRefresh).finally(
				() => {
					this._refreshPromise = null
				},
			)

			try {
				return await this._refreshPromise
			} catch (error) {
				console.error(`Failed to refresh MCP OAuth token for ${this._serverUrl}:`, error)
				// Clear stale tokens on refresh failure so we don't keep retrying a dead refresh token
				await this._secretStorage.deleteOAuthData(this._serverUrl, this._configuredClientId)
				// Fall through to return undefined, which triggers full re-auth
			}
		}

		return undefined
	}

	async saveTokens(tokens: OAuthTokens, clientIdOverride?: string): Promise<void> {
		const expires_at = tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : Date.now() + 3600 * 1000 // default 1 hour when server omits expires_in
		const clientInfo =
			clientIdOverride && this._clientInfo
				? { ...this._clientInfo, client_id: clientIdOverride }
				: this._clientInfo
		await this._secretStorage.saveOAuthData(
			this._serverUrl,
			{
				tokens,
				expires_at,
				...(this._authServerMeta?.issuer ? { issuer: this._authServerMeta.issuer as string } : {}),
				...(this._effectiveResourceIndicator ? { resource_indicator: this._effectiveResourceIndicator } : {}),
				...(clientInfo ? { client_info: clientInfo } : {}),
			},
			this._configuredClientId,
		)
	}

	async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
		// Ensure the callback server is running so redirectUrl has a real port.
		// The server must be started here because the SDK calls this method as
		// part of its internal auth flow (before throwing UnauthorizedError back
		// to our caller).  We do NOT open the browser here — that is deferred to
		// openBrowser(), which McpHub calls only after the user confirms the toast.
		await this._ensureCallbackServer()

		// Workaround for SDK metadata discovery bug (see utils/oauth.ts for issue links).
		// The SDK's discoverOAuthMetadata() builds a wrong well-known URL for issuers
		// with path components, causing it to fall back to a default "/authorize" path.
		// We correct the URL using our pre-fetched metadata:
		//  1. Replace the origin+pathname with the real authorization_endpoint.
		//  2. Preserve all SDK-generated query params (client_id, code_challenge, etc.).
		//  3. Override SDK scopes when the configuration explicitly supplies a scope.
		//  4. Set an explicit or discovered RFC 8707 `resource` parameter. Preserve
		//     an SDK-generated value unless the configuration disables it.
		if (this._resourceIndicator) {
			authorizationUrl.searchParams.set("resource", this._resourceIndicator)
			this._effectiveResourceIndicator = this._resourceIndicator
		} else if (this._resourceDisabled) {
			authorizationUrl.searchParams.delete("resource")
			this._effectiveResourceIndicator = null
		} else {
			const sdkResourceIndicator = authorizationUrl.searchParams.get("resource")
			if (sdkResourceIndicator) {
				this._effectiveResourceIndicator = sdkResourceIndicator
			} else if (this._effectiveResourceIndicator) {
				authorizationUrl.searchParams.set("resource", this._effectiveResourceIndicator)
			}
		}
		let correctedUrl = authorizationUrl
		if (this._authServerMeta?.authorization_endpoint) {
			try {
				const fixed = new URL(this._authServerMeta.authorization_endpoint as string)
				// Validate the authorization_endpoint origin matches the issuer to prevent
				// a compromised metadata document from redirecting users to a phishing page.
				const expectedOrigin = this._authServerMeta.issuer
					? new URL(this._authServerMeta.issuer as string).origin
					: new URL(this._serverUrl).origin
				if (fixed.origin !== expectedOrigin) {
					// Fall through and use the SDK-supplied URL unchanged
					throw new Error(
						`authorization_endpoint origin mismatch: expected ${expectedOrigin}, got ${fixed.origin}`,
					)
				}
				// Copy all query params generated by the SDK
				authorizationUrl.searchParams.forEach((value, key) => {
					fixed.searchParams.set(key, value)
				})
				correctedUrl = fixed
			} catch {
				// Fall through and use the original URL if correction fails
			}
		}

		if (this._scopeConfigured) {
			if (this._scopes.length > 0) {
				correctedUrl.searchParams.set("scope", this._scopes.join(" "))
			} else {
				correctedUrl.searchParams.delete("scope")
			}
		} else if (!correctedUrl.searchParams.has("scope") && this._scopes.length > 0) {
			correctedUrl.searchParams.set("scope", this._scopes.join(" "))
		}

		// Store the (possibly corrected) URL; it will be opened by openBrowser()
		// once the user confirms the "Authenticate" toast in McpHub.
		this._pendingAuthorizationUrl = correctedUrl
	}

	/**
	 * Opens the pending OAuth authorization URL in the system browser.
	 * Must be called after `redirectToAuthorization()` has been invoked by the SDK.
	 * McpHub calls this only after the user confirms the authentication toast.
	 */
	async openBrowser(): Promise<void> {
		const url = this._pendingAuthorizationUrl
		if (!url) {
			throw new Error("No pending authorization URL — redirectToAuthorization() was not called")
		}
		try {
			await vscode.env.openExternal(vscode.Uri.parse(url.toString()))
		} catch {
			void vscode.window.showInformationMessage(`Please open this URL in your browser to authenticate: ${url}`)
		}
	}

	async saveCodeVerifier(codeVerifier: string): Promise<void> {
		this._codeVerifier = codeVerifier
	}

	async codeVerifier(): Promise<string> {
		if (!this._codeVerifier) throw new Error("No PKCE code verifier saved")
		return this._codeVerifier
	}

	// ── Extra helpers for McpHub ─────────────────────────────────────────────

	/**
	 * Resolves with the authorization code once the user completes the OAuth
	 * browser flow and the local callback server receives the redirect.
	 * Rejects on error or 5-minute timeout.
	 */
	async waitForAuthCode(): Promise<string> {
		if (!this._authCodePromise || !this._server) {
			await this._ensureCallbackServer()
		}
		return this._authCodePromise!
	}

	/**
	 * Exchanges an authorization code for tokens by POSTing directly to the
	 * `token_endpoint` from our pre-fetched metadata.
	 *
	 * This bypasses the SDK's `transport.finishAuth()` which internally re-runs
	 * `discoverOAuthMetadata()` and hits the same broken URL construction for
	 * issuers with path components (see utils/oauth.ts for upstream issue links).
	 *
	 * After a successful exchange the tokens are persisted via `saveTokens()`
	 * so the next `client.connect()` call finds them in SecretStorage and
	 * connects without another OAuth round-trip.
	 *
	 * @param authorizationCode  The code received in the OAuth callback redirect.
	 * @throws When the token endpoint is unknown or the exchange request fails.
	 */
	async exchangeCodeForTokens(authorizationCode: string): Promise<void> {
		if (!this._authServerMeta?.token_endpoint) {
			throw new Error("No token_endpoint in auth server metadata — cannot exchange code")
		}
		if (!this._clientInfo) {
			throw new Error("No client information — registerClientIfNeeded() must be called first")
		}

		const codeVerifier = await this.codeVerifier()

		// Build the token request body per RFC 6749 §4.1.3 + RFC 7636 §4.5.
		const params: Record<string, string> = {
			grant_type: AUTHORIZATION_CODE_GRANT_TYPE,
			code: authorizationCode,
			redirect_uri: this.redirectUrl,
			client_id: this._clientInfo.client_id,
			code_verifier: codeVerifier,
		}

		// RFC 8707: include resource indicator so servers that bind token requests
		// to a specific resource can validate the exchange.
		if (this._effectiveResourceIndicator) {
			params.resource = this._effectiveResourceIndicator
		}

		// Include client_secret in the body when the auth method is client_secret_post.
		if (this._tokenEndpointAuthMethod === "client_secret_post" && this._clientInfo.client_secret) {
			params.client_secret = this._clientInfo.client_secret
		}

		const response = await fetch(this._authServerMeta.token_endpoint as string, {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				Accept: "application/json",
			},
			body: new URLSearchParams(params).toString(),
		})

		if (!response.ok) {
			throw new Error(`Token exchange failed: HTTP ${response.status}`)
		}

		const tokens = (await response.json()) as OAuthTokens
		await this.saveTokens(tokens)
	}

	/**
	 * Refreshes the access token using a refresh token.
	 *
	 * @param refreshToken The refresh token to use.
	 * @param clientIdOverride Optional client_id to use instead of `this._clientInfo.client_id`.
	 *   This is used when the stored tokens were issued to a different client_id than the
	 *   current in-memory registration (e.g. after a port change caused a new DCR).
	 * @returns The new tokens.
	 */
	async refreshAccessToken(refreshToken: string, clientIdOverride?: string): Promise<OAuthTokens> {
		if (!this._authServerMeta?.token_endpoint) {
			throw new Error("No token_endpoint in auth server metadata — cannot refresh token")
		}

		const clientId = clientIdOverride ?? this._clientInfo?.client_id
		if (!clientId) {
			throw new Error("No client information — registerClientIfNeeded() must be called first")
		}

		const params: Record<string, string> = {
			grant_type: REFRESH_TOKEN_GRANT_TYPE,
			refresh_token: refreshToken,
			client_id: clientId,
		}

		// RFC 8707: include resource indicator in refresh requests too.
		if (this._effectiveResourceIndicator) {
			params.resource = this._effectiveResourceIndicator
		}

		if (this._tokenEndpointAuthMethod === "client_secret_post" && this._clientInfo?.client_secret) {
			params.client_secret = this._clientInfo.client_secret
		}

		const response = await fetch(this._authServerMeta.token_endpoint as string, {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				Accept: "application/json",
			},
			body: new URLSearchParams(params).toString(),
		})

		if (!response.ok) {
			const errorBody = await response.text().catch(() => "")
			throw new Error(`Token refresh failed: HTTP ${response.status} ${errorBody}`)
		}

		const tokens = (await response.json()) as OAuthTokens
		const mergedTokens: OAuthTokens = {
			...tokens,
			refresh_token: tokens.refresh_token ?? refreshToken,
		}
		await this.saveTokens(mergedTokens, clientId)
		return mergedTokens
	}

	/** Close the local callback server. Always call this when done. */
	async close(): Promise<void> {
		// If a server startup is in flight, wait for it to finish so we don't
		// close before _server is set (which would leave a dangling server).
		if (this._ensureServerPromise) {
			await this._ensureServerPromise.catch(() => {})
		}
		if (!this._closed && this._server) {
			this._closed = true
			await stopCallbackServer(this._server, this._cancelCallbackServer ?? (() => {})).catch(() => {})
			this._server = null
			this._cancelCallbackServer = null
			this._authCodePromise = null
		}
	}
}

function resolveResourceIndicator(configured: McpOAuthResource | undefined, discovered?: string | null): string | null {
	if (configured === false) return null
	if (configured && configured !== "auto") return configured
	return discovered ?? null
}

function getCallbackAddress(redirectUri?: string): {
	port?: number
	host: "localhost" | "127.0.0.1"
	path: string
} {
	if (!redirectUri) return { host: "127.0.0.1", path: "/callback" }
	const url = new URL(redirectUri)
	if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
		throw new Error("MCP OAuth redirectUri must use a loopback host")
	}
	if (url.protocol !== "http:") {
		throw new Error("MCP OAuth redirectUri must use HTTP on a loopback host")
	}
	// Authorization servers with pre-registered clients may require a specific path.
	if (url.pathname === "/") {
		throw new Error("MCP OAuth redirectUri must specify a callback path")
	}
	if (url.username || url.password || url.search || url.hash) {
		throw new Error("MCP OAuth redirectUri must not contain credentials, a query, or a fragment")
	}
	const port = Number(url.port)
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		throw new Error("MCP OAuth redirectUri must specify a valid port")
	}
	return { port, host: url.hostname, path: url.pathname }
}
