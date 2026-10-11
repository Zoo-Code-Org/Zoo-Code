import {
	abandoned,
	abort,
	abortReason,
	didFinishAbortingStream,
	initialRunState,
	isInitialized,
	isStreaming,
	nextRunState,
	type RunEvent,
	type RunState,
} from "../runState"

function accept(state: RunState, event: RunEvent): RunState {
	const result = nextRunState(state, event)
	if (!("ok" in result)) {
		throw new Error(`expected ${event.tag} to be accepted`)
	}
	return result.ok
}

function reject(state: RunState, event: RunEvent): void {
	const result = nextRunState(state, event)
	expect(result).toEqual({ rejected: state })
}

function acceptOnly(state: RunState, event: RunEvent, changes: Partial<RunState>): void {
	expect(accept(state, event)).toEqual({ ...state, ...changes })
}

function run(events: RunEvent[], from: RunState = initialRunState): RunState {
	return events.reduce(accept, from)
}

function deepFreeze<T extends object>(value: T): T {
	for (const child of Object.values(value)) {
		if (typeof child === "object" && child !== null) {
			deepFreeze(child)
		}
	}
	return Object.freeze(value)
}

const running = deepFreeze(run([{ tag: "initialized" }]))
const streaming = deepFreeze(run([{ tag: "streamStarted" }], running))
const aborted = deepFreeze(run([{ tag: "abortRequested", abandoned: false }], running))
const completed = deepFreeze(
	run(
		[
			{ tag: "askStarted", ask: { tag: "completion", askTs: 10 } },
			{ tag: "completionAccepted", askTs: 10 },
		],
		running,
	),
)
const abortedStreaming = deepFreeze(run([{ tag: "abortRequested", abandoned: false }], streaming))
const completedStreaming = deepFreeze(
	run(
		[
			{ tag: "askStarted", ask: { tag: "completion", askTs: 10 } },
			{ tag: "completionAccepted", askTs: 10 },
		],
		streaming,
	),
)
const allEvents: RunEvent[] = [
	{ tag: "initialized" },
	{ tag: "streamStarted" },
	{ tag: "streamCleanupFinished" },
	{ tag: "streamEnded" },
	{ tag: "askStarted", ask: { tag: "completion", askTs: 10 } },
	{ tag: "askSettled", askTs: 10 },
	{ tag: "completionAccepted", askTs: 10 },
	{ tag: "reasonSet", reason: "user_cancelled" },
	{ tag: "abortRequested", abandoned: true },
	{ tag: "abandonRequested" },
	{ tag: "disposeRequested" },
]

