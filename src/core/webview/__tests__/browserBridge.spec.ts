// npx vitest run core/webview/__tests__/browserBridge.spec.ts
//
// BrowserBridgeServer / createVirtualWebview round-trip tests.
//
// These spin up a real socket.io server on an ephemeral port and connect with
// socket.io-client, exactly like the webview-ui BrowserBridgeClient does, so a
// regression in the socket.io v4 wiring (client events arrive on the socket,
// not the Server) is caught here.

import { io, type Socket } from "socket.io-client"

import type { ExtensionMessage, WebviewMessage } from "@roo-code/types"

import { allowNetConnect } from "../../../vitest.setup"
import { BrowserBridgeServer, getBrowserBridgePort } from "../browserBridge"

// vitest.setup.ts disables real network requests via nock by default. The
// bridge tests connect a real socket.io client to a loopback server, so allow
// net connect for 127.0.0.1 (both the websocket upgrade and the polling
// transport use the same host).
allowNetConnect(/^127\.0\.0\.1(?::\d+)?$/)

function connectToBridge(port: number): Promise<Socket> {
	return new Promise((resolve, reject) => {
		const socket = io(`http://127.0.0.1:${port}`, {
			transports: ["websocket", "polling"],
			reconnection: false,
			timeout: 5_000,
		})
		socket.once("connect", () => resolve(socket))
		socket.once("connect_error", (error) => {
			socket.disconnect()
			reject(error)
		})
	})
}

function waitFor<T>(predicate: () => T | undefined, timeoutMs = 5_000): Promise<T> {
	return new Promise((resolve, reject) => {
		const started = Date.now()
		const poll = () => {
			const value = predicate()
			if (value !== undefined) {
				resolve(value)
			} else if (Date.now() - started > timeoutMs) {
				reject(new Error("Timed out waiting for bridge message"))
			} else {
				setTimeout(poll, 10)
			}
		}
		poll()
	})
}

describe("BrowserBridgeServer", () => {
	let bridge: BrowserBridgeServer | undefined
	const sockets: Socket[] = []

	beforeEach(async () => {
		expect(getBrowserBridgePort()).toBe(0) // default: OS-assigned port
		bridge = await BrowserBridgeServer.start(() => {})
		expect(bridge).toBeDefined()
	})

	afterEach(async () => {
		for (const socket of sockets.splice(0)) {
			socket.disconnect()
		}
		bridge?.dispose()
		bridge = undefined
	})

	it("forwards webview->extension messages received from a browser client", async () => {
		const server = bridge!
		const received: WebviewMessage[] = []
		server.onWebviewMessage((message) => received.push(message))

		const client = await connectToBridge(server.port)
		sockets.push(client)

		const sent: WebviewMessage = { type: "clearTask" }
		client.emit("webviewMessage", sent)

		const arrived = await waitFor(() => (received.length > 0 ? received[0] : undefined))
		expect(arrived).toEqual(sent)
	})

	it("broadcasts extension->webview messages to connected clients", async () => {
		const server = bridge!
		const client = await connectToBridge(server.port)
		sockets.push(client)

		let inbound: unknown
		client.on("extensionMessage", (message: unknown) => {
			inbound = message
		})

		const sent: ExtensionMessage = { type: "state", state: { clineMessages: [] } as never }
		server.broadcast(sent)

		const arrived = await waitFor(() => inbound)
		expect(arrived).toEqual(sent)
	})

	it("delivers virtual-webview messages to the provider listener (full round trip)", async () => {
		const server = bridge!
		const webview = server.getOrCreateVirtualWebview()

		const providerReceived: WebviewMessage[] = []
		webview.onDidReceiveMessage((message) => {
			providerReceived.push(message as WebviewMessage)
		})

		const client = await connectToBridge(server.port)
		sockets.push(client)

		const sent: WebviewMessage = { type: "clearTask" }
		client.emit("webviewMessage", sent)

		const arrived = await waitFor(() => (providerReceived.length > 0 ? providerReceived[0] : undefined))
		expect(arrived).toEqual(sent)
	})

	it("getBrowserUrl builds the Vite dev-server URL with the bridge port", () => {
		const server = bridge!
		expect(server.getBrowserUrl()).toBe(`http://localhost:5173/?bridgePort=${server.port}`)
		expect(BrowserBridgeServer.getBrowserUrl(43210)).toBe("http://localhost:5173/?bridgePort=43210")
	})

	it("getPlaceholderHtml renders browser-mode info with a clickable valid link", () => {
		const server = bridge!
		const html = server.getPlaceholderHtml()

		expect(html).toContain("<!DOCTYPE html>")
		// Browser-mode notice: the tab cannot be restored.
		expect(html).toContain("browser mode")
		expect(html).toContain("cannot be restored")
		// The link points at the exact URL that opens the browser tab.
		expect(html).toContain(`href="${server.getBrowserUrl()}"`)
	})

	it("stop delivers after the listener is disposed", async () => {
		const server = bridge!
		const received: WebviewMessage[] = []
		const subscription = server.onWebviewMessage((message) => received.push(message))

		const client = await connectToBridge(server.port)
		sockets.push(client)

		subscription.dispose()
		client.emit("webviewMessage", { type: "clearTask" } satisfies WebviewMessage)
		await new Promise((resolve) => setTimeout(resolve, 150))

		expect(received).toHaveLength(0)
	})
})
