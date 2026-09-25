import { createServer } from "http"
import { randomBytes, timingSafeEqual } from "crypto"
import type { Server as SocketIoServer, Socket } from "socket.io"
import * as vscode from "vscode"
import type { Disposable, Webview } from "vscode"

import type { ExtensionMessage, WebviewMessage } from "@roo-code/types"

import { BROWSER_BRIDGE_UNAUTHORIZED_MESSAGE } from "../../shared/browserBridge"
import { Package } from "../../shared/package"

/**
 * Browser bridge — standalone-browser UI transport for the Zoo Code webview
 * (development-only tooling for analyzing render issues with full
 * React DevTools / Chrome DevTools support).
 *
 * `BrowserBridgeServer` is a single statically-imported class used as a
 * namespace of verbose statics; per-provider bridge state lives in the module
 * {@link BrowserBridgeServer.bridges} WeakMap keyed by the owning host (a
 * structural {@link BridgeHost}, so this module never imports ClineProvider).
 * The bridge is started on demand from the dev-only `zoo-code.openInBrowser`
 * command, registered by {@link BrowserBridgeServer.registerCommand} only when
 * `ROO_BROWSER_BRIDGE=1` is set in a Development extension host; it is not
 * contributed in package.json. Once started, the extension host serves a
 * socket.io server on `127.0.0.1:<port>` and swaps the real VSCode webview for
 * a virtual one. The UI then lives entirely in a normal Chrome tab (loaded
 * from the Vite dev server) instead of the VSCode webview iframe, while the
 * message protocol (`WebviewMessage` / `ExtensionMessage`) stays unchanged.
 *
 * socket.io itself is imported lazily inside {@link BrowserBridgeServer.start}
 * (and externalized in production bundles), so the shipping extension carries
 * zero bytes of the bridge server library.
 *
 * Ports are unique per bridge: the OS assigns a free port unless
 * `ROO_BROWSER_BRIDGE_PORT` is set (a dev-only override). The actual port is
 * passed to the browser tab as a `?bridgePort=<port>` URL query parameter, so
 * any number of Zoo Code tabs or sidebar panels can run in the browser
 * simultaneously, each on its own port.
 *
 * Each bridge also generates a random per-bridge token, handed to the browser
 * tab as `?bridgeToken=<token>`. The client presents it in the socket.io
 * handshake (`auth: { token }`) and the server rejects every socket whose
 * token does not match, so a local process that merely finds the open port
 * cannot drive the provider through the bridge.
 */

export const DEFAULT_BROWSER_BRIDGE_PORT = 0

/**
 * Base URL of the webview-ui Vite dev server. It always runs on a fixed port
 * (see webview-ui/vite.config.ts); if it's not up, the browser tab simply
 * shows a connection error — good enough for a dev-only tool. Wrapped in a
 * function so both consumers (the URL builder and the origin pattern) read
 * the same value lazily, at call time rather than at module load.
 */
function getViteBaseUrl(): string {
	return "http://localhost:5173"
}

/**
 * Origins the bridge accepts. The bridge is the only consumer and it always
 * opens the tab on {@link getViteBaseUrl}, so the allowlist is exactly that
 * origin plus its 127.0.0.1 equivalent — never an arbitrary local port
 * (a page served by some other local dev app must not be able to reach the
 * bridge from the browser). The pattern is built on demand from
 * getViteBaseUrl() so the two can never drift apart (and so a malformed base
 * URL surfaces as a startup failure rather than an import-time crash). A
 * browser always sends an `Origin` header on a cross-origin WebSocket
 * upgrade / polling handshake, so the same pattern gates both the CORS
 * responses and the handshake itself (see {@link isAllowedHandshakeOrigin}).
 */
function getLocalOrigin(): RegExp {
	// The loopback names are hard-coded with their dots pre-escaped so
	// "127.0.0.1" stays literal instead of matching arbitrary characters.
	// No runtime escaping here at all: escaping only the dots (and not, say,
	// backslashes) is the classic incomplete-escape pitfall a static checker
	// will (rightly) flag even for a constant input.
	// The Vite dev server always runs with an explicit port; any other
	// base URL makes `new URL` throw or yields a non-matching pattern.
	const port = new URL(getViteBaseUrl()).port
	return new RegExp(`^http://(127\\.0\\.0\\.1|localhost)(:${port})$`)
}

