/**
 * Network Proxy Configuration Module
 *
 * Provides proxy configuration for all outbound HTTP/HTTPS requests from the Roo Code extension.
 * When running in debug mode (F5), a proxy can be enabled for outbound traffic.
 * Optionally, TLS certificate verification can be disabled (debug only) to allow
 * MITM proxy inspection.
 *
 * Uses global-agent to globally route all HTTP/HTTPS traffic through the proxy,
 * which works with axios, fetch, and most SDKs that use native Node.js http/https.
 */

import * as vscode from "vscode"
import { NodeHttpHandler } from "@smithy/node-http-handler"
import { HttpProxyAgent } from "http-proxy-agent"
import { HttpsProxyAgent } from "https-proxy-agent"
import { Package } from "../shared/package"

/**
 * Proxy configuration state
 */
export interface ProxyConfig {
	/** Whether the debug proxy is enabled */
	enabled: boolean
	/** The proxy server URL (e.g., http://127.0.0.1:8888) */
	serverUrl: string
	/** Accept self-signed/insecure TLS certificates from the proxy (required for MITM) */
	tlsInsecure: boolean
	/** Whether running in debug/development mode */
	isDebugMode: boolean
}

let extensionContext: vscode.ExtensionContext | null = null
let proxyInitialized = false
let undiciProxyInitialized = false
let fetchPatched = false
let originalFetch: typeof fetch | undefined
let outputChannel: vscode.OutputChannel | null = null

let loggingEnabled = false
let consoleLoggingEnabled = false

let tlsVerificationOverridden = false
let originalNodeTlsRejectUnauthorized: string | undefined

function redactProxyUrl(proxyUrl: string | undefined): string {
	if (!proxyUrl) {
		return "(not set)"
	}

	try {
		const url = new URL(proxyUrl)
		url.username = ""
		url.password = ""
		return url.toString()
	} catch {
		// Fallback for invalid URLs: redact basic auth if present.
		return proxyUrl.replace(/\/\/[^@/]+@/g, "//REDACTED@")
	}
}

function restoreGlobalFetchPatch(): void {
	if (!fetchPatched) {
		return
	}

	if (originalFetch) {
		globalThis.fetch = originalFetch
	}

	fetchPatched = false
	originalFetch = undefined
}

/**
 * Fire-and-log variant of ProxyAgent.close(): Disposable.dispose() is synchronous while
 * close() is async, and neither a teardown sequence nor the late-import abort may block on
 * (or reject into) its caller.
 */
function closeProxyAgentBestEffort(proxyAgent: { close(): Promise<void> }): void {
	void proxyAgent.close().catch((error) => {
		log(`Failed to close undici proxy agent: ${error instanceof Error ? error.message : String(error)}`)
	})
}

function restoreTlsVerificationOverride(): void {
	if (!tlsVerificationOverridden) {
		return
	}

	if (typeof originalNodeTlsRejectUnauthorized === "string") {
		process.env.NODE_TLS_REJECT_UNAUTHORIZED = originalNodeTlsRejectUnauthorized
	} else {
		delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
	}

	tlsVerificationOverridden = false
	originalNodeTlsRejectUnauthorized = undefined
}

function applyTlsVerificationOverride(config: ProxyConfig): void {
	// Only relevant in debug mode with an active proxy.
	if (!config.isDebugMode || !config.enabled) {
		restoreTlsVerificationOverride()
		return
	}

	if (!config.tlsInsecure) {
		restoreTlsVerificationOverride()
		return
	}

	if (!tlsVerificationOverridden) {
		originalNodeTlsRejectUnauthorized = process.env.NODE_TLS_REJECT_UNAUTHORIZED
	}

	// CodeQL: debug-only opt-in for MITM debugging.
	process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0" // lgtm[js/disabling-certificate-validation]
	tlsVerificationOverridden = true
}

