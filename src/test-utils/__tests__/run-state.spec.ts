import { describe, expect, it } from "vitest"

import { initialRunState, type RunState } from "../../core/task/run-state/runState"
import { setAbortLatch } from "../run-state"

const runningState = (abort = false): RunState =>
	Object.freeze({
		...initialRunState,
		phase: "running",
		generation: 3,
		stream: Object.freeze({ tag: "live", generation: 3, cleanupFinished: true }),
		ask: Object.freeze({ tag: "other", askTs: 7 }),
		turn: Object.freeze({ ...initialRunState.turn, toolUsed: true }),
		latches: Object.freeze({ abort, abandoned: true, disposed: true, reason: "user_cancelled" }),
		lastCompletionAskTs: 7,
	})

describe("setAbortLatch", () => {
	it("starts from the initial state when the task has no run state", () => {
		const task: { runState?: RunState } = {}
		setAbortLatch(task, true)
		expect(task.runState).toEqual({
			...initialRunState,
			latches: { ...initialRunState.latches, abort: true },
		})
	})

	it("keeps every other part of an existing run state and returns a new object", () => {
		const before = runningState()
		const task = { runState: before }
		setAbortLatch(task, true)
		expect(task.runState).not.toBe(before)
		expect(task.runState).toEqual(runningState(true))
	})

	it.each([true, false])("sets abort to %s from the opposite value", (aborted) => {
		const task = { runState: runningState(!aborted) }
		setAbortLatch(task, aborted)
		expect(task.runState.latches.abort).toBe(aborted)
	})
})