/**
 * engine.io invokes `allowRequest` for every fresh handshake — the polling GET
 * and the WebSocket upgrade alike — while CORS never gates the WS upgrade.
 * Validate the handshake Origin here so a random web page cannot open a
 * socket to the local dev bridge. Non-browser clients (tests, curl) omit
 * `Origin`; for them the per-bridge handshake token (verified by the
 * `server.use` middleware in the {@link BrowserBridgeServer} constructor)
 * remains the boundary.
 */
function isAllowedHandshakeOrigin(origin: string | string[] | undefined): boolean {
	return origin === undefined || (typeof origin === "string" && getLocalOrigin().test(origin))
}

/**
 * The port the bridge binds to. Defaults to `0` (let the OS pick a free port)
 * so every provider gets a unique port. `ROO_BROWSER_BRIDGE_PORT` can still
 * override this for parallel dev hosts that need a fixed, known port.
 */
export function getBrowserBridgePort(): number {
	const raw = process.env.ROO_BROWSER_BRIDGE_PORT
	// Stryker disable next-line ConditionalExpression,LogicalOperator,StringLiteral: ""/undefined both fall through Number() to DEFAULT_BROWSER_BRIDGE_PORT (equivalent mutants)
	if (raw === undefined || raw === "") {
		return DEFAULT_BROWSER_BRIDGE_PORT
	}
	const port = Number(raw)
	// Stryker disable next-line EqualityOperator: port 0 is returned unchanged because DEFAULT_BROWSER_BRIDGE_PORT is 0 (equivalent mutant)
	return Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_BROWSER_BRIDGE_PORT
}

/**
 * Resolves the port a bound http server is actually listening on. When
 * `port: 0` was requested, the OS picks a free port and reports it back here.
 *
 * Exported for tests only; production callers go through
 * {@link BrowserBridgeServer.start}.
 */
export function getBoundPort(httpServer: SocketIoServer["httpServer"], requestedPort: number): number {
	const address = httpServer.address()
	if (address && typeof address === "object") {
		return address.port
	}
	return requestedPort
}

/**
 * Opaque host key for the per-provider bridge state (in practice a
 * `ClineProvider`). Typing it as a plain object keeps the bridge usable from
 * the activation layer without importing ClineProvider (no module cycle).
 */
export type BridgeHost = object

/**
 * The provider internals the bridge needs: the currently resolved real webview
 * (to render the browser-mode placeholder into) and the private
 * webview-message wiring entry point. Both are private on ClineProvider, so
 * the bridge reaches them through element access via this local view rather
 * than expanding the provider's public API with bridge-specific members.
 */
interface BridgeHostInternals {
	view?: vscode.WebviewView | vscode.WebviewPanel
	/**
	 * Attaches the provider's message handler to `webview` and returns the
	 * subscription. The bridge owns that disposable (the sidebar's
	 * `webviewDisposables` must not, or clearing them on sidebar disposal
	 * would silently deafen the virtual webview).
	 */
	attachWebviewMessageListener(webview: Webview): Disposable
}

/**
 * Server side of the bridge. Binds to 127.0.0.1 only and restricts CORS plus
 * the handshake Origin check to local origins, since this is a
 * development-only transport.
 */
export class BrowserBridgeServer {
	/**
	 * Per-host bridge registry. One host (provider) -> one bridge -> one port,
	 * permanently, until {@link BrowserBridgeServer.disposeFor} runs.
	 */
	private static readonly bridges = new WeakMap<BridgeHost, BrowserBridgeServer>()