/**
 * Initialize the network proxy module with the extension context.
 * Must be called early in extension activation before any network requests.
 *
 * Each resource created here is also registered on `context.subscriptions` for the normal
 * deactivate path. The returned disposable covers the same resources so a failed activation
 * can tear them down itself: `deactivate()` is not guaranteed to run after activation fails,
 * and a retained configuration listener would let a `debugProxy.*` settings toggle re-apply
 * proxy configuration (including the TLS verification override) inside a dead extension.
 *
 * @param context The VS Code extension context
 * @param channel Optional output channel for logging
 * @returns A disposable releasing everything initialized here; a no-op outside debug mode, where nothing is created.
 */
export async function initializeNetworkProxy(
	context: vscode.ExtensionContext,
	channel?: vscode.OutputChannel,
): Promise<vscode.Disposable> {
	extensionContext = context

	// extensionMode is immutable for the process lifetime - exit early if not in debug mode.
	// This avoids any overhead (listeners, logging, etc.) in production.
	const isDebugMode = context.extensionMode === vscode.ExtensionMode.Development
	if (!isDebugMode) {
		// Nothing was acquired in production, so there is nothing for the caller to tear down.
		return { dispose: () => {} }
	}

	outputChannel = channel ?? null
	loggingEnabled = true
	consoleLoggingEnabled = !outputChannel

	const config = getProxyConfig()

	log(`Initializing network proxy module...`)
	log(
		`Proxy config: enabled=${config.enabled}, serverUrl=${redactProxyUrl(config.serverUrl)}, tlsInsecure=${config.tlsInsecure}`,
	)

	// Collect every resource created here so the returned disposable can release them when a
	// later activation step fails; the same objects also go to context.subscriptions for the
	// deactivate path, and both restores below are idempotent, so double disposal is safe.
	const resources: vscode.Disposable[] = []

	// The two dynamic imports in the configure* helpers below are suspension points: a teardown
	// can run while one is pending, and its continuation would write process-global state
	// (dispatcher, fetch patch, global-agent bootstrap) after disposal. Both disposal paths set
	// the flag - the aggregate dispose at the end of this function, and overrideCleanup, which
	// VS Code also disposes item-by-item through context.subscriptions - and each continuation
	// checks it before installing.
	let disposed = false
	const isDisposed = () => disposed

	// Listen for configuration changes to allow toggling proxy during a debug session.
	// Guard for test environments where onDidChangeConfiguration may not be mocked.
	if (typeof vscode.workspace.onDidChangeConfiguration === "function") {
		const configListener = vscode.workspace.onDidChangeConfiguration((e) => {
			if (
				e.affectsConfiguration(`${Package.name}.debugProxy.enabled`) ||
				e.affectsConfiguration(`${Package.name}.debugProxy.serverUrl`) ||
				e.affectsConfiguration(`${Package.name}.debugProxy.tlsInsecure`)
			) {
				const newConfig = getProxyConfig()

				if (newConfig.enabled) {
					applyTlsVerificationOverride(newConfig)
					configureGlobalProxy(newConfig, isDisposed)
					// The aggregate owns whatever this enables: without registering the created
					// agent resource here, a proxy toggled on mid-session would survive every
					// teardown path the returned disposable covers.
					configureUndiciProxy(newConfig, context, isDisposed, (resource) => resources.push(resource))
				} else {
					// Proxy disabled mid-session: global-agent can't be un-bootstrapped, and the
					// dispatcher stays installed until the resources below are disposed (re-pointing
					// live traffic mid-session is not safe). Any global fetch patch *can* be
					// restored immediately.
					restoreGlobalFetchPatch()
					restoreTlsVerificationOverride()
					log("Debug proxy disabled. Restart VS Code to fully disable proxy routing.")
				}
			}
		})
		context.subscriptions.push(configListener)
		resources.push(configListener)
	}

	// Ensure we restore any overrides when the extension unloads.
	const overrideCleanup: vscode.Disposable = {
		dispose: () => {
			// Latching disposal here covers the path where VS Code disposes context.subscriptions
			// item-by-item; the aggregate dispose below sets the same flag itself.
			disposed = true
			restoreGlobalFetchPatch()
			restoreTlsVerificationOverride()
		},
	}
	context.subscriptions.push(overrideCleanup)
	resources.push(overrideCleanup)

	if (config.enabled) {
		applyTlsVerificationOverride(config)
		await configureGlobalProxy(config, isDisposed)
		await configureUndiciProxy(config, context, isDisposed, (resource) => resources.push(resource))
	} else {
		log(`Debug proxy not enabled.`)
	}

	return {
		dispose: () => {
			// Stryker disable next-line BooleanLiteral: the override-cleanup resource disposed by the same loop latches the identical flag, so no interleaving distinguishes this assignment from its mutant.
			disposed = true
			for (const resource of resources) {
				resource.dispose()
			}
		},
	}
}

