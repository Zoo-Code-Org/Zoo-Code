import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { classifyRunOutcome } from "./coding-outcomes.ts"

const base = {
	hasTrace: true,
	executionCode: "COMPLETED" as const,
	finalWorkspaceAvailable: true,
}

describe("run outcome classification", () => {
	it("grades a completed run by the hidden tests", () => {
		assert.deepEqual(classifyRunOutcome({ ...base, grading: { kind: "passed" } }), {
			outcome: "correct",
			reason: "hiddenTestsPassed",
		})
		// A completion message from the agent never makes a failing workspace correct.
		assert.deepEqual(classifyRunOutcome({ ...base, grading: { kind: "failed" } }), {
			outcome: "incorrect",
			reason: "hiddenTestsFailed",
		})
	})

	it("grades a stopped run by the hidden tests", () => {
		assert.equal(
			classifyRunOutcome({ ...base, executionCode: "STOPPED", grading: { kind: "passed" } }).outcome,
			"correct",
		)
		assert.equal(
			classifyRunOutcome({ ...base, executionCode: "STOPPED", grading: { kind: "failed" } }).outcome,
			"incorrect",
		)
	})

	it("keeps grading failures out of incorrect", () => {
		assert.deepEqual(
			classifyRunOutcome({ ...base, grading: { kind: "grading-failure", reason: "graderTimeout" } }),
			{ outcome: "grading-failure", reason: "graderTimeout" },
		)
	})

	it("reports timed out for the run-window expiry", () => {
		assert.equal(classifyRunOutcome({ ...base, executionCode: "TASK_RUN_TIMEOUT" }).outcome, "timed-out")
		assert.equal(
			classifyRunOutcome({ ...base, executionCode: "TASK_RUN_TIMEOUT", grading: { kind: "passed" } }).outcome,
			"timed-out",
		)
	})

	it("reports infrastructure failures for host, IPC, and provider faults", () => {
		for (const code of ["SETUP_FAILED", "ACTIVATION_FAILED", "TASK_START_FAILED", "SESSION_LOST"] as const)
			assert.equal(classifyRunOutcome({ ...base, executionCode: code }).outcome, "infrastructure-failure")
		assert.equal(classifyRunOutcome({ ...base, hasTrace: false }).outcome, "infrastructure-failure")
		assert.equal(
			classifyRunOutcome({ ...base, grading: undefined, finalWorkspaceAvailable: false }).outcome,
			"infrastructure-failure",
		)
		assert.equal(classifyRunOutcome({ ...base, grading: undefined }).outcome, "infrastructure-failure")
	})
})