	/**
	 * Per-host lifecycle epoch. Bridge startup is asynchronous, so
	 * {@link BrowserBridgeServer.disposeFor} can run while a `start()` is
	 * still pending; disposeFor bumps the epoch, and an awaiting caller that
	 * sees it moved disposes the late bridge instead of binding it to a host
	 * that is already released (which would leak the listening port and hold
	 * a message listener into the disposed provider). Starts that merely race
	 * each other keep the epoch, so the one-bridge-per-host bind() rule still
	 * decides the winner between them.
	 */
	private static readonly lifecycleEpoch = new WeakMap<BridgeHost, number>()

	// ---- dev-only command registration (self-gating; one line at the call site) ----

	/**
	 * Registers the dev-only `openInBrowser` command when (and only when)
	 * `ROO_BROWSER_BRIDGE=1` is set in a Development extension host. In every
	 * other environment (i.e. production) this is a no-op, so the command —
	 * and everything reachable only through it — is dead code.
	 *
	 * The command handler owns the whole flow: visible-provider lookup ->
	 * reuse existing bridge or start a new one -> enable (bind) -> open the
	 * browser tab.
	 */
	static registerCommand(
		context: vscode.ExtensionContext,
		outputChannel: vscode.OutputChannel,
		getVisibleProvider: () => BridgeHost | undefined,
	): void {
		// Dev-only tooling: intentionally absent from package.json
		// contributions, so public users never see a toolbar button or a
		// localized command-palette entry.
		if (process.env.ROO_BROWSER_BRIDGE !== "1") {
			return
		}
		if (context.extensionMode !== vscode.ExtensionMode.Development) {
			return
		}

		context.subscriptions.push(
			vscode.commands.registerCommand(`${Package.name}.openInBrowser`, async () => {
				const host = getVisibleProvider()
				if (!host) {
					outputChannel.appendLine("Cannot find any visible Roo Code instances.")
					return
				}

				// One host -> one bridge -> one port, permanently. If this
				// provider is already in browser mode, reuse its bridge
				// instead of starting a second one (an extra socket.io server
				// would leak its port).
				const existing = BrowserBridgeServer.bridges.get(host)
				if (existing) {
					outputChannel.appendLine(
						`[openInBrowser] Reusing existing browser bridge on port ${existing._port}.`,
					)
					await vscode.env.openExternal(
						vscode.Uri.parse(BrowserBridgeServer.getBrowserUrl(existing._port, existing.token)),
					)
					return
				}

				// Snapshot the lifecycle epoch so a disposeFor(host) racing the
				// awaited start below can invalidate it before it reaches bind().
				const epoch = BrowserBridgeServer.lifecycleEpoch.get(host) ?? 0
				const bridge = await BrowserBridgeServer.start(
					(message) => outputChannel.appendLine(message),
					(error) => {
						// Surface bridge failures to the developer, not just the
						// output channel — a silently dead command is a dead end.
						void vscode.window.showErrorMessage(`Failed to start the browser bridge: ${error.message}`)
					},
				)
				if (!bridge) {
					outputChannel.appendLine("[openInBrowser] Failed to start the browser bridge.")
					return
				}
				if ((BrowserBridgeServer.lifecycleEpoch.get(host) ?? 0) !== epoch) {
					// The host was released (disposeFor) while start() was in
					// flight; closing the newcomer here is what keeps the port
					// from leaking into an orphaned socket.io server.
					bridge.dispose()
					outputChannel.appendLine("[openInBrowser] The host was disposed while the bridge was starting.")
					return
				}

				// Irreversible switch: from now on the provider posts to the
				// virtual webview (socket.io) and the real iframe renders a
				// placeholder with a clickable link to the browser tab.
				BrowserBridgeServer.bind(host, bridge)

				// bind() disposes a newcomer that lost a race; open the authoritative bridge.
				const active = BrowserBridgeServer.bridges.get(host) ?? bridge
				await vscode.env.openExternal(vscode.Uri.parse(active.getBrowserUrl()))
			}),
		)
	}

	// ---- provider-facing statics ----

