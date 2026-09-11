// npx vitest run core/webview/__tests__/browserBridge.spec.ts
//
// Browser bridge coverage for the dev-only isolation model:
//  - getBrowserBridgePort env parsing (the ROO_BROWSER_BRIDGE_PORT alt mode)
//  - the statics/WeakMap registry: enable/active/webviewFor/setPlaceholder/
//    disposeFor, the one-bridge-per-host rule, and the rejected-newcomer bind
//  - registerCommand self-gating (env unset / wrong extension mode) and the
//    full command flow: start + bind + openExternal, the reuse path, and the
//    occupied-port failure path
//  - a real socket.io round trip (server + socket.io-client, mirroring the
//    webview-ui BrowserBridgeClient wiring, so a socket.io v4 event-routing
//    regression is caught here)

import { createServer } from "http"
import type { AddressInfo } from "net"

import { io, type Socket } from "socket.io-client"
import type { Mock } from "vitest"
import * as vscode from "vscode"

import type { ExtensionMessage, WebviewMessage } from "@roo-code/types"

import { allowNetConnect } from "../../../vitest.setup"
import type { BridgeHost } from "../browserBridge"
import { BrowserBridgeServer, getBrowserBridgePort } from "../browserBridge"

// The shared src/__mocks__/vscode.js lacks the ExtensionMode/env/commands/
// window surface the bridge touches at runtime, so this spec supplies its own
// module mock instead.
vi.mock("vscode", () => ({
	ExtensionMode: { Production: 1, Development: 2, Test: 3 },
	commands: { registerCommand: vi.fn() },
	env: { openExternal: vi.fn().mockResolvedValue(true) },
	Uri: {
		parse: vi.fn((value: string) => ({ toString: () => value })),
	},
	window: { showErrorMessage: vi.fn() },
}))

// vitest.setup.ts disables real network requests via nock by default. The
// round-trip tests connect a real socket.io client to a loopback server, so
// allow net connect for 127.0.0.1 (the websocket upgrade and the polling
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
				reject(new Error("Timed out waiting for bridge condition"))
			} else {
				setTimeout(poll, 10)
			}
		}
		poll()
	})
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

type HostStub = {
	view?: { webview: { html: string } }
	setWebviewMessageListener: Mock
}

function createHost(): HostStub {
	return { view: { webview: { html: "" } }, setWebviewMessageListener: vi.fn() }
}

/** Starts a real bridge (private statics are reached via element access). */
async function startBridge(): Promise<BrowserBridgeServer> {
	const bridge = await BrowserBridgeServer["start"](() => {})
	if (!bridge) {
		throw new Error("Test bridge failed to start")
	}
	return bridge
}

describe("getBrowserBridgePort", () => {
	const original = process.env.ROO_BROWSER_BRIDGE_PORT

	afterEach(() => {
		if (original === undefined) {
			delete process.env.ROO_BROWSER_BRIDGE_PORT
		} else {
			process.env.ROO_BROWSER_BRIDGE_PORT = original
		}
	})

	test.each([
		["unset", undefined, 0],
		["empty", "", 0],
		["valid port", "51234", 51234],
		["non-numeric", "abc", 0],
		["float", "1.5", 0],
		["zero", "0", 0],
		["negative", "-1", 0],
		["out of range", "99999", 0],
	])("%s -> %i", (_label, value, expected) => {
		if (value === undefined) {
			delete process.env.ROO_BROWSER_BRIDGE_PORT
		} else {
			process.env.ROO_BROWSER_BRIDGE_PORT = value
		}
		expect(getBrowserBridgePort()).toBe(expected)
	})
})

