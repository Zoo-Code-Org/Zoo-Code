import WebSocket from "ws"

import { CodexWebSocketTransport } from "../../../CodexWebSocketTransport"
import { CodexWebSocketResponseLocalDataSource } from "../../data/local/CodexWebSocketResponseLocalDataSource"
import { CodexWebSocketContinuationRepository } from "../../repositories/CodexWebSocketContinuationRepository"
import { CodexWebSocketConnectionManager } from "../../managers/CodexWebSocketConnectionManager"
import { CodexWebSocketConnectionScope } from "../CodexWebSocketConnectionScope"
import { CodexWebSocketRequestScope } from "../CodexWebSocketRequestScope"
import { CodexWebSocketTransportScope } from "../CodexWebSocketTransportScope"
import { CodexWebSocketRequestManager } from "../../managers/CodexWebSocketRequestManager"
import { CodexWebSocketResponseManager } from "../../managers/CodexWebSocketResponseManager"
import { CodexWebSocketSocketRemoteDataSource } from "../../data/remote/CodexWebSocketSocketRemoteDataSource"
import { CodexWebSocketUnavailableError } from "../../errors/CodexWebSocketUnavailableError"
import type { CodexWebSocketOptions } from "../../models/protocol"
import { CodexWebSocketConnectionStateHolder } from "../../state-holders/CodexWebSocketConnectionStateHolder"
import { CodexWebSocketRequestStateHolder } from "../../state-holders/CodexWebSocketRequestStateHolder"

const { sockets } = vi.hoisted(() => ({ sockets: [] as WebSocket[] }))

vi.mock("ws", async () => {
	const { EventEmitter } = await import("node:events")
	class MockWebSocket extends EventEmitter {
		static readonly CONNECTING = 0
		static readonly OPEN = 1
		static readonly CLOSING = 2
		static readonly CLOSED = 3
		readyState = MockWebSocket.CONNECTING

		constructor() {
			super()
			// The mock implements the socket surface used by these scopes, not all of ws.
			sockets.push(this as unknown as WebSocket)
		}

		override emit(event: string | symbol, ...args: unknown[]): boolean {
			if (event === "open") this.readyState = MockWebSocket.OPEN
			if (event === "close") this.readyState = MockWebSocket.CLOSED
			return super.emit(event, ...args)
		}

		terminate = vi.fn(() => {
			const connecting = this.readyState === MockWebSocket.CONNECTING
			this.readyState = MockWebSocket.CLOSING
			queueMicrotask(() => {
				if (connecting) this.emit("error", new Error("WebSocket closed before the connection was established"))
				this.emit("close")
			})
		})
	}
	return { default: MockWebSocket }
})

