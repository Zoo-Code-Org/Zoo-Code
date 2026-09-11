// npx vitest run src/utils/__tests__/browserBridgeClient.spec.ts

import { BrowserBridgeClient } from "../browserBridgeClient"

// Capture the sockets created through the lazy `import("socket.io-client")` in
// BrowserBridgeClient.connect() without ever opening a real connection.
const { ioMock } = vi.hoisted(() => {
	type MockSocket = {
		on: ReturnType<typeof vi.fn>
		emit: ReturnType<typeof vi.fn>
		disconnect: ReturnType<typeof vi.fn>
		handlers: Record<string, ((...args: any[]) => void)[]>
	}

	const sockets: MockSocket[] = []

	return {
		ioMock: vi.fn((_url: string, _opts?: unknown) => {
			const handlers: MockSocket["handlers"] = {}
			const socket: MockSocket = {
				handlers,
				on: vi.fn((event: string, listener: (...args: any[]) => void) => {
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
	handlers: Record<string, ((...args: any[]) => void)[]>
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

	afterEach(() => {
		BrowserBridgeClient.resetForTests()
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
			setSearch(search)

			BrowserBridgeClient.maybeConnect()

			expect(BrowserBridgeClient.active()).toBe(false)
			await Promise.resolve()
			await Promise.resolve()
			expect(ioMock).not.toHaveBeenCalled()
		})

		it("connects and marks the document when a valid ?bridgePort is present", async () => {
			setSearch("?bridgePort=9999")

			BrowserBridgeClient.maybeConnect()

			expect(BrowserBridgeClient.active()).toBe(true)
			await awaitSockets()
			expect(ioMock).toHaveBeenCalledWith("http://127.0.0.1:9999", {
				transports: ["websocket", "polling"],
			})
			expect(document.documentElement.classList.contains("roo-browser-mode")).toBe(true)
		})

		it("is a no-op once an instance exists (singleton guard)", async () => {
			setSearch("?bridgePort=9999")

			BrowserBridgeClient.maybeConnect()
			BrowserBridgeClient.maybeConnect()

			await awaitSockets()
			expect(ioMock).toHaveBeenCalledTimes(1)
		})
	})

	describe("message flow", () => {
		const ready = { type: "webviewDidLaunch" } as any
		const later = { type: "showTaskWithId", text: "task-1" } as any

		it("is a no-op without an instance", () => {
			expect(() => BrowserBridgeClient.postMessage(ready)).not.toThrow()
			expect(ioMock).not.toHaveBeenCalled()
		})

		it("queues messages while connecting and flushes them in order on connect", async () => {
			setSearch("?bridgePort=9999")

			BrowserBridgeClient.maybeConnect()
			// The socket is not attached yet: both messages must be buffered.
			BrowserBridgeClient.postMessage(ready)
			BrowserBridgeClient.postMessage(later)

			await awaitSockets()
			const socket = createdSocket()
			expect(socket.emit).not.toHaveBeenCalled()

			for (const listener of socket.handlers["connect"]) {
				listener()
			}

			expect(socket.emit.mock.calls).toEqual([
				["webviewMessage", ready],
				["webviewMessage", later],
			])

			// The queue is drained: post-send goes straight to the socket.
			const sent = { type: "acceptInput" } as any
			BrowserBridgeClient.postMessage(sent)
			expect(socket.emit).toHaveBeenLastCalledWith("webviewMessage", sent)
		})

		it("re-dispatches inbound extensionMessage events through window.postMessage", async () => {
			const postMessageSpy = vi.spyOn(window, "postMessage")
			setSearch("?bridgePort=9999")

			BrowserBridgeClient.maybeConnect()
			await awaitSockets()
			const socket = createdSocket()

			const extensionMessage = { type: "state", values: {} } as any
			for (const listener of socket.handlers["extensionMessage"]) {
				listener(extensionMessage)
			}

			expect(postMessageSpy).toHaveBeenCalledWith(extensionMessage, "*")
			postMessageSpy.mockRestore()
		})
	})

	describe("resetForTests", () => {
		it("tears the singleton down and disconnects the socket", async () => {
			setSearch("?bridgePort=9999")

			BrowserBridgeClient.maybeConnect()
			await awaitSockets()
			const socket = createdSocket()

			BrowserBridgeClient.resetForTests()

			expect(BrowserBridgeClient.active()).toBe(false)
			expect(socket.disconnect).toHaveBeenCalledTimes(1)

			BrowserBridgeClient.postMessage({ type: "acceptInput" } as any)
			expect(socket.emit).not.toHaveBeenCalled()
		})
	})
})
