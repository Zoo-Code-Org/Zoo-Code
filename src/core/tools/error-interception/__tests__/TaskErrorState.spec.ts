import { describe, expect, it } from "vitest"

import { getTaskErrorState, hasTaskErrorState, STUCK_LOOP_THRESHOLD, TaskErrorState } from "../TaskErrorState"

describe("TaskErrorState", () => {
	describe("getOccurrence / incrementOccurrence", () => {
		it("returns 0 for a category that has never been recorded", () => {
			const state = new TaskErrorState()
			expect(state.getOccurrence("PARAM_TYPE_MISMATCH")).toBe(0)
		})

		it("increments occurrence and returns the new count", () => {
			const state = new TaskErrorState()
			expect(state.incrementOccurrence("PARAM_TYPE_MISMATCH")).toBe(1)
			expect(state.incrementOccurrence("PARAM_TYPE_MISMATCH")).toBe(2)
			expect(state.getOccurrence("PARAM_TYPE_MISMATCH")).toBe(2)
		})

		it("tracks occurrences independently per category", () => {
			const state = new TaskErrorState()
			state.incrementOccurrence("PARAM_TYPE_MISMATCH")
			state.incrementOccurrence("PARAM_TYPE_MISMATCH")
			state.incrementOccurrence("INVALID_TOOL_PROTOCOL")
			expect(state.getOccurrence("PARAM_TYPE_MISMATCH")).toBe(2)
			expect(state.getOccurrence("INVALID_TOOL_PROTOCOL")).toBe(1)
		})
	})

	describe("isOpen circuit", () => {
		it("is closed before the threshold", () => {
			const state = new TaskErrorState()
			for (let i = 0; i < STUCK_LOOP_THRESHOLD - 1; i += 1) {
				state.incrementOccurrence("PARAM_TYPE_MISMATCH")
				expect(state.isOpen("PARAM_TYPE_MISMATCH")).toBe(false)
			}
		})

		it("opens when occurrence reaches the threshold", () => {
			const state = new TaskErrorState()
			for (let i = 0; i < STUCK_LOOP_THRESHOLD; i += 1) {
				state.incrementOccurrence("PARAM_TYPE_MISMATCH")
			}
			expect(state.isOpen("PARAM_TYPE_MISMATCH")).toBe(true)
		})

		it("stays open on further increments", () => {
			const state = new TaskErrorState()
			for (let i = 0; i < STUCK_LOOP_THRESHOLD + 2; i += 1) {
				state.incrementOccurrence("PARAM_TYPE_MISMATCH")
			}
			expect(state.isOpen("PARAM_TYPE_MISMATCH")).toBe(true)
		})

		it("opens only for the affected category", () => {
			const state = new TaskErrorState()
			for (let i = 0; i < STUCK_LOOP_THRESHOLD; i += 1) {
				state.incrementOccurrence("PARAM_TYPE_MISMATCH")
			}
			expect(state.isOpen("PARAM_TYPE_MISMATCH")).toBe(true)
			expect(state.isOpen("INVALID_TOOL_PROTOCOL")).toBe(false)
		})
	})

	describe("fingerprint", () => {
		it("returns undefined when no fingerprint was recorded", () => {
			const state = new TaskErrorState()
			expect(state.getFingerprint("PARAM_TYPE_MISMATCH")).toBeUndefined()
		})

		it("stores and returns the fingerprint without touching the counter", () => {
			const state = new TaskErrorState()
			state.setFingerprint("PARAM_TYPE_MISMATCH", "PARAM_TYPE_MISMATCH|CWD_OBJECT_MISUSE|execute_command|cwd")
			expect(state.getFingerprint("PARAM_TYPE_MISMATCH")).toBe(
				"PARAM_TYPE_MISMATCH|CWD_OBJECT_MISUSE|execute_command|cwd",
			)
			expect(state.getOccurrence("PARAM_TYPE_MISMATCH")).toBe(0)
		})

		it("keeps fingerprints isolated per category", () => {
			const state = new TaskErrorState()
			state.setFingerprint("A", "fp-a")
			state.setFingerprint("B", "fp-b")
			expect(state.getFingerprint("A")).toBe("fp-a")
			expect(state.getFingerprint("B")).toBe("fp-b")
		})
	})

	describe("reset", () => {
		it("resets a single category and closes its circuit", () => {
			const state = new TaskErrorState()
			for (let i = 0; i < STUCK_LOOP_THRESHOLD; i += 1) {
				state.incrementOccurrence("PARAM_TYPE_MISMATCH")
			}
			state.setFingerprint("PARAM_TYPE_MISMATCH", "fp")
			expect(state.isOpen("PARAM_TYPE_MISMATCH")).toBe(true)

			state.reset("PARAM_TYPE_MISMATCH")
			expect(state.getOccurrence("PARAM_TYPE_MISMATCH")).toBe(0)
			expect(state.isOpen("PARAM_TYPE_MISMATCH")).toBe(false)
			expect(state.getFingerprint("PARAM_TYPE_MISMATCH")).toBeUndefined()
		})

		it("does not affect other categories when resetting one", () => {
			const state = new TaskErrorState()
			state.incrementOccurrence("PARAM_TYPE_MISMATCH")
			state.incrementOccurrence("INVALID_TOOL_PROTOCOL")
			state.reset("PARAM_TYPE_MISMATCH")
			expect(state.getOccurrence("PARAM_TYPE_MISMATCH")).toBe(0)
			expect(state.getOccurrence("INVALID_TOOL_PROTOCOL")).toBe(1)
		})

		it("resets every category when no argument is given", () => {
			const state = new TaskErrorState()
			state.incrementOccurrence("A")
			state.incrementOccurrence("B")
			state.reset()
			expect(state.getOccurrence("A")).toBe(0)
			expect(state.getOccurrence("B")).toBe(0)
		})
	})
})