	/**
	 * Puts `host` into browser mode: start-if-needed + one-bridge-per-host
	 * guard + virtual webview + listener wiring + placeholder refresh. Bridge
	 * startup is asynchronous; a disposeFor racing the start disposes the
	 * late bridge instead of binding it to a released host (see
	 * {@link BrowserBridgeServer.lifecycleEpoch}). Callers that need the
	 * port/URL (e.g. the `openInBrowser` command) go through
	 * {@link registerCommand}'s handler.
	 */
	static enable(host: BridgeHost, listen?: (webview: Webview) => void): void {
		if (BrowserBridgeServer.bridges.has(host)) {
			return
		}
		const epoch = BrowserBridgeServer.lifecycleEpoch.get(host) ?? 0
		void BrowserBridgeServer.start()
			.then((bridge) => {
				if (!bridge) {
					return
				}
				if ((BrowserBridgeServer.lifecycleEpoch.get(host) ?? 0) !== epoch) {
					bridge.dispose()
					return
				}
				BrowserBridgeServer.bind(host, bridge, listen)
			})
			.catch((error: unknown) => {
				console.error("[BrowserBridge] Failed to start:", error)
			})
	}

	/** True while `host` has an active bridge — the only query callers need. */
	static active(host: BridgeHost): boolean {
		return BrowserBridgeServer.bridges.has(host)
	}

	/**
	 * Renders the bridge placeholder into the host's already-resolved real
	 * webview (no-op while the view is not resolved or no bridge is active).
	 */
	static setPlaceholder(host: BridgeHost): void {
		const bridge = BrowserBridgeServer.bridges.get(host)
		const view = (host as BridgeHostInternals).view
		if (bridge && view) {
			view.webview.html = bridge.getPlaceholderHtml()
		}
	}

	/** The virtual webview when a bridge is active, `undefined` otherwise. */
	static webviewFor(host: BridgeHost): Webview | undefined {
		return BrowserBridgeServer.bridges.get(host)?.getOrCreateVirtualWebview()
	}

	/** Closes the socket.io server and drops the WeakMap entry for `host`. */
	static disposeFor(host: BridgeHost): void {
		// Bump the lifecycle epoch so any start still in flight disposes its
		// bridge rather than binding it to this now-released host.
		BrowserBridgeServer.lifecycleEpoch.set(host, (BrowserBridgeServer.lifecycleEpoch.get(host) ?? 0) + 1)
		const bridge = BrowserBridgeServer.bridges.get(host)
		if (bridge) {
			bridge.dispose()
			BrowserBridgeServer.bridges.delete(host)
		}
	}

	// ---- private internals ----

	private readonly server: SocketIoServer
	private readonly _port: number

	private readonly webviewMessageListeners = new Set<(message: WebviewMessage) => void>()

	/**
	 * The host's message-handler subscription for the virtual webview, set by
	 * {@link BrowserBridgeServer.bind}. Bridge-owned: it survives sidebar
	 * dispose/re-resolve and is released only when the bridge itself is
	 * disposed ({@link dispose}).
	 */
	private messageListener: Disposable | undefined

	private virtualWebview: Webview | undefined

	private constructor(
		server: SocketIoServer,
		port: number,
		private readonly token: string,
	) {
		this.server = server
		this._port = port

		// Every accepted socket reaches the provider's webviewMessageHandler,
		// so a fresh connection must present this bridge's handshake token.
		// Without it any local process that finds the port could create tasks,
		// change settings, and run approved commands.
		server.use((socket, next) => {
			const presented = socket.handshake.auth?.token
			const expected = Buffer.from(token)
			const actual = typeof presented === "string" ? Buffer.from(presented) : undefined

			if (actual !== undefined && actual.length === expected.length && timingSafeEqual(actual, expected)) {
				next()
			} else {
				// The client matches on this exact message (shared constant) to
				// tell a token rejection apart from transient connect errors.
				next(new Error(BROWSER_BRIDGE_UNAUTHORIZED_MESSAGE))
			}
		})

		// In socket.io v4 client-emitted events arrive on the individual
		// socket, not on the Server instance: forward each socket's
		// "webviewMessage" events to the onWebviewMessage() subscribers.
		server.on("connection", (socket: Socket) => {
			socket.on("webviewMessage", (message: WebviewMessage) => {
				for (const listener of this.webviewMessageListeners) {
					listener(message)
				}
			})
		})
	}