describe("nextRunState", () => {
	describe("initialized", () => {
		it("moves uninitialized to running", () => {
			acceptOnly(initialRunState, { tag: "initialized" }, { phase: "running" })
		})

		it.each([running, completed])("rejects when the phase is $phase", (state) => {
			reject(state, { tag: "initialized" })
		})
	})

	describe("streamStarted", () => {
		it("starts a live stream with the next generation and clears the completion ask", () => {
			const withCompletionAsk = run([{ tag: "askStarted", ask: { tag: "completion", askTs: 5 } }], running)
			acceptOnly(
				withCompletionAsk,
				{ tag: "streamStarted" },
				{
					generation: 1,
					stream: { tag: "live", generation: 1, cleanupFinished: false },
					lastCompletionAskTs: undefined,
				},
			)
		})

		it("rejects before initialization", () => {
			reject(initialRunState, { tag: "streamStarted" })
		})

		it("rejects after completion", () => {
			reject(completed, { tag: "streamStarted" })
		})

		it("rejects while a stream is live", () => {
			reject(streaming, { tag: "streamStarted" })
		})

		it("is accepted after abort", () => {
			expect(accept(aborted, { tag: "streamStarted" }).stream.tag).toBe("live")
		})

		it("increments the generation on each stream", () => {
			const second = run([{ tag: "streamEnded" }, { tag: "streamStarted" }], streaming)
			expect(second.generation).toBe(2)
		})
	})

	describe("streamCleanupFinished", () => {
		it("marks the live stream as cleaned up", () => {
			acceptOnly(
				streaming,
				{ tag: "streamCleanupFinished" },
				{ stream: { tag: "live", generation: 1, cleanupFinished: true } },
			)
		})

		it("rejects without a live stream", () => {
			reject(running, { tag: "streamCleanupFinished" })
		})

		it.each([
			["abort", abortedStreaming],
			["completion", completedStreaming],
		])("is accepted after %s while the stream is live", (_name, base) => {
			acceptOnly(
				base,
				{ tag: "streamCleanupFinished" },
				{ stream: { tag: "live", generation: 1, cleanupFinished: true } },
			)
		})
	})

	describe("streamEnded", () => {
		it("clears the live stream and keeps the generation", () => {
			acceptOnly(streaming, { tag: "streamEnded" }, { stream: { tag: "none" } })
		})

		it.each([
			["abort", abortedStreaming],
			["completion", completedStreaming],
		])("is accepted after %s while the stream is live", (_name, base) => {
			acceptOnly(base, { tag: "streamEnded" }, { stream: { tag: "none" } })
		})

		it("rejects without a live stream", () => {
			reject(running, { tag: "streamEnded" })
		})
	})

	describe("askStarted", () => {
		it("records an approval ask with its opaque ids", () => {
			const ask = { tag: "approval", askTs: 1, toolCallId: "call", approvalId: "approval" } as const
			acceptOnly(running, { tag: "askStarted", ask }, { ask, lastCompletionAskTs: undefined })
		})

		it("records a completion ask and its timestamp", () => {
			const ask = { tag: "completion", askTs: 7 } as const
			acceptOnly(running, { tag: "askStarted", ask }, { ask, lastCompletionAskTs: 7 })
		})

		it("clears the completion timestamp when a non-completion ask replaces it", () => {
			const next = run(
				[
					{ tag: "askStarted", ask: { tag: "completion", askTs: 7 } },
					{ tag: "askStarted", ask: { tag: "other", askTs: 8 } },
				],
				running,
			)

			expect(next.lastCompletionAskTs).toBeUndefined()
		})

		it("is accepted with a live stream", () => {
			expect(accept(streaming, { tag: "askStarted", ask: { tag: "other", askTs: 1 } }).ask.tag).toBe("other")
		})

		it("is accepted with no stream", () => {
			expect(accept(running, { tag: "askStarted", ask: { tag: "other", askTs: 1 } }).ask.tag).toBe("other")
		})

		it("rejects before initialization", () => {
			reject(initialRunState, { tag: "askStarted", ask: { tag: "other", askTs: 1 } })
		})

		it("rejects after completion", () => {
			reject(completed, { tag: "askStarted", ask: { tag: "other", askTs: 1 } })
		})

		it("rejects after abort", () => {
			reject(aborted, { tag: "askStarted", ask: { tag: "other", askTs: 1 } })
		})
	})

	describe("askSettled", () => {
		const pending = run([{ tag: "askStarted", ask: { tag: "other", askTs: 3 } }], running)

		it("clears the ask when the askTs matches", () => {
			acceptOnly(pending, { tag: "askSettled", askTs: 3 }, { ask: { tag: "none" } })
		})

		it("changes nothing when the askTs differs", () => {
			acceptOnly(pending, { tag: "askSettled", askTs: 2 }, {})
		})

		it("changes nothing when no ask is pending", () => {
			acceptOnly(running, { tag: "askSettled", askTs: 3 }, {})
		})

		it("is accepted after abort", () => {
			const abortedWithAsk = run([{ tag: "abortRequested", abandoned: false }], pending)
			acceptOnly(abortedWithAsk, { tag: "askSettled", askTs: 3 }, { ask: { tag: "none" } })
		})
	})

	describe("completionAccepted", () => {
		const withCompletionAsk = run([{ tag: "askStarted", ask: { tag: "completion", askTs: 10 } }], running)

		it("completes the task and clears the ask", () => {
			acceptOnly(
				withCompletionAsk,
				{ tag: "completionAccepted", askTs: 10 },
				{ phase: "completed", ask: { tag: "none" } },
			)
		})

		it("is accepted after the completion ask has settled", () => {
			const settled = accept(withCompletionAsk, { tag: "askSettled", askTs: 10 })
			acceptOnly(settled, { tag: "completionAccepted", askTs: 10 }, { phase: "completed" })
		})

		it("rejects an askTs that is not the completion ask", () => {
			reject(withCompletionAsk, { tag: "completionAccepted", askTs: 11 })
		})

		it("rejects when no completion ask started", () => {
			reject(running, { tag: "completionAccepted", askTs: 10 })
		})

		it("rejects once a later ask has cleared the completion ask", () => {
			const later = accept(withCompletionAsk, { tag: "askStarted", ask: { tag: "other", askTs: 11 } })
			reject(later, { tag: "completionAccepted", askTs: 10 })
		})

		it("rejects once a new stream has started", () => {
			const next = accept(withCompletionAsk, { tag: "streamStarted" })
			reject(next, { tag: "completionAccepted", askTs: 10 })
		})

		it("rejects after abort", () => {
			const next = accept(withCompletionAsk, { tag: "abortRequested", abandoned: false })
			reject(next, { tag: "completionAccepted", askTs: 10 })
		})

		it("rejects after completion", () => {
			reject(completed, { tag: "completionAccepted", askTs: 10 })
		})

		it("rejects before initialization", () => {
			reject(initialRunState, { tag: "completionAccepted", askTs: 10 })
		})
	})

	describe("reasonSet", () => {
		it("sets the first reason", () => {
			acceptOnly(
				running,
				{ tag: "reasonSet", reason: "user_cancelled" },
				{ latches: { ...running.latches, reason: "user_cancelled" } },
			)
		})

		it("keeps the first reason when a later one arrives", () => {
			const next = run(
				[
					{ tag: "reasonSet", reason: "user_cancelled" },
					{ tag: "reasonSet", reason: "streaming_failed" },
				],
				running,
			)

			expect(next.latches.reason).toBe("user_cancelled")
		})

		it("is accepted in every phase", () => {
			for (const state of [initialRunState, running, completed]) {
				expect(accept(state, { tag: "reasonSet", reason: "streaming_failed" }).latches.reason).toBe(
					"streaming_failed",
				)
			}
		})
	})

	describe("abortRequested", () => {
		it("sets abort without abandoning", () => {
			acceptOnly(
				running,
				{ tag: "abortRequested", abandoned: false },
				{ latches: { abort: true, abandoned: false, disposed: false } },
			)
		})

		it("sets abort and abandoned together", () => {
			acceptOnly(
				running,
				{ tag: "abortRequested", abandoned: true },
				{ latches: { abort: true, abandoned: true, disposed: false } },
			)
		})

		it("keeps abandoned set when a later abort passes false", () => {
			const next = run(
				[
					{ tag: "abortRequested", abandoned: true },
					{ tag: "abortRequested", abandoned: false },
				],
				running,
			)

			expect(next.latches.abandoned).toBe(true)
		})

		it("is accepted in every phase", () => {
			for (const state of [initialRunState, running, completed]) {
				expect(accept(state, { tag: "abortRequested", abandoned: false }).latches.abort).toBe(true)
			}
		})

		it("keeps the reason", () => {
			const withReason = accept(running, { tag: "reasonSet", reason: "user_cancelled" })
			expect(accept(withReason, { tag: "abortRequested", abandoned: false }).latches.reason).toBe(
				"user_cancelled",
			)
		})
	})

	describe("abandonRequested", () => {
		it("abandons after abort", () => {
			acceptOnly(
				aborted,
				{ tag: "abandonRequested" },
				{ latches: { abort: true, abandoned: true, disposed: false } },
			)
		})

		it("abandons after abort in the uninitialized phase", () => {
			const state = accept(initialRunState, { tag: "abortRequested", abandoned: false })
			expect(accept(state, { tag: "abandonRequested" }).latches.abandoned).toBe(true)
		})

		it("abandons after abort in the completed phase", () => {
			const state = accept(completed, { tag: "abortRequested", abandoned: false })
			expect(accept(state, { tag: "abandonRequested" }).latches.abandoned).toBe(true)
		})

		it("abandons after abort when the stream has ended", () => {
			const next = run(
				[{ tag: "abortRequested", abandoned: false }, { tag: "streamEnded" }, { tag: "abandonRequested" }],
				streaming,
			)

			expect(next.latches.abandoned).toBe(true)
		})

		it("rejects before abort", () => {
			reject(running, { tag: "abandonRequested" })
		})
	})

	describe("disposeRequested", () => {
		it("sets abort and disposed", () => {
			acceptOnly(
				running,
				{ tag: "disposeRequested" },
				{ latches: { abort: true, abandoned: false, disposed: true } },
			)
		})

		it("does not change the reason", () => {
			const withReason = accept(running, { tag: "reasonSet", reason: "streaming_failed" })
			expect(accept(withReason, { tag: "disposeRequested" }).latches.reason).toBe("streaming_failed")
		})

		it("is accepted in every phase", () => {
			for (const state of [initialRunState, running, completed]) {
				expect(accept(state, { tag: "disposeRequested" }).latches.disposed).toBe(true)
			}
		})
	})

	const frozenStates = [initialRunState, running, streaming, aborted, abortedStreaming, completed, completedStreaming]

	it("initialRunState has the expected values and is frozen at every level", () => {
		expect(initialRunState).toEqual({
			phase: "uninitialized",
			generation: 0,
			stream: { tag: "none" },
			ask: { tag: "none" },
			latches: { abort: false, abandoned: false, disposed: false },
		})
		expect(Object.isFrozen(initialRunState)).toBe(true)
		expect(Object.isFrozen(initialRunState.stream)).toBe(true)
		expect(Object.isFrozen(initialRunState.ask)).toBe(true)
		expect(Object.isFrozen(initialRunState.latches)).toBe(true)
	})

	it("initialRunState rejects a nested write", () => {
		const latches: { abort: boolean } = initialRunState.latches
		expect(() => {
			latches.abort = true
		}).toThrow(TypeError)
		expect(initialRunState.latches.abort).toBe(false)
	})

	it.each(allEvents.map((event) => [event.tag, event] as const))(
		"%s does not mutate a frozen input state",
		(_tag, event) => {
			for (const state of frozenStates) {
				expect(() => nextRunState(state, event)).not.toThrow()
			}
		},
	)

	it.each(allEvents.map((event) => [event.tag, event] as const))(
		"%s never returns a latch to false",
		(_tag, event) => {
			const latched = run([{ tag: "abortRequested", abandoned: true }, { tag: "disposeRequested" }], running)
			const result = nextRunState(latched, event)
			const next = "ok" in result ? result.ok : result.rejected

			expect(next.latches).toMatchObject({ abort: true, abandoned: true, disposed: true })
		},
	)
})

