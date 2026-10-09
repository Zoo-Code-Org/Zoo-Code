// npx vitest run core/tools/__tests__/writeToFileTool-partial-state-cleanup.spec.ts

import { RooCodeEventName } from "@roo-code/types"
import { vi, type MockedFunction } from "vitest"

import { type Task } from "../../task/Task"
import { writeToFileTool } from "../WriteToFileTool"

// The cleanup primitives only read these members, so a structural double is enough;
// the double assertion is the repo's existing pattern for private-method tests
// (see src/__tests__/removeClineFromStack-delegation.spec.ts).
interface CleanupTask {
	taskId: string
	instanceId: string
	once: MockedFunction<(...args: unknown[]) => unknown>
	off: MockedFunction<(...args: unknown[]) => unknown>
	diffViewProvider: {
		reset: MockedFunction<() => Promise<void>>
		revertChanges: MockedFunction<() => Promise<void>>
	}
	finalizePartialToolAsk: MockedFunction<() => Promise<void>>
}

function buildTask(taskId: string, instanceId: string): Task {
	const task: CleanupTask = {
		taskId,
		instanceId,
		once: vi.fn(),
		off: vi.fn(),
		diffViewProvider: {
			reset: vi.fn().mockResolvedValue(undefined),
			revertChanges: vi.fn().mockResolvedValue(undefined),
		},
		finalizePartialToolAsk: vi.fn().mockResolvedValue(undefined),
	}
	return task as unknown as Task
}

// Private members are reached by bracket notation (AGENTS.md: no `as any`).
const stateFor = (task: Task) => writeToFileTool["taskPartialStreamState"].get(`${task.taskId}.${task.instanceId}`)

describe("WriteToFileTool per-task partial-state cleanup", () => {
	afterEach(() => {
		writeToFileTool["taskPartialStreamState"].clear()
		vi.restoreAllMocks()
	})

	it("releases the task state and deregisters the abort listener", async () => {
		const task = buildTask("cleanup-task", "inst-1")
		const state = writeToFileTool["getTaskPartialStreamState"](task)
		expect(writeToFileTool["taskPartialStreamState"].size).toBe(1)
		// The registration side of the pairing, asserted BEFORE the cleanup runs: the off()
		// assertion below only proves the right listener was deregistered if this one pins which
		// listener was registered in the first place.
		expect((task as unknown as CleanupTask).once).toHaveBeenCalledWith(RooCodeEventName.TaskAborted, state.abortCleanup)

		writeToFileTool.clearTaskState(task)

		expect(writeToFileTool["taskPartialStreamState"].size).toBe(0)
		expect((task as unknown as CleanupTask).off).toHaveBeenCalledWith(RooCodeEventName.TaskAborted, state.abortCleanup)
	})

	it("is a no-op for a task that never streamed", async () => {
		const task = buildTask("never-streamed", "inst-2")

		writeToFileTool.clearTaskState(task)

		expect(writeToFileTool["taskPartialStreamState"].size).toBe(0)
		expect((task as unknown as CleanupTask).off).not.toHaveBeenCalled()
	})

	it("logs and continues when resetting the diff view fails", async () => {
		const task = buildTask("reset-fails", "inst-3")
		const t = task as unknown as CleanupTask
		t.diffViewProvider.reset = vi.fn().mockRejectedValue(new Error("reset failed"))
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

		await writeToFileTool["resetDiffViewAfterWrite"](task)

		expect(errorSpy).toHaveBeenCalledWith("Error resetting write_to_file diff view:", expect.any(Error))
	})

	it("logs and continues when reverting the diff document fails", async () => {
		const task = buildTask("revert-fails", "inst-4")
		const t = task as unknown as CleanupTask
		t.diffViewProvider.revertChanges = vi.fn().mockRejectedValue(new Error("revert failed"))
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

		await writeToFileTool["revertDiffChangesBeforeReset"](task)

		expect(errorSpy).toHaveBeenCalledWith("Error reverting write_to_file diff view changes:", expect.any(Error))
	})

	it("logs and continues when finalizing the open partial ask fails", async () => {
		const task = buildTask("finalize-fails", "inst-5")
		const t = task as unknown as CleanupTask
		t.finalizePartialToolAsk = vi.fn().mockRejectedValue(new Error("finalize failed"))
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

		await writeToFileTool["finalizePartialToolAskAfterFailure"](task, "partial text")

		expect(errorSpy).toHaveBeenCalledWith("Error finalizing write_to_file partial tool ask:", expect.any(Error))
	})
})