	/**
	 * URL a browser tab must load to connect to the bridge listening on
	 * `port` (the Vite dev server plus the `?bridgePort` and `?bridgeToken`
	 * query parameters — the token authenticates the socket.io handshake).
	 */
	static getBrowserUrl(port: number, token: string): string {
		return `${getViteBaseUrl()}/?bridgePort=${port}&bridgeToken=${token}`
	}

	/**
	 * Attaches `bridge` to `host` under the one-bridge-per-host rule: a
	 * rejected newcomer (e.g. a second enable racing the first) disposes
	 * itself instead of overwriting the active bridge.
	 */
	private static bind(host: BridgeHost, bridge: BrowserBridgeServer, listen?: (webview: Webview) => void): void {
		if (BrowserBridgeServer.bridges.has(host)) {
			bridge.dispose()
			return
		}
		BrowserBridgeServer.bridges.set(host, bridge)

		const webview = bridge.getOrCreateVirtualWebview()
		if (listen) {
			listen(webview)
		} else {
			// Element-access call into the provider's private wiring (see
			// BridgeHostInternals) — keeps ClineProvider's public API clean.
			// The returned disposable is kept on the bridge, deliberately not
			// on the host's per-sidebar `webviewDisposables`.
			const internals = host as BridgeHostInternals
			bridge.messageListener = internals.attachWebviewMessageListener(webview)
		}

		BrowserBridgeServer.setPlaceholder(host)
	}

	/**
	 * Placeholder rendered inside the real VSCode webview when the browser
	 * bridge is active. The UI lives only in Chrome; this keeps the iframe
	 * empty (no React, no scripts), while native VSCode webview chrome
	 * (tab/sidebar shell) stays. The message tells the developer the tab
	 * cannot be restored and links back to the browser tab so it can be
	 * reopened by clicking.
	 */
	private getPlaceholderHtml(): string {
		const url = this.getBrowserUrl()
		return /*html*/ `<!DOCTYPE html>
<html lang="en">
	<head>
		<meta charset="utf-8">
		<title>Zoo Code</title>
	</head>
	<body style="margin: 0; padding: 0; background: transparent">
		<main style="display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; padding: 24px 16px; font-family: var(--vscode-font-family, sans-serif); font-size: var(--vscode-font-size, 13px); color: var(--vscode-foreground, #cccccc); text-align: center">
			<p style="margin: 0">
				You have started browser mode. The Zoo Code UI now runs in a
				Chrome tab connected via the browser bridge, and this tab
				cannot be restored.
			</p>
			<p style="margin: 0">
				<a href="${url}" target="_blank" rel="noopener noreferrer" style="color: var(--vscode-textLink-foreground, #3794ff)">${url}</a>
			</p>
		</main>
	</body>
</html>`
	}

	/** The URL a browser tab must load to connect to this bridge. */
	private getBrowserUrl(): string {
		return BrowserBridgeServer.getBrowserUrl(this._port, this.token)
	}