/**
 * Get the current proxy configuration based on VS Code settings and extension mode.
 */
export function getProxyConfig(): ProxyConfig {
	const defaultServerUrl = "http://127.0.0.1:8888"

	if (!extensionContext) {
		// Fallback if called before initialization
		return {
			enabled: false,
			serverUrl: defaultServerUrl,
			tlsInsecure: false,
			isDebugMode: false,
		}
	}

	const config = vscode.workspace.getConfiguration(Package.name)
	const enabled = Boolean(config.get<unknown>("debugProxy.enabled"))
	const rawServerUrl = config.get<unknown>("debugProxy.serverUrl")
	const serverUrl = typeof rawServerUrl === "string" && rawServerUrl.trim() ? rawServerUrl.trim() : defaultServerUrl
	const tlsInsecure = Boolean(config.get<unknown>("debugProxy.tlsInsecure"))

	// Debug mode only.
	const isDebugMode = extensionContext.extensionMode === vscode.ExtensionMode.Development

	return {
		enabled,
		serverUrl,
		tlsInsecure,
		isDebugMode,
	}
}

/**
 * Configure global-agent to route all HTTP/HTTPS traffic through the proxy.
 *
 * @param isDisposed Teardown latch checked after the dynamic import below; bootstrap is
 * skipped when the extension was disposed while the import was pending.
 */
async function configureGlobalProxy(config: ProxyConfig, isDisposed: () => boolean): Promise<void> {
	if (proxyInitialized) {
		// global-agent can only be bootstrapped once
		// Update environment variables for any new connections
		log(`Proxy already initialized, updating env vars only`)
		updateProxyEnvVars(config)
		return
	}

	// Set up environment variables before bootstrapping
	log(`Setting proxy environment variables before bootstrap (values redacted)...`)
	updateProxyEnvVars(config)

	let bootstrap: (() => void) | undefined
	try {
		const mod = (await import("global-agent")) as typeof import("global-agent")
		bootstrap = mod.bootstrap
	} catch (error) {
		log(
			`Failed to load global-agent (proxy support is only available in debug/dev builds): ${error instanceof Error ? error.message : String(error)}`,
		)
		return
	}

	// A teardown may have run while the import above was pending; bootstrapping global-agent
	// then would intercept this process's HTTP traffic for a dead extension.
	if (isDisposed()) {
		log("global-agent import completed after disposal; skipping bootstrap")
		return
	}

	// Bootstrap global-agent to intercept all HTTP/HTTPS requests
	log(`Calling global-agent bootstrap()...`)
	try {
		bootstrap()
		proxyInitialized = true
		log(`global-agent bootstrap() completed successfully`)
	} catch (error) {
		log(`global-agent bootstrap() FAILED: ${error instanceof Error ? error.message : String(error)}`)
		return
	}

	log(`Network proxy configured: ${redactProxyUrl(config.serverUrl)}`)
}

