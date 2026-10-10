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
		discardUnapprovedStream: MockedFunction<() => Promise<void>>
		revertChanges: MockedFunction<() => Promise<void>>
	}
	finalizePartialToolAsk: MockedFunction<() => Promise<void>>
	say: MockedFunction<(...args: unknown[]) => Promise<void>>
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
		const task = buildTask("revert-fails", "inst-4")
		const t = task as unknown as CleanupTask
		t.diffViewProvider.discardUnapprovedStream = vi.fn().mockRejectedValue(new Error("revert failed"))
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

		await writeToFileTool["discardUnapprovedStreamBeforeReset"](task)

		expect(errorSpy).toHaveBeenCalledWith(
			"Error discarding the unapproved write_to_file diff view:",
			expect.any(Error),
		)
	})

	it("discards while the recovery state exists and reports the hazard when the discard fails", async () => {
		const task = buildTask("revert-fails-teardown", "inst-6")
		const t = task as unknown as CleanupTask
		let stateSizeDuringRevert = -1
		t.diffViewProvider.discardUnapprovedStream = vi.fn(async () => {
			// The recovery state must still be present while the rollback runs.
			stateSizeDuringRevert = writeToFileTool["taskPartialStreamState"].size
			throw new Error("revert failed")
		})
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		// Seed the per-task stream state so this teardown boundary is taken at all.
		writeToFileTool["getTaskPartialStreamState"](task)
		expect(writeToFileTool["taskPartialStreamState"].size).toBe(1)

		const handled = await writeToFileTool["onParameterParseFailure"](
			task,
			// Only handleError is reached when no streaming error was recorded; the
			// structural double is the existing pattern in this file.
			{ handleError: vi.fn().mockResolvedValue(undefined) } as unknown as Parameters<
				(typeof writeToFileTool)["onParameterParseFailure"]
			>[1],
			new Error("parameter parse failed"),
		)

		// A failed rollback is not a completed teardown: the user is told the editor may
		// still hold content the task never approved.
		expect(t.say).toHaveBeenCalledWith("error", expect.stringContaining("unapproved"))
		expect(stateSizeDuringRevert).toBe(1)
		// The teardown still finished.
		expect(writeToFileTool["taskPartialStreamState"].size).toBe(0)
		expect(t.diffViewProvider.reset).toHaveBeenCalled()
		expect(handled).toBe(false)
		errorSpy.mockRestore()
	})

	it("reports the rollback hazard AND the retained streaming error, and returns true", async () => {
		const task = buildTask("revert-fails-with-stream-error", "inst-7")
		const t = task as unknown as CleanupTask
		t.diffViewProvider.discardUnapprovedStream = vi.fn().mockRejectedValue(new Error("revert failed"))
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		const state = writeToFileTool["getTaskPartialStreamState"](task)
		const streamError = new Error("filesystem failure while streaming")
		state.streamFailed = true
		state.streamError = streamError
		const handleError = vi.fn().mockResolvedValue(undefined)

		const handled = await writeToFileTool["onParameterParseFailure"](
			task,
			{ handleError } as unknown as Parameters<(typeof writeToFileTool)["onParameterParseFailure"]>[1],
			new Error("parameter parse failed"),
		)

		// Both reports happen: the rollback hazard and the error the user can act on.
		expect(t.say).toHaveBeenCalledWith("error", expect.stringContaining("unapproved"))
		expect(handleError).toHaveBeenCalledWith("writing file", streamError)
		expect(handled).toBe(true)
		errorSpy.mockRestore()
	})

	it("still reports the streaming error when the rollback warning itself fails", async () => {
		const task = buildTask("rollback-warning-fails", "inst-8")
		const t = task as unknown as CleanupTask
		t.diffViewProvider.discardUnapprovedStream = vi.fn().mockRejectedValue(new Error("revert failed"))
		t.say = vi.fn().mockRejectedValue(new Error("say failed"))
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		const state = writeToFileTool["getTaskPartialStreamState"](task)
		const streamError = new Error("filesystem failure while streaming")
		state.streamFailed = true
		state.streamError = streamError
		const handleError = vi.fn().mockResolvedValue(undefined)

		const handled = await writeToFileTool["onParameterParseFailure"](
			task,
			{ handleError } as unknown as Parameters<(typeof writeToFileTool)["onParameterParseFailure"]>[1],
			new Error("parameter parse failed"),
		)

		// A failing report must not abort the teardown: the streaming error still lands.
		expect(errorSpy).toHaveBeenCalledWith("Error reporting write_to_file rollback failure:", expect.any(Error))
		expect(handleError).toHaveBeenCalledWith("writing file", streamError)
		expect(handled).toBe(true)
		errorSpy.mockRestore()
	})

	it("surfaces the rollback hazard from the failed-stream cleanup as well", async () => {
		const task = buildTask("failed-stream-cleanup", "inst-9")
		const t = task as unknown as CleanupTask
		t.diffViewProvider.discardUnapprovedStream = vi.fn().mockRejectedValue(new Error("revert failed"))
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

		await writeToFileTool["cleanupFailedPartialStream"](task)

		// Same contract as the parse-failure teardown: a failed restore is reported.
		expect(t.say).toHaveBeenCalledWith("error", expect.stringContaining("unapproved"))
		expect(t.diffViewProvider.reset).toHaveBeenCalled()
		errorSpy.mockRestore()
	})

	it("stays silent when the failed-stream cleanup restored the editor", async () => {
		// Every other case here makes the discard reject, so a cleanup that warned after EVERY
		// restore still passed. "The editor may hold content you never approved" is only true when
		// the restore failed; saying it regardless trains the user to ignore the warning.
		const task = buildTask("failed-stream-clean", "inst-10")
		const t = task as unknown as CleanupTask

		await writeToFileTool["cleanupFailedPartialStream"](task)

		expect(t.diffViewProvider.discardUnapprovedStream).toHaveBeenCalledTimes(1)
		expect(t.diffViewProvider.reset).toHaveBeenCalledTimes(1)
		expect(t.say).not.toHaveBeenCalled()
	})

	it("stays silent when the parse-failure teardown restored the editor", async () => {
		// The same contract on the other teardown boundary: a completed restore is not a hazard,
		// so nothing is reported and the incidental parse error is left to the caller.
		const task = buildTask("parse-failure-clean", "inst-11")
		const t = task as unknown as CleanupTask
		writeToFileTool["getTaskPartialStreamState"](task)
		const handleError = vi.fn().mockResolvedValue(undefined)

		const handled = await writeToFileTool["onParameterParseFailure"](
			task,
			{ handleError } as unknown as Parameters<(typeof writeToFileTool)["onParameterParseFailure"]>[1],
			new Error("parameter parse failed"),
		)

		expect(t.diffViewProvider.discardUnapprovedStream).toHaveBeenCalledTimes(1)
		expect(t.say).not.toHaveBeenCalled()
		expect(handleError).not.toHaveBeenCalled()
		expect(handled).toBe(false)
		expect(writeToFileTool["taskPartialStreamState"].size).toBe(0)
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