describe("getters", () => {
	it("derive from the initial state", () => {
		expect(abort(initialRunState)).toBe(false)
		expect(abandoned(initialRunState)).toBe(false)
		expect(abortReason(initialRunState)).toBeUndefined()
		expect(didFinishAbortingStream(initialRunState)).toBe(false)
		expect(isStreaming(initialRunState)).toBe(false)
		expect(isInitialized(initialRunState)).toBe(false)
	})

	it("abort reads the abort latch", () => {
		expect(abort(aborted)).toBe(true)
		expect(abort(accept(running, { tag: "disposeRequested" }))).toBe(true)
	})

	it("abandoned reads the abandoned latch", () => {
		expect(abandoned(aborted)).toBe(false)
		expect(abandoned(accept(aborted, { tag: "abandonRequested" }))).toBe(true)
	})

	it("abortReason reads the reason latch", () => {
		expect(abortReason(accept(running, { tag: "reasonSet", reason: "streaming_failed" }))).toBe("streaming_failed")
	})

	it("isStreaming is true only while a stream is live", () => {
		expect(isStreaming(running)).toBe(false)
		expect(isStreaming(streaming)).toBe(true)
		expect(isStreaming(accept(streaming, { tag: "streamEnded" }))).toBe(false)
	})

	it("didFinishAbortingStream is true only for a live stream whose cleanup finished", () => {
		const cleaned = accept(streaming, { tag: "streamCleanupFinished" })

		expect(didFinishAbortingStream(running)).toBe(false)
		expect(didFinishAbortingStream(streaming)).toBe(false)
		expect(didFinishAbortingStream(cleaned)).toBe(true)
		expect(didFinishAbortingStream(accept(cleaned, { tag: "streamEnded" }))).toBe(false)
	})

	it("isInitialized is true in running and completed", () => {
		expect(isInitialized(running)).toBe(true)
		expect(isInitialized(completed)).toBe(true)
	})
})

