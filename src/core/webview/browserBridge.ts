import { createServer } from "http"

import type { Server as SocketIoServer, Socket } from "socket.io"
import * as vscode from "vscode"
import type { Disposable, Webview } from "vscode"

import type { ExtensionMessage, WebviewMessage } from "@roo-code/types"

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
 */

export const DEFAULT_BROWSER_BRIDGE_PORT = 0

/**
 * Base URL of the webview-ui Vite dev server. It always runs on a fixed port
 * (see webview-ui/vite.config.ts); if it's not up, the browser tab simply
 * shows a connection error — good enough for a dev-only tool.
 */
const VITE_BASE_URL = "http://localhost:5173"

/**
 * The port the bridge binds to. Defaults to `0` (let the OS pick a free port)
 * so every provider gets a unique port. `ROO_BROWSER_BRIDGE_PORT` can still
 * override this for parallel dev hosts that need a fixed, known port.
 */
export function getBrowserBridgePort(): number {
	const raw = process.env.ROO_BROWSER_BRIDGE_PORT
	if (raw === undefined || raw === "") {
		return DEFAULT_BROWSER_BRIDGE_PORT
	}
	const port = Number(raw)
	return Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_BROWSER_BRIDGE_PORT
}

/**
 * Resolves the port a bound http server is actually listening on. When
 * `port: 0` was requested, the OS picks a free port and reports it back here.
 */
function getBoundPort(httpServer: SocketIoServer["httpServer"], requestedPort: number): number {
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
 * The two provider internals the bridge needs: the currently resolved real
 * webview (to render the browser-mode placeholder into) and the private
 * webview-message wiring entry point. Both are private on ClineProvider, so
 * the bridge reaches them through element access via this local view rather
 * than expanding the provider's public API with bridge-specific members.
 */
interface BridgeHostInternals {
	view?: vscode.WebviewView | vscode.WebviewPanel
	setWebviewMessageListener(webview: Webview): void
}

/**
 * Server side of the bridge. Binds to 127.0.0.1 only and restricts CORS to
 * local origins, since this is a development-only transport.
 */
export class BrowserBridgeServer {
	/**
	 * Per-host bridge registry. One host (provider) -> one bridge -> one port,
	 * permanently, until {@link BrowserBridgeServer.disposeFor} runs.
	 */
	private static readonly bridges = new WeakMap<BridgeHost, BrowserBridgeServer>()

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
					await vscode.env.openExternal(vscode.Uri.parse(BrowserBridgeServer.getBrowserUrl(existing._port)))
					return
				}

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

				// Irreversible switch: from now on the provider posts to the
				// virtual webview (socket.io) and the real iframe renders a
				// placeholder with a clickable link to the browser tab.
				BrowserBridgeServer.bind(host, bridge)

				await vscode.env.openExternal(vscode.Uri.parse(bridge.getBrowserUrl()))
			}),
		)
	}

	// ---- provider-facing statics ----

	/**
	 * Puts `host` into browser mode: start-if-needed + one-bridge-per-host
	 * guard + virtual webview + listener wiring + placeholder refresh. Bridge
	 * startup is asynchronous; callers that need the port/URL (e.g. the
	 * `openInBrowser` command) go through {@link registerCommand}'s handler.
	 */
	static enable(host: BridgeHost, listen?: (webview: Webview) => void): void {
		if (BrowserBridgeServer.bridges.has(host)) {
			return
		}
		void BrowserBridgeServer.start().then((bridge) => {
			if (bridge) {
				BrowserBridgeServer.bind(host, bridge, listen)
			}
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

	private virtualWebview: Webview | undefined

	private constructor(server: SocketIoServer, port: number) {
		this.server = server
		this._port = port

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
	 * `port` (the Vite dev server plus the `?bridgePort` query parameter).
	 */
	static getBrowserUrl(port: number): string {
		return `${VITE_BASE_URL}/?bridgePort=${port}`
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
			const internals = host as BridgeHostInternals
			internals.setWebviewMessageListener(webview)
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
		return BrowserBridgeServer.getBrowserUrl(this._port)
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
				origin: [/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/],
			},
			transports: ["websocket", "polling"],
		})

		try {
			await new Promise<void>((resolve, reject) => {
				httpServer.once("error", reject)
				httpServer.listen({ port: requestedPort, host: "127.0.0.1" }, () => {
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
		return new BrowserBridgeServer(server, port)
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
