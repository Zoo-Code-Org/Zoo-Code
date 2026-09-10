import type { WebviewApi } from "vscode-webview"
import { io, type Socket } from "socket.io-client"

import { WebviewMessage } from "@roo/WebviewMessage"

/**
 * Browser bridge transport for standalone (non-webview) browser mode.
 *
 * When the UI runs in a normal Chrome tab (loaded from the Vite dev server),
 * `acquireVsCodeApi` is undefined. Messages then flow over socket.io to the
 * extension host instead of the VSCode webview message protocol:
 *
 *  - `postMessage(message)` emits `webviewMessage` to the bridge server
 *  - inbound `extensionMessage` events are re-dispatched through
 *    `window.postMessage` so the existing `window.addEventListener("message")`
 *    consumers in the app work unchanged.
 */
class BrowserBridgeClient {
	private readonly socket: Socket

	constructor(port: number) {
		this.socket = io(`http://127.0.0.1:${port}`, {
			transports: ["websocket", "polling"],
		})

		// Mark the document so CSS can provide a dark-theme fallback for the
		// --vscode-* variables that VS Code normally injects into the webview.
		document.documentElement.classList.add("roo-browser-mode")

		this.socket.on("extensionMessage", (message: unknown) => {
			window.postMessage(message, "*")
		})

		this.socket.on("connect_error", (error) => {
			console.warn("[BrowserBridge] socket.io connect error:", error)
		})
	}

	public postMessage(message: WebviewMessage) {
		this.socket.emit("webviewMessage", message)
	}

	public dispose() {
		this.socket.disconnect()
	}
}

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

/**
 * A utility wrapper around the acquireVsCodeApi() function, which enables
 * message passing and state management between the webview and extension
 * contexts.
 *
 * This utility also enables webview code to be run in a web browser-based
 * dev server by using native web browser features that mock the functionality
 * enabled by acquireVsCodeApi.
 */
class VSCodeAPIWrapper {
	private readonly vsCodeApi: WebviewApi<unknown> | undefined
	private readonly browserBridge: BrowserBridgeClient | undefined

	constructor() {
		// Check if the acquireVsCodeApi function exists in the current development
		// context (i.e. VS Code development window or web browser)
		if (typeof acquireVsCodeApi === "function") {
			this.vsCodeApi = acquireVsCodeApi()
		} else {
			// Use the browser bridge only when the "Open in Chrome" flow opened
			// this tab with a ?bridgePort=... query param. Otherwise (e.g. a
			// plain dev-server tab) fall back to localStorage-only behavior.
			const bridgePort = getBridgePortFromUrl()
			if (bridgePort !== undefined) {
				this.browserBridge = new BrowserBridgeClient(bridgePort)
			}
		}
	}

	/**
	 * Post a message (i.e. send arbitrary data) to the owner of the webview.
	 *
	 * @remarks When running webview code inside a web browser, postMessage will instead
	 * send the message over the browser bridge (socket.io) to the extension host.
	 *
	 * @param message Arbitrary data (must be JSON serializable) to send to the extension context.
	 */
	public postMessage(message: WebviewMessage) {
		if (this.vsCodeApi) {
			this.vsCodeApi.postMessage(message)
		} else if (this.browserBridge) {
			this.browserBridge.postMessage(message)
		} else {
			console.log(message)
		}
	}

	/**
	 * Get the persistent state stored for this webview.
	 *
	 * @remarks When running webview source code inside a web browser, getState will retrieve state
	 * from local storage (https://developer.mozilla.org/en-US/docs/Web/API/Window/localStorage).
	 *
	 * @return The current state or `undefined` if no state has been set.
	 */
	public getState(): unknown | undefined {
		if (this.vsCodeApi) {
			return this.vsCodeApi.getState()
		} else {
			const state = localStorage.getItem("vscodeState")
			return state ? JSON.parse(state) : undefined
		}
	}

	/**
	 * Set the persistent state stored for this webview.
	 *
	 * @remarks When running webview source code inside a web browser, setState will set the given
	 * state using local storage (https://developer.mozilla.org/en-US/docs/Web/API/Window/localStorage).
	 *
	 * @param newState New persisted state. This must be a JSON serializable object. Can be retrieved
	 * using {@link getState}.
	 *
	 * @return The new state.
	 */
	public setState<T extends unknown | undefined>(newState: T): T {
		if (this.vsCodeApi) {
			return this.vsCodeApi.setState(newState)
		} else {
			localStorage.setItem("vscodeState", JSON.stringify(newState))
			return newState
		}
	}
}

// Exports class singleton to prevent multiple invocations of acquireVsCodeApi.
export const vscode = new VSCodeAPIWrapper()
