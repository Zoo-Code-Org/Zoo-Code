import WebSocket from "ws"

import { CodexWebSocketConnectionManager } from "../CodexWebSocketConnectionManager"
import { CodexWebSocketUnavailableError } from "../../errors/CodexWebSocketUnavailableError"
import { CodexWebSocketConnectionStateHolder } from "../../state-holders/CodexWebSocketConnectionStateHolder"
import type { CodexWebSocketOptions } from "../../models/protocol"

interface TestScope {
	socketRemoteDataSource: { socket: { readyState: number } }
	init: ReturnType<typeof vi.fn<(options: CodexWebSocketOptions) => Promise<void>>>
	dispose: ReturnType<typeof vi.fn<() => void>>
	open(): void
	fail(error: Error): void
	onError(): void
	onClose(): void
}

const { scopes } = vi.hoisted(() => ({ scopes: [] as TestScope[] }))

vi.mock("../../scopes/CodexWebSocketConnectionScope", () => {
	class TestConnectionScope implements TestScope {
		readonly socketRemoteDataSource = { socket: { readyState: WebSocket.CONNECTING as number } }
		private resolveInit?: () => void
		private rejectInit?: (error: Error) => void

		constructor(
			_url: string,
			readonly onError: () => void,
			readonly onClose: () => void,
		) {
			scopes.push(this)
		}

		init = vi.fn(
			(_options: CodexWebSocketOptions) =>
				new Promise<void>((resolve, reject) => {
					this.resolveInit = resolve
					this.rejectInit = reject
				}),
		)
		dispose = vi.fn(() => {
			this.socketRemoteDataSource.socket.readyState = WebSocket.CLOSED
		})
		open(): void {
			this.socketRemoteDataSource.socket.readyState = WebSocket.OPEN
			this.resolveInit?.()
		}
		fail(error: Error): void {
			this.rejectInit?.(error)
		}
	}
	return { CodexWebSocketConnectionScope: TestConnectionScope }
})