describe("Codex WebSocket scopes", () => {
	const resources: { dispose(): void | Promise<void> }[] = []
	let controller: AbortController
	let options: CodexWebSocketOptions
	let reset = vi.fn<() => void>()
	let connection: CodexWebSocketConnectionManager
	let repository: CodexWebSocketContinuationRepository
	const body = { model: "test-model", input: [] }

	const own = <T extends { dispose(): void | Promise<void> }>(resource: T): T => {
		resources.push(resource)
		return resource
	}
	const lastSocket = (): WebSocket => {
		const socket = sockets.at(-1)
		if (!socket) throw new Error("No test socket was created")
		return socket
	}
	const expectNoListeners = (socket: WebSocket) => {
		expect(socket.eventNames()).toEqual([])
	}

	beforeEach(() => {
		sockets.length = 0
		controller = new AbortController()
		options = { headers: { Authorization: "Bearer test-token" }, signal: controller.signal, timeoutMs: 2_000 }
		reset = vi.fn()
		connection = own(
			new CodexWebSocketConnectionManager(
				"ws://test/responses",
				reset,
				new CodexWebSocketConnectionStateHolder(),
			),
		)
		repository = new CodexWebSocketContinuationRepository(new CodexWebSocketResponseLocalDataSource())
	})

	afterEach(async () => {
		for (const resource of resources.splice(0).reverse()) await resource.dispose()
		vi.useRealTimers()
		vi.restoreAllMocks()
	})

	it("does not create sockets, subscriptions, or timers in constructors", async () => {
		vi.useFakeTimers()
		const addListener = vi.spyOn(AbortSignal.prototype, "addEventListener")
		const onAbort = vi.fn()
		const scope = own(new CodexWebSocketConnectionScope("ws://test/responses", vi.fn(), vi.fn()))
		const requestScope = own(new CodexWebSocketRequestScope(options, onAbort))
		const request = own(new CodexWebSocketRequestManager(options, onAbort, new CodexWebSocketRequestStateHolder()))
		own(new CodexWebSocketSocketRemoteDataSource("ws://test/responses", vi.fn(), vi.fn()))
		expect(sockets).toHaveLength(0)
		expect(addListener).not.toHaveBeenCalled()
		expect(vi.getTimerCount()).toBe(0)
		expect(() => scope.socketRemoteDataSource).toThrow("not initialized")
		expect(() => requestScope.requestManager).toThrow("not initialized")
		expect(() => request.socket).toThrow("not initialized")
		expect(() => request.events).toThrow("not initialized")
		expect(() => request.refreshTimeout()).toThrow("not initialized")
		scope.dispose()
		await requestScope.dispose()
		await request.dispose()
		controller.abort()
		expect(onAbort).not.toHaveBeenCalled()
	})

	it("exposes only owned services and lifecycle methods on scopes", () => {
		expect(Object.getOwnPropertyNames(CodexWebSocketConnectionScope.prototype).sort()).toEqual(
			["constructor", "socketRemoteDataSource", "init", "dispose"].sort(),
		)
		expect(Object.getOwnPropertyNames(CodexWebSocketRequestScope.prototype).sort()).toEqual(
			["constructor", "requestManager", "responseManager", "init", "dispose"].sort(),
		)
		expect(Object.getOwnPropertyNames(CodexWebSocketTransportScope.prototype).sort()).toEqual(
			["constructor", "transport", "init", "dispose"].sort(),
		)
	})

	it("assembles the transport only on root-scope initialization without creating runtime resources", async () => {
		vi.useFakeTimers()
		const addListener = vi.spyOn(AbortSignal.prototype, "addEventListener")
		const scope = own(new CodexWebSocketTransportScope("ws://test/responses"))
		expect(() => scope.transport).toThrow("not initialized")
		await scope.dispose()
		scope.init()
		const transport = scope.transport
		expect(transport).toBeInstanceOf(CodexWebSocketTransport)
		expect(() => scope.init()).toThrow("already initialized")
		expect(sockets).toHaveLength(0)
		expect(addListener).not.toHaveBeenCalled()
		expect(vi.getTimerCount()).toBe(0)
		const dispose = vi.spyOn(transport, "dispose")
		await scope.dispose()
		await scope.dispose()
		expect(dispose).toHaveBeenCalledOnce()
		expect(() => scope.transport).toThrow("not initialized")
		scope.init()
		expect(scope.transport).not.toBe(transport)
	})

	it("creates the connection on init and removes its subscriptions on disposal", async () => {
		const onError = vi.fn()
		const onClose = vi.fn()
		const scope = own(new CodexWebSocketConnectionScope("ws://test/responses", onError, onClose))
		const initialized = scope.init(options)
		const socket = lastSocket()
		socket.emit("open")
		await initialized
		expect(scope.socketRemoteDataSource).toBeInstanceOf(CodexWebSocketSocketRemoteDataSource)
		expect(scope.socketRemoteDataSource.socket).toBe(socket)
		await expect(scope.init(options)).rejects.toThrow("already initialized")
		socket.emit("error", new Error("Idle error"))
		expect(onError).toHaveBeenCalledOnce()
		scope.dispose()
		scope.dispose()
		expect(socket.terminate).toHaveBeenCalledOnce()
		expect(() => scope.socketRemoteDataSource).toThrow("not initialized")
		await Promise.resolve()
		expect(onClose).not.toHaveBeenCalled()
		expectNoListeners(socket)
	})

	it("guards direct socket access and initialization without duplicating handlers", async () => {
		const source = own(new CodexWebSocketSocketRemoteDataSource("ws://test/responses", vi.fn(), vi.fn()))
		expect(() => source.socket).toThrow("not initialized")
		source.dispose()
		const initialized = source.init(options)
		const socket = lastSocket()
		socket.emit("open")
		await initialized
		expect(source.socket).toBe(socket)
		await expect(source.init(options)).rejects.toThrow("already initialized")
		expect(socket.listenerCount("error")).toBe(1)
		expect(socket.listenerCount("close")).toBe(1)
	})

	it("ignores stale socket-close dispatch after a replacement has initialized", async () => {
		const onClose = vi.fn()
		const source = own(new CodexWebSocketSocketRemoteDataSource("ws://test/responses", vi.fn(), onClose))
		const firstInit = source.init(options)
		const first = lastSocket()
		first.emit("open")
		await firstInit
		const staleClose = first.listeners("close")[0]
		if (!staleClose) throw new Error("No socket-close handler was registered")
		source.dispose()
		const nextInit = source.init(options)
		const next = lastSocket()
		next.emit("open")
		await nextInit
		staleClose()
		expect(onClose).not.toHaveBeenCalled()
		expect(source.socket).toBe(next)
	})

	it("preserves a replacement socket when a previous handshake finishes after disposal", async () => {
		const source = own(new CodexWebSocketSocketRemoteDataSource("ws://test/responses", vi.fn(), vi.fn()))
		const firstInit = expect(source.init(options)).rejects.toThrow("scope was disposed")
		const first = lastSocket()
		first.emit("open")
		source.dispose()
		const nextInit = source.init(options)
		const next = lastSocket()
		next.emit("open")
		await firstInit
		await nextInit
		expect(source.socket).toBe(next)
		expectNoListeners(first)
	})

	it("does not let late service initialization dispose a replacement connection scope", async () => {
		vi.spyOn(CodexWebSocketSocketRemoteDataSource.prototype, "init").mockResolvedValue()
		const scope = own(new CodexWebSocketConnectionScope("ws://test/responses", vi.fn(), vi.fn()))
		const firstInit = expect(scope.init(options)).rejects.toThrow("connection scope was disposed")
		scope.dispose()
		await scope.init(options)
		const replacement = scope.socketRemoteDataSource
		await firstInit
		expect(scope.socketRemoteDataSource).toBe(replacement)
		expect(sockets).toHaveLength(0)
	})

	it("safely disposes an in-flight upgrade without retaining listeners", async () => {
		const onError = vi.fn()
		const onClose = vi.fn()
		const scope = own(new CodexWebSocketConnectionScope("ws://test/responses", onError, onClose))
		const initialized = expect(scope.init(options)).rejects.toThrow("before the connection was established")
		const socket = lastSocket()
		scope.dispose()
		await initialized
		expect(onError).not.toHaveBeenCalled()
		expect(onClose).not.toHaveBeenCalled()
		expectNoListeners(socket)
	})

	it("cleans up cancellation after socket open but before initialization resolves", async () => {
		const scope = own(new CodexWebSocketConnectionScope("ws://test/responses", vi.fn(), vi.fn()))
		const initialized = scope.init(options)
		const reason = new Error("Stopped after socket open")
		const rejected = expect(initialized).rejects.toBe(reason)
		const socket = lastSocket()
		socket.emit("open")
		controller.abort(reason)
		await rejected
		expect(socket.terminate).toHaveBeenCalledOnce()
		expect(() => scope.socketRemoteDataSource).toThrow("not initialized")
		expectNoListeners(socket)
	})

	it("removes subscriptions from an already-closed socket", async () => {
		const onClose = vi.fn()
		const scope = own(new CodexWebSocketConnectionScope("ws://test/responses", vi.fn(), onClose))
		const initialized = scope.init(options)
		const socket = lastSocket()
		socket.emit("open")
		await initialized
		socket.emit("close")
		expect(onClose).toHaveBeenCalledOnce()
		scope.dispose()
		expect(socket.terminate).not.toHaveBeenCalled()
		expectNoListeners(socket)
	})

	it("can initialize again after disposal without stale callbacks affecting the new socket", async () => {
		const onError = vi.fn()
		const onClose = vi.fn()
		const scope = own(new CodexWebSocketConnectionScope("ws://test/responses", onError, onClose))
		const firstInit = scope.init(options)
		const first = lastSocket()
		first.emit("open")
		await firstInit
		scope.dispose()
		const nextInit = scope.init(options)
		const next = lastSocket()
		first.emit("error", new Error("Stale error"))
		next.emit("open")
		await nextInit
		expectNoListeners(first)
		expect(onError).not.toHaveBeenCalled()
		expect(onClose).not.toHaveBeenCalled()
		expect(scope.socketRemoteDataSource.socket).toBe(next)
	})

	it("does not open a connection for an already-aborted request", async () => {
		controller.abort(new Error("Stopped"))
		const scope = own(new CodexWebSocketConnectionScope("ws://test/responses", vi.fn(), vi.fn()))
		const requestScope = own(new CodexWebSocketRequestScope(options, vi.fn()))
		await expect(scope.init(options)).rejects.toThrow("Stopped")
		await expect(requestScope.init(connection, repository, body)).rejects.toThrow("Stopped")
		expect(sockets).toHaveLength(0)
	})

	it("owns request subscriptions and deadlines without disposing the reusable connection", async () => {
		vi.useFakeTimers()
		const onAbort = vi.fn()
		const requestScope = own(new CodexWebSocketRequestScope(options, onAbort))
		const initialized = requestScope.init(connection, repository, body)
		expect(() => requestScope.requestManager).toThrow("not initialized")
		const socket = lastSocket()
		socket.emit("open")
		await initialized
		const request = requestScope.requestManager
		expect(request).toBeInstanceOf(CodexWebSocketRequestManager)
		expect(requestScope.responseManager).toBeInstanceOf(CodexWebSocketResponseManager)
		expect(requestScope.responseManager.preparedRequest.request).toBe(body)
		expect(request.socket).toBe(socket)
		expect(socket.listenerCount("message")).toBe(1)
		await expect(requestScope.init(connection, repository, body)).rejects.toThrow("already initialized")
		request.refreshTimeout()
		request.refreshTimeout()
		expect(vi.getTimerCount()).toBe(1)
		await requestScope.dispose()
		await requestScope.dispose()
		expect(() => requestScope.requestManager).toThrow("not initialized")
		expect(() => request.socket).toThrow("not initialized")
		expect(() => request.events).toThrow("not initialized")
		expect(vi.getTimerCount()).toBe(0)
		expect(socket.listenerCount("message")).toBe(0)
		expect(socket.listenerCount("error")).toBe(1)
		expect(socket.listenerCount("close")).toBe(1)
		expect(socket.terminate).not.toHaveBeenCalled()
		controller.abort()
		expect(onAbort).not.toHaveBeenCalled()
	})

	it("can reinitialize a disposed request on the same connection without duplicate listeners", async () => {
		const requestScope = own(new CodexWebSocketRequestScope(options, () => connection.dispose()))
		const initialized = requestScope.init(connection, repository, body)
		const socket = lastSocket()
		socket.emit("open")
		await initialized
		const firstRequest = requestScope.requestManager
		await requestScope.dispose()
		await requestScope.init(connection, repository, body)
		const request = requestScope.requestManager
		expect(request).not.toBe(firstRequest)
		expect(sockets).toHaveLength(1)
		expect(socket.listenerCount("message")).toBe(1)
		const event = request.events.next()
		const reason = new Error("Stopped")
		controller.abort(reason)
		await expect(event).rejects.toThrow()
		expect(request.signal.reason).toBe(reason)
		await requestScope.dispose()
		expectNoListeners(socket)
	})

	it("cleans up a rejected upgrade and preserves the safe HTTP fallback error", async () => {
		const onAbort = vi.fn()
		const requestScope = own(new CodexWebSocketRequestScope(options, onAbort))
		const initialized = expect(requestScope.init(connection, repository, body)).rejects.toBeInstanceOf(
			CodexWebSocketUnavailableError,
		)
		const socket = lastSocket()
		socket.emit("error", new Error("Upgrade rejected"))
		await initialized
		expect(() => requestScope.requestManager).toThrow("not initialized")
		expect(onAbort).not.toHaveBeenCalled()
		expectNoListeners(socket)
		controller.abort()
		expect(onAbort).not.toHaveBeenCalled()
	})

	it("cleans up request subscriptions when response-manager initialization fails", async () => {
		const onAbort = vi.fn()
		const scope = own(new CodexWebSocketRequestScope(options, onAbort))
		const initialized = expect(scope.init(connection, repository, { input: "invalid" })).rejects.toThrow(
			"input must be an array",
		)
		const socket = lastSocket()
		socket.emit("open")
		await initialized
		expect(() => scope.requestManager).toThrow("not initialized")
		expect(() => scope.responseManager).toThrow("not initialized")
		expect(socket.listenerCount("message")).toBe(0)
		expect(socket.listenerCount("error")).toBe(1)
		expect(socket.listenerCount("close")).toBe(1)
		controller.abort()
		expect(onAbort).not.toHaveBeenCalled()
	})

	it("cancels and cleans up a request disposed during initialization", async () => {
		const requestScope = own(new CodexWebSocketRequestScope(options, () => connection.dispose()))
		const initialized = expect(requestScope.init(connection, repository, body)).rejects.toThrow()
		const socket = lastSocket()
		await requestScope.dispose()
		await initialized
		expectNoListeners(socket)
		expect(() => requestScope.requestManager).toThrow("not initialized")
	})

	it("does not become initialized if disposed after acquiring a socket but before init resolves", async () => {
		const socket = new WebSocket("ws://test/responses")
		socket.emit("open")
		vi.spyOn(connection, "acquire").mockResolvedValue(socket)
		const requestScope = own(new CodexWebSocketRequestScope(options, vi.fn()))
		const initialized = expect(requestScope.init(connection, repository, body)).rejects.toThrow(
			"scope was disposed",
		)
		await Promise.resolve()
		await requestScope.dispose()
		await initialized
		expectNoListeners(socket)
		expect(() => requestScope.requestManager).toThrow("not initialized")
	})

	it("clears an idle connection timer on disposal and does not schedule one without a socket", async () => {
		vi.useFakeTimers()
		connection.release()
		expect(vi.getTimerCount()).toBe(0)
		const acquired = connection.acquire(options)
		const socket = lastSocket()
		socket.emit("open")
		await acquired
		connection.release()
		connection.release()
		expect(vi.getTimerCount()).toBe(1)
		connection.dispose()
		expect(vi.getTimerCount()).toBe(0)
		await Promise.resolve()
		expectNoListeners(socket)
	})
})
