// npx vitest run core/webview/__tests__/browserBridge.spec.ts
//
// Browser bridge coverage for the dev-only isolation model:
//  - getBrowserBridgePort env parsing (the ROO_BROWSER_BRIDGE_PORT alt mode)
//  - the statics/WeakMap registry: enable/active/webviewFor/setPlaceholder/
//    disposeFor, the one-bridge-per-host rule, and the rejected-newcomer bind
//  - registerCommand self-gating (env unset / wrong extension mode) and the
//    full command flow: start + bind + openExternal, the reuse path, the
//    concurrent-bind race, and the occupied-port failure path
//  - the handshake middleware token gate (unit-level) and enable()'s catch
//    when bridge construction fails synchronously
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
import { BrowserBridgeServer, getBoundPort, getBrowserBridgePort } from "../browserBridge"

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

// Capture the Server constructor options the bridge passes through the lazy
// `import("socket.io")` in BrowserBridgeServer.start, without altering the
// real server behavior (the round-trip tests still run against socket.io).
type CapturedServerOptions = {
	cors: { origin: RegExp[] }
	allowRequest: (
		req: { headers: { origin?: string | string[] } },
		callback: (err: string | null | undefined, success: boolean) => void,
	) => void
	transports: string[]
	maxHttpBufferSize: number
}

const { socketIoOptions, bridgeServerHooks } = vi.hoisted(() => ({
	socketIoOptions: { current: undefined as CapturedServerOptions | undefined },
	bridgeServerHooks: {
		// The handshake middleware of the most recently constructed bridge,
		// widened to unknown params so the token-gate test can call it with
		// minimal structural stubs.
		middleware: undefined as ((socket: unknown, next: unknown) => void) | undefined,
		// When set, the mocked Server constructor throws synchronously, which
		// makes BrowserBridgeServer.start reject (for enable()'s catch path).
		throwOnConstruct: false,
	},
}))

vi.mock("socket.io", async (importOriginal) => {
	const actual = await importOriginal<typeof import("socket.io")>()
	return {
		...actual,
		Server: class CapturingServer extends actual.Server {
			constructor(...args: ConstructorParameters<typeof actual.Server>) {
				if (bridgeServerHooks.throwOnConstruct) {
					throw new Error("simulated bridge server construction failure")
				}
				super(...args)
				// The bridge always constructs `new Server(httpServer, options)`.
				const options = args[1] ?? args[0]
				socketIoOptions.current = options as CapturedServerOptions | undefined
				// Shadow the prototype method so the token-gate unit test can
				// invoke the middleware the bridge registers via `server.use`
				// (real clients always send an `auth` object, so only a direct
				// call can probe the missing-auth branch). The single
				// assertion widens socket.io's Socket/NextFunction params,
				// which the stubs below satisfy structurally.
				this.use = (fn) => {
					bridgeServerHooks.middleware = fn as typeof bridgeServerHooks.middleware
					return super.use(fn)
				}
			}
		},
	}
})

