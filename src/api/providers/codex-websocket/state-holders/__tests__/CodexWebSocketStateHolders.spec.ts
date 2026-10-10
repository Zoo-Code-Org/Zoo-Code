import WebSocket from "ws"

import { asyncStreamFrom } from "../../../../../test-utils/stream"
import { CodexWebSocketResponseLocalDataSource } from "../../data/local/CodexWebSocketResponseLocalDataSource"
import { CodexWebSocketContinuationRepository } from "../../repositories/CodexWebSocketContinuationRepository"
import { CodexWebSocketConnectionScope } from "../../scopes/CodexWebSocketConnectionScope"
import { CodexWebSocketConnectionStateHolder } from "../CodexWebSocketConnectionStateHolder"
import { CodexWebSocketRequestStateHolder } from "../CodexWebSocketRequestStateHolder"
import { CodexWebSocketResponseStateHolder } from "../CodexWebSocketResponseStateHolder"
import { StateHolder } from "../StateHolder"

vi.mock("ws", async () => {
	const { EventEmitter } = await import("node:events")
	return { default: class TestSocket extends EventEmitter {} }
})

describe("Codex WebSocket state holders", () => {
	beforeEach(() => vi.useFakeTimers())
	afterEach(() => vi.useRealTimers())
	const scope = () => new CodexWebSocketConnectionScope("ws://test/responses", vi.fn(), vi.fn())
	const prepared = () =>
		new CodexWebSocketContinuationRepository(new CodexWebSocketResponseLocalDataSource()).prepare({
			model: "test-model",
			input: [],
		})

	it("uses the generic holder and replaces snapshots rather than mutating prior state", () => {
		const holder = new CodexWebSocketConnectionStateHolder()
		expect(holder).toBeInstanceOf(StateHolder)
		const initial = holder.state
		const attempt = holder.beginConnection("credentials-hash", scope())
		expect(holder.isCurrent(attempt)).toBe(true)
		expect(holder.isCurrent(initial)).toBe(false)
		holder.connect(attempt, 123)
		expect(initial).toEqual({ status: "disconnected" })
		expect(attempt.status).toBe("connecting")
		expect(holder.state).toMatchObject({ status: "active", key: "credentials-hash", connectedAt: 123 })
	})

	it("associates idle resources only with the idle snapshot", () => {
		const holder = new CodexWebSocketConnectionStateHolder()
		const attempt = holder.beginConnection("key", scope())
		holder.connect(attempt, 123)
		const active = holder.state
		if (active.status !== "active") throw new Error("Expected an active connection")
		const timer = setTimeout(() => {}, 1_000)
		const idle = holder.idle(active, timer)
		holder.activate(idle)
		expect(active).not.toHaveProperty("idleTimer")
		expect(idle.idleTimer).toBe(timer)
		expect(holder.state).not.toHaveProperty("idleTimer")
		expect(vi.getTimerCount()).toBe(1)
		clearTimeout(timer)
	})

	it("rejects transitions from a replaced connection snapshot", () => {
		const holder = new CodexWebSocketConnectionStateHolder()
		const stale = holder.beginConnection("old", scope())
		holder.disconnect()
		const current = holder.beginConnection("new", scope())
		expect(() => holder.connect(stale, 123)).toThrow("disposed")
		expect(holder.state).toBe(current)
	})

	it("rejects overlapping connection state and cooldown publication while connecting", () => {
		const holder = new CodexWebSocketConnectionStateHolder()
		const attempt = holder.beginConnection("key", scope())
		expect(() => holder.beginConnection("other", scope())).toThrow("already active")
		expect(() => holder.markUnavailable("key", 60_000)).toThrow("must be disconnected")
		expect(holder.state).toBe(attempt)
	})

	it("preserves credential cooldown without retaining connection resources", () => {
		const holder = new CodexWebSocketConnectionStateHolder()
		holder.markUnavailable("key", 60_000)
		const unavailable = holder.state
		holder.disconnect()
		expect(holder.state).toBe(unavailable)
		expect(holder.state).toEqual({ status: "unavailable", key: "key", retryAt: 60_000 })
		expect(vi.getTimerCount()).toBe(0)
	})

	it("changes request lifecycle state without aborting signals or owning subscriptions", () => {
		const holder = new CodexWebSocketRequestStateHolder()
		const controller = new AbortController()
		const initializing = holder.beginInitialization(controller, controller.signal)
		holder.dispose()
		expect(holder.state).toEqual({ status: "disposed", signal: controller.signal })
		expect(controller.signal.aborted).toBe(false)
		expect(initializing.status).toBe("initializing")
		expect(vi.getTimerCount()).toBe(0)
	})

	it("rejects repeated initialization and activation from an obsolete request snapshot", () => {
		const holder = new CodexWebSocketRequestStateHolder()
		const controller = new AbortController()
		const first = holder.beginInitialization(controller, controller.signal)
		expect(() => holder.beginInitialization(controller, controller.signal)).toThrow("already initialized")
		holder.dispose()
		const current = holder.beginInitialization(controller, controller.signal)
		const socket = new WebSocket("ws://test")
		const events = asyncStreamFrom<unknown[]>([])
		expect(() => holder.activate(first, socket, events)).toThrow("scope was disposed")
		expect(holder.state).toBe(current)
		holder.activate(current, socket, events)
		expect(() => holder.beginInitialization(controller, controller.signal)).toThrow("already initialized")
	})

	it("replaces request deadline snapshots without clearing timers itself", () => {
		const holder = new CodexWebSocketRequestStateHolder()
		const controller = new AbortController()
		const initializing = holder.beginInitialization(controller, controller.signal)
		holder.activate(initializing, new WebSocket("ws://test"), asyncStreamFrom<unknown[]>([]))
		const active = holder.state
		if (active.status !== "active") throw new Error("Expected an active request")
		const timer = setTimeout(() => {}, 1_000)
		const timed = holder.setDeadline(active, timer)
		holder.clearDeadline(timed)
		expect(active).not.toHaveProperty("timeout")
		expect(timed.timeout).toBe(timer)
		expect(holder.state).not.toHaveProperty("timeout")
		expect(vi.getTimerCount()).toBe(1)
		clearTimeout(timer)
	})

	it("keeps prior response output snapshots unchanged and makes completion terminal", () => {
		const holder = new CodexWebSocketResponseStateHolder()
		holder.initialize(prepared())
		holder.appendOutputItem("first")
		const first = holder.state
		holder.appendOutputItem("second")
		expect(first).toMatchObject({ status: "streaming", output: ["first"] })
		expect(holder.streamedOutput).toEqual(["first", "second"])
		holder.complete()
		expect(holder.state.status).toBe("completed")
		expect(holder.state).not.toHaveProperty("output")
		expect(() => holder.appendOutputItem("late")).toThrow("already completed")
	})

	it("rejects repeated response initialization without replacing the prepared request", () => {
		const holder = new CodexWebSocketResponseStateHolder()
		holder.initialize(prepared())
		const initial = holder.state
		expect(() => holder.initialize(prepared())).toThrow("already initialized")
		expect(holder.state).toBe(initial)
	})

	it("permits recovery only in the initial awaiting state", () => {
		const holder = new CodexWebSocketResponseStateHolder()
		holder.initialize({ ...prepared(), fullContextReason: undefined, previousResponseId: "resp_1" })
		expect(holder.canRecoverCacheMiss).toBe(true)
		holder.beginRecovery()
		expect(holder.state.status).toBe("recovering")
		expect(holder.canRecoverCacheMiss).toBe(false)
		expect(() => holder.beginRecovery()).toThrow("cannot recover")
		holder.startStreaming()
		expect(holder.state.status).toBe("streaming")
	})
})
