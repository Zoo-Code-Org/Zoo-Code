import type { Socket } from "socket.io-client"

import { WebviewMessage } from "@roo/WebviewMessage"
import { BROWSER_BRIDGE_UNAUTHORIZED_MESSAGE } from "@roo/browserBridge"

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
 * Production bundle isolation works on two levels: every call site in
 * `vscode.ts` is wrapped in `import.meta.env.DEV &&`, which Vite replaces with
 * a literal `false` at build time, so this class becomes unreachable and the
 * bundler tree-shakes it entirely (dynamic `import("socket.io-client")` and
 * the browser-mode CSS import never land in the shipped assets). As defense in
 * depth, `maybeConnect`/`active` also self-gate on `import.meta.env.DEV`.
 */

/**
 * The bridge port is served as a `?bridgePort=<port>` query parameter on the
 * URL opened in Chrome by the "Open in Chrome" command. Its presence tells the
 * UI that the browser bridge is active — there is no env-var or build-time
 * flag involved. Returns `undefined` when the param is absent.
 */
function getBridgePortFromUrl(): number | undefined {
	const raw = new URLSearchParams(window.location.search).get("bridgePort")
	// Stryker disable next-line ConditionalExpression,LogicalOperator,StringLiteral: "" and null both fall through Number()/the port>0 bound check to the same undefined result (equivalent mutants)
	if (raw !== null && raw !== "") {
		const port = Number(raw)
		if (Number.isInteger(port) && port > 0 && port < 65536) {
			return port
		}
	}
	return undefined
}

/**
 * The per-bridge handshake token is served as a `?bridgeToken=<token>` query
 * parameter next to the port. The bridge server rejects every socket whose
 * handshake auth token does not match, so without it the tab could not
 * connect anyway — an absent (or empty) token keeps the client inert, exactly
 * like an absent port.
 */
function getBridgeTokenFromUrl(): string | undefined {
	const raw = new URLSearchParams(window.location.search).get("bridgeToken")
	// Stryker disable next-line ConditionalExpression,LogicalOperator,StringLiteral: "" and null both fall through to the same undefined result (equivalent mutants)
	return raw !== null && raw !== "" ? raw : undefined
}

// The subset of the socket.io client surface the bridge uses. Type-only
// import above, so this adds no runtime dependency to the bundle.
type BridgeSocket = Pick<Socket, "on" | "emit" | "disconnect">

export class BrowserBridgeClient {
	private static instance: BrowserBridgeClient | undefined
	private static queue: WebviewMessage[] = []
	private status: "init" | "connected" | "retry" | "disposed" = "init"
	private initProcess: Promise<void> | null = null

	private socket: BridgeSocket | undefined

	private constructor(port: number, token: string) {
		this.initProcess = this.connect(port, token).catch((error: unknown) => {
			// Initialization can fail before the socket exists (the lazy
			// socket.io-client or browser-mode CSS import rejecting). A dead
			// singleton must not keep claiming `active()` or hoard the queue
			// for a later, unrelated client — tear this one down.
			console.error("[BrowserBridge] Failed to initialize the browser bridge:", error)
			this.dispose()
		})
	}

	private dispose() {
		this.socket?.disconnect()
		this.socket = undefined
		// connect() marks the document before the CSS import and the socket
		// setup, so a bridge that dies after marking it (initialization
		// failure, test reset) must un-mark it: an inactive tab has no
		// business keeping browser-bridge styling.
		document.documentElement.classList.remove("roo-browser-mode")
		if (BrowserBridgeClient.instance === this) {
			BrowserBridgeClient.instance = undefined
			// Stryker disable next-line ArrayDeclaration: the queue reset only matters for a future instance, which no test can observe through the old array reference
			BrowserBridgeClient.queue = []
		}
		this.status = "disposed"
	}

	private async connect(port: number, token: string): Promise<void> {
		// The only socket.io-client reference in the whole webview bundle, and
		// it is reachable only from dev builds (see the class doc comment).
		const { io } = await import("socket.io-client")

		// Mark the document so CSS can provide a dark-theme fallback for the
		// --vscode-* variables that VS Code normally injects into the webview.
		document.documentElement.classList.add("roo-browser-mode")
		// Browser-mode styles are shipped as a separate chunk that production
		// builds never emit (unreachable from dead code above).
		await import("../browserBridge.css")

		// The token authenticates the handshake against the bridge server's
		// `server.use` middleware; a socket without the right token is
		// rejected before any message can reach the provider.
		const socket: BridgeSocket = io(`http://127.0.0.1:${port}`, {
			auth: { token },
			transports: ["polling", "websocket"],
		})
		this.socket = socket

		// Drain the queue synchronously at socket creation, not from a
		// "connect" listener: socket.io buffers pre-connect emits in a FIFO
		// sendBuffer and flushes it *before* the "connect" event fires, so a
		// drain inside the listener would send queued messages after any
		// message posted while connecting (a real reordering of the wire).
		for (const message of BrowserBridgeClient.queue.splice(0)) {
			socket.emit("webviewMessage", message)
		}

		socket.on("extensionMessage", (message: unknown) => {
			window.postMessage(message, "*")
		})

		socket.on("connect_error", (error: unknown) => {
			// The bridge server rejects a bad/expired handshake token via its
			// `server.use` middleware, and socket.io does NOT retry such a
			// rejection. Keeping the singleton alive would leave `active()`
			// true, so every later `postMessage` would go into a socket buffer
			// that can never deliver — a silently dead tab. Treat the
			// rejection as fatal and tear the bridge down instead (the user
			// recovers by re-running "Open in Chrome", which hands out a fresh
			// token).
			if (error instanceof Error && error.message === BROWSER_BRIDGE_UNAUTHORIZED_MESSAGE) {
				console.error("[BrowserBridge] The bridge server rejected the handshake token; deactivating.")
				this.dispose()
				return
			}
			console.warn("[BrowserBridge] socket.io connect error:", error)
			this.status = "retry"
		})

		socket.on("connect", () => {
			this.status = "connected"
		})
	}

	/**
	 * Connects to the bridge when (and only when) this tab was opened by the
	 * dev-only "Open in Chrome" command. Self-gating, in this order:
	 *
	 *  1. production build (`import.meta.env.DEV === false`) → return; dead-code
	 *     elimination strips everything below from the shipped bundle
	 *  2. no `?bridgePort=`/`?bridgeToken=` param → return (plain dev-server tab
	 *     keeps the localStorage-only fallback behavior; a port without its
	 *     token could never complete the authenticated handshake)
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
		const token = getBridgeTokenFromUrl()
		if (port === undefined || token === undefined) {
			return
		}
		BrowserBridgeClient.instance = new BrowserBridgeClient(port, token)
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
	static async resetForTests(): Promise<void> {
		if (BrowserBridgeClient.instance?.status === "init") {
			await BrowserBridgeClient.instance.initProcess
		}

		BrowserBridgeClient.instance?.dispose()
		BrowserBridgeClient.queue = []
	}
}
