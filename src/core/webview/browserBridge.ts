import { createServer } from "http"

import { Server as SocketIoServer, type Socket } from "socket.io"
import { Uri } from "vscode"
import type { Disposable, Webview } from "vscode"

import type { ExtensionMessage, WebviewMessage } from "@roo-code/types"

/**
 * Browser bridge — standalone-browser UI transport for the Zoo Code webview
 * (development-only tooling for analyzing render issues with full
 * React DevTools / Chrome DevTools support).
 *
 * Each `ClineProvider` owns exactly one {@link BrowserBridgeServer} instance.
 * The bridge is started on demand from the dev-only `zoo-code.openInBrowser`
 * command, which is registered only when `ROO_BROWSER_BRIDGE=1` is set in a
 * Development extension host (see `registerCommands.ts`); it is not
 * contributed in package.json. Once started, the extension host serves a
 * socket.io server on `127.0.0.1:<port>` and swaps the real VSCode webview for
 * a virtual one ({@link createVirtualWebview}). The UI then lives entirely in a
 * normal Chrome tab (loaded from the Vite dev server) instead of the VSCode
 * webview iframe, while the message protocol (`WebviewMessage` /
 * `ExtensionMessage`) stays unchanged.
 *
 * Ports are unique per bridge: the OS assigns a free port unless
 * `ROO_BROWSER_BRIDGE_PORT` is set (a dev-only override). The actual port is
 * exposed via {@link BrowserBridgeServer.port} and passed to the browser tab
 * as a `?bridgePort=<port>` URL query parameter, so any number of Zoo Code
 * tabs or sidebar panels can run in the browser simultaneously, each on its
 * own port.
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
 * Server side of the bridge. Binds to 127.0.0.1 only and restricts CORS to
 * local origins, since this is a development-only transport.
 */
export class BrowserBridgeServer implements Disposable {
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

	/** The TCP port this bridge is listening on. */
	get port(): number {
		return this._port
	}

	/**
	 * URL a browser tab must load to connect to the bridge listening on
	 * `port` (the Vite dev server plus the `?bridgePort` query parameter).
	 */
	static getBrowserUrl(port: number): string {
		return `${VITE_BASE_URL}/?bridgePort=${port}`
	}

	/**
	 * URL a browser tab must load to connect to this bridge.
	 */
	getBrowserUrl(): string {
		return BrowserBridgeServer.getBrowserUrl(this._port)
	}

	/**
	 * Placeholder rendered inside the real VSCode webview when the browser
	 * bridge is active. The UI lives only in Chrome; this keeps the iframe
	 * empty (no React, no scripts), while native VSCode webview chrome
	 * (tab/sidebar shell) stays. The message tells the developer the tab
	 * cannot be restored and links back to the browser tab so it can be
	 * reopened by clicking.
	 */
	getPlaceholderHtml(): string {
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

	/**
	 * Starts the bridge server on {@link getBrowserBridgePort}. Returns
	 * undefined when the port is already taken (only possible with an explicit
	 * `ROO_BROWSER_BRIDGE_PORT`, e.g. a second dev host).
	 *
	 * `onError` (when provided) is invoked with the failure so callers can
	 * surface it to the user (e.g. `vscode.window.showErrorMessage`) instead
	 * of only writing to a log.
	 */
	static async start(
		log: (message: string) => void = console.log,
		onError?: (error: Error) => void,
	): Promise<BrowserBridgeServer | undefined> {
		const requestedPort = getBrowserBridgePort()

		// Create the http server explicitly (the socket.io Server constructor
		// with options alone does not own one) and let socket.io take over its
		// lifecycle.
		const httpServer = createServer()
		const server = new SocketIoServer(httpServer, {
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
	getOrCreateVirtualWebview(): Webview {
		if (!this.virtualWebview) {
			this.virtualWebview = createVirtualWebview(this)
		}
		return this.virtualWebview
	}

	/**
	 * Broadcasts an extension->webview message to all connected browser clients.
	 */
	broadcast(message: ExtensionMessage): void {
		this.server.emit("extensionMessage", message)
	}

	/**
	 * Subscribes to webview->extension messages coming from browser clients.
	 * Returns a dispose function.
	 */
	onWebviewMessage(listener: (message: WebviewMessage) => void): Disposable {
		this.webviewMessageListeners.add(listener)
		return {
			dispose: () => {
				this.webviewMessageListeners.delete(listener)
			},
		}
	}

	dispose(): void {
		try {
			void this.server.close()
		} catch {
			// Already closed
		}
	}
}

/**
 * A virtual `vscode.Webview` implementation backed by the browser bridge.
 *
 * Mirrors the CLI mock-webview pattern: `postMessage` broadcasts to the browser,
 * `onDidReceiveMessage` forwards browser messages to the provider. The real
 * iframe webview is intentionally not used — the UI runs only in Chrome.
 */
export function createVirtualWebview(bridge: BrowserBridgeServer): Webview {
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
		asWebviewUri(localResource: Uri): Uri {
			// The browser UI never renders webview URIs; return the input unchanged.
			return localResource
		},
	}
}
