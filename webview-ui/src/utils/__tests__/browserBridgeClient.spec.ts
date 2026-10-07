// npx vitest run src/utils/__tests__/browserBridgeClient.spec.ts

import type { ExtensionMessage, WebviewMessage } from "@roo-code/types"

import { BrowserBridgeClient } from "../browserBridgeClient"

// Capture the sockets created through the lazy `import("socket.io-client")` in
// BrowserBridgeClient.connect() without ever opening a real connection.
const { ioMock } = vi.hoisted(() => {
	type MockSocket = {
		on: ReturnType<typeof vi.fn>
		emit: ReturnType<typeof vi.fn>
		disconnect: ReturnType<typeof vi.fn>
		handlers: Record<string, ((...args: unknown[]) => void)[]>
	}

	const sockets: MockSocket[] = []

	return {
		ioMock: vi.fn((_url: string, _opts?: unknown) => {
			const handlers: MockSocket["handlers"] = {}
			const socket: MockSocket = {
				handlers,
				on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
					handlers[event] = [...(handlers[event] ?? []), listener]
				}),
				emit: vi.fn(),
				disconnect: vi.fn(),
			}
			sockets.push(socket)
			return socket
		}),
	}
})

vi.mock("socket.io-client", () => ({ io: ioMock }))

/**
 * Flush the awaited module imports inside `connect()` (socket.io-client, the
 * browser-mode CSS, then socket creation) so the mock socket exists.
 */
async function awaitSockets(count = 1): Promise<void> {
	await vi.waitFor(() => expect(ioMock).toHaveBeenCalledTimes(count), { timeout: 2_000 })
}

type MockSocket = {
	on: ReturnType<typeof vi.fn>
	emit: ReturnType<typeof vi.fn>
	disconnect: ReturnType<typeof vi.fn>
	handlers: Record<string, ((...args: unknown[]) => void)[]>
}

function createdSocket(): MockSocket {
	return ioMock.mock.results[0].value as MockSocket
}

function setSearch(search: string): void {
	window.history.replaceState({}, "", search ? `/${search}` : "/")
}

