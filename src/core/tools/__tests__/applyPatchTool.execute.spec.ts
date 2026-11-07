// npx vitest run core/tools/__tests__/applyPatchTool.execute.spec.ts

import type { MockedFunction } from "vitest"

import { fileExistsAtPath } from "../../../utils/fs"
import { isPathOutsideWorkspace } from "../../../utils/pathUtils"
import * as fsPromises from "fs/promises"
import type { Task } from "../../task/Task"
import { checkpointSave } from "../../checkpoints"
import { ApplyPatchTool } from "../ApplyPatchTool"

// The vi.mock factory exposes the fs/promises functions under a `default`
// property (matching the SUT's default import), which the static module type
// does not declare; cast once at this boundary rather than at each call site.
const mockedFsPromises = vi.mocked(
	fsPromises as unknown as {
		default: {
			readFile: MockedFunction<typeof fsPromises.readFile>
			unlink: MockedFunction<typeof fsPromises.unlink>
			rm: MockedFunction<typeof fsPromises.rm>
			rename: MockedFunction<typeof fsPromises.rename>
			stat: MockedFunction<typeof fsPromises.stat>
			chmod: MockedFunction<typeof fsPromises.chmod>
			writeFile: MockedFunction<typeof fsPromises.writeFile>
		}
	},
)

vi.mock("fs/promises", () => ({
	default: {
		readFile: vi.fn().mockResolvedValue("original file content\n"),
		unlink: vi.fn().mockResolvedValue(undefined),
		rm: vi.fn().mockResolvedValue(undefined),
		rename: vi.fn().mockResolvedValue(undefined),
		stat: vi.fn().mockResolvedValue({ mode: 0o755, uid: 0, gid: 0 }),
		chmod: vi.fn().mockResolvedValue(undefined),
		mkdir: vi.fn().mockResolvedValue(undefined),
		writeFile: vi.fn().mockResolvedValue(undefined),
	},
}))

vi.mock("../../../utils/fs", () => ({
	fileExistsAtPath: vi.fn().mockResolvedValue(true),
}))

vi.mock("../../../utils/pathUtils", () => ({
	isPathOutsideWorkspace: vi.fn().mockReturnValue(false),
}))

vi.mock("../../checkpoints", () => ({
	checkpointSave: vi.fn().mockResolvedValue(undefined),
}))