function connectToBridge(port: number, token: string): Promise<Socket> {
	return new Promise((resolve, reject) => {
		const socket = io(`http://127.0.0.1:${port}`, {
			auth: { token },
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

/**
 * Forces a pure WebSocket handshake (no polling fallback) and reports whether
 * the bridge accepted it. `extraHeaders` simulates the `Origin` header a
 * browser sends on the upgrade request; `token` is sent as the socket.io
 * handshake auth payload (omitted entirely when undefined).
 */
function connectOutcome(
	port: number,
	opts?: { extraHeaders?: Record<string, string>; token?: string },
): Promise<"connected" | "rejected"> {
	return new Promise((resolve) => {
		const socket = io(`http://127.0.0.1:${port}`, {
			transports: ["websocket"],
			reconnection: false,
			timeout: 3_000,
			extraHeaders: opts?.extraHeaders,
			auth: opts?.token === undefined ? undefined : { token: opts.token },
		})
		socket.once("connect", () => {
			socket.disconnect()
			resolve("connected")
		})
		socket.once("connect_error", () => {
			socket.disconnect()
			resolve("rejected")
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
	attachWebviewMessageListener: Mock
}

function createHost(): HostStub {
	return {
		view: { webview: { html: "" } },
		attachWebviewMessageListener: vi.fn(() => ({ dispose: vi.fn() })),
	}
}

/** Starts a real bridge (private statics are reached via element access). */
async function startBridge(): Promise<BrowserBridgeServer> {
	const bridge = await BrowserBridgeServer["start"](() => {})
	if (!bridge) {
		throw new Error("Test bridge failed to start")
	}
	return bridge
}

/**
 * Swaps the private prototype `dispose` for a spy that still closes the real
 * server, for observing a late bridge's disposal when no instance reference
 * exists yet (the bridge is created inside an in-flight `start()`).
 */
function spyOnDispose() {
	const proto = BrowserBridgeServer.prototype
	const original = proto["dispose"]
	const spy = vi.fn(function (this: BrowserBridgeServer) {
		return original.call(this)
	})
	proto["dispose"] = spy
	return {
		spy,
		restore: () => {
			proto["dispose"] = original
		},
	}
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
		["upper boundary", "65536", 0],
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

describe("getBoundPort", () => {
	it("returns the OS-assigned port for an AddressInfo object", () => {
		const httpServer = { address: () => ({ port: 43210, address: "127.0.0.1", family: "IPv4" }) }
		expect(getBoundPort(httpServer as never, 0)).toBe(43210)
	})

	it("falls back to the requested port for a string (pipe) address", () => {
		const httpServer = { address: () => "\\\\.\\pipe\\bridge" }
		expect(getBoundPort(httpServer as never, 8080)).toBe(8080)
	})

	it("falls back to the requested port while unbound (null address)", () => {
		const httpServer = { address: () => null }
		expect(getBoundPort(httpServer as never, 8080)).toBe(8080)
	})
})

describe("BrowserBridgeServer.start (socket.io options)", () => {
	beforeEach(() => {
		socketIoOptions.current = undefined
		bridgeServerHooks.middleware = undefined
	})

	function captureOptions(): CapturedServerOptions {
		const options = socketIoOptions.current
		expect(options).toBeDefined()
		return options!
	}

	it("passes local-origin CORS, the transports, and the 100 MiB buffer limit", async () => {
		const bridge = await startBridge()
		try {
			const options = captureOptions()
			expect(options.cors).toEqual({ origin: [expect.any(RegExp)] })
			expect(options.transports).toEqual(["websocket", "polling"])
			// Webview messages carry base64 images; socket.io's 1 MB default
			// would silently drop them and disconnect the tab.
			expect(options.maxHttpBufferSize).toBe(100 * 1024 * 1024)
		} finally {
			bridge["dispose"]()
		}
	})

	it("binds the listening socket to the loopback interface only", async () => {
		const bridge = await startBridge()
		try {
			// The dev-only bridge must never be reachable from outside the
			// machine. An emptied host option makes Node bind to all interfaces,
			// and every loopback client still connects to such a server, so only
			// the actually-bound address pins the loopback-only guarantee.
			const bound = bridge["server"].httpServer.address() as AddressInfo
			expect(bound.address).toBe("127.0.0.1")
			expect(bound.port).toBe(bridge["_port"])
		} finally {
			bridge["dispose"]()
		}
	})

	it("gates every fresh handshake through the allowRequest Origin check", async () => {
		const bridge = await startBridge()
		try {
			const allowRequest = captureOptions().allowRequest
			expect(typeof allowRequest).toBe("function")

			const outcome = (origin?: string | string[]) => {
				let error: string | null | undefined = "callback-not-called"
				let success = false
				allowRequest({ headers: origin === undefined ? {} : { origin } }, (err, ok) => {
					error = err
					success = ok
				})
				return { error, success }
			}

			const refusal = { error: "The browser bridge only accepts local origins.", success: false }

			// Local origins and non-browser clients (no Origin header) pass;
			// everything else is refused before the handshake completes. The
			// exact refusal string is asserted, and the "callback-not-called"
			// sentinel proves the callback actually ran (an emptied else-block
			// would leave it).
			expect(outcome("http://localhost:5173")).toEqual({ error: null, success: true })
			expect(outcome()).toEqual({ error: null, success: true })
			expect(outcome("http://evil.com")).toEqual(refusal)
			// Node types a repeated Origin header as string[]. Only a plain
			// string may match the allowlist: a one-element array coerces to an
			// allowed origin, so the typeof gate is observable exactly here.
			expect(outcome(["http://localhost:5173"])).toEqual(refusal)
		} finally {
			bridge["dispose"]()
		}
	})

	it("token-gates every fresh socket through the handshake middleware", async () => {
		const bridge = await startBridge()
		try {
			const middleware = bridgeServerHooks.middleware
			expect(middleware).toBeTypeOf("function")

			const refused = (next: Mock<(err?: Error) => void>) => {
				expect(next).toHaveBeenCalledTimes(1)
				const error = next.mock.calls[0][0]
				expect(error).toBeInstanceOf(Error)
				// Literal, not the imported shared constant: both wire ends
				// match on this exact string, so a rename must break here.
				expect(error?.message).toBe("unauthorized")
			}

			// A bare handshake (no `auth` object) must be rejected by the
			// optional chain, not crash on `auth.token` (mutant without ?.).
			const noAuth = vi.fn<(err?: Error) => void>()
			middleware!({ handshake: {} }, noAuth)
			refused(noAuth)

			const wrongToken = vi.fn<(err?: Error) => void>()
			middleware!({ handshake: { auth: { token: "deadbeefdeadbeefdeadbeefdeadbeef" } } }, wrongToken)
			refused(wrongToken)

			// A wrong-LENGTH token must be refused through the length guard in
			// front of timingSafeEqual: without it, the mismatched buffers make
			// timingSafeEqual throw a RangeError instead of a clean rejection.
			const shortToken = vi.fn<(err?: Error) => void>()
			middleware!({ handshake: { auth: { token: "deadbeef" } } }, shortToken)
			refused(shortToken)

			const accepted = vi.fn<(err?: Error) => void>()
			middleware!({ handshake: { auth: { token: bridge["token"] } } }, accepted)
			expect(accepted).toHaveBeenCalledTimes(1)
			expect(accepted.mock.calls[0][0]).toBeUndefined()
		} finally {
			bridge["dispose"]()
		}
	})

	it("rejects a websocket handshake carrying a foreign Origin and accepts the dev-server one", async () => {
		const bridge = await startBridge()
		try {
			// CORS never gated the WS upgrade, so this exercises the server-side
			// handshake check. The allowed-origin connect also proves the
			// extraHeaders actually reach the server (otherwise the rejection
			// assertions below could pass vacuously).
			await expect(
				connectOutcome(bridge["_port"], {
					extraHeaders: { Origin: "http://localhost:5173" },
					token: bridge["token"],
				}),
			).resolves.toBe("connected")
			await expect(
				connectOutcome(bridge["_port"], {
					extraHeaders: { Origin: "http://evil.com" },
					token: bridge["token"],
				}),
			).resolves.toBe("rejected")
			// A page served by another local dev app is not the bridge client.
			await expect(
				connectOutcome(bridge["_port"], {
					extraHeaders: { Origin: "http://localhost:3000" },
					token: bridge["token"],
				}),
			).resolves.toBe("rejected")
		} finally {
			bridge["dispose"]()
		}
	})

	it("rejects a handshake that does not present the bridge token", async () => {
		const bridge = await startBridge()
		try {
			// A non-browser local process (no Origin header, so allowRequest
			// passes) must still fail the handshake without the token; the
			// right token connects.
			await expect(connectOutcome(bridge["_port"])).resolves.toBe("rejected")
			await expect(connectOutcome(bridge["_port"], { token: "deadbeefdeadbeefdeadbeefdeadbeef" })).resolves.toBe(
				"rejected",
			)
			await expect(connectOutcome(bridge["_port"], { token: bridge["token"] })).resolves.toBe("connected")
		} finally {
			bridge["dispose"]()
		}
	})

	it("generates a distinct per-bridge token", async () => {
		const first = await startBridge()
		const second = await startBridge()
		try {
			expect(first["token"]).toMatch(/^[0-9a-f]{32}$/)
			expect(second["token"]).toMatch(/^[0-9a-f]{32}$/)
			expect(second["token"]).not.toBe(first["token"])
		} finally {
			first["dispose"]()
			second["dispose"]()
		}
	})

	it("removes the http error listener once the server is listening", async () => {
		const bridge = await startBridge()
		try {
			// start() registers `once("error", reject)` and clears it in the
			// listen callback; dropping that off() call would leave a dangling
			// listener, which the count is the only non-disruptive proof of.
			expect(bridge["server"].httpServer.listenerCount("error")).toBe(0)
		} finally {
			bridge["dispose"]()
		}
	})

	it("restricts the CORS origin regex to the Vite dev-server origin only", async () => {
		const bridge = await startBridge()
		try {
			const origin = captureOptions().cors.origin[0]
			const allowed = ["http://localhost:5173", "http://127.0.0.1:5173"]
			const denied = [
				"http://localhost",
				"http://127.0.0.1",
				"http://localhost:3000",
				"http://localhost:65535",
				"http://localhost:5173/path",
				"xhttp://localhost:5173",
				"http://evil.com",
				"http://localhost:5173x",
				"https://localhost:5173",
			]
			for (const value of allowed) {
				expect(origin.test(value)).toBe(true)
			}
			for (const value of denied) {
				expect(origin.test(value)).toBe(false)
			}
		} finally {
			bridge["dispose"]()
		}
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
		// Default wiring goes through the host's private attachWebviewMessageListener.
		expect(host.attachWebviewMessageListener).toHaveBeenCalledTimes(1)
		expect(host.attachWebviewMessageListener).toHaveBeenCalledWith(BrowserBridgeServer.webviewFor(host))
		// The placeholder is rendered into the already-resolved real webview.
		expect(host.view!.webview.html).toContain("browser mode")
		expect(host.view!.webview.html).toContain("?bridgePort=")
		expect(host.view!.webview.html).toContain("&bridgeToken=")
	})

	it("the bridge owns the host listener subscription for its whole lifetime", async () => {
		const host = createHost()
		const disposeListener = vi.fn()
		host.attachWebviewMessageListener = vi.fn(() => ({ dispose: disposeListener }))
		hosts.push(host)

		BrowserBridgeServer.enable(host)
		await waitFor(() => (BrowserBridgeServer.active(host) ? true : undefined))
		expect(host.attachWebviewMessageListener).toHaveBeenCalledTimes(1)

		// Disposing the bridge releases the subscription it owns...
		BrowserBridgeServer.disposeFor(host)
		expect(disposeListener).toHaveBeenCalledTimes(1)

		// ...and re-enabling attaches a fresh one on the fresh bridge.
		BrowserBridgeServer.enable(host)
		await waitFor(() => (BrowserBridgeServer.active(host) ? true : undefined))
		expect(host.attachWebviewMessageListener).toHaveBeenCalledTimes(2)
		expect(disposeListener).toHaveBeenCalledTimes(1)
	})

	it("enable uses an explicit listen callback instead of host internals", async () => {
		const host = createHost()
		hosts.push(host)
		const listen = vi.fn()

		BrowserBridgeServer.enable(host, listen)
		await waitFor(() => (BrowserBridgeServer.active(host) ? true : undefined))

		expect(listen).toHaveBeenCalledTimes(1)
		expect(listen.mock.calls[0][0]).toBe(BrowserBridgeServer.webviewFor(host))
		expect(host.attachWebviewMessageListener).not.toHaveBeenCalled()
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
		expect(host.view!.webview.html).toContain(`?bridgePort=${first["_port"]}&bridgeToken=${first["token"]}`)
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

	it("getBrowserUrl builds the Vite dev-server URL with the bridge port and token", () => {
		expect(BrowserBridgeServer.getBrowserUrl(43210, "aabbccddeeff00112233445566778899")).toBe(
			"http://localhost:5173/?bridgePort=43210&bridgeToken=aabbccddeeff00112233445566778899",
		)
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

		const client = await connectToBridge(bridge["_port"], bridge["token"])
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

	it("enable disposes the bridge when the host is released while start is in flight", async () => {
		const host = createHost()
		hosts.push(host)

		// disposeFor runs before start() resolves (start awaits the lazy
		// socket.io import, so the host is definitively still in flight here).
		// Without the pending-start invalidation, bind() would resurrect the
		// registry entry for a disposed provider and leak the listening port.
		const { spy, restore } = spyOnDispose()
		try {
			BrowserBridgeServer.enable(host)
			const epochBefore = BrowserBridgeServer["lifecycleEpoch"].get(host) ?? 0
			BrowserBridgeServer.disposeFor(host)
			// disposeFor must advance the epoch by exactly one step (the
			// in-flight start compares against it; a non-advancing or
			// decrementing bump would leave it observable only through
			// accidental strict-inequality).
			expect(BrowserBridgeServer["lifecycleEpoch"].get(host)).toBe(epochBefore + 1)
			await new Promise((resolve) => setTimeout(resolve, 150))

			// The invalidated in-flight start disposed its late bridge...
			expect(spy).toHaveBeenCalledTimes(1)
			// ...instead of binding it to the released host.
			expect(BrowserBridgeServer.active(host)).toBe(false)
			expect(host.attachWebviewMessageListener).not.toHaveBeenCalled()
		} finally {
			restore()
		}

		// Rejecting the late bridge must not poison the host: re-enabling works.
		BrowserBridgeServer.enable(host)
		await waitFor(() => (BrowserBridgeServer.active(host) ? true : undefined))
	})

	it("disposeFor disposes the bridge server before dropping the entry", async () => {
		const host = createHost()
		hosts.push(host)

		BrowserBridgeServer.enable(host)
		await waitFor(() => (BrowserBridgeServer.active(host) ? true : undefined))
		const bridge = BrowserBridgeServer["bridges"].get(host)!

		// Wrap the private dispose so the real server still closes (no leaked port).
		const originalDispose = bridge["dispose"].bind(bridge)
		const disposeSpy = vi.fn(() => originalDispose())
		bridge["dispose"] = disposeSpy

		BrowserBridgeServer.disposeFor(host)

		expect(disposeSpy).toHaveBeenCalledTimes(1)
		expect(BrowserBridgeServer.active(host)).toBe(false)
	})

	it("the virtual webview mirrors the vscode.Webview contract", async () => {
		const host = createHost()
		hosts.push(host)
		BrowserBridgeServer.enable(host)
		await waitFor(() => (BrowserBridgeServer.active(host) ? true : undefined))

		const webview = BrowserBridgeServer.webviewFor(host)!
		expect(webview.options).toEqual({ enableScripts: true })
		expect(webview.cspSource).toBe("vscode-webview://bridge")
		expect(webview.html).toBe("")
		await expect(webview.postMessage({ type: "action", action: "chatButtonClicked" })).resolves.toBe(true)
		const uri = { toString: () => "file:///test/asset.png" } as never
		expect(webview.asWebviewUri(uri)).toBe(uri)
	})

	it("an onWebviewMessage subscription stops delivering after dispose", async () => {
		const host = createHost()
		hosts.push(host)
		BrowserBridgeServer.enable(host)
		await waitFor(() => (BrowserBridgeServer.active(host) ? true : undefined))
		const bridge = BrowserBridgeServer["bridges"].get(host)!

		const received: WebviewMessage[] = []
		const disposable = bridge["onWebviewMessage"]((message) => {
			received.push(message)
		})
		expect(typeof disposable.dispose).toBe("function")

		const client = await connectToBridge(bridge["_port"], bridge["token"])
		sockets.push(client)

		const first: WebviewMessage = { type: "clearTask" }
		client.emit("webviewMessage", first)
		await waitFor(() => (received.length > 0 ? received[0] : undefined))

		disposable.dispose()
		client.emit("webviewMessage", { type: "acceptInput" })
		await new Promise((resolve) => setTimeout(resolve, 150))
		expect(received).toEqual([first])
	})
})

describe("BrowserBridgeServer occupied-port failure paths", () => {
	const originalPort = process.env.ROO_BROWSER_BRIDGE_PORT
	let blocker: ReturnType<typeof createServer>
	let occupied: number

	beforeEach(async () => {
		// Occupy a real port and force the bridge to request exactly that one,
		// so start() deterministically fails with EADDRINUSE.
		blocker = createServer()
		await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve))
		occupied = (blocker.address() as AddressInfo).port
		process.env.ROO_BROWSER_BRIDGE_PORT = String(occupied)
	})

	afterEach(async () => {
		if (originalPort === undefined) {
			delete process.env.ROO_BROWSER_BRIDGE_PORT
		} else {
			process.env.ROO_BROWSER_BRIDGE_PORT = originalPort
		}
		await new Promise<void>((resolve) => blocker.close(() => resolve()))
	})

	it("start without onError resolves undefined instead of rejecting", async () => {
		await expect(BrowserBridgeServer["start"](() => {})).resolves.toBeUndefined()
	})

	it("enable leaves the host inert when the bridge fails to start", async () => {
		const host = createHost()
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
		try {
			BrowserBridgeServer.enable(host)
			await waitFor(() =>
				logSpy.mock.calls.some(([message]) => String(message).includes("[BrowserBridge] Failed to start"))
					? true
					: undefined,
			)
			// Grace for the awaited server.close() and any (mutant) bind attempt.
			await new Promise((resolve) => setTimeout(resolve, 100))

			expect(BrowserBridgeServer.active(host)).toBe(false)
			expect(host.attachWebviewMessageListener).not.toHaveBeenCalled()
		} finally {
			logSpy.mockRestore()
			BrowserBridgeServer.disposeFor(host)
		}
	})

	it("a second enable never starts a second listening server", async () => {
		const host = createHost()
		// Port 0 (not the occupied override) so the second start *can* succeed:
		// without the bridges.has guard its "[BrowserBridge] Listening" log is
		// the observable proof a second server bound.
		delete process.env.ROO_BROWSER_BRIDGE_PORT
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
		try {
			BrowserBridgeServer.enable(host)
			await waitFor(() => (BrowserBridgeServer.active(host) ? true : undefined))

			BrowserBridgeServer.enable(host)
			// Grace for a would-be second server to bind and log.
			await new Promise((resolve) => setTimeout(resolve, 250))

			const listening = logSpy.mock.calls.filter(([message]) =>
				String(message).includes("[BrowserBridge] Listening"),
			)
			expect(listening).toHaveLength(1)
		} finally {
			logSpy.mockRestore()
			BrowserBridgeServer.disposeFor(host)
		}
	})
})

describe("BrowserBridgeServer.enable (bridge construction throws)", () => {
	it("logs to console.error when the bridge fails synchronously", async () => {
		const host = createHost()
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		bridgeServerHooks.throwOnConstruct = true
		try {
			// A synchronous construction failure escapes start() as a rejected
			// promise, so enable()'s .catch handler runs (not the occupied-port
			// path). The exact string kills the StringLiteral->"" mutant, and
			// the awaited call kills the emptied catch block.
			BrowserBridgeServer.enable(host)
			await waitFor(() => (errorSpy.mock.calls.length > 0 ? true : undefined))
			expect(errorSpy).toHaveBeenCalledWith("[BrowserBridge] Failed to start:", expect.any(Error))
			expect(BrowserBridgeServer.active(host)).toBe(false)
			expect(host.attachWebviewMessageListener).not.toHaveBeenCalled()
		} finally {
			bridgeServerHooks.throwOnConstruct = false
			errorSpy.mockRestore()
			BrowserBridgeServer.disposeFor(host)
		}
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

	it("closes the bridge when the host is disposed while the command's start is in flight", async () => {
		process.env.ROO_BROWSER_BRIDGE = "1"
		register()

		// Fire the handler and release the host before its awaited start()
		// resolves. The late bridge must be disposed, never bound, and the
		// browser tab must not be opened for a host that is already gone.
		const { spy, restore } = spyOnDispose()
		try {
			const running = handlers["zoo-code.openInBrowser"]()
			BrowserBridgeServer.disposeFor(host)
			await running

			// Exactly one dispose: the command handler's late-bridge guard,
			// not the (empty) disposeFor that ran while no bridge was bound.
			expect(spy).toHaveBeenCalledTimes(1)
			expect(BrowserBridgeServer.active(host)).toBe(false)
			expect(host.attachWebviewMessageListener).not.toHaveBeenCalled()
			expect(outputChannel.appendLine).toHaveBeenCalledWith(
				"[openInBrowser] The host was disposed while the bridge was starting.",
			)
			expect(vscode.env.openExternal).not.toHaveBeenCalled()
		} finally {
			restore()
		}
	})

	it("starts, binds and opens the browser tab on the happy path", async () => {
		process.env.ROO_BROWSER_BRIDGE = "1"
		register()

		await handlers["zoo-code.openInBrowser"]()

		expect(BrowserBridgeServer.active(host)).toBe(true)
		expect(host.attachWebviewMessageListener).toHaveBeenCalledTimes(1)
		expect(host.view!.webview.html).toContain("browser mode")

		expect(vscode.env.openExternal).toHaveBeenCalledTimes(1)
		const url = (vscode.Uri.parse as Mock).mock.calls[0][0] as string
		expect(url).toMatch(/^http:\/\/localhost:5173\/\?bridgePort=\d+&bridgeToken=[0-9a-f]{32}$/)
		expect(outputChannel.appendLine).toHaveBeenCalledWith(expect.stringContaining("[BrowserBridge] Listening on"))
	})

	it("opens the authoritative bridge when two commands race to bind", async () => {
		process.env.ROO_BROWSER_BRIDGE = "1"
		register()

		// Fire both handlers before either awaits its lazy socket.io import:
		// both start a server, and the loser of the bind race gets disposed.
		await Promise.all([handlers["zoo-code.openInBrowser"](), handlers["zoo-code.openInBrowser"]()])

		const winner = BrowserBridgeServer["bridges"].get(host)
		expect(winner).toBeDefined()
		const winnerUrl = `http://localhost:5173/?bridgePort=${winner!["_port"]}&bridgeToken=${winner!["token"]}`
		const urls = (vscode.Uri.parse as Mock).mock.calls.map(([value]) => value as string)
		// Both openExternal calls must target the authoritative bridge; the
		// `bridges.get(host) && bridge` mutant would open the disposed
		// newcomer's URL on the losing handler.
		expect(urls).toEqual([winnerUrl, winnerUrl])
	})

	it("reuses the existing bridge instead of starting a second server", async () => {
		process.env.ROO_BROWSER_BRIDGE = "1"
		register()

		await handlers["zoo-code.openInBrowser"]()
		const bridge = BrowserBridgeServer["bridges"].get(host)!
		const port = bridge["_port"]
		const token = bridge["token"]

		await handlers["zoo-code.openInBrowser"]()

		expect(outputChannel.appendLine).toHaveBeenCalledWith(
			`[openInBrowser] Reusing existing browser bridge on port ${port}.`,
		)
		expect(vscode.env.openExternal).toHaveBeenCalledTimes(2)
		// The reuse path reopens the same bridge with its original token.
		expect((vscode.Uri.parse as Mock).mock.calls[1][0]).toBe(
			`http://localhost:5173/?bridgePort=${port}&bridgeToken=${token}`,
		)
		// Still exactly one bind: the listener was not re-registered.
		expect(host.attachWebviewMessageListener).toHaveBeenCalledTimes(1)
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