/**
 * Configure undici's global dispatcher so Node's built-in `fetch()` and any undici-based
 * clients route through the proxy.
 *
 * The dispatcher active before the install is captured and restored when the created resource
 * is disposed — but only while the global slot still holds the agent installed here; a slot a
 * third party has since replaced belongs to that installer, not to this teardown.
 *
 * @param context The extension context whose subscriptions register the created resource.
 * @param isDisposed Teardown latch checked after the dynamic import below; a late import
 * completion closes the freshly built agent instead of installing it.
 * @param registerResource Called with the created resource synchronously after the last await,
 * so a teardown that starts while this function is in flight cannot miss it.
 */
async function configureUndiciProxy(
	config: ProxyConfig,
	context: vscode.ExtensionContext,
	isDisposed: () => boolean,
	registerResource: (resource: vscode.Disposable) => void,
): Promise<void> {
	if (!config.enabled || !config.serverUrl) {
		return
	}

	if (undiciProxyInitialized) {
		log(`undici global dispatcher already configured; restart VS Code to change proxy safely`)
		return
	}

	try {
		const {
			ProxyAgent,
			setGlobalDispatcher,
			getGlobalDispatcher,
			fetch: undiciFetch,
		} = (await import("undici")) as typeof import("undici")

		const proxyAgent = new ProxyAgent({
			uri: config.serverUrl,
			// If the user enabled TLS insecure mode (debug only), apply it to undici.
			requestTls: config.tlsInsecure
				? ({ rejectUnauthorized: false } satisfies import("tls").ConnectionOptions) // lgtm[js/disabling-certificate-validation]
				: undefined,
			proxyTls: config.tlsInsecure
				? ({ rejectUnauthorized: false } satisfies import("tls").ConnectionOptions) // lgtm[js/disabling-certificate-validation]
				: undefined,
		})

		// A teardown may have run while the import above was pending. Installing the dispatcher
		// or patching fetch then would leave process-global routing active for a dead extension,
		// so the freshly built agent is closed and nothing is installed.
		if (isDisposed()) {
			log("undici import completed after disposal; closing the late proxy agent without installing it")
			closeProxyAgentBestEffort(proxyAgent)
			return
		}

		// A concurrent call can pass the already-configured check above while this import is
		// pending. Installing after another call has set the dispatcher would capture that
		// agent as the previous dispatcher, and its teardown would then restore a closed
		// agent globally; the first install owns the slot, so this agent is closed instead.
		if (undiciProxyInitialized) {
			closeProxyAgentBestEffort(proxyAgent)
			return
		}

		// undici exposes a getter for its global dispatcher slot, so the dispatcher that
		// predates this install can be captured here and put back by the resource below.
		const previousDispatcher = getGlobalDispatcher()
		setGlobalDispatcher(proxyAgent)
		undiciProxyInitialized = true
		log(`undici global dispatcher configured for proxy: ${redactProxyUrl(config.serverUrl)}`)

		// Node's built-in `fetch()` (Node 18+) is powered by an internal undici copy.
		// Setting a dispatcher on our `undici` dependency does NOT affect that internal fetch.
		// To ensure Roo Code's `fetch()` calls are proxied, patch global fetch in debug mode.
		// This patch is scoped to the extension lifecycle (restored on deactivate) and can be restored
		// immediately if the proxy is disabled.
		if (!fetchPatched) {
			if (typeof globalThis.fetch === "function") {
				originalFetch = globalThis.fetch
			}

			globalThis.fetch = undiciFetch as unknown as typeof fetch
			fetchPatched = true
			log(`globalThis.fetch patched to undici.fetch (debug proxy mode)`)
		}

		// The agent owns sockets, so teardown must close it; restoring the fetch patch is owned
		// by the override-cleanup resource, which every disposal path also disposes. The
		// dispatcher is restored before the close so traffic started after teardown cannot land
		// on the closed agent, and only while the slot still holds this agent — a dispatcher
		// installed by someone else afterwards is theirs to manage. Disposal reaches this
		// resource from two owners (context.subscriptions and the aggregate returned by
		// initializeNetworkProxy), so the once-guard keeps a double dispose to a single close.
		let agentClosed = false
		const undiciResource: vscode.Disposable = {
			dispose: () => {
				if (!agentClosed) {
					agentClosed = true
					if (getGlobalDispatcher() === proxyAgent) {
						setGlobalDispatcher(previousDispatcher)
					}
					closeProxyAgentBestEffort(proxyAgent)
				}
			},
		}
		registerResource(undiciResource)
		context.subscriptions.push(undiciResource)
	} catch (error) {
		log(`Failed to configure undici proxy dispatcher: ${error instanceof Error ? error.message : String(error)}`)
	}
}
/**
 * Update environment variables for proxy configuration.
 * global-agent reads from GLOBAL_AGENT_* environment variables.
 */