describe("ApplyPatchTool.execute - delete file success path", () => {
	const mockedFileExistsAtPath = fileExistsAtPath as MockedFunction<typeof fileExistsAtPath>
	const mockedIsPathOutsideWorkspace = isPathOutsideWorkspace as MockedFunction<typeof isPathOutsideWorkspace>

	let tool: ApplyPatchTool
	let mockTask: Pick<
		Task,
		| "cwd"
		| "consecutiveMistakeCount"
		| "recordToolUsage"
		| "recordToolError"
		| "rooIgnoreController"
		| "rooProtectedController"
		| "say"
		| "processQueuedMessages"
		| "didEditFile"
		| "providerRef"
		| "diffViewProvider"
		| "fileContextTracker"
	>
	let mockAskApproval: MockedFunction<(...args: unknown[]) => Promise<boolean>>
	let mockHandleError: MockedFunction<(...args: unknown[]) => Promise<void>>
	let mockPushToolResult: MockedFunction<(...args: unknown[]) => void>

	beforeEach(() => {
		vi.clearAllMocks()

		mockedFileExistsAtPath.mockResolvedValue(true)
		mockedIsPathOutsideWorkspace.mockReturnValue(false)

		mockTask = {
			cwd: "/workspace/project",
			consecutiveMistakeCount: 0,
			providerRef: {
				deref: vi.fn().mockReturnValue({
					getState: vi.fn().mockResolvedValue({}),
				}),
			} as unknown as Task["providerRef"],
			recordToolUsage: vi.fn(),
			recordToolError: vi.fn(),
			rooIgnoreController: {
				validateAccess: vi.fn().mockReturnValue(true),
			} as unknown as Task["rooIgnoreController"],
			rooProtectedController: {
				isWriteProtected: vi.fn().mockReturnValue(false),
			} as unknown as Task["rooProtectedController"],
			say: vi.fn().mockResolvedValue(undefined),
			processQueuedMessages: vi.fn(),
			didEditFile: false,
			diffViewProvider: {
				editType: "modify",
				originalContent: undefined,
				open: vi.fn().mockResolvedValue(undefined),
				update: vi.fn().mockResolvedValue(undefined),
				scrollToFirstDiff: vi.fn(),
				revertChanges: vi.fn().mockResolvedValue(undefined),
				reset: vi.fn().mockResolvedValue(undefined),
				saveDirectly: vi.fn().mockResolvedValue({ finalContent: "saved" }),
				saveChanges: vi.fn().mockResolvedValue(undefined),
				pushToolWriteResult: vi.fn().mockResolvedValue("File saved successfully"),
			} as unknown as Task["diffViewProvider"],
			fileContextTracker: {
				trackFileContext: vi.fn().mockResolvedValue(undefined),
			} as unknown as Task["fileContextTracker"],
		}

		mockAskApproval = vi.fn().mockResolvedValue(true)
		mockHandleError = vi.fn().mockResolvedValue(undefined)
		mockPushToolResult = vi.fn()

		tool = new ApplyPatchTool()
	})

	it("deletes the file and records no local tool usage on success", async () => {
		const patch = `*** Begin Patch
*** Delete File: src/obsolete.ts
*** End Patch`

		await tool.execute({ patch }, mockTask as Task, {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
			toolCallId: "test-tool-call-id",
		})

		expect(mockAskApproval).toHaveBeenCalled()
		expect(mockPushToolResult).toHaveBeenCalledWith(expect.stringContaining("Successfully deleted"))
		expect(mockTask.didEditFile).toBe(true)
		expect(mockHandleError).not.toHaveBeenCalled()

		// Usage is recorded once at the central presentAssistantMessage
		// attribution point, not locally by the handler.
		expect(mockTask.recordToolUsage).not.toHaveBeenCalled()
		expect(mockTask.recordToolError).not.toHaveBeenCalled()
	})

	describe("per-write checkpoints (B1)", () => {
		const deletePatch = `*** Begin Patch
*** Delete File: src/obsolete.ts
*** End Patch`
		const mockedCheckpointSave = checkpointSave as MockedFunction<typeof checkpointSave>

		it("records the partial-state checkpoint when post-write bookkeeping rejects after the write", async () => {
			const patch = `*** Begin Patch
*** Add File: src/new.ts
+file content
*** End Patch`
			mockedFileExistsAtPath.mockResolvedValueOnce(false)
			// The write commits, then a later bookkeeping call rejects before the handler can
			// return: the committed mutation is tracked outside the handler-return boundary, so
			// the partial-state checkpoint and the queued-message handoff must still happen.
			vi.mocked(mockTask.diffViewProvider.pushToolWriteResult).mockRejectedValueOnce(
				new Error("diagnostics unavailable"),
			)

			await tool.execute({ patch }, mockTask as Task, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				toolCallId: "test-tool-call-id",
			})

			expect(mockedCheckpointSave).toHaveBeenCalledOnce()
			expect(mockTask.processQueuedMessages).toHaveBeenCalledOnce()
			expect(mockHandleError).toHaveBeenCalled()
		})

		it("restores the pre-move state and fails the operation when source deletion fails", async () => {
			const patch = `*** Begin Patch
*** Update File: src/old.ts
*** Move to: src/new.ts
@@
-original file content
+new content
*** End Patch`
			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
			// The move destination does not exist: the rollback must remove the
			// destination rather than restore content that was never there.
			mockedFsPromises.default.readFile.mockImplementation(async (p: unknown) => {
				if (String(p).includes("new.ts")) {
					throw Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" })
				}
				return "original file content\n"
			})
			mockedFsPromises.default.unlink.mockRejectedValueOnce(
				Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" }),
			)
			// The restore itself fails too: the failure is logged, not swallowed.
			mockedFsPromises.default.rm.mockRejectedValueOnce(new Error("EROFS: read-only file system"))

			await tool.execute({ patch }, mockTask as Task, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				toolCallId: "test-tool-call-id",
			})

			// The destination write is undone so the file does not live in two places.
			expect(mockedFsPromises.default.rm).toHaveBeenCalledWith(expect.stringContaining("new.ts"), { force: true })
			expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Failed to restore pre-move state"))
			errorSpy.mockRestore()
			// The move is reported as failed rather than as a successful write, and the
			// failed rollback is part of the message: the destination may still hold the
			// new content, which the model and user must know.
			expect(mockPushToolResult).toHaveBeenCalledWith(
				expect.stringContaining("Failed to delete original file after move"),
			)
			expect(mockPushToolResult).toHaveBeenCalledWith(
				expect.stringContaining("could not be restored and may still contain the new content"),
			)
			expect(mockPushToolResult).toHaveBeenCalledWith(expect.stringContaining("EROFS"))
			// The approved content survives the failed rollback as an explicit recovery artifact.
			expect(mockPushToolResult).toHaveBeenCalledWith(
				expect.stringContaining("The approved new content was kept at"),
			)
			// ...and no whole-patch checkpoint is recorded for the failed move.
			// The destination was written (then rolled back): that is a workspace mutation, so
			// the partial-state checkpoint is recorded even though the patch reports failure.
			expect(mockedCheckpointSave).toHaveBeenCalledOnce()
			// Restore the default readFile behavior for later tests.
			mockedFsPromises.default.readFile.mockResolvedValue("original file content\n")
		})

		it("restores an existing destination when source deletion fails after the move clobbered it", async () => {
			const patch = `*** Begin Patch
*** Update File: src/old.ts
*** Move to: src/new.ts
@@
-original file content
+new content
*** End Patch`
			// The destination already exists with its own content; the move writes
			// over it before the source unlink runs.
			mockedFsPromises.default.readFile.mockImplementation(async (p: unknown) => {
				if (String(p).includes("new.ts")) {
					return "existing destination content"
				}
				return "original file content\n"
			})
			mockedFsPromises.default.unlink.mockRejectedValueOnce(
				Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" }),
			)

			await tool.execute({ patch }, mockTask as Task, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				toolCallId: "test-tool-call-id",
			})

			// The captured destination content is restored by renaming the on-disk backup
			// over the clobbered destination (one atomic replacement), never by rewriting
			// the captured bytes and never by deleting a destination that existed before.
			expect(mockedFsPromises.default.writeFile).not.toHaveBeenCalledWith(
				expect.stringContaining("new.ts"),
				"existing destination content",
			)
			expect(mockedFsPromises.default.rename).toHaveBeenCalledWith(
				expect.stringContaining(".backup"),
				expect.stringMatching(/[\\/]new\.ts$/),
			)
			// The replacement keeps the destination's mode instead of installing the
			// process defaults on the staging file.
			expect(mockedFsPromises.default.chmod).toHaveBeenCalledWith(expect.stringContaining(".staging"), 0o755)
			expect(mockPushToolResult).toHaveBeenCalledWith(
				expect.stringContaining("Failed to delete original file after move"),
			)
			// The destination was written (then rolled back): that is a workspace mutation, so
			// the partial-state checkpoint is recorded even though the patch reports failure.
			expect(mockedCheckpointSave).toHaveBeenCalledOnce()
			// Restore the default readFile behavior for later tests.
			mockedFsPromises.default.readFile.mockResolvedValue("original file content\n")
		})

		it("refuses the move before writing when the destination cannot be inspected", async () => {
			const patch = `*** Begin Patch
*** Update File: src/old.ts
*** Move to: src/new.ts
@@
-original file content
+new content
*** End Patch`
			// An EACCES on the destination is not "absent": treating every read
			// failure as missing could delete an inaccessible destination.
			mockedFsPromises.default.readFile.mockImplementation(async (p: unknown) => {
				if (String(p).includes("new.ts")) {
					throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" })
				}
				return "original file content\n"
			})

			await tool.execute({ patch }, mockTask as Task, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				toolCallId: "test-tool-call-id",
			})

			// The destination is never written and the source is never unlinked.
			expect(mockedFsPromises.default.writeFile).not.toHaveBeenCalled()
			expect(mockedFsPromises.default.unlink).not.toHaveBeenCalled()
			expect(mockPushToolResult).toHaveBeenCalledWith(expect.stringContaining("Cannot inspect move destination"))
			expect(mockedCheckpointSave).not.toHaveBeenCalled()
			// Restore the default readFile behavior for later tests.
			mockedFsPromises.default.readFile.mockResolvedValue("original file content\n")
		})

		it("persists an explicit partial-state checkpoint before handoff when a later operation fails", async () => {
			const patch = `*** Begin Patch
*** Delete File: src/obsolete.ts
*** Delete File: src/locked.ts
*** End Patch`
			// The first delete succeeds; the second fails.
			mockedFsPromises.default.unlink.mockRejectedValueOnce(new Error("EPERM: operation not permitted"))

			await tool.execute({ patch }, mockTask as Task, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				toolCallId: "test-tool-call-id",
			})

			// The retained successful delete gets an explicit partial-state
			// checkpoint before the queued-message handoff.
			expect(mockedCheckpointSave).toHaveBeenCalledTimes(1)
			const checkpointAt = mockedCheckpointSave.mock.invocationCallOrder[0] ?? Infinity
			const handoffAt = vi.mocked(mockTask.processQueuedMessages).mock.invocationCallOrder[0] ?? Infinity
			expect(checkpointAt).toBeLessThan(handoffAt)
		})
		it("persists a partial-state checkpoint when a later handler rejects outright after an earlier write", async () => {
			const patch = `*** Begin Patch
*** Delete File: src/obsolete.ts
*** Delete File: src/locked.ts
*** End Patch`
			// The first delete approves and succeeds; the second handler rejects
			// outright (e.g. the approval stream dies), so the outer catch runs
			// and the partial-state checkpoint branch above it is skipped.
			mockAskApproval.mockResolvedValueOnce(true).mockRejectedValueOnce(new Error("approval stream died"))

			await tool.execute({ patch }, mockTask as Task, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				toolCallId: "test-tool-call-id",
			})

			// The retained first delete still gets rollback metadata before the
			// queued-message handoff in the finally block.
			expect(mockedCheckpointSave).toHaveBeenCalledTimes(1)
			const checkpointAt = mockedCheckpointSave.mock.invocationCallOrder[0] ?? Infinity
			const handoffAt = vi.mocked(mockTask.processQueuedMessages).mock.invocationCallOrder[0] ?? Infinity
			expect(checkpointAt).toBeLessThan(handoffAt)
			expect(mockHandleError).toHaveBeenCalled()
		})
		it("records one suppressed checkpoint for the whole patch (default-on)", async () => {
			await tool.execute({ patch: deletePatch }, mockTask as Task, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				toolCallId: "test-tool-call-id",
			})

			expect(mockPushToolResult).toHaveBeenCalledWith(expect.stringContaining("Successfully deleted"))
			expect(mockedCheckpointSave).toHaveBeenCalledOnce()
			expect(mockedCheckpointSave).toHaveBeenCalledWith(mockTask as Task, false, true)
		})

		it("awaits the checkpoint before completing the patch", async () => {
			// An unawaited save let the tool complete (and queued work start) while
			// the checkpoint was still committing - a queued write could interleave
			// its own checkpoint and shutdown could lose the commit.
			let releaseCheckpoint: () => void = () => {}
			mockedCheckpointSave.mockImplementationOnce(
				() => new Promise<void>((resolve) => (releaseCheckpoint = resolve)),
			)
			let settled = false
			const run = tool
				.execute({ patch: deletePatch }, mockTask as Task, {
					askApproval: mockAskApproval,
					handleError: mockHandleError,
					pushToolResult: mockPushToolResult,
					toolCallId: "test-tool-call-id",
				})
				.then(() => {
					settled = true
				})
			await vi.waitFor(() => expect(mockedCheckpointSave).toHaveBeenCalledOnce())
			expect(settled).toBe(false)
			releaseCheckpoint()
			await run
			expect(settled).toBe(true)
		})
		it("defers the queued-message handoff until the checkpoint completes", async () => {
			// processQueuedMessages schedules submitUserMessage on a timer; a
			// handler that hands off before the whole-patch checkpoint completes
			// lets the queued turn start while the commit is still running.
			let releaseCheckpoint: () => void = () => {}
			mockedCheckpointSave.mockImplementationOnce(
				() => new Promise<void>((resolve) => (releaseCheckpoint = resolve)),
			)
			const run = tool.execute({ patch: deletePatch }, mockTask as Task, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				toolCallId: "test-tool-call-id",
			})
			await vi.waitFor(() => expect(mockedCheckpointSave).toHaveBeenCalledOnce())
			expect(mockTask.processQueuedMessages).not.toHaveBeenCalled()
			releaseCheckpoint()
			await run
			expect(mockTask.processQueuedMessages).toHaveBeenCalled()
		})

		it("hands off queued messages when checkpoints are disabled", async () => {
			// The handoff must not depend on the checkpoint setting: disabling
			// checkpoints must not strand queued messages.
			const ref = (mockTask["providerRef"] as unknown as { deref: MockedFunction<() => unknown> }).deref
			ref.mockReturnValue({
				getState: vi.fn().mockResolvedValue({ perWriteCheckpoints: false }),
			})

			await tool.execute({ patch: deletePatch }, mockTask as Task, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				toolCallId: "test-tool-call-id",
			})

			expect(mockedCheckpointSave).not.toHaveBeenCalled()
			expect(mockTask.processQueuedMessages).toHaveBeenCalled()
		})

		it("does not hand off queued messages when the patch fails", async () => {
			// A failed file operation must not hand off: the model is waiting
			// on the error result, not on queued input.
			mockedFsPromises.default.unlink.mockRejectedValueOnce(new Error("EBUSY"))

			await tool.execute({ patch: deletePatch }, mockTask as Task, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				toolCallId: "test-tool-call-id",
			})

			expect(mockTask.processQueuedMessages).not.toHaveBeenCalled()
		})

		it("hands off queued messages after a partial patch failure", async () => {
			// Fidelity: upstream handed off in each handler right after every
			// successful write, so a patch whose first write succeeded and whose
			// later write failed still drained the queue. The deferral preserves
			// that condition (a write happened) and only moves its timing after
			// the checkpoint attempt; requiring full-patch success would strand
			// queued input on any partial failure.
			const mixedPatch = `*** Begin Patch
*** Add File: src/new.ts
+hello
*** Delete File: src/obsolete.ts
*** End Patch`
			// Add sees no existing file and succeeds; the delete's unlink fails.
			mockedFileExistsAtPath.mockResolvedValueOnce(false)
			mockedFsPromises.default.unlink.mockRejectedValueOnce(new Error("EBUSY"))

			await tool.execute({ patch: mixedPatch }, mockTask as Task, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				toolCallId: "test-tool-call-id",
			})

			// The retained successful write gets an explicit partial-state
			// checkpoint before the queued-message handoff.
			expect(mockedCheckpointSave).toHaveBeenCalledTimes(1)
			expect(mockTask.processQueuedMessages).toHaveBeenCalled()
			expect(mockedCheckpointSave.mock.invocationCallOrder[0]).toBeLessThan(
				vi.mocked(mockTask.processQueuedMessages).mock.invocationCallOrder[0] ?? Infinity,
			)
		})

		it("hands off queued messages when a later file fails the access check", async () => {
			// The rooignored path makes execute return early, but the earlier
			// successful write had already handed off upstream - the deferred
			// handoff preserves that too.
			const mixedPatch = `*** Begin Patch
*** Delete File: src/obsolete.ts
*** Add File: src/secret.ts
+hidden
*** End Patch`
			const validateAccess = mockTask.rooIgnoreController?.validateAccess as MockedFunction<
				(path: string) => boolean
			>
			validateAccess.mockReturnValueOnce(true).mockReturnValueOnce(false)

			await tool.execute({ patch: mixedPatch }, mockTask as Task, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				toolCallId: "test-tool-call-id",
			})

			// The earlier successful delete is retained: an explicit partial-state
			// checkpoint persists it before the deferred handoff.
			expect(mockedCheckpointSave).toHaveBeenCalledTimes(1)
			expect(mockTask.processQueuedMessages).toHaveBeenCalledTimes(1)
			// The access-failed file is never written and the loop stops there.
			expect(mockTask.fileContextTracker.trackFileContext).not.toHaveBeenCalledWith(
				"src/secret.ts",
				expect.anything(),
			)
		})

		it("does not record a checkpoint when perWriteCheckpoints is disabled", async () => {
			// Structural cast for the test double (matches the mock style used for the controllers above).
			const ref = (mockTask["providerRef"] as unknown as { deref: MockedFunction<() => unknown> }).deref
			ref.mockReturnValue({
				getState: vi.fn().mockResolvedValue({ perWriteCheckpoints: false }),
			})

			await tool.execute({ patch: deletePatch }, mockTask as Task, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				toolCallId: "test-tool-call-id",
			})

			expect(mockPushToolResult).toHaveBeenCalledWith(expect.stringContaining("Successfully deleted"))
			expect(mockedCheckpointSave).not.toHaveBeenCalled()
		})

		it("does not record a checkpoint when patch processing fails", async () => {
			// A malformed patch fails at parse time, before the change loop and
			// the post-loop checkpoint hook.
			const badPatch = `*** Begin Patch
*** This is not a valid hunk
*** End Patch`

			await tool.execute({ patch: badPatch }, mockTask as Task, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				toolCallId: "test-tool-call-id",
			})

			expect(mockTask.recordToolError).toHaveBeenCalledWith("apply_patch")
			expect(mockedCheckpointSave).not.toHaveBeenCalled()
		})
	})

	describe("checkpoint only for fully successful patches (B1)", () => {
		const mockedCheckpointSave = checkpointSave as MockedFunction<typeof checkpointSave>
		const deletePatch = `*** Begin Patch
*** Delete File: src/obsolete.ts
*** End Patch`
		const addPatch = `*** Begin Patch
*** Add File: src/new.ts
+hello
+world
*** End Patch`
		const updatePatch = `*** Begin Patch
*** Update File: src/test.ts
@@
-original file content
+modified content
*** End Patch`
		const updateNoDiffPatch = `*** Begin Patch
*** Update File: src/test.ts
@@
-original file content
+original file content
*** End Patch`
		const movePatch = `*** Begin Patch
*** Update File: src/test.ts
*** Move to: src/moved.ts
@@
-original file content
+modified content
*** End Patch`

		it("does not record a checkpoint when the user rejects the patch", async () => {
			// Rejected approval: the handler early-returns without recording a
			// tool error, so the success flag must come from the handler itself.
			mockAskApproval.mockResolvedValue(false)

			await tool.execute({ patch: deletePatch }, mockTask as Task, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				toolCallId: "test-tool-call-id",
			})

			expect(mockPushToolResult).toHaveBeenCalledWith("Delete operation was rejected by the user.")
			expect(mockedCheckpointSave).not.toHaveBeenCalled()
		})

		it("does not record a checkpoint when the file to delete does not exist", async () => {
			mockedFileExistsAtPath.mockResolvedValue(false)

			await tool.execute({ patch: deletePatch }, mockTask as Task, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				toolCallId: "test-tool-call-id",
			})

			expect(mockPushToolResult).toHaveBeenCalledWith(expect.stringContaining("File not found"))
			expect(mockedCheckpointSave).not.toHaveBeenCalled()
		})

		it("does not record a checkpoint when the delete write fails", async () => {
			mockedFsPromises.default.unlink.mockRejectedValueOnce(new Error("EBUSY"))

			await tool.execute({ patch: deletePatch }, mockTask as Task, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				toolCallId: "test-tool-call-id",
			})

			expect(mockPushToolResult).toHaveBeenCalledWith(expect.stringContaining("Failed to delete file"))
			expect(mockedCheckpointSave).not.toHaveBeenCalled()
		})

		it("does not record a checkpoint when the added file already exists", async () => {
			// fileExistsAtPath resolves true by default in beforeEach.

			await tool.execute({ patch: addPatch }, mockTask as Task, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				toolCallId: "test-tool-call-id",
			})

			expect(mockPushToolResult).toHaveBeenCalledWith(expect.stringContaining("File already exists"))
			expect(mockedCheckpointSave).not.toHaveBeenCalled()
		})

		it("does not record a checkpoint when the user rejects the add", async () => {
			mockedFileExistsAtPath.mockResolvedValue(false)
			mockAskApproval.mockResolvedValue(false)

			await tool.execute({ patch: addPatch }, mockTask as Task, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				toolCallId: "test-tool-call-id",
			})

			expect(mockPushToolResult).toHaveBeenCalledWith("Changes were rejected by the user.")
			expect(mockedCheckpointSave).not.toHaveBeenCalled()
		})

		it("records a checkpoint when the add succeeds", async () => {
			mockedFileExistsAtPath.mockResolvedValue(false)

			await tool.execute({ patch: addPatch }, mockTask as Task, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				toolCallId: "test-tool-call-id",
			})

			expect(mockPushToolResult).toHaveBeenCalledWith("File saved successfully")
			expect(mockedCheckpointSave).toHaveBeenCalledOnce()
		})

		it("does not record a checkpoint when the file to update does not exist", async () => {
			mockedFileExistsAtPath.mockResolvedValue(false)

			await tool.execute({ patch: updatePatch }, mockTask as Task, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				toolCallId: "test-tool-call-id",
			})

			expect(mockPushToolResult).toHaveBeenCalledWith(expect.stringContaining("File not found"))
			expect(mockedCheckpointSave).not.toHaveBeenCalled()
		})

		it("records a checkpoint when the update is a no-op (no changes needed)", async () => {
			// A no-op change is not a failure, so the whole-patch checkpoint still runs.

			await tool.execute({ patch: updateNoDiffPatch }, mockTask as Task, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				toolCallId: "test-tool-call-id",
			})

			expect(mockPushToolResult).toHaveBeenCalledWith(expect.stringContaining("No changes needed"))
			expect(mockedCheckpointSave).toHaveBeenCalledOnce()
		})

		it("does not record a checkpoint when the user rejects the update", async () => {
			mockAskApproval.mockResolvedValue(false)

			await tool.execute({ patch: updatePatch }, mockTask as Task, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				toolCallId: "test-tool-call-id",
			})

			expect(mockPushToolResult).toHaveBeenCalledWith("Changes were rejected by the user.")
			expect(mockedCheckpointSave).not.toHaveBeenCalled()
		})

		it("does not record a checkpoint when the move destination is not allowed", async () => {
			// First validateAccess call (source path, in the execute loop) passes;
			// the move destination check inside the handler fails.
			const validateAccess = (
				mockTask["rooIgnoreController"] as unknown as { validateAccess: MockedFunction<() => boolean> }
			).validateAccess
			validateAccess.mockReturnValueOnce(true).mockReturnValue(false)

			await tool.execute({ patch: movePatch }, mockTask as Task, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				toolCallId: "test-tool-call-id",
			})

			expect(mockTask.say).toHaveBeenCalledWith("rooignore_error", "src/moved.ts")
			expect(mockedCheckpointSave).not.toHaveBeenCalled()
		})

		it("does not record a checkpoint when the move destination is write-protected", async () => {
			// Source path check (execute loop) passes; the move destination fails.
			const isWriteProtected = (
				mockTask["rooProtectedController"] as unknown as {
					isWriteProtected: MockedFunction<(p: string) => boolean>
				}
			).isWriteProtected
			isWriteProtected.mockReturnValueOnce(false).mockReturnValue(true)

			await tool.execute({ patch: movePatch }, mockTask as Task, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				toolCallId: "test-tool-call-id",
			})

			expect(mockPushToolResult).toHaveBeenCalledWith(
				expect.stringContaining("Cannot move file to write-protected path"),
			)
			expect(mockedCheckpointSave).not.toHaveBeenCalled()
		})

		it("does not record a checkpoint when the move destination is outside the workspace", async () => {
			// Source path (first call) is inside; the move destination (second)
			// call is outside the workspace.
			mockedIsPathOutsideWorkspace.mockReturnValueOnce(false).mockReturnValue(true)

			await tool.execute({ patch: movePatch }, mockTask as Task, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				toolCallId: "test-tool-call-id",
			})

			expect(mockPushToolResult).toHaveBeenCalledWith(
				expect.stringContaining("Cannot move file to path outside workspace"),
			)
			expect(mockedCheckpointSave).not.toHaveBeenCalled()
		})

		it("records a checkpoint when the move succeeds", async () => {
			await tool.execute({ patch: movePatch }, mockTask as Task, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				toolCallId: "test-tool-call-id",
			})

			// path is platform-dependent (Windows resolves cwd to a drive path);
			// assert on the written content instead.
			// The staging file is created owner-only; the destination mode is re-applied
			// separately before the atomic rename.
			expect(mockedFsPromises.default.writeFile).toHaveBeenCalledWith(expect.any(String), "modified content\n", {
				encoding: "utf8",
				mode: 0o600,
			})
			expect(mockedCheckpointSave).toHaveBeenCalledOnce()
		})

		it("records a checkpoint when the in-place update succeeds", async () => {
			await tool.execute({ patch: updatePatch }, mockTask as Task, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				toolCallId: "test-tool-call-id",
			})

			expect(mockHandleError).not.toHaveBeenCalled()
			expect(mockedCheckpointSave).toHaveBeenCalledOnce()
			expect(mockedCheckpointSave).toHaveBeenCalledWith(mockTask as Task, false, true)
		})

		it("records exactly one checkpoint for a multi-file patch", async () => {
			// B1's core contract: one checkpoint per patch, not per file - a
			// regression to per-change saves would double the checkpoint count.
			const multiPatch = [
				"*** Begin Patch",
				"*** Add File: src/new.ts",
				"+hello",
				"+world",
				"*** Update File: src/test.ts",
				"@@",
				"-original file content",
				"+modified content",
				"*** End Patch",
			].join(String.fromCharCode(10))
			mockedFileExistsAtPath.mockImplementation((filePath: string) =>
				Promise.resolve(!String(filePath).toLowerCase().endsWith("new.ts")),
			)

			await tool.execute({ patch: multiPatch }, mockTask as Task, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				toolCallId: "test-tool-call-id",
			})

			expect(mockHandleError).not.toHaveBeenCalled()
			expect(mockedCheckpointSave).toHaveBeenCalledOnce()
		})
	})
})
