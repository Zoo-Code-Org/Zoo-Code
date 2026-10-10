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
		discardUnapprovedStream: MockedFunction<() => Promise<void>>
		adoptCreatedDirectories: MockedFunction<(directories: string[]) => void>
		removeAdoptedDirectories: MockedFunction<() => Promise<void>>
	}
	finalizePartialToolAsk: MockedFunction<() => Promise<void>>
	say: MockedFunction<() => Promise<void>>
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
			discardUnapprovedStream: vi.fn().mockResolvedValue(undefined),
			adoptCreatedDirectories: vi.fn(),
			removeAdoptedDirectories: vi.fn().mockResolvedValue(undefined),
		},
		finalizePartialToolAsk: vi.fn().mockResolvedValue(undefined),
		say: vi.fn().mockResolvedValue(undefined),
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

		writeToFileTool.clearTaskState(task)

		expect(writeToFileTool["taskPartialStreamState"].size).toBe(0)
		expect((task as unknown as CleanupTask).off).toHaveBeenCalledWith(
			RooCodeEventName.TaskAborted,
			state.abortCleanup,
		)
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

	it("logs and continues when discarding the unapproved diff view fails", async () => {
		const task = buildTask("discard-fails", "inst-4")
		const t = task as unknown as CleanupTask
		t.diffViewProvider.discardUnapprovedStream = vi.fn().mockRejectedValue(new Error("discard failed"))
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

		const failure = await writeToFileTool["discardUnapprovedStreamBeforeReset"](task)

		expect(errorSpy).toHaveBeenCalledWith(
			"Error discarding the unapproved write_to_file diff view:",
			expect.any(Error),
		)
		// Returned, not dropped: the caller reports the debris instead of continuing past it.
		expect(failure?.message).toBe("discard failed")
	})

	it("releases the stream state and the preview when the completed block is rejected before the tool runs", async () => {
		// Streaming is not gated by the checks that guard execution: a partial delta registers
		// this entry and may open a preview, then validateToolUse() throws (or the repetition
		// guard refuses the block) and the loop breaks before handle() is reached. Nothing else
		// on that path releases the entry, the listener, or the preview.
		const task = buildTask("validation-rejected", "inst-6")
		const t = task as unknown as CleanupTask
		const state = writeToFileTool["getTaskPartialStreamState"](task)
		expect(writeToFileTool["taskPartialStreamState"].size).toBe(1)

		await writeToFileTool.releaseStreamAfterValidationRejection(task)

		expect(writeToFileTool["taskPartialStreamState"].size).toBe(0)
		expect(t.off).toHaveBeenCalledWith(RooCodeEventName.TaskAborted, state.abortCleanup)
		expect(t.diffViewProvider.discardUnapprovedStream).toHaveBeenCalledTimes(1)
		expect(t.diffViewProvider.reset).toHaveBeenCalledTimes(1)
		// The discard must run first: reset() clears the state it reads.
		expect(t.diffViewProvider.discardUnapprovedStream.mock.invocationCallOrder[0]).toBeLessThan(
			t.diffViewProvider.reset.mock.invocationCallOrder[0],
		)
		// Resources only - the validation error is the tool result the model sees.
		expect(t.say).not.toHaveBeenCalled()
	})

	it("is a no-op when the rejected block never streamed", async () => {
		// Every other tool and every non-streaming write reaches this branch.
		const task = buildTask("rejected-never-streamed", "inst-7")
		const t = task as unknown as CleanupTask

		await writeToFileTool.releaseStreamAfterValidationRejection(task)

		expect(t.off).not.toHaveBeenCalled()
		expect(t.diffViewProvider.discardUnapprovedStream).not.toHaveBeenCalled()
		expect(t.diffViewProvider.reset).not.toHaveBeenCalled()
	})

	it("tells the user the editor may still hold unapproved content when that rejection cannot restore it", async () => {
		// The validation error is the model's tool result and must stay the only one; the disk
		// hazard belongs to the user, so it surfaces in the chat instead of replacing it.
		const task = buildTask("rejected-rollback-fails", "inst-8")
		const t = task as unknown as CleanupTask
		t.diffViewProvider.discardUnapprovedStream = vi.fn().mockRejectedValue(new Error("close rejected"))
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		writeToFileTool["getTaskPartialStreamState"](task)

		await writeToFileTool.releaseStreamAfterValidationRejection(task)

		expect(t.say).toHaveBeenCalledWith("error", expect.stringContaining("may still show unapproved content"))
		expect(t.diffViewProvider.reset).toHaveBeenCalledTimes(1)
		errorSpy.mockRestore()
	})

	it("resolves and logs when the rollback report itself cannot be delivered", async () => {
		// Task.say() throws once the task is aborted, and the presenter can reject a block
		// while that abort lands. The release must still finish and reset the view: a report
		// that cannot be delivered is not a reason to stop cleaning up.
		const task = buildTask("rejected-report-fails", "inst-9")
		const t = task as unknown as CleanupTask
		t.diffViewProvider.discardUnapprovedStream = vi.fn().mockRejectedValue(new Error("close rejected"))
		t.say = vi.fn().mockRejectedValue(new Error("task aborted"))
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		writeToFileTool["getTaskPartialStreamState"](task)

		await expect(writeToFileTool.releaseStreamAfterValidationRejection(task)).resolves.toBeUndefined()

		expect(errorSpy).toHaveBeenCalledWith("Error reporting write_to_file rollback failure:", expect.any(Error))
		expect(t.diffViewProvider.reset).toHaveBeenCalledTimes(1)
		errorSpy.mockRestore()
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