function updateProxyEnvVars(config: ProxyConfig): void {
	if (config.serverUrl) {
		// global-agent uses these environment variables
		process.env.GLOBAL_AGENT_HTTP_PROXY = config.serverUrl
		process.env.GLOBAL_AGENT_HTTPS_PROXY = config.serverUrl
		process.env.GLOBAL_AGENT_NO_PROXY = "" // Proxy all requests
	}
}

/**
 * Check if a proxy is currently configured and active.
 *
 * @internal
 */
export function isProxyEnabled(): boolean {
	const config = getProxyConfig()
	// Active proxy is only applied in debug mode.
	return config.enabled && config.isDebugMode
}

/**
 * Check if we're running in debug mode.
 *
 * @internal
 */
export function isDebugMode(): boolean {
	if (!extensionContext) {
		return false
	}
	return extensionContext.extensionMode === vscode.ExtensionMode.Development
}

/**
 * Determine whether a target URL should bypass the proxy based on NO_PROXY / no_proxy.
 *
 * Follows the widely-used convention (curl, proxy-from-env):
 * - `NO_PROXY=*` bypasses the proxy for every host.
 * - Entries are comma-separated host suffixes; an optional leading `.` or `*.` and a
 *   trailing `:port` are ignored. A target matches when its hostname equals an entry
 *   or ends with `.<entry>` (so `amazonaws.com` covers `bedrock-runtime.us-east-1.amazonaws.com`).
 * - Matching is case-insensitive.
 */
function isNoProxyHost(targetUrl: string): boolean {
	const noProxy = (process.env.NO_PROXY || process.env.no_proxy || "").trim()
	if (!noProxy) return false
	if (noProxy === "*") return true

	let hostname: string
	try {
		hostname = new URL(targetUrl).hostname.toLowerCase()
	} catch {
		return false
	}
	if (!hostname) return false

	return noProxy
		.split(",")
		.map((entry) => entry.trim().toLowerCase())
		.filter(Boolean)
		.some((entry) => {
			// Normalize a leading wildcard/dot and a trailing port: "*.example.com:443" -> "example.com"
			const suffix = entry.replace(/^\*?\./, "").replace(/:\d+$/, "")
			if (!suffix) return false
			return hostname === suffix || hostname.endsWith(`.${suffix}`)
		})
}

/**
 * Get the proxy URL from environment variables or VS Code settings.
 * Works in all extension modes (production and debug).
 *
 * When `targetUrl` is provided and its host is covered by NO_PROXY / no_proxy, this
 * returns undefined so the caller connects directly — honoring the user's intent to
 * bypass the proxy for e.g. a directly-reachable VPC or AWS endpoint.
 *
 * @param targetUrl Optional URL of the request destination, used for NO_PROXY matching.
 * @returns The proxy URL, or undefined if no proxy applies or only whitespace is set.
 */
export function getSystemProxyUrl(targetUrl?: string): string | undefined {
	// If the destination is covered by NO_PROXY, connect directly regardless of proxy source.
	if (targetUrl && isNoProxyHost(targetUrl)) {
		return undefined
	}

	// Standard proxy environment variables (HTTPS takes precedence over HTTP).
	// Trim to reject whitespace-only values which would be invalid for HttpsProxyAgent.
	const fromEnv =
		process.env.HTTPS_PROXY?.trim() ||
		process.env.https_proxy?.trim() ||
		process.env.HTTP_PROXY?.trim() ||
		process.env.http_proxy?.trim()

	if (fromEnv) return fromEnv

	// Fall back to VS Code's http.proxy setting
	try {
		const vsCodeProxy = vscode.workspace.getConfiguration("http").get<string>("proxy")
		if (vsCodeProxy?.trim()) return vsCodeProxy.trim()
	} catch {
		// VS Code API may be unavailable in test environments
	}

	return undefined
}

