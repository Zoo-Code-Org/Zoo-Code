import { WebviewMessage } from "@roo/WebviewMessage"

/**
 * Browser bridge — client side of the standalone-browser UI transport.
 *
 * Mirrors the server-side design (`src/core/webview/browserBridge.ts`): one
 * self-contained class exposing verbose statics that own all bridge state
 * internally and self-gate their own enablement. `VSCodeAPIWrapper` keeps no
 * bridge fields — it only calls {@link BrowserBridgeClient.maybeConnect},
 * {@link BrowserBridgeClient.active}, and {@link BrowserBridgeClient.postMessage}.
 *
 * When the UI runs in a normal Chrome tab (loaded from the Vite dev server),
 * `acquireVsCodeApi` is undefined. Messages then flow over socket.io to the
 * extension host instead of the VSCode webview message protocol:
 *
 *  - `postMessage(message)` emits `webviewMessage` to the bridge server
 *  - inbound `extensionMessage` events are re-dispatched through
 *    `window.postMessage` so the existing `window.addEventListener("message")`
 *    consumers in the app work unchanged.
 *
 * Production bundle isolation: the first thing `maybeConnect` does is return
 * when `import.meta.env.DEV` is false. Vite replaces that with a literal
 * `false` at build time, so the entire remainder of the body — including the
 * dynamic `import("socket.io-client")` and the browser-mode CSS import — is
 * dead code the bundler strips, and neither ever lands in the shipped assets.
 */

/**
 * The bridge port is served as a `?bridgePort=<port>` query parameter on the
 * URL opened in Chrome by the "Open in Chrome" command. Its presence tells the
 * UI that the browser bridge is active — there is no env-var or build-time
 * flag involved. Returns `undefined` when the param is absent.
 */
function getBridgePortFromUrl(): number | undefined {
	const raw = new URLSearchParams(window.location.search).get("bridgePort")
	if (raw !== null && raw !== "") {
		const port = Number(raw)
		if (Number.isInteger(port) && port > 0 && port < 65536) {
			return port
		}
	}
	return undefined
}

type BridgeSocket = {
	on(event: string, listener: (...args: any[]) => void): void
	emit(event: string, ...args: any[]): void
	disconnect(): void
}

export class BrowserBridgeClient {
	private static instance: BrowserBridgeClient | undefined
	private static queue: WebviewMessage[] = []

	private socket: BridgeSocket | undefined

	private constructor(port: number) {
		void this.connect(port)
	}

	private async connect(port: number): Promise<void> {
		// The only socket.io-client reference in the whole webview bundle, and
		// it is reachable only from dev builds (see the class doc comment).
		const { io } = await import("socket.io-client")

		// Mark the document so CSS can provide a dark-theme fallback for the
		// --vscode-* variables that VS Code normally injects into the webview.
		document.documentElement.classList.add("roo-browser-mode")
		// Browser-mode styles are shipped as a separate chunk that production
		// builds never emit (unreachable from dead code above).
		await import("../browserBridge.css")

		const socket: BridgeSocket = io(`http://127.0.0.1:${port}`, {
			transports: ["websocket", "polling"],
		})
		this.socket = socket

		socket.on("connect", () => {
			const pending = BrowserBridgeClient.queue
			BrowserBridgeClient.queue = []
			for (const message of pending) {
				socket.emit("webviewMessage", message)
			}
		})

		socket.on("extensionMessage", (message: unknown) => {
			window.postMessage(message, "*")
		})

		socket.on("connect_error", (error: unknown) => {
			console.warn("[BrowserBridge] socket.io connect error:", error)
		})
	}

	/**
	 * Connects to the bridge when (and only when) this tab was opened by the
	 * dev-only "Open in Chrome" command. Self-gating, in this order:
	 *
	 *  1. production build (`import.meta.env.DEV === false`) → return; dead-code
	 *     elimination strips everything below from the shipped bundle
	 *  2. no `?bridgePort=` param → return (plain dev-server tab keeps the
	 *     localStorage-only fallback behavior)
	 *  3. lazy-load socket.io-client, apply browser-mode CSS, connect, and
	 *     flush any queued messages
	 */
	static maybeConnect(): void {
		if (!import.meta.env.DEV) {
			return
		}
		if (BrowserBridgeClient.instance) {
			return
		}
		const port = getBridgePortFromUrl()
		if (port === undefined) {
			return
		}
		BrowserBridgeClient.instance = new BrowserBridgeClient(port)
	}

	/** True while the bridge client exists (connecting or connected). */
	static active(): boolean {
		if (!import.meta.env.DEV) {
			return false
		}
		return BrowserBridgeClient.instance !== undefined
	}

	/**
	 * Sends a webview->extension message over the bridge. Queues while the
	 * socket is still connecting so early app messages are not lost.
	 */
	static postMessage(message: WebviewMessage): void {
		const instance = BrowserBridgeClient.instance
		if (!instance) {
			return
		}
		if (instance.socket) {
			instance.socket.emit("webviewMessage", message)
		} else {
			BrowserBridgeClient.queue.push(message)
		}
	}

	/** Test seam: tear the singleton down (not part of the app lifecycle). */
	static resetForTests(): void {
		BrowserBridgeClient.instance?.socket?.disconnect()
		BrowserBridgeClient.instance = undefined
		BrowserBridgeClient.queue = []
	}
}
