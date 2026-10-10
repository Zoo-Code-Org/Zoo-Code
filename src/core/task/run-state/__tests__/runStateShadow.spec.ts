import { initialRunState, nextRunState, type RunEvent, type RunState } from "../runState"
import {
	applyRunEvent,
	MAX_RUN_REJECTIONS,
	projectRunState,
	runStateFieldGetters,
	type RunRejection,
	type RunStateFields,
} from "../runStateShadow"

const idle: RunStateFields = {
	abort: false,
	abandoned: false,
	isInitialized: false,
	isStreaming: false,
	didFinishAbortingStream: false,
}

function drive(events: RunEvent[]): RunState {
	return events.reduce((state, event) => {
		const result = nextRunState(state, event)
		if (!("ok" in result)) {
			throw new Error(`expected ${event.tag} to be accepted`)
		}
		return result.ok
	}, initialRunState as RunState)
}

function kernelFields(state: RunState): RunStateFields {
	return {
		abort: runStateFieldGetters.abort(state),
		abandoned: runStateFieldGetters.abandoned(state),
		abortReason: runStateFieldGetters.abortReason(state),
		isInitialized: runStateFieldGetters.isInitialized(state),
		isStreaming: runStateFieldGetters.isStreaming(state),
		didFinishAbortingStream: runStateFieldGetters.didFinishAbortingStream(state),
	}
}

describe("projectRunState", () => {
	it("keeps each field value in its own slot", () => {
		const fields: RunStateFields = {
			abort: true,
			abandoned: false,
			abortReason: "user_cancelled",
			isInitialized: true,
			isStreaming: true,
			didFinishAbortingStream: true,
		}
		expect(projectRunState(fields)).toEqual(fields)
		expect(projectRunState({ ...fields, abort: false, abandoned: true })).toMatchObject({
			abort: false,
			abandoned: true,
		})
	})

	it("reports didFinishAbortingStream false without a live stream, even when the field is stale", () => {
		expect(projectRunState({ ...idle, didFinishAbortingStream: true }).didFinishAbortingStream).toBe(false)
	})

	it("agrees with the kernel getters after the same sequence of writes", () => {
		const completed = drive([
			{ tag: "initialized" },
			{ tag: "askStarted", ask: { tag: "completion", askTs: 1 } },
			{ tag: "completionAccepted", askTs: 1 },
		])
		const cases: Array<[RunState, RunStateFields]> = [
			[initialRunState, idle],
			[drive([{ tag: "initialized" }]), { ...idle, isInitialized: true }],
			[
				drive([{ tag: "initialized" }, { tag: "streamStarted" }, { tag: "streamCleanupFinished" }]),
				{ ...idle, isInitialized: true, isStreaming: true, didFinishAbortingStream: true },
			],
			[
				drive([
					{ tag: "initialized" },
					{ tag: "reasonSet", reason: "user_cancelled" },
					{ tag: "abortRequested", abandoned: false },
				]),
				{ ...idle, isInitialized: true, abort: true, abortReason: "user_cancelled" },
			],
			[drive([{ tag: "abortRequested", abandoned: true }]), { ...idle, abort: true, abandoned: true }],
			[completed, { ...idle, isInitialized: true }],
		]
		for (const [state, fields] of cases) {
			expect(projectRunState(fields)).toEqual(kernelFields(state))
		}
	})
})

describe("applyRunEvent", () => {
	it("returns the next state and records nothing when the kernel accepts the event", () => {
		const rejections: RunRejection[] = []
		const next = applyRunEvent(initialRunState, { tag: "initialized" }, rejections)
		expect(next.phase).toBe("running")
		expect(rejections).toEqual([])
	})

	it("keeps the state and records the event and state when the kernel rejects the event", () => {
		const rejections: RunRejection[] = []
		const next = applyRunEvent(initialRunState, { tag: "streamEnded" }, rejections)
		expect(next).toBe(initialRunState)
		expect(rejections).toEqual([{ event: { tag: "streamEnded" }, state: initialRunState }])
	})

	it("drops the oldest rejection when the buffer is full", () => {
		const rejections: RunRejection[] = []
		for (let askTs = 0; askTs < MAX_RUN_REJECTIONS + 5; askTs++) {
			applyRunEvent(initialRunState, { tag: "completionAccepted", askTs }, rejections)
		}
		expect(rejections).toHaveLength(MAX_RUN_REJECTIONS)
		expect(rejections[0].event).toEqual({ tag: "completionAccepted", askTs: 5 })
		expect(rejections.at(-1)?.event).toEqual({ tag: "completionAccepted", askTs: MAX_RUN_REJECTIONS + 4 })
	})
})
