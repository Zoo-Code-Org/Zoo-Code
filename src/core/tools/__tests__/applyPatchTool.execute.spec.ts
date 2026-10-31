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
			unlink: MockedFunction<typeof fsPromises.unlink>
			writeFile: MockedFunction<typeof fsPromises.writeFile>
		}
	},
)

vi.mock("fs/promises", () => ({
	default: {
		readFile: vi.fn().mockResolvedValue("original file content\n"),
		unlink: vi.fn().mockResolvedValue(undefined),
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
	getCheckpointService: vi.fn(),
	checkpointSave: vi.fn().mockResolvedValue(undefined),
	checkpointRestore: vi.fn(),
	checkpointDiff: vi.fn(),
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

		it("records one suppressed checkpoint for the whole patch (default-on)", async () => {
			await tool.execute({ patch: deletePatch }, mockTask as Task, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				toolCallId: "test-tool-call-id",
			})

			expect(mockPushToolResult).toHaveBeenCalledWith(expect.stringContaining("Successfully deleted"))
			expect(mockedCheckpointSave).toHaveBeenCalledOnce()
			// B2: the delete patch produces one journal write, referencing the
			// single checkpoint saved for the whole patch.
			expect(mockedCheckpointSave).toHaveBeenCalledWith(mockTask as Task, false, true, [
				{ path: "src/obsolete.ts", operation: "delete" },
			])
		})

		it("emits per-file success results only after the post-patch checkpoint persists", async () => {
			await tool.execute({ patch: deletePatch }, mockTask as Task, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				toolCallId: "test-tool-call-id",
			})

			// CR follow-up: the buffered success result is emitted only after
			// checkpointSave resolved - a success is never reported before its
			// journal save completes.
			expect(mockPushToolResult).toHaveBeenCalledWith(expect.stringContaining("Successfully deleted"))
			const saveOrder = mockedCheckpointSave.mock.invocationCallOrder[0]
			const resultOrder = mockPushToolResult.mock.invocationCallOrder[0]
			expect(saveOrder).toBeLessThan(resultOrder)
		})

		it("drops buffered success results and still hands off on a journal persistence failure", async () => {
			mockedCheckpointSave.mockRejectedValueOnce(
				new Error(
					"Checkpoint abc123def was committed but its change journal could not be persisted (files: src/obsolete.ts); rollback metadata is incomplete.",
				),
			)

			await tool.execute({ patch: deletePatch }, mockTask as Task, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				toolCallId: "test-tool-call-id",
			})

			// The delete succeeded on disk, so the queued handoff still runs,
			// but no success result is emitted: the persistence failure
			// surfaces through handleError instead.
			expect(mockPushToolResult).not.toHaveBeenCalled()
			expect(mockHandleError).toHaveBeenCalledWith("apply patch", expect.any(Error))
			expect(vi.mocked(mockTask.processQueuedMessages)).toHaveBeenCalled()
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
		it("awaits the post-patch checkpoint before processing queued messages", async () => {
			// A pending checkpoint must not let queued messages (and the
			// writes they trigger) start first: execute() awaits the
			// post-patch checkpointSave and only then processes queued
			// messages, so a queued write's own checkpoint cannot interleave
			// with this commit.
			const order: string[] = []
			;(mockTask.processQueuedMessages as MockedFunction<() => void>).mockImplementation(() => {
				order.push("processQueuedMessages")
			})
			mockedCheckpointSave.mockImplementationOnce(() => {
				order.push("checkpointSave:start")
				return new Promise<void>((resolve) => {
					setTimeout(() => {
						order.push("checkpointSave:done")
						resolve()
					}, 10)
				}).then(() => undefined)
			})

			await tool.execute({ patch: deletePatch }, mockTask as Task, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				toolCallId: "test-tool-call-id",
			})

			// The checkpoint fully completes before queued messages are
			// processed.
			expect(order).toEqual(["checkpointSave:start", "checkpointSave:done", "processQueuedMessages"])
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
			expect(mockedCheckpointSave).toHaveBeenCalledWith(mockTask as Task, false, true, [])
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

		it("checkpoints the written subset when a later hunk is access-denied", async () => {
			// Hunk 1 (src/first.ts) writes; hunk 2 (src/denied.ts) is rejected by
			// validateAccess. The access-denied branch must not bypass the partial
			// flush: the earlier write still receives the checkpoint/journal/card.
			// Hunk 2's context matches the mocked file content so the patch
			// passes pre-processing; the denial happens at the per-file access check.
			const partialDenyPatch = `*** Begin Patch
*** Add File: src/first.ts
+hello
*** Update File: src/denied.ts
@@
-original file content
+new content
*** End Patch`
			const validateAccess = (
				mockTask["rooIgnoreController"] as unknown as { validateAccess: MockedFunction<() => boolean> }
			).validateAccess
			validateAccess.mockReturnValueOnce(true).mockReturnValueOnce(false)
			// The add target does not exist, so hunk 1 writes; fileExistsAtPath
			// defaults to true and would otherwise reject the add.
			mockedFileExistsAtPath.mockResolvedValueOnce(false)

			await tool.execute({ patch: partialDenyPatch }, mockTask as Task, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				toolCallId: "test-tool-call-id",
			})

			expect(mockTask.say).toHaveBeenCalledWith("rooignore_error", "src/denied.ts")
			// Only the first (written) hunk is checkpointed.
			expect(mockedCheckpointSave).toHaveBeenCalledOnce()
			expect(mockedCheckpointSave).toHaveBeenCalledWith(mockTask, false, true, [
				expect.objectContaining({ path: "src/first.ts", operation: "create" }),
			])
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

		it("keeps the mistake count when a patch operation fails", async () => {
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

			// The failed operation incremented the counter; the end-of-loop reset
			// must only run for a fully successful patch, so the count survives.
			expect(mockTask.consecutiveMistakeCount).toBe(1)
		})

		it("clears the mistake count after a fully successful patch", async () => {
			mockTask.consecutiveMistakeCount = 2

			await tool.execute({ patch: movePatch }, mockTask as Task, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				toolCallId: "test-tool-call-id",
			})

			expect(mockTask.consecutiveMistakeCount).toBe(0)
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
			expect(mockedFsPromises.default.writeFile).toHaveBeenCalledWith(
				expect.any(String),
				"modified content\n",
				"utf8",
			)
			expect(mockedCheckpointSave).toHaveBeenCalledOnce()
		})

		it("journals the source deletion alongside the destination write for a completed move", async () => {
			await tool.execute({ patch: movePatch }, mockTask as Task, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				toolCallId: "test-tool-call-id",
			})

			// A completed move touches two journal-relevant paths: the
			// destination write (carrying the content diff) and the source
			// deletion (a pure delete record). Step rollback restores the
			// removed source from these entries.
			expect(mockedCheckpointSave).toHaveBeenCalledWith(mockTask as Task, false, true, [
				expect.objectContaining({ path: "src/moved.ts", operation: "update" }),
				expect.objectContaining({ path: "src/test.ts", operation: "delete" }),
			])
		})

		it("awaits the patch checkpoint before execute settles", async () => {
			type SaveResult = Awaited<ReturnType<typeof checkpointSave>>
			let resolveSave: (value: SaveResult | PromiseLike<SaveResult>) => void = () => {}
			const saveDeferred = new Promise<SaveResult>((resolve) => (resolveSave = resolve))
			mockedCheckpointSave.mockImplementationOnce(() => saveDeferred)

			const executePromise = tool.execute({ patch: movePatch }, mockTask as Task, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				toolCallId: "test-tool-call-id",
			})

			// execute must not settle while the checkpoint is still in flight:
			// a later write would otherwise interleave with this patch's staged work.
			let settled = false
			void executePromise.finally(() => (settled = true))
			await new Promise((resolve) => setTimeout(resolve, 0))
			expect(mockedCheckpointSave).toHaveBeenCalledOnce()
			expect(settled).toBe(false)

			resolveSave()
			await executePromise
			expect(settled).toBe(true)
		})

		it("records a checkpoint when the in-place update succeeds", async () => {
			await tool.execute({ patch: updatePatch }, mockTask as Task, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				toolCallId: "test-tool-call-id",
			})

			expect(mockPushToolResult).toHaveBeenCalledWith("File saved successfully")
			expect(mockedCheckpointSave).toHaveBeenCalledOnce()
		})

		it("journals the recorded write when a handler throws after its write", async () => {
			// Post-write bookkeeping (trackFileContext) fails after the file is
			// already on disk: the write recorded at write time must still receive
			// its checkpoint and journal entry through the catch-path flush; the
			// buffered success result is dropped in favor of the failure result.
			vi.mocked(mockTask.fileContextTracker.trackFileContext).mockRejectedValueOnce(new Error("tracker boom"))
			await tool.execute({ patch: updatePatch }, mockTask as Task, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				toolCallId: "test-tool-call-id",
			})

			expect(mockedCheckpointSave).toHaveBeenCalledTimes(1)
			expect(mockedCheckpointSave).toHaveBeenCalledWith(
				mockTask as Task,
				false,
				true,
				expect.arrayContaining([expect.objectContaining({ path: "src/test.ts", operation: "update" })]),
			)
			expect(mockPushToolResult).not.toHaveBeenCalledWith("File saved successfully")
			expect(mockHandleError).toHaveBeenCalledWith("apply patch", expect.anything())
			// The finally-block handoff still runs for the recorded write.
			expect(mockTask.processQueuedMessages).toHaveBeenCalled()
		})

		it("flushes the recorded write from the catch path when the settings read rejects", async () => {
			// The handler's settings lookup succeeds; the success-path flush's
			// lookup rejects. The flush flag must not have been set before that
			// rejection, so the catch path still persists the write already on
			// disk using the cached (undefined = default-on) setting.
			const getState = vi.fn().mockResolvedValueOnce({}).mockRejectedValueOnce(new Error("state boom"))
			mockTask.providerRef = { deref: vi.fn().mockReturnValue({ getState }) } as unknown as Task["providerRef"]

			await tool.execute({ patch: updatePatch }, mockTask as Task, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				toolCallId: "test-tool-call-id",
			})

			expect(mockedCheckpointSave).toHaveBeenCalledTimes(1)
			expect(mockedCheckpointSave).toHaveBeenCalledWith(
				mockTask as Task,
				false,
				true,
				expect.arrayContaining([expect.objectContaining({ path: "src/test.ts", operation: "update" })]),
			)
		})

		it("honors perWriteCheckpoints: false on the catch path when a handler throws", async () => {
			// The user turned per-write checkpoints off. A handler that throws after
			// recording its write skips the success-path settings read, so the catch
			// path must read the setting itself instead of treating the unread
			// undefined as default-on - otherwise the failed patch still commits a
			// checkpoint, journals an entry and emits a change card.
			vi.mocked(mockTask.fileContextTracker.trackFileContext).mockRejectedValueOnce(new Error("tracker boom"))
			const getState = vi.fn().mockResolvedValue({ perWriteCheckpoints: false })
			mockTask.providerRef = { deref: vi.fn().mockReturnValue({ getState }) } as unknown as Task["providerRef"]

			await tool.execute({ patch: updatePatch }, mockTask as Task, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				toolCallId: "test-tool-call-id",
			})

			expect(mockedCheckpointSave).not.toHaveBeenCalled()
			expect(mockHandleError).toHaveBeenCalledWith("apply patch", expect.anything())
			// The recorded write still hands the queue off.
			expect(mockTask.processQueuedMessages).toHaveBeenCalled()
		})

		it("reports the catch-path flush failure alongside the bookkeeping error", async () => {
			vi.mocked(mockTask.fileContextTracker.trackFileContext).mockRejectedValueOnce(new Error("tracker boom"))
			mockedCheckpointSave.mockRejectedValueOnce(new Error("journal boom"))

			await tool.execute({ patch: updatePatch }, mockTask as Task, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				toolCallId: "test-tool-call-id",
			})

			// The user must see that the completed write lacks rollback
			// metadata: the reported error keeps the original message and
			// appends the persistence failure instead of replacing it.
			expect(mockHandleError).toHaveBeenCalledTimes(1)
			const reported = mockHandleError.mock.calls[0][1] as Error
			expect(reported.message).toContain("tracker boom")
			expect(reported.message).toContain("checkpoint flush also failed: journal boom")
		})

		it("records one journal write per file change for a multi-file patch", async () => {
			// src/a.ts does not exist (add); src/b.ts does (update).
			mockedFileExistsAtPath.mockImplementation((filePath: string) =>
				Promise.resolve(!String(filePath).toLowerCase().endsWith("a.ts")),
			)
			const multiPatch = [
				"*** Begin Patch",
				"*** Add File: src/a.ts",
				"+alpha",
				"*** Update File: src/b.ts",
				"@@",
				"-original file content",
				"+second content",
				"*** End Patch",
			].join(String.fromCharCode(10))

			await tool.execute({ patch: multiPatch }, mockTask as Task, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				toolCallId: "test-tool-call-id",
			})

			expect(mockedCheckpointSave).toHaveBeenCalledOnce()
			// B3a: each write threads the approval diff and stats computed by its
			// handler so the per-step change card can reuse them verbatim.
			expect(mockedCheckpointSave).toHaveBeenCalledWith(mockTask as Task, false, true, [
				{
					path: "src/a.ts",
					operation: "create",
					diffStats: { additions: 1, deletions: 0 },
					diff: expect.stringContaining("+alpha"),
				},
				{
					path: "src/b.ts",
					operation: "update",
					diffStats: { additions: 1, deletions: 1 },
					diff: expect.stringContaining("+second content"),
				},
			])
		})
	})

	describe("change-card threading (B3a)", () => {
		const mockedCheckpointSave = checkpointSave as MockedFunction<typeof checkpointSave>
		const deletePatch = `*** Begin Patch
		*** Delete File: src/obsolete.ts
		*** End Patch`

		it("threads autoApproved into the checkpoint writes for auto-approved steps", async () => {
			// B3a: auto-approved steps carry autoApproved on every write so
			// checkpointSave can force the compact (summary) change card.
			const ref = (mockTask["providerRef"] as unknown as { deref: MockedFunction<() => unknown> }).deref
			ref.mockReturnValue({
				getState: vi.fn().mockResolvedValue({ autoApprovalEnabled: true, alwaysAllowWrite: true }),
			})

			await tool.execute({ patch: deletePatch }, mockTask as Task, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				toolCallId: "test-tool-call-id",
			})

			expect(mockedCheckpointSave).toHaveBeenCalledWith(mockTask as Task, false, true, [
				{ path: "src/obsolete.ts", operation: "delete", autoApproved: true },
			])
		})

		it("omits autoApproved when the step is not auto-approved", async () => {
			// The default provider state ({}) disables auto-approval, so no write
			// carries the autoApproved flag and the card follows the user setting.
			await tool.execute({ patch: deletePatch }, mockTask as Task, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				toolCallId: "test-tool-call-id",
			})

			expect(mockedCheckpointSave).toHaveBeenCalledWith(mockTask as Task, false, true, [
				{ path: "src/obsolete.ts", operation: "delete" },
			])
		})

		it("journals only the files actually written for a mixed no-op and write patch", async () => {
			// src/same.ts exists and the hunk rewrites identical content (a
			// no-op update); src/new.ts does not exist (a real write).
			mockedFileExistsAtPath.mockImplementation((filePath: string) =>
				Promise.resolve(!String(filePath).toLowerCase().endsWith("new.ts")),
			)
			const mixedPatch = [
				"*** Begin Patch",
				"*** Update File: src/same.ts",
				"@@",
				"-original file content",
				"+original file content",
				"*** Add File: src/new.ts",
				"+fresh content",
				"*** End Patch",
			].join(String.fromCharCode(10))

			await tool.execute({ patch: mixedPatch }, mockTask as Task, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				toolCallId: "test-tool-call-id",
			})

			// The no-op update is reported to the model...
			expect(mockPushToolResult).toHaveBeenCalledWith("No changes needed for 'src/same.ts'")
			// ...but the journal documents only the file that was actually
			// written, even though the whole patch succeeded.
			expect(mockedCheckpointSave).toHaveBeenCalledOnce()
			expect(mockedCheckpointSave).toHaveBeenCalledWith(mockTask as Task, false, true, [
				{
					path: "src/new.ts",
					operation: "create",
					diffStats: { additions: 1, deletions: 0 },
					diff: expect.stringContaining("+fresh content"),
				},
			])
		})

		it("still checkpoints the successful subset when a later hunk fails", async () => {
			// src/first.ts already exists (the add fails); src/second.ts does not
			// (the add writes). The whole patch fails, but the written file is
			// still documented by the checkpoint and journal.
			mockedFileExistsAtPath.mockImplementation((filePath: string) =>
				Promise.resolve(String(filePath).toLowerCase().endsWith("first.ts")),
			)
			const partialPatch = [
				"*** Begin Patch",
				"*** Add File: src/first.ts",
				"+boom",
				"*** Add File: src/second.ts",
				"+fresh",
				"*** End Patch",
			].join(String.fromCharCode(10))

			await tool.execute({ patch: partialPatch }, mockTask as Task, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				toolCallId: "test-tool-call-id",
			})

			// The failed operation is reported to the model...
			expect(mockPushToolResult).toHaveBeenCalledWith(expect.stringContaining("File already exists"))
			// ...and the successful subset is checkpointed and journaled.
			expect(mockedCheckpointSave).toHaveBeenCalledOnce()
			expect(mockedCheckpointSave).toHaveBeenCalledWith(mockTask as Task, false, true, [
				{
					path: "src/second.ts",
					operation: "create",
					diffStats: { additions: 1, deletions: 0 },
					diff: expect.stringContaining("+fresh"),
				},
			])
		})

		it("reports a failed move when the original file cannot be deleted", async () => {
			mockedFsPromises.default.unlink.mockRejectedValueOnce(new Error("EBUSY: resource busy"))
			const movePatch = [
				"*** Begin Patch",
				"*** Update File: src/old.ts",
				"*** Move to: src/new-location.ts",
				"@@",
				"-original file content",
				"+new content",
				"*** End Patch",
			].join(String.fromCharCode(10))

			await tool.execute({ patch: movePatch }, mockTask as Task, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				toolCallId: "test-tool-call-id",
			})

			// The copy succeeded but the source still exists, so the move is
			// reported as a failed tool error - but the destination write was
			// made on disk and must still be covered by the checkpoint/journal.
			// The single-entry payload below also guards that the source
			// deletion is NOT journaled: the source was never removed.
			expect(mockedCheckpointSave).toHaveBeenCalledOnce()
			expect(mockedCheckpointSave).toHaveBeenCalledWith(mockTask as Task, false, true, [
				expect.objectContaining({ path: "src/new-location.ts", operation: "update" }),
			])
			expect(mockTask.recordToolError).toHaveBeenCalledWith("apply_patch")
			expect(mockPushToolResult).toHaveBeenCalledWith(
				expect.stringContaining("could not delete the original file"),
			)
		})
	})
})