// Derived from the handler's own signatures so this file needs no @smithy/types dependency.
type HandleParameters = Parameters<NodeHttpHandler["handle"]>
type UpdateClientConfigParameters = Parameters<NodeHttpHandler["updateHttpClientConfig"]>

/**
 * The subset of the AWS SDK request-handler contract implemented below. Exported so callers and
 * their tests can name the type without reaching for @smithy/types.
 */
export interface ProxyRoutingHandler {
	handle(...args: HandleParameters): ReturnType<NodeHttpHandler["handle"]>
	updateHttpClientConfig(...args: UpdateClientConfigParameters): void
	httpHandlerConfigs(): ReturnType<NodeHttpHandler["httpHandlerConfigs"]>
	destroy(): void
}

/**
 * AWS SDK request handler that chooses, per request, between the system proxy and a direct
 * connection.
 *
 * The SDK resolves its own endpoint — region, partition, FIPS/dualstack flags, and any endpoint
 * override — so the destination is only known once a request has been built. Choosing here is
 * what makes NO_PROXY apply to the host actually called, rather than one guessed up front.
 *
 * Both routes are HTTP/1.1: a client defaulting to NodeHttp2Handler drops to 1.1 once a proxy is
 * configured, which is what the chat provider already does.
 */
class ProxyRoutingRequestHandler implements ProxyRoutingHandler {
	private readonly direct = new NodeHttpHandler()
	private readonly proxied: NodeHttpHandler

	constructor(proxyUrl: string) {
		// Smithy applies these defaults only to agents it builds itself, as for the direct route.
		// Without them every proxied request would pay a fresh CONNECT and TLS handshake.
		const agentOptions = { keepAlive: true, maxSockets: 50 }
		this.proxied = new NodeHttpHandler({
			httpAgent: new HttpProxyAgent(proxyUrl, agentOptions),
			httpsAgent: new HttpsProxyAgent(proxyUrl, agentOptions),
		})
	}

	private handlerFor(request: HandleParameters[0]): NodeHttpHandler {
		// NO_PROXY entries match on host alone, so the port is left out.
		return isNoProxyHost(`${request.protocol}//${request.hostname}`) ? this.direct : this.proxied
	}

	handle(...args: HandleParameters) {
		return this.handlerFor(args[0]).handle(...args)
	}

	updateHttpClientConfig(...args: UpdateClientConfigParameters) {
		this.direct.updateHttpClientConfig(...args)
		this.proxied.updateHttpClientConfig(...args)
	}

	httpHandlerConfigs() {
		return this.proxied.httpHandlerConfigs()
	}

	destroy() {
		this.direct.destroy()
		this.proxied.destroy()
	}
}

/**
 * Build a request handler routing AWS SDK traffic through the system proxy, except for the
 * destinations NO_PROXY excludes.
 *
 * Returns undefined when no proxy is configured, so the client keeps its own default handler.
 */
export function createProxyRoutingRequestHandler(): ProxyRoutingHandler | undefined {
	const proxyUrl = getSystemProxyUrl()
	return proxyUrl ? new ProxyRoutingRequestHandler(proxyUrl) : undefined
}

/**
 * Log a message to the output channel if available.
 */
function log(message: string): void {
	if (!loggingEnabled) {
		return
	}

	const logMessage = `[NetworkProxy] ${message}`
	if (outputChannel) {
		outputChannel.appendLine(logMessage)
	}
	if (consoleLoggingEnabled) {
		console.log(logMessage)
	}
}