describe("getTaskErrorState", () => {
	it("returns the same instance for the same task", () => {
		const task = { id: "task-1" }
		const a = getTaskErrorState(task)
		const b = getTaskErrorState(task)
		expect(a).toBe(b)
	})

	it("returns distinct instances for distinct tasks", () => {
		const taskA = { id: "task-A" }
		const taskB = { id: "task-B" }
		expect(getTaskErrorState(taskA)).not.toBe(getTaskErrorState(taskB))
	})

	it("persists occurrences across multiple accessor calls", () => {
		const task = { id: "task-persist" }
		getTaskErrorState(task).incrementOccurrence("PARAM_TYPE_MISMATCH")
		getTaskErrorState(task).incrementOccurrence("PARAM_TYPE_MISMATCH")
		expect(getTaskErrorState(task).getOccurrence("PARAM_TYPE_MISMATCH")).toBe(2)
	})

	it("does not leak state across tasks", () => {
		const taskA = { id: "task-leak-A" }
		const taskB = { id: "task-leak-B" }
		getTaskErrorState(taskA).incrementOccurrence("PARAM_TYPE_MISMATCH")
		expect(getTaskErrorState(taskB).getOccurrence("PARAM_TYPE_MISMATCH")).toBe(0)
	})
})

describe("hasTaskErrorState", () => {
	it("returns false for a task that has never been accessed", () => {
		const task = { id: "task-never" }
		expect(hasTaskErrorState(task)).toBe(false)
	})

	it("returns true after getTaskErrorState has been called", () => {
		const task = { id: "task-accessed" }
		getTaskErrorState(task)
		expect(hasTaskErrorState(task)).toBe(true)
	})

	it("returns false for a different task that was never accessed", () => {
		const taskA = { id: "task-has-state" }
		const taskB = { id: "task-no-state" }
		getTaskErrorState(taskA)
		expect(hasTaskErrorState(taskA)).toBe(true)
		expect(hasTaskErrorState(taskB)).toBe(false)
	})
})

describe("non-object key guards", () => {
	// Double assertions are required below to simulate the caller mistake these
	// guards protect against: passing a primitive (e.g. a string taskId) or
	// null/undefined where a Task object is expected. There is no typed way to
	// express that mistake.

	it("getTaskErrorState returns an ephemeral state for a primitive key instead of throwing", () => {
		const notATask = "task-id" as unknown as object
		expect(() => getTaskErrorState(notATask)).not.toThrow()
		// Ephemeral: nothing is stored in the WeakMap for invalid keys.
		expect(hasTaskErrorState(notATask)).toBe(false)
	})

	it("getTaskErrorState returns a fresh ephemeral instance per call for invalid keys", () => {
		const notATask = "task-id" as unknown as object
		expect(getTaskErrorState(notATask)).not.toBe(getTaskErrorState(notATask))
	})

	it("getTaskErrorState tolerates null and undefined keys", () => {
		expect(() => getTaskErrorState(null as unknown as object)).not.toThrow()
		expect(() => getTaskErrorState(undefined as unknown as object)).not.toThrow()
	})

	it("hasTaskErrorState returns false for primitive and nullish keys", () => {
		expect(hasTaskErrorState("task-id" as unknown as object)).toBe(false)
		expect(hasTaskErrorState(42 as unknown as object)).toBe(false)
		expect(hasTaskErrorState(null as unknown as object)).toBe(false)
		expect(hasTaskErrorState(undefined as unknown as object)).toBe(false)
	})

	it("still works normally for object keys after guarded calls", () => {
		const task = { id: "task-after-guard" }
		getTaskErrorState("task-id" as unknown as object).incrementOccurrence("PARAM_MISSING")
		expect(getTaskErrorState(task).getOccurrence("PARAM_MISSING")).toBe(0)
		getTaskErrorState(task).incrementOccurrence("PARAM_MISSING")
		expect(getTaskErrorState(task).getOccurrence("PARAM_MISSING")).toBe(1)
	})
})