describe("BrowserBridgeServer statics (WeakMap registry)", () => {
	const hosts: HostStub[] = []
	const sockets: Socket[] = []

	afterEach(async () => {
		for (const socket of sockets.splice(0)) {
			socket.disconnect()
		}
		for (const host of hosts.splice(0)) {
			BrowserBridgeServer.disposeFor(host)
		}
	})

	it("is inert for unknown hosts", () => {
		const stranger = createHost()
		hosts.push(stranger)

		expect(BrowserBridgeServer.active(stranger)).toBe(false)
		expect(BrowserBridgeServer.webviewFor(stranger)).toBeUndefined()
		expect(() => BrowserBridgeServer.setPlaceholder(stranger)).not.toThrow()
		expect(() => BrowserBridgeServer.disposeFor(stranger)).not.toThrow()
		expect(stranger.view!.webview.html).toBe("")
	})

	it("enable binds a started bridge to the host and wires the provider listener", async () => {
		const host = createHost()
		hosts.push(host)

		BrowserBridgeServer.enable(host)
		await waitFor(() => (BrowserBridgeServer.active(host) ? true : undefined))

		expect(BrowserBridgeServer.active(host)).toBe(true)
		// Default wiring goes through the host's private setWebviewMessageListener.
		expect(host.setWebviewMessageListener).toHaveBeenCalledTimes(1)
		// The placeholder is rendered into the already-resolved real webview.
		expect(host.view!.webview.html).toContain("browser mode")
		expect(host.view!.webview.html).toContain("?bridgePort=")
	})

	it("enable uses an explicit listen callback instead of host internals", async () => {
		const host = createHost()
		hosts.push(host)
		const listen = vi.fn()

		BrowserBridgeServer.enable(host, listen)
		await waitFor(() => (BrowserBridgeServer.active(host) ? true : undefined))

		expect(listen).toHaveBeenCalledTimes(1)
		expect(listen.mock.calls[0][0]).toBe(BrowserBridgeServer.webviewFor(host))
		expect(host.setWebviewMessageListener).not.toHaveBeenCalled()
	})

	it("enable is idempotent: the first bridge stays authoritative", async () => {
		const host = createHost()
		hosts.push(host)

		BrowserBridgeServer.enable(host)
		await waitFor(() => (BrowserBridgeServer.active(host) ? true : undefined))
		const webview = BrowserBridgeServer.webviewFor(host)
		expect(webview).toBeDefined()

		// A second enable for the same host is a no-op (no second server leaks).
		const secondListen = vi.fn()
		BrowserBridgeServer.enable(host, secondListen)
		await tick()

		expect(secondListen).not.toHaveBeenCalled()
		expect(BrowserBridgeServer.webviewFor(host)).toBe(webview)
	})

	it("bind disposes a rejected newcomer (one bridge per host)", async () => {
		const host = createHost()
		hosts.push(host)
		const first = await startBridge()
		const second = await startBridge()

		BrowserBridgeServer["bind"](host, first)

		// Wrap the private dispose to observe the rejection path while still
		// closing the newcomer's real server (no leaked ports).
		const originalDispose = second["dispose"].bind(second)
		const disposeSpy = vi.fn(() => originalDispose())
		second["dispose"] = disposeSpy
		BrowserBridgeServer["bind"](host, second)

		expect(disposeSpy).toHaveBeenCalledTimes(1)
		expect(BrowserBridgeServer.webviewFor(host)).toBe(first["getOrCreateVirtualWebview"]())
		expect(host.view!.webview.html).toContain(`?bridgePort=${first["_port"]}`)
	})

	it("disposeFor releases the host and drops the registry entry", async () => {
		const host = createHost()
		hosts.push(host)

		BrowserBridgeServer.enable(host)
		await waitFor(() => (BrowserBridgeServer.active(host) ? true : undefined))
		const firstWebview = BrowserBridgeServer.webviewFor(host)
		expect(firstWebview).toBeDefined()

		BrowserBridgeServer.disposeFor(host)

		expect(BrowserBridgeServer.active(host)).toBe(false)
		expect(BrowserBridgeServer.webviewFor(host)).toBeUndefined()

		// Re-enabling after dispose starts a fresh bridge.
		BrowserBridgeServer.enable(host)
		await waitFor(() => (BrowserBridgeServer.active(host) ? true : undefined))
		expect(BrowserBridgeServer.webviewFor(host)).toBeDefined()
		expect(BrowserBridgeServer.webviewFor(host)).not.toBe(firstWebview)
	})

	it("setPlaceholder refreshes the placeholder on a later view resolve", async () => {
		const host = createHost()
		hosts.push(host)
		delete host.view

		BrowserBridgeServer.enable(host)
		await waitFor(() => (BrowserBridgeServer.active(host) ? true : undefined))
		// No resolved view yet: the placeholder render is a no-op.
		expect(host.view).toBeUndefined()

		host.view = { webview: { html: "" } }
		BrowserBridgeServer.setPlaceholder(host)
		expect(host.view.webview.html).toContain("browser mode")
	})

	it("getBrowserUrl builds the Vite dev-server URL with the bridge port", () => {
		expect(BrowserBridgeServer.getBrowserUrl(43210)).toBe("http://localhost:5173/?bridgePort=43210")
	})

	it("reuses the same virtual webview across calls", async () => {
		const host = createHost()
		hosts.push(host)
		BrowserBridgeServer.enable(host)
		await waitFor(() => (BrowserBridgeServer.active(host) ? true : undefined))

		expect(BrowserBridgeServer.webviewFor(host)).toBe(BrowserBridgeServer.webviewFor(host))
	})

	it("delivers a full round trip through the virtual webview", async () => {
		const host = createHost()
		hosts.push(host)
		BrowserBridgeServer.enable(host)
		await waitFor(() => (BrowserBridgeServer.active(host) ? true : undefined))

		const webview = BrowserBridgeServer.webviewFor(host)!
		const bridge = BrowserBridgeServer["bridges"].get(host)!

		const providerReceived: WebviewMessage[] = []
		const subscription = webview.onDidReceiveMessage((message) => {
			providerReceived.push(message as WebviewMessage)
		})

		const client = await connectToBridge(bridge["_port"])
		sockets.push(client)

		// webview -> extension
		const sent: WebviewMessage = { type: "clearTask" }
		client.emit("webviewMessage", sent)
		const arrived = await waitFor(() => (providerReceived.length > 0 ? providerReceived[0] : undefined))
		expect(arrived).toEqual(sent)

		// After the subscription is disposed, delivery stops.
		subscription.dispose()
		client.emit("webviewMessage", sent)
		await new Promise((resolve) => setTimeout(resolve, 150))
		expect(providerReceived).toHaveLength(1)

		// extension -> webview broadcast reaches connected clients.
		let inbound: unknown
		client.on("extensionMessage", (message: unknown) => {
			inbound = message
		})
		const extensionMessage: ExtensionMessage = { type: "state", state: { clineMessages: [] } as never }
		await webview.postMessage(extensionMessage)
		const broadcast = await waitFor(() => inbound)
		expect(broadcast).toEqual(extensionMessage)
	})
})

