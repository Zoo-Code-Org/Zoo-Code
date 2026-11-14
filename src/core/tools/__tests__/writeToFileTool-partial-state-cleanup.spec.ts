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
		/** Whether this edit still owns the empty placeholder open() created for a new file. */
		ownsPlaceholder: boolean
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
			// The default scenario is a delta over an EXISTING file: no placeholder ownership is
			// at stake, so the only reason a failed restore has to keep a session is the
			// unapproved content still sitting in the buffer.
			ownsPlaceholder: false,
		},
		finalizePartialToolAsk: vi.fn().mockResolvedValue(undefined),
		say: vi.fn().mockResolvedValue(undefined),
	}
	return task as unknown as Task
}

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
		// Seed the per-task stream state so this teardown boundary is taken at all, and mark it as a
		// stream that reached the diff view: that is the preview the hook below owes a rollback, and
		// ownsPreview is the flag it checks before touching the view.
		const seededState = writeToFileTool["getTaskPartialStreamState"](task)
		seededState.ownsPreview = true
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
		// The restore failed over an existing file, so the buffer can still hold that
		// unapproved content: the recovery state AND the diff session have to survive, or
		// nothing is left that knows this path still owes a rollback.
		expect(writeToFileTool["taskPartialStreamState"].size).toBe(1)
		expect(t.diffViewProvider.reset).not.toHaveBeenCalled()
		expect(t.off).not.toHaveBeenCalled()
		expect(handled).toBe(false)
		// The retained entry is still tearable: clearing the task state releases the
		// bookkeeping and deregisters the abort listener it registered.
		writeToFileTool.clearTaskState(task)
		expect(writeToFileTool["taskPartialStreamState"].size).toBe(0)
		expect(t.off).toHaveBeenCalledWith(RooCodeEventName.TaskAborted, seededState.abortCleanup)
		errorSpy.mockRestore()
	})

	it("reports the rollback hazard AND the retained streaming error, and returns true", async () => {
		const task = buildTask("revert-fails-with-stream-error", "inst-7")
		const t = task as unknown as CleanupTask
		t.diffViewProvider.discardUnapprovedStream = vi.fn().mockRejectedValue(new Error("revert failed"))
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		const state = writeToFileTool["getTaskPartialStreamState"](task)
		// The scenario stands for a delta that had already streamed into the diff view - that is
		// the preview this teardown is on the hook to roll back - and ownsPreview is the flag the
		// parse-failure hook checks before it touches the view.
		state.ownsPreview = true
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
		// The scenario stands for a delta that had already streamed into the diff view - that is
		// the preview this teardown is on the hook to roll back - and ownsPreview is the flag the
		// parse-failure hook checks before it touches the view.
		state.ownsPreview = true
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
		// The restore failed over an existing file, so the diff session survives with it:
		// resetting here would forget that this path still owes a rollback.
		expect(t.diffViewProvider.reset).not.toHaveBeenCalled()
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
		// The scenario owns the preview the teardown below is responsible for, and ownsPreview is
		// the flag the hook checks before it touches the view.
		writeToFileTool["getTaskPartialStreamState"](task).ownsPreview = true
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

	it("releases only its own bookkeeping when a parse failure follows a stream that never reached the view", async () => {
		// The ownership case at this boundary: a stream whose path never stabilized still has
		// state, and its final block can still fail to parse. The provider may be holding a
		// session from an earlier call - together with the placeholder ownership that goes with
		// it - and this stream never opened or updated that view, so the hook has to release the
		// bookkeeping and leave the provider state alone: discarding or resetting here would throw
		// away a session this stream does not own.
		const task = buildTask("parse-failure-never-owned", "inst-12")
		const t = task as unknown as CleanupTask
		writeToFileTool["getTaskPartialStreamState"](task)
		const handleError = vi.fn().mockResolvedValue(undefined)

		const handled = await writeToFileTool["onParameterParseFailure"](
			task,
			{ handleError } as unknown as Parameters<(typeof writeToFileTool)["onParameterParseFailure"]>[1],
			new Error("parameter parse failed"),
		)

		expect(handled).toBe(false)
		expect(t.diffViewProvider.discardUnapprovedStream).not.toHaveBeenCalled()
		expect(t.diffViewProvider.reset).not.toHaveBeenCalled()
		expect(t.say).not.toHaveBeenCalled()
		expect(handleError).not.toHaveBeenCalled()
		expect(writeToFileTool["taskPartialStreamState"].size).toBe(0)
	})

	it("reports a retained streaming error without touching a view this stream never owned", async () => {
		// Same ownership answer, with a filesystem failure on the books: the error is still
		// the user's to act on, so it is reported with execute()'s "writing file" context -
		// reporting it never required touching the other session's view.
		const task = buildTask("never-owned-stream-error", "inst-13")
		const t = task as unknown as CleanupTask
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

		expect(handled).toBe(true)
		expect(handleError).toHaveBeenCalledWith("writing file", streamError)
		expect(t.diffViewProvider.discardUnapprovedStream).not.toHaveBeenCalled()
		expect(t.diffViewProvider.reset).not.toHaveBeenCalled()
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

	it("keeps the diff session when the cleanup could not restore an existing file", async () => {
		// The class the review named, pinned on its own: the restore refused, the file is an
		// existing one, so ownsPlaceholder is false and the old code reset the view anyway.
		// That reset cleared isEditing and relPath - the only thing telling a later call that
		// this path still owes a rollback - while the buffer went on holding content the task
		// never approved, one save away from landing on disk.
		const task = buildTask("failed-stream-existing-file", "inst-14")
		const t = task as unknown as CleanupTask
		t.diffViewProvider.discardUnapprovedStream = vi.fn().mockRejectedValue(new Error("revert failed"))
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

		await writeToFileTool["cleanupFailedPartialStream"](task)

		expect(t.diffViewProvider.reset).not.toHaveBeenCalled()
		expect(t.say).toHaveBeenCalledWith("error", expect.stringContaining("unapproved"))
		errorSpy.mockRestore()
	})
})