describe("BrowserBridgeClient", () => {
	beforeEach(() => {
		ioMock.mockClear()
		setSearch("")
		document.documentElement.classList.remove("roo-browser-mode")
	})

	afterEach(async () => {
		await BrowserBridgeClient.resetForTests()
	})

	describe("maybeConnect self-gating", () => {
		it("stays inert in a plain dev-server tab without ?bridgePort", async () => {
			BrowserBridgeClient.maybeConnect()

			expect(BrowserBridgeClient.active()).toBe(false)
			await Promise.resolve()
			await Promise.resolve()
			expect(ioMock).not.toHaveBeenCalled()
			expect(document.documentElement.classList.contains("roo-browser-mode")).toBe(false)
		})

		it.each([
			"?bridgePort=abc",
			"?bridgePort=",
			"?bridgePort=0",
			"?bridgePort=-1",
			"?bridgePort=65536",
			"?bridgePort=80.5",
		])("ignores the invalid port value in %s", async (search) => {
			setSearch(`${search}&bridgeToken=test-token`)

			BrowserBridgeClient.maybeConnect()

			expect(BrowserBridgeClient.active()).toBe(false)
			await Promise.resolve()
			await Promise.resolve()
			expect(ioMock).not.toHaveBeenCalled()
		})

		it.each(["?bridgePort=9999", "?bridgePort=9999&bridgeToken="])(
			"stays inert with a valid port but no usable token in %s",
			async (search) => {
				// The server rejects every handshake without the bridge token,
				// so a port alone (or an empty token param) must not produce a
				// permanently failing connection attempt.
				setSearch(search)

				BrowserBridgeClient.maybeConnect()

				expect(BrowserBridgeClient.active()).toBe(false)
				await Promise.resolve()
				await Promise.resolve()
				expect(ioMock).not.toHaveBeenCalled()
				expect(document.documentElement.classList.contains("roo-browser-mode")).toBe(false)
			},
		)

		it("connects and marks the document when a valid ?bridgePort is present", async () => {
			setSearch("?bridgePort=9999&bridgeToken=test-token")

			BrowserBridgeClient.maybeConnect()

			expect(BrowserBridgeClient.active()).toBe(true)
			// The initial status is observable before the socket exists;
			// connect() only transitions it afterwards.
			expect(BrowserBridgeClient["instance"]!["status"]).toBe("init")
			await awaitSockets()
			expect(ioMock).toHaveBeenCalledWith("http://127.0.0.1:9999", {
				auth: { token: "test-token" },
				transports: ["polling", "websocket"],
			})
			expect(document.documentElement.classList.contains("roo-browser-mode")).toBe(true)
		})

		it("is a no-op once an instance exists (singleton guard)", async () => {
			setSearch("?bridgePort=9999&bridgeToken=test-token")

			BrowserBridgeClient.maybeConnect()
			const first = BrowserBridgeClient["instance"]!
			BrowserBridgeClient.maybeConnect()

			// A regressed guard would replace the singleton with a fresh
			// instance whose initProcess resolves only after another io()
			// call, so awaiting the current singleton's initProcess makes the
			// count assertion deterministic instead of racing the microtask
			// queue (the previous flush-then-count check passed under the
			// second instance while its socket creation was still pending).
			await BrowserBridgeClient["instance"]?.["initProcess"]
			await new Promise((resolve) => setTimeout(resolve, 0))

			expect(BrowserBridgeClient["instance"]).toBe(first)
			expect(ioMock).toHaveBeenCalledTimes(1)
		})
	})

	describe("queue initialization", () => {
		// The static field initializer runs once per module load, so only a
		// freshly-reset module can observe a corrupted initial queue.
		it("flushes exactly the posted messages on a freshly-loaded module", async () => {
			ioMock.mockClear()
			vi.resetModules()
			const { BrowserBridgeClient: FreshClient } = await import("../browserBridgeClient")
			try {
				const ready: WebviewMessage = { type: "webviewDidLaunch" }
				const later: WebviewMessage = { type: "showTaskWithId", text: "task-1" }
				setSearch("?bridgePort=9999&bridgeToken=test-token")

				FreshClient.maybeConnect()
				FreshClient.postMessage(ready)
				FreshClient.postMessage(later)

				await awaitSockets()
				const socket = createdSocket()
				expect(socket.emit.mock.calls).toEqual([
					["webviewMessage", ready],
					["webviewMessage", later],
				])
			} finally {
				await FreshClient.resetForTests()
			}
		})
	})

	describe("message flow", () => {
		const ready: WebviewMessage = { type: "webviewDidLaunch" }
		const later: WebviewMessage = { type: "showTaskWithId", text: "task-1" }

		it("is a no-op without an instance", () => {
			expect(() => BrowserBridgeClient.postMessage(ready)).not.toThrow()
			expect(ioMock).not.toHaveBeenCalled()
		})

		it("queues messages while connecting and flushes them in order at socket creation", async () => {
			setSearch("?bridgePort=9999&bridgeToken=test-token")

			BrowserBridgeClient.maybeConnect()
			// The socket is not attached yet: both messages must be buffered.
			BrowserBridgeClient.postMessage(ready)
			BrowserBridgeClient.postMessage(later)

			// The queue drains as soon as the socket is created, not from the
			// "connect" listener: socket.io flushes its own pre-connect
			// sendBuffer FIFO before "connect" fires, so a later drain would
			// reorder queued messages behind anything posted meanwhile.
			await awaitSockets()
			const socket = createdSocket()
			expect(socket.emit.mock.calls).toEqual([
				["webviewMessage", ready],
				["webviewMessage", later],
			])

			// The queue is drained: post-send goes straight to the socket.
			const sent: WebviewMessage = { type: "clearTask" }
			BrowserBridgeClient.postMessage(sent)
			expect(socket.emit).toHaveBeenLastCalledWith("webviewMessage", sent)
		})

		it("preserves ordering for a message posted between socket creation and connect", async () => {
			setSearch("?bridgePort=9999&bridgeToken=test-token")

			BrowserBridgeClient.maybeConnect()
			// A is buffered before the socket exists.
			BrowserBridgeClient.postMessage(ready)

			// Wait only for the socket to be created; the "connect" event has
			// not fired (the mock never fires it). B lands directly on the
			// socket after A's queued drain, so the wire order must be A, B.
			await awaitSockets()
			const socket = createdSocket()
			BrowserBridgeClient.postMessage(later)

			expect(socket.emit.mock.calls).toEqual([
				["webviewMessage", ready],
				["webviewMessage", later],
			])
			// The permanent "connect" listener only tracks the connection
			// status; firing it must not re-emit anything.
			expect(socket.handlers["connect"]).toHaveLength(1)
			for (const listener of socket.handlers["connect"]) {
				listener()
			}
			// The "connect" listener must record the transition; an empty
			// listener body or a mutated status string leaves the client on
			// "init".
			expect(BrowserBridgeClient["instance"]!["status"]).toBe("connected")
			expect(socket.emit.mock.calls).toEqual([
				["webviewMessage", ready],
				["webviewMessage", later],
			])
		})

		it("re-dispatches inbound extensionMessage events through window.postMessage", async () => {
			const postMessageSpy = vi.spyOn(window, "postMessage")
			setSearch("?bridgePort=9999&bridgeToken=test-token")

			BrowserBridgeClient.maybeConnect()
			await awaitSockets()
			const socket = createdSocket()

			const extensionMessage: ExtensionMessage = { type: "state", values: {} }
			for (const listener of socket.handlers["extensionMessage"]) {
				listener(extensionMessage)
			}

			expect(postMessageSpy).toHaveBeenCalledWith(extensionMessage, "*")
			postMessageSpy.mockRestore()
		})

		it("registers a connect_error listener that warns with the failure", async () => {
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
			setSearch("?bridgePort=9999&bridgeToken=test-token")

			BrowserBridgeClient.maybeConnect()
			await awaitSockets()
			const socket = createdSocket()

			// The listener must exist under the exact event name socket.io emits.
			expect(socket.handlers["connect_error"]).toHaveLength(1)

			const failure = new Error("boom")
			for (const listener of socket.handlers["connect_error"]) {
				listener(failure)
			}
			expect(warnSpy).toHaveBeenCalledWith("[BrowserBridge] socket.io connect error:", failure)
			warnSpy.mockRestore()
		})

		it("deactivates the bridge when the server rejects the handshake token", async () => {
			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
			setSearch("?bridgePort=9999&bridgeToken=bad-token")

			BrowserBridgeClient.maybeConnect()
			await awaitSockets()
			const socket = createdSocket()
			const client = BrowserBridgeClient["instance"]!
			expect(BrowserBridgeClient.active()).toBe(true)

			// socket.io never retries a middleware rejection, so an error
			// carrying the server's "unauthorized" wire message must tear the
			// singleton down instead of leaving active() true over a dead
			// socket that would silently swallow every later postMessage. The
			// literal (not the shared constant) pins the cross-process wire
			// contract from the client side.
			const rejection = new Error("unauthorized")
			for (const listener of socket.handlers["connect_error"]) {
				listener(rejection)
			}

			expect(BrowserBridgeClient.active()).toBe(false)
			expect(socket.disconnect).toHaveBeenCalledTimes(1)
			expect(client["status"]).toBe("disposed")
			expect(errorSpy).toHaveBeenCalledWith(
				"[BrowserBridge] The bridge server rejected the handshake token; deactivating.",
			)
			errorSpy.mockRestore()

			// Deactivated means gone: a postMessage must not reach the dead
			// socket or a queue, and a re-run of maybeConnect starts a fresh
			// bridge (the recovery path: re-open the tab with a new token).
			socket.emit.mockClear()
			BrowserBridgeClient.postMessage({ type: "clearTask" })
			expect(socket.emit).not.toHaveBeenCalled()

			setSearch("?bridgePort=9999&bridgeToken=good-token")
			BrowserBridgeClient.maybeConnect()
			await awaitSockets(2)
			expect(BrowserBridgeClient.active()).toBe(true)
		})

		it("keeps a transient (non-rejection) connect_error retryable", async () => {
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
			setSearch("?bridgePort=9999&bridgeToken=test-token")

			BrowserBridgeClient.maybeConnect()
			await awaitSockets()
			const socket = createdSocket()

			// A network blip (server not up yet) must NOT deactivate: socket.io
			// keeps retrying those on its own, and the bridge recovers.
			for (const listener of socket.handlers["connect_error"]) {
				listener(new Error("xhr poll error"))
			}

			expect(BrowserBridgeClient.active()).toBe(true)
			expect(socket.disconnect).not.toHaveBeenCalled()
			// A transient failure stays retryable: the status must move off
			// "init" without becoming the fatal "disposed".
			expect(BrowserBridgeClient["instance"]!["status"]).toBe("retry")
			warnSpy.mockRestore()
		})
	})

	describe("connect() initialization failure", () => {
		it("logs the failure, deactivates the singleton, un-marks the document and drops the queued messages", async () => {
			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
			setSearch("?bridgePort=9999&bridgeToken=test-token")

			// The lazy socket.io-client import resolves, but socket creation
			// rejects: connect() settles as a failure with no socket attached.
			ioMock.mockImplementationOnce(() => {
				throw new Error("socket boom")
			})

			BrowserBridgeClient.maybeConnect()
			const stale: WebviewMessage = { type: "webviewDidLaunch" }
			BrowserBridgeClient.postMessage(stale)

			await vi.waitFor(() => expect(BrowserBridgeClient.active()).toBe(false), { timeout: 2_000 })
			expect(errorSpy).toHaveBeenCalledWith(
				"[BrowserBridge] Failed to initialize the browser bridge:",
				expect.any(Error),
			)
			// connect() marked the document before the socket creation threw;
			// disposal must un-mark it so the dead tab keeps no bridge styling.
			expect(document.documentElement.classList.contains("roo-browser-mode")).toBe(false)
			errorSpy.mockRestore()

			// A later bridge client must start from an empty queue rather than
			// replaying the message left behind by the failed one.
			BrowserBridgeClient.maybeConnect()
			await awaitSockets(2)
			const socket = ioMock.mock.results[1].value as MockSocket
			expect(socket.emit).not.toHaveBeenCalled()
		})

		it("disconnects and clears the socket when initialization fails after creation", async () => {
			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
			setSearch("?bridgePort=9999&bridgeToken=test-token")

			// The socket is created, but registering its first listener throws,
			// so connect() rejects with `this.socket` already attached and the
			// failure handler must disconnect it.
			const halfLive: MockSocket = {
				handlers: {},
				on: vi.fn(() => {
					throw new Error("on boom")
				}),
				emit: vi.fn(),
				disconnect: vi.fn(),
			}
			ioMock.mockImplementationOnce(() => halfLive)

			BrowserBridgeClient.maybeConnect()

			await vi.waitFor(() => expect(BrowserBridgeClient.active()).toBe(false), { timeout: 2_000 })
			expect(halfLive.disconnect).toHaveBeenCalledTimes(1)
			// The document was already marked when the failure hit; disposal
			// must remove the browser-mode class along with the socket.
			expect(document.documentElement.classList.contains("roo-browser-mode")).toBe(false)
			errorSpy.mockRestore()
		})
	})

	describe("resetForTests before the socket exists", () => {
		it("tears down an instance whose connect() has not attached a socket yet", async () => {
			setSearch("?bridgePort=9999&bridgeToken=test-token")

			BrowserBridgeClient.maybeConnect()
			// The lazy socket.io-client import has not resolved: `socket` is
			// still undefined, so the optional chaining in resetForTests matters.
			await expect(BrowserBridgeClient.resetForTests()).resolves.toBeUndefined()
			expect(BrowserBridgeClient.active()).toBe(false)
		})
	})

	describe("production-build self-gating (import.meta.env.DEV)", () => {
		afterEach(() => {
			vi.unstubAllEnvs()
		})

		it("maybeConnect stays inert when DEV is false, even with a valid port", async () => {
			vi.stubEnv("DEV", false)
			setSearch("?bridgePort=9999&bridgeToken=test-token")

			BrowserBridgeClient.maybeConnect()

			expect(BrowserBridgeClient.active()).toBe(false)
			// Without the DEV gate maybeConnect would build an instance whose
			// initProcess resolves only after socket.io has been invoked, so
			// awaiting it (plus one macrotask flush) makes the "never
			// connects" assertion deterministic instead of racing two
			// microtask flushes against the lazy imports.
			await BrowserBridgeClient["instance"]?.["initProcess"]
			await new Promise((resolve) => setTimeout(resolve, 0))
			expect(ioMock).not.toHaveBeenCalled()
		})

		it("active() reports false when DEV flips off, even with a live instance", async () => {
			setSearch("?bridgePort=9999&bridgeToken=test-token")
			BrowserBridgeClient.maybeConnect()
			await awaitSockets()
			expect(BrowserBridgeClient.active()).toBe(true)

			vi.stubEnv("DEV", false)
			expect(BrowserBridgeClient.active()).toBe(false)
		})
	})

	describe("resetForTests", () => {
		it("tears the singleton down and disconnects the socket", async () => {
			setSearch("?bridgePort=9999&bridgeToken=test-token")

			BrowserBridgeClient.maybeConnect()
			await awaitSockets()
			const socket = createdSocket()

			await BrowserBridgeClient.resetForTests()

			expect(BrowserBridgeClient.active()).toBe(false)
			expect(socket.disconnect).toHaveBeenCalledTimes(1)
			expect(document.documentElement.classList.contains("roo-browser-mode")).toBe(false)

			BrowserBridgeClient.postMessage({ type: "clearTask" })
			expect(socket.emit).not.toHaveBeenCalled()
		})

		it("waits for the pending connect before tearing the singleton down", async () => {
			setSearch("?bridgePort=9999&bridgeToken=test-token")

			BrowserBridgeClient.maybeConnect()
			const client = BrowserBridgeClient["instance"]!
			// While the status is still "init" the socket does not exist yet,
			// so resetForTests must await initProcess before disposing:
			// otherwise dispose() skips disconnect() and a real teardown
			// would leak the in-flight connection. A dropped await (or a
			// broken status comparison) leaves ioMock.results empty here.
			await BrowserBridgeClient.resetForTests()

			const socket = createdSocket()
			expect(socket.disconnect).toHaveBeenCalledTimes(1)
			expect(client["status"]).toBe("disposed")
		})

		it("a stale dispose() does not clobber the live singleton", async () => {
			setSearch("?bridgePort=9999&bridgeToken=token-a")
			BrowserBridgeClient.maybeConnect()
			const stale = BrowserBridgeClient["instance"]!
			await awaitSockets()

			await BrowserBridgeClient.resetForTests()
			setSearch("?bridgePort=9999&bridgeToken=token-b")
			BrowserBridgeClient.maybeConnect()
			await awaitSockets(2)

			// Re-disposing an instance that the singleton no longer points to
			// must not clear the live one: dispose() only owns the statics
			// while `instance === this`.
			stale["dispose"]()

			expect(BrowserBridgeClient.active()).toBe(true)
			BrowserBridgeClient.postMessage({ type: "clearTask" })
			const live = ioMock.mock.results[1].value as MockSocket
			expect(live.emit).toHaveBeenCalledWith("webviewMessage", { type: "clearTask" })
		})
	})
})
