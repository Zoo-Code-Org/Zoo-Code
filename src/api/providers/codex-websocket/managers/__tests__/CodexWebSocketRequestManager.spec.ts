import WebSocket from "ws"

import { CodexWebSocketConnectionManager } from "../CodexWebSocketConnectionManager"
import { CodexWebSocketRequestManager } from "../CodexWebSocketRequestManager"
import { CodexWebSocketUnavailableError } from "../../errors/CodexWebSocketUnavailableError"
import { CodexWebSocketConnectionStateHolder } from "../../state-holders/CodexWebSocketConnectionStateHolder"
import { CodexWebSocketRequestStateHolder } from "../../state-holders/CodexWebSocketRequestStateHolder"

vi.mock("ws", async () => {
	const { EventEmitter } = await import("node:events")
	return {
		default: class TestSocket extends EventEmitter {
			constructor(_url: string) {
				super()
			}
		},
	}
})

describe("CodexWebSocketRequestManager state transitions", () => {
	let manager: CodexWebSocketRequestManager
	let connection: CodexWebSocketConnectionManager
	let socket: WebSocket
	let stateHolder: CodexWebSocketRequestStateHolder
	let onAbort = vi.fn<() => void>()

	beforeEach(() => {
		vi.useFakeTimers()
		onAbort = vi.fn()
		socket = new WebSocket("ws://test/responses")
		connection = new CodexWebSocketConnectionManager(
			"ws://test/responses",
			vi.fn(),
			new CodexWebSocketConnectionStateHolder(),
		)
		vi.spyOn(connection, "acquire").mockResolvedValue(socket)
		stateHolder = new CodexWebSocketRequestStateHolder()
		manager = new CodexWebSocketRequestManager(
			{ headers: {}, signal: new AbortController().signal, timeoutMs: 2_000 },
			onAbort,
			stateHolder,
		)
	})

	afterEach(async () => {
		await manager.dispose()
		vi.useRealTimers()
		vi.restoreAllMocks()
	})

	it("makes socket, subscriptions, and deadline unavailable together after disposal", async () => {
		await manager.init(connection)
		manager.refreshTimeout()
		expect(manager.socket).toBe(socket)
		expect(socket.listenerCount("message")).toBe(1)
		expect(vi.getTimerCount()).toBe(1)
		await manager.dispose()
		await manager.dispose()
		expect(() => manager.socket).toThrow("not initialized")
		expect(() => manager.events).toThrow("not initialized")
		expect(() => manager.refreshTimeout()).toThrow("not initialized")
		expect(socket.eventNames()).toEqual([])
		expect(vi.getTimerCount()).toBe(0)
	})

	it("reads the caller signal and clears deadlines safely before initialization and after disposal", async () => {
		expect(manager.signal).toBeInstanceOf(AbortSignal)
		expect(manager.signal.aborted).toBe(false)
		manager.clearTimeout()
		await manager.init(connection)
		await manager.dispose()
		manager.clearTimeout()
		expect(vi.getTimerCount()).toBe(0)
	})

	it("rejects repeated initialization without disturbing an active request", async () => {
		await manager.init(connection)
		const signal = manager.signal
		await expect(manager.init(connection)).rejects.toThrow("already initialized")
		expect(manager.signal).toBe(signal)
		expect(manager.socket).toBe(socket)
		expect(socket.listenerCount("message")).toBe(1)
		expect(connection.acquire).toHaveBeenCalledOnce()
	})

	it("rejects overlapping initialization while acquisition is still pending", async () => {
		let resolve: ((value: WebSocket) => void) | undefined
		vi.mocked(connection.acquire).mockImplementationOnce(
			() =>
				new Promise<WebSocket>((complete) => {
					resolve = complete
				}),
		)
		const initialized = manager.init(connection)
		await expect(manager.init(connection)).rejects.toThrow("already initialized")
		if (!resolve) throw new Error("Acquisition was not started")
		resolve(socket)
		await initialized
		expect(manager.socket).toBe(socket)
		expect(connection.acquire).toHaveBeenCalledOnce()
	})

	it("does not convert a failed upgrade into cancellation during cleanup", async () => {
		const error = new CodexWebSocketUnavailableError("Upgrade rejected")
		vi.mocked(connection.acquire).mockRejectedValueOnce(error)
		await expect(manager.init(connection)).rejects.toBe(error)
		expect(manager.signal.aborted).toBe(false)
		expect(onAbort).not.toHaveBeenCalled()
		await manager.init(connection)
		expect(manager.socket).toBe(socket)
	})

	it("ignores stale request initialization after disposal and reinitialization", async () => {
		let resolveFirst: ((value: WebSocket) => void) | undefined
		vi.mocked(connection.acquire).mockImplementationOnce(
			() => new Promise<WebSocket>((resolve) => (resolveFirst = resolve)),
		)
		const first = expect(manager.init(connection)).rejects.toThrow("scope was disposed")
		await manager.dispose()
		await manager.init(connection)
		const currentSignal = manager.signal
		const staleSocket = new WebSocket("ws://stale/responses")
		if (!resolveFirst) throw new Error("First acquisition was not started")
		resolveFirst(staleSocket)
		await first
		expect(manager.socket).toBe(socket)
		expect(manager.signal).toBe(currentSignal)
		expect(currentSignal.aborted).toBe(false)
		expect(socket.listenerCount("message")).toBe(1)
		expect(staleSocket.listenerCount("message")).toBe(0)
	})

	it("rejects acquisition completing after the injected holder has discarded the attempt", async () => {
		const initialized = expect(manager.init(connection)).rejects.toThrow("scope was disposed")
		const abandoned = stateHolder.dispose()
		await initialized
		expect(socket.eventNames()).toEqual([])
		expect(() => manager.socket).toThrow("not initialized")
		// Discarding state is not IO cleanup: the owner must release its abandoned listener.
		if (abandoned.status !== "initializing") throw new Error("Expected an initializing request")
		abandoned.signal.removeEventListener("abort", onAbort)
		expect(abandoned.signal.aborted).toBe(false)
	})

	it.each(["refresh", "clear", "dispose"])(
		"ignores a stale deadline callback after %s",
		async (operation: string) => {
			await manager.init(connection)
			const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout")
			manager.refreshTimeout()
			const callback = setTimeoutSpy.mock.calls.at(-1)?.[0]
			if (typeof callback !== "function") throw new Error("No deadline callback was registered")
			if (operation === "refresh") manager.refreshTimeout()
			else if (operation === "clear") manager.clearTimeout()
			else await manager.dispose()
			callback()
			expect(manager.signal.aborted).toBe(false)
			expect(onAbort).not.toHaveBeenCalled()
		},
	)

	it("preserves timeout cancellation as the outcome of a disposed request", async () => {
		await manager.init(connection)
		manager.refreshTimeout()
		await vi.advanceTimersByTimeAsync(2_000)
		expect(onAbort).toHaveBeenCalledOnce()
		const signal = manager.signal
		expect(signal.reason).toEqual(new Error("Codex WebSocket stream timed out"))
		await manager.dispose()
		expect(manager.signal).toBe(signal)
		expect(socket.eventNames()).toEqual([])
	})
})