	/**
	 * Starts the bridge server on {@link getBrowserBridgePort}. Returns
	 * undefined when the port is already taken (only possible with an explicit
	 * `ROO_BROWSER_BRIDGE_PORT`, e.g. a second dev host).
	 *
	 * `onError` (when provided) is invoked with the failure so callers can
	 * surface it to the user (e.g. `vscode.window.showErrorMessage`) instead
	 * of only writing to a log.
	 */
	private static async start(
		log: (message: string) => void = console.log,
		onError?: (error: Error) => void,
	): Promise<BrowserBridgeServer | undefined> {
		const requestedPort = getBrowserBridgePort()

		// Lazy import keeps socket.io off the eager module graph: the only
		// reachable caller is the dev-only command path (plus tests), so the
		// production bundle (where socket.io is externalized) ships none of it.
		const { Server: SocketIoServerClass } = await import("socket.io")

		// Create the http server explicitly (the socket.io Server constructor
		// with options alone does not own one) and let socket.io take over its
		// lifecycle.
		const httpServer = createServer()
		const server = new SocketIoServerClass(httpServer, {
			// Development-only transport: bind loopback and allow local origins only.
			cors: {
				origin: [getLocalOrigin()],
			},
			// CORS alone does not gate the WebSocket upgrade, so re-check the
			// handshake Origin server-side (see isAllowedHandshakeOrigin).
			allowRequest: (request, callback) => {
				if (isAllowedHandshakeOrigin(request.headers.origin)) {
					callback(null, true)
				} else {
					callback("The browser bridge only accepts local origins.", false)
				}
			},
			transports: ["websocket", "polling"],
			// Webview messages carry base64 images (maxImageFileSize defaults to 5 MB);
			// the 1 MB socket.io default would drop them and disconnect the tab.
			maxHttpBufferSize: 100 * 1024 * 1024,
		})

		try {
			await new Promise<void>((resolve, reject) => {
				httpServer.once("error", reject)
				httpServer.listen({ port: requestedPort, host: "127.0.0.1" }, () => {
					// Stryker disable next-line StringLiteral: a settled promise ignores extra rejects; the listener is only removed to avoid a latent leak (unobservable in-process)
					httpServer.off("error", reject)
					resolve()
				})
			})
		} catch (error) {
			const failure = error instanceof Error ? error : new Error(String(error))
			log(`[BrowserBridge] Failed to start on 127.0.0.1:${requestedPort} -> ${failure.message}`)
			onError?.(failure)
			await new Promise<void>((resolve) => void server.close(() => resolve()))
			return undefined
		}

		const port = getBoundPort(httpServer, requestedPort)
		log(`[BrowserBridge] Listening on ws://127.0.0.1:${port}`)
		const token = randomBytes(16).toString("hex")

		return new BrowserBridgeServer(server, port, token)
	}

	/**
	 * The single virtual webview for this bridge. Reused across webview
	 * re-resolves so bridge-level listeners are registered exactly once.
	 */
	private getOrCreateVirtualWebview(): Webview {
		if (!this.virtualWebview) {
			this.virtualWebview = BrowserBridgeServer.createVirtualWebview(this)
		}
		return this.virtualWebview
	}

	/**
	 * Broadcasts an extension->webview message to all connected browser clients.
	 */
	private broadcast(message: ExtensionMessage): void {
		this.server.emit("extensionMessage", message)
	}

	/**
	 * Subscribes to webview->extension messages coming from browser clients.
	 * Returns a dispose function.
	 */
	private onWebviewMessage(listener: (message: WebviewMessage) => void): Disposable {
		this.webviewMessageListeners.add(listener)
		return {
			dispose: () => {
				this.webviewMessageListeners.delete(listener)
			},
		}
	}

	private dispose(): void {
		this.messageListener?.dispose()
		try {
			void this.server.close()
		} catch {
			// Already closed
		}
	}

	/**
	 * A virtual `vscode.Webview` implementation backed by the browser bridge.
	 *
	 * Mirrors the CLI mock-webview pattern: `postMessage` broadcasts to the
	 * browser, `onDidReceiveMessage` forwards browser messages to the
	 * provider. The real iframe webview is intentionally not used — the UI
	 * runs only in Chrome.
	 */
	private static createVirtualWebview(bridge: BrowserBridgeServer): Webview {
		const messageListeners = new Set<(message: WebviewMessage) => void>()

		bridge.onWebviewMessage((message) => {
			for (const listener of messageListeners) {
				listener(message)
			}
		})

		return {
			options: { enableScripts: true },
			cspSource: "vscode-webview://bridge",
			html: "",
			postMessage(message: unknown): Thenable<boolean> {
				bridge.broadcast(message as ExtensionMessage)
				return Promise.resolve(true)
			},
			onDidReceiveMessage(listener: (message: unknown) => void): Disposable {
				const wrapped = listener as (message: WebviewMessage) => void
				messageListeners.add(wrapped)
				return {
					dispose: () => {
						messageListeners.delete(wrapped)
					},
				}
			},
			asWebviewUri(localResource: vscode.Uri): vscode.Uri {
				// The browser UI never renders webview URIs; return the input unchanged.
				return localResource
			},
		}
	}
}