describe("BrowserBridgeServer.registerCommand (dev-only self-gating)", () => {
	let handlers: Record<string, () => Promise<void>>
	let context: { extensionMode: number; subscriptions: { dispose: Mock }[] }
	let outputChannel: { appendLine: Mock }
	let host: HostStub
	let visible: HostStub | undefined

	beforeEach(() => {
		vi.clearAllMocks()
		handlers = {}
		;(vscode.commands.registerCommand as Mock).mockImplementation((id: string, callback: () => Promise<void>) => {
			handlers[id] = callback
			return { dispose: vi.fn() }
		})
		context = { extensionMode: vscode.ExtensionMode.Development, subscriptions: [] }
		outputChannel = { appendLine: vi.fn() }
		host = createHost()
		visible = host
		delete process.env.ROO_BROWSER_BRIDGE
		delete process.env.ROO_BROWSER_BRIDGE_PORT
	})

	afterEach(() => {
		BrowserBridgeServer.disposeFor(host)
		delete process.env.ROO_BROWSER_BRIDGE
		delete process.env.ROO_BROWSER_BRIDGE_PORT
	})

	function register() {
		BrowserBridgeServer.registerCommand(
			context as never,
			outputChannel as never,
			() => visible as BridgeHost | undefined,
		)
	}

	it("is a no-op when ROO_BROWSER_BRIDGE is unset", () => {
		register()
		expect(vscode.commands.registerCommand).not.toHaveBeenCalled()
		expect(context.subscriptions).toHaveLength(0)
	})

	it("is a no-op when ROO_BROWSER_BRIDGE=1 but the host is not Development", () => {
		process.env.ROO_BROWSER_BRIDGE = "1"
		for (const mode of [vscode.ExtensionMode.Production, vscode.ExtensionMode.Test]) {
			context.extensionMode = mode
			register()
		}
		expect(vscode.commands.registerCommand).not.toHaveBeenCalled()
		expect(context.subscriptions).toHaveLength(0)
	})

	it("registers zoo-code.openInBrowser in a gated dev host", () => {
		process.env.ROO_BROWSER_BRIDGE = "1"
		register()
		expect(vscode.commands.registerCommand).toHaveBeenCalledWith("zoo-code.openInBrowser", expect.any(Function))
		expect(context.subscriptions).toHaveLength(1)
	})

	it("logs when no visible provider exists", async () => {
		process.env.ROO_BROWSER_BRIDGE = "1"
		register()
		visible = undefined

		await handlers["zoo-code.openInBrowser"]()

		expect(outputChannel.appendLine).toHaveBeenCalledWith("Cannot find any visible Roo Code instances.")
		expect(vscode.env.openExternal).not.toHaveBeenCalled()
		expect(BrowserBridgeServer.active(host)).toBe(false)
	})

	it("starts, binds and opens the browser tab on the happy path", async () => {
		process.env.ROO_BROWSER_BRIDGE = "1"
		register()

		await handlers["zoo-code.openInBrowser"]()

		expect(BrowserBridgeServer.active(host)).toBe(true)
		expect(host.setWebviewMessageListener).toHaveBeenCalledTimes(1)
		expect(host.view!.webview.html).toContain("browser mode")

		expect(vscode.env.openExternal).toHaveBeenCalledTimes(1)
		const url = (vscode.Uri.parse as Mock).mock.calls[0][0] as string
		expect(url).toMatch(/^http:\/\/localhost:5173\/\?bridgePort=\d+$/)
		expect(outputChannel.appendLine).toHaveBeenCalledWith(expect.stringContaining("[BrowserBridge] Listening on"))
	})

	it("reuses the existing bridge instead of starting a second server", async () => {
		process.env.ROO_BROWSER_BRIDGE = "1"
		register()

		await handlers["zoo-code.openInBrowser"]()
		const port = BrowserBridgeServer["bridges"].get(host)!["_port"]

		await handlers["zoo-code.openInBrowser"]()

		expect(outputChannel.appendLine).toHaveBeenCalledWith(
			`[openInBrowser] Reusing existing browser bridge on port ${port}.`,
		)
		expect(vscode.env.openExternal).toHaveBeenCalledTimes(2)
		expect((vscode.Uri.parse as Mock).mock.calls[1][0]).toBe(`http://localhost:5173/?bridgePort=${port}`)
		// Still exactly one bind: the listener was not re-registered.
		expect(host.setWebviewMessageListener).toHaveBeenCalledTimes(1)
	})

	it("surfaces startup failures (occupied fixed port) to the developer", async () => {
		process.env.ROO_BROWSER_BRIDGE = "1"
		// Occupy the exact port the bridge will be told to use.
		const blocker = createServer()
		await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve))
		const occupied = (blocker.address() as AddressInfo).port
		process.env.ROO_BROWSER_BRIDGE_PORT = String(occupied)
		register()

		try {
			await handlers["zoo-code.openInBrowser"]()

			expect(outputChannel.appendLine).toHaveBeenCalledWith(
				expect.stringContaining(`[BrowserBridge] Failed to start on 127.0.0.1:${occupied}`),
			)
			expect(outputChannel.appendLine).toHaveBeenCalledWith("[openInBrowser] Failed to start the browser bridge.")
			expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
				expect.stringContaining("Failed to start the browser bridge"),
			)
			expect(BrowserBridgeServer.active(host)).toBe(false)
			expect(vscode.env.openExternal).not.toHaveBeenCalled()
		} finally {
			await new Promise<void>((resolve) => blocker.close(() => resolve()))
		}
	})
})