describe("observed flows", () => {
	it("flow 1: a resumed task starts a request without user input", () => {
		const state = run([{ tag: "initialized" }, { tag: "streamStarted" }])
		expect(isStreaming(state)).toBe(true)
	})

	it("flow 1: resume asks for approval before any stream starts", () => {
		const state = run([
			{ tag: "initialized" },
			{ tag: "askStarted", ask: { tag: "approval", askTs: 1 } },
			{ tag: "askSettled", askTs: 1 },
			{ tag: "streamStarted" },
		])

		expect(state.ask).toEqual({ tag: "none" })
		expect(isStreaming(state)).toBe(true)
	})

	it("flow 2: an ask starts with the stream live, and another after it ends", () => {
		const state = run([
			{ tag: "initialized" },
			{ tag: "streamStarted" },
			{ tag: "askStarted", ask: { tag: "approval", askTs: 1 } },
			{ tag: "askSettled", askTs: 1 },
			{ tag: "streamEnded" },
			{ tag: "askStarted", ask: { tag: "approval", askTs: 2 } },
		])

		expect(isStreaming(state)).toBe(false)
		expect(state.ask).toEqual({ tag: "approval", askTs: 2 })
		expect(state.generation).toBe(1)
	})

	it("flow 2: one request keeps one generation across its asks", () => {
		const state = run([
			{ tag: "initialized" },
			{ tag: "streamStarted" },
			{ tag: "askStarted", ask: { tag: "approval", askTs: 1 } },
			{ tag: "askSettled", askTs: 1 },
			{ tag: "askStarted", ask: { tag: "approval", askTs: 2 } },
		])

		expect(state.generation).toBe(1)
	})

	it("flow 3: back-to-back asks leave the newest ask pending", () => {
		const state = run([
			{ tag: "initialized" },
			{ tag: "askStarted", ask: { tag: "other", askTs: 1 } },
			{ tag: "askSettled", askTs: 1 },
			{ tag: "askStarted", ask: { tag: "other", askTs: 2 } },
		])

		expect(state.ask).toEqual({ tag: "other", askTs: 2 })
	})

	it("flow 4: a user cancel latches abort and abandoned, and the stream stays live until it ends", () => {
		const state = run([
			{ tag: "initialized" },
			{ tag: "streamStarted" },
			{ tag: "reasonSet", reason: "user_cancelled" },
			{ tag: "abortRequested", abandoned: false },
			{ tag: "abandonRequested" },
		])

		expect(abort(state)).toBe(true)
		expect(abandoned(state)).toBe(true)
		expect(abortReason(state)).toBe("user_cancelled")
		expect(isStreaming(state)).toBe(true)
		expect(didFinishAbortingStream(state)).toBe(false)
		expect(isStreaming(accept(state, { tag: "streamEnded" }))).toBe(false)
	})

	it("flow 5: eviction aborts and abandons in one event", () => {
		const state = run([{ tag: "initialized" }, { tag: "abortRequested", abandoned: true }])

		expect(abort(state)).toBe(true)
		expect(abandoned(state)).toBe(true)
		expect(abortReason(state)).toBeUndefined()
	})

	it("flow 5: a checkpoint-restore delete aborts first and abandons later", () => {
		const state = run([
			{ tag: "initialized" },
			{ tag: "abortRequested", abandoned: false },
			{ tag: "abortRequested", abandoned: true },
		])

		expect(abandoned(state)).toBe(true)
	})

	it("flows 6 and 7: dispose latches abort and an abort drain finishes cleanup", () => {
		const state = run([
			{ tag: "initialized" },
			{ tag: "streamStarted" },
			{ tag: "disposeRequested" },
			{ tag: "streamCleanupFinished" },
		])

		expect(abort(state)).toBe(true)
		expect(state.latches.disposed).toBe(true)
		expect(didFinishAbortingStream(state)).toBe(true)

		const ended = accept(state, { tag: "streamEnded" })
		expect(isStreaming(ended)).toBe(false)
		expect(didFinishAbortingStream(ended)).toBe(false)
	})

	it("flow 8: a stream failure cleans up, and the retry starts with cleanup unfinished", () => {
		const state = run([
			{ tag: "initialized" },
			{ tag: "streamStarted" },
			{ tag: "streamCleanupFinished" },
			{ tag: "streamEnded" },
			{ tag: "streamStarted" },
		])

		expect(abort(state)).toBe(false)
		expect(didFinishAbortingStream(state)).toBe(false)
		expect(state.generation).toBe(2)
	})

	it("flow 9: a completion ask outlives the stream and its accept completes the task", () => {
		const state = run([
			{ tag: "initialized" },
			{ tag: "streamStarted" },
			{ tag: "askStarted", ask: { tag: "completion", askTs: 20 } },
			{ tag: "streamEnded" },
			{ tag: "askSettled", askTs: 20 },
			{ tag: "completionAccepted", askTs: 20 },
		])

		expect(state.phase).toBe("completed")
		expect(state.ask).toEqual({ tag: "none" })
	})

	it("flow 9: feedback on a completion ask continues the loop and a late accept is rejected", () => {
		const state = run([
			{ tag: "initialized" },
			{ tag: "askStarted", ask: { tag: "completion", askTs: 20 } },
			{ tag: "askSettled", askTs: 20 },
			{ tag: "streamStarted" },
		])

		reject(state, { tag: "completionAccepted", askTs: 20 })
	})

	it("flow 10: an aborted instance leaves the initial state unchanged for the next instance", () => {
		const previous = run([{ tag: "initialized" }, { tag: "abortRequested", abandoned: true }])
		const next = accept(initialRunState, { tag: "initialized" })

		expect(abort(previous)).toBe(true)
		expect(next.latches).toEqual({ abort: false, abandoned: false, disposed: false })
		expect(Object.isFrozen(initialRunState)).toBe(true)
	})

	it("race R-6: a superseded ask settling late keeps the newer ask", () => {
		const state = run([
			{ tag: "initialized" },
			{ tag: "askStarted", ask: { tag: "approval", askTs: 1 } },
			{ tag: "askStarted", ask: { tag: "approval", askTs: 2 } },
			{ tag: "askSettled", askTs: 1 },
		])

		expect(state.ask).toEqual({ tag: "approval", askTs: 2 })
		expect(accept(state, { tag: "askSettled", askTs: 2 }).ask).toEqual({ tag: "none" })
	})

	it("race R-3: an ask after abort is rejected", () => {
		const state = run([{ tag: "initialized" }, { tag: "abortRequested", abandoned: false }])
		reject(state, { tag: "askStarted", ask: { tag: "other", askTs: 1 } })
	})

	it("race R-4: the first reason wins over a later streaming failure", () => {
		const state = run([
			{ tag: "initialized" },
			{ tag: "reasonSet", reason: "user_cancelled" },
			{ tag: "reasonSet", reason: "streaming_failed" },
		])

		expect(abortReason(state)).toBe("user_cancelled")
	})
})