describe("CodexWebSocketConnectionManager state transitions", () => {
	let manager: CodexWebSocketConnectionManager
	let reset = vi.fn<() => void>()
	const options = (): CodexWebSocketOptions => ({
		headers: { Authorization: "Bearer test-token" },
		signal: new AbortController().signal,
		timeoutMs: 2_000,
	})
	const lastScope = (): TestScope => {
		const scope = scopes.at(-1)
		if (!scope) throw new Error("No test connection scope was created")
		return scope
	}

	beforeEach(() => {
		vi.useFakeTimers()
		scopes.length = 0
		reset = vi.fn()
		manager = new CodexWebSocketConnectionManager(
			"ws://test/responses",
			reset,
			new CodexWebSocketConnectionStateHolder(),
		)
	})

	afterEach(() => {
		manager.dispose()
		vi.useRealTimers()
		vi.restoreAllMocks()
	})

	it("moves from connecting to active to idle and back without retaining the idle timer", async () => {
		const acquired = manager.acquire(options())
		const scope = lastScope()
		manager.release()
		expect(vi.getTimerCount()).toBe(0)
		scope.open()
		await acquired
		manager.release()
		expect(vi.getTimerCount()).toBe(1)
		await expect(manager.acquire(options())).resolves.toBe(scope.socketRemoteDataSource.socket)
		expect(vi.getTimerCount()).toBe(0)
		await vi.advanceTimersByTimeAsync(120_000)
		expect(scope.dispose).not.toHaveBeenCalled()
		expect(scopes).toHaveLength(1)
	})

	it("rejects overlapping upgrades without disturbing the current attempt", async () => {
		const acquired = manager.acquire(options())
		const scope = lastScope()
		await expect(manager.acquire(options())).rejects.toThrow("Concurrent")
		expect(scopes).toHaveLength(1)
		expect(scope.dispose).not.toHaveBeenCalled()
		scope.open()
		await expect(acquired).resolves.toBe(scope.socketRemoteDataSource.socket)
	})

	it("replaces a socket that is no longer open even before its close callback runs", async () => {
		const acquired = manager.acquire(options())
		const first = lastScope()
		first.open()
		await acquired
		first.socketRemoteDataSource.socket.readyState = WebSocket.CLOSING
		const next = manager.acquire(options())
		const current = lastScope()
		current.open()
		await expect(next).resolves.toBe(current.socketRemoteDataSource.socket)
		expect(first.dispose).toHaveBeenCalledOnce()
		expect(scopes).toHaveLength(2)
	})

	it("preserves upgrade cooldown through cleanup without retaining a socket or timer", async () => {
		const failed = expect(manager.acquire(options())).rejects.toBeInstanceOf(CodexWebSocketUnavailableError)
		const scope = lastScope()
		scope.fail(new Error("Upgrade rejected"))
		await failed
		manager.dispose()
		manager.release()
		await expect(manager.acquire(options())).rejects.toBeInstanceOf(CodexWebSocketUnavailableError)
		expect(scope.dispose).toHaveBeenCalledOnce()
		expect(vi.getTimerCount()).toBe(0)
		expect(scopes).toHaveLength(1)
		await vi.advanceTimersByTimeAsync(60_000)
		const retried = manager.acquire(options())
		lastScope().open()
		await retried
		expect(scopes).toHaveLength(2)
	})

	it("preserves cancellation rather than reporting HTTP fallback during cooldown", async () => {
		const failed = expect(manager.acquire(options())).rejects.toBeInstanceOf(CodexWebSocketUnavailableError)
		lastScope().fail(new Error("Upgrade rejected"))
		await failed
		const controller = new AbortController()
		const reason = new Error("Stopped during cooldown")
		controller.abort(reason)
		await expect(manager.acquire({ ...options(), signal: controller.signal })).rejects.toBe(reason)
		await expect(manager.acquire(options())).rejects.toBeInstanceOf(CodexWebSocketUnavailableError)
		expect(scopes).toHaveLength(1)
	})

	it.each(["success", "failure"])(
		"ignores late upgrade %s after disposal and replacement",
		async (outcome: string) => {
			const first = manager.acquire(options())
			const rejected = expect(first).rejects.toThrow()
			const staleScope = lastScope()
			manager.dispose()
			const second = manager.acquire(options())
			const currentScope = lastScope()
			currentScope.open()
			await second
			if (outcome === "success") staleScope.open()
			else staleScope.fail(new Error("Late upgrade failure"))
			await rejected
			const resets = reset.mock.calls.length
			staleScope.onError()
			staleScope.onClose()
			expect(reset).toHaveBeenCalledTimes(resets)
			await expect(manager.acquire(options())).resolves.toBe(currentScope.socketRemoteDataSource.socket)
			expect(currentScope.dispose).not.toHaveBeenCalled()
			expect(scopes).toHaveLength(2)
		},
	)

	it("does not turn disposal of an in-flight upgrade into an HTTP fallback cooldown", async () => {
		const failed = expect(manager.acquire(options())).rejects.not.toBeInstanceOf(CodexWebSocketUnavailableError)
		const staleScope = lastScope()
		manager.dispose()
		staleScope.fail(new Error("Disposed upgrade"))
		await failed
		const next = manager.acquire(options())
		lastScope().open()
		await next
		expect(scopes).toHaveLength(2)
	})

	it("ignores a stale idle-timer callback after reacquiring the connection", async () => {
		const acquired = manager.acquire(options())
		const scope = lastScope()
		scope.open()
		await acquired
		const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout")
		manager.release()
		const callback = setTimeoutSpy.mock.calls.at(-1)?.[0]
		if (typeof callback !== "function") throw new Error("No idle timeout callback was registered")
		await manager.acquire(options())
		callback()
		expect(scope.dispose).not.toHaveBeenCalled()
		await expect(manager.acquire(options())).resolves.toBe(scope.socketRemoteDataSource.socket)
	})
})
