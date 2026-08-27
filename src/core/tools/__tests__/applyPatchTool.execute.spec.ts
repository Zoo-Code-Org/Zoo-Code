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
			})

			expect(mockPushToolResult).toHaveBeenCalledWith(expect.stringContaining("Successfully deleted"))
			expect(mockedCheckpointSave).toHaveBeenCalledOnce()
			expect(mockedCheckpointSave).toHaveBeenCalledWith(mockTask as Task, false, true)
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

		it("records a checkpoint when the in-place update succeeds", async () => {
			await tool.execute({ patch: updatePatch }, mockTask as Task, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
			})

			expect(mockPushToolResult).toHaveBeenCalledWith("File saved successfully")
			expect(mockedCheckpointSave).toHaveBeenCalledOnce()
		})
	})
})
