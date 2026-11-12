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
// The move path asks lstat only whether the destination is a link, readlink only for the
// target of that link and realpath only for the spelling of a path that exists, so the
// boundary double declares those shapes rather than the whole fs/promises surface.
type DestinationShape = { isSymbolicLink: () => boolean }

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
			lstat: MockedFunction<(target: string) => Promise<DestinationShape>>
			readlink: MockedFunction<(target: string) => Promise<string>>
			realpath: MockedFunction<(target: string) => Promise<string>>
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
		lstat: vi.fn(async () => {
			// No destination exists in the default world, the way readFile below is stubbed for
			// a plain file: the caller treats ENOENT as an absent destination.
			throw Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" })
		}),
		readlink: vi.fn(async () => ""),
		realpath: vi.fn(async (target: string) => target),
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

		it("keeps the written content when a move targets the file's own path", async () => {
			// A patch whose Move to resolves back onto its Update File path rewrites that path;
			// it does not create a second copy. Unlinking the source afterwards - the same inode
			// the destination now holds - would delete the content the patch just committed.
			const patch = `*** Begin Patch
*** Update File: src/old.ts
*** Move to: src/old.ts
@@
-original file content
+new content
*** End Patch`

			await tool.execute({ patch }, mockTask as Task, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				toolCallId: "test-tool-call-id",
			})

			// The staged content was renamed onto the path, and nothing was unlinked.
			expect(mockedFsPromises.default.rename).toHaveBeenCalledWith(
				expect.stringContaining(".staging"),
				expect.stringMatching(/[\\/]old\.ts$/),
			)
			expect(mockedFsPromises.default.unlink).not.toHaveBeenCalled()
			expect(mockHandleError).not.toHaveBeenCalled()
			expect(mockTask.diffViewProvider.pushToolWriteResult).toHaveBeenCalledOnce()
		})

		it("creates the staging entry exclusively rather than truncating whatever name is there", async () => {
			const patch = `*** Begin Patch
*** Update File: src/old.ts
*** Move to: src/new.ts
@@
-original file content
+new content
*** End Patch`
			// The staging name is derived from the pid and a millisecond stamp, so a name an
			// interrupted run left behind can come back around. Truncating it would put two
			// moves behind one staging file, so the entry has to be created, not opened.
			await tool.execute({ patch }, mockTask as Task, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				toolCallId: "test-tool-call-id",
			})

			// The pin is the flag and the mode: the entry is created, not opened, and owner-only.
			expect(mockedFsPromises.default.writeFile).toHaveBeenCalledWith(
				expect.stringContaining(".staging"),
				expect.any(String),
				expect.objectContaining({ encoding: "utf8", flag: "wx", mode: 0o600 }),
			)
			expect(mockHandleError).not.toHaveBeenCalled()
		})

		it("re-stamps the staging entry when the name it chose is already taken", async () => {
			const patch = `*** Begin Patch
*** Update File: src/old.ts
*** Move to: src/new.ts
@@
-original file content
+new content
*** End Patch`
			// The first try is the collision: the entry exists, so the write answers with
			// EEXIST rather than truncating it. A retry has to choose a different name.
			mockedFsPromises.default.writeFile.mockImplementationOnce(async () => {
				throw Object.assign(new Error("EEXIST: file already exists, open"), { code: "EEXIST" })
			})

			await tool.execute({ patch }, mockTask as Task, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				toolCallId: "test-tool-call-id",
			})

			const stagingNames = mockedFsPromises.default.writeFile.mock.calls
				.map((call) => String(call[0]))
				.filter((name) => name.includes(".staging"))
			expect(stagingNames.length).toBe(2)
			expect(stagingNames[0]).not.toBe(stagingNames[1])
			expect(mockedFsPromises.default.rename).toHaveBeenCalledWith(
				expect.stringContaining(".staging"),
				expect.stringContaining("new.ts"),
			)
			expect(mockHandleError).not.toHaveBeenCalled()
			// Restore the default writeFile behavior for later rows: the collision answer is
			// queued as a one-shot, so a change that stopped retrying would leak the rejection
			// into the next row instead of failing only this one.
			mockedFsPromises.default.writeFile.mockResolvedValue(undefined)
		})

		it("decides a chained destination link from the entry the rename acts on", async () => {
			const patch = `*** Begin Patch
*** Update File: src/old.ts
*** Move to: src/new.ts
@@
-original file content
+new content
*** End Patch`
			// new.ts links to link2.ts, which links to target.ts. One hop gives link2.ts, a
			// link; the bytes land on the entry the rename is given, and the checks below read
			// a spelling two steps further, so the decision has to follow the chain to the
			// plain file the write actually acts on.
			mockedFsPromises.default.lstat
				.mockResolvedValueOnce({ isSymbolicLink: (): boolean => true })
				.mockResolvedValueOnce({ isSymbolicLink: (): boolean => true })
				.mockResolvedValueOnce({ isSymbolicLink: (): boolean => false })
			mockedFsPromises.default.readlink.mockResolvedValueOnce("link2.ts").mockResolvedValueOnce("target.ts")

			await tool.execute({ patch }, mockTask as Task, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				toolCallId: "test-tool-call-id",
			})

			expect(mockedFsPromises.default.rename).toHaveBeenCalledWith(
				expect.stringContaining(".staging"),
				expect.stringContaining("target.ts"),
			)
			// Never the intermediate link, in either direction of either rename.
			expect(mockedFsPromises.default.rename).not.toHaveBeenCalledWith(
				expect.any(String),
				expect.stringContaining("link2.ts"),
			)
			expect(mockHandleError).not.toHaveBeenCalled()
			// Restore the lstat and readlink defaults the chain walk consumed, the way the
			// dangling-link row restores readFile, so a regression in the walk cannot leak the
			// link answers into the rows that follow.
			mockedFsPromises.default.lstat.mockImplementation(async () => {
				throw Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" })
			})
			mockedFsPromises.default.readlink.mockResolvedValue("")
		})

		it("keeps a destination symlink and writes the moved content through its target", async () => {
			const patch = `*** Begin Patch
*** Update File: src/old.ts
*** Move to: src/new.ts
@@
-original file content
+new content
*** End Patch`
			// The destination is a symlink. Renaming the link itself would carry it to the backup name
			// and install a regular file at the requested path while the target kept the old bytes,
			// so the moved bytes have to land on the target and the link has to stay where it is.
			mockedFsPromises.default.lstat.mockResolvedValueOnce({ isSymbolicLink: (): boolean => true })
			mockedFsPromises.default.readlink.mockResolvedValueOnce("target.ts")

			await tool.execute({ patch }, mockTask as Task, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				toolCallId: "test-tool-call-id",
			})

			// The path the destination checks were run against, captured from the handler itself so
			// the assertion does not have to guess how the workspace spelling was built.
			const linkPath = mockedFsPromises.default.lstat.mock.calls[0]?.[0]
			expect(linkPath).toEqual(expect.stringContaining("new.ts"))
			expect(mockedFsPromises.default.rename).toHaveBeenCalledWith(
				expect.stringContaining("target.ts"),
				expect.stringContaining(".backup"),
			)
			expect(mockedFsPromises.default.rename).toHaveBeenCalledWith(
				expect.stringContaining(".staging"),
				expect.stringContaining("target.ts"),
			)
			// Never the link itself, in either direction of either rename.
			expect(mockedFsPromises.default.rename).not.toHaveBeenCalledWith(expect.any(String), linkPath)
			expect(mockedFsPromises.default.rename).not.toHaveBeenCalledWith(linkPath, expect.any(String))
			expect(mockHandleError).not.toHaveBeenCalled()
		})

		it("restores the symlink target bytes when the source deletion fails", async () => {
			const patch = `*** Begin Patch
*** Update File: src/old.ts
*** Move to: src/new.ts
@@
-original file content
+new content
*** End Patch`
			// A link whose target already holds content: the backup captured the target bytes, so the
			// rollback has to put them back at the target, which is where the link still points. The
			// read is keyed on the path because the hunk pass reads the source file through the same
			// stub, and only the destination read may see the link target content.
			mockedFsPromises.default.lstat.mockResolvedValueOnce({ isSymbolicLink: (): boolean => true })
			mockedFsPromises.default.readlink.mockResolvedValueOnce("target.ts")
			mockedFsPromises.default.readFile.mockImplementation(async (p: unknown) => {
				if (String(p).includes("target.ts")) {
					return "target file content"
				}
				return "original file content"
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

			const linkPath = mockedFsPromises.default.lstat.mock.calls[0]?.[0]
			// The restore rename runs from the backup name back onto the target, never onto the link.
			expect(mockedFsPromises.default.rename).toHaveBeenCalledWith(
				expect.stringContaining(".backup"),
				expect.stringContaining("target.ts"),
			)
			expect(mockedFsPromises.default.rename).not.toHaveBeenCalledWith(expect.any(String), linkPath)
			expect(mockPushToolResult).toHaveBeenCalledWith(
				expect.stringContaining("Failed to delete original file after move"),
			)
			// The destination was written and then rolled back: still a workspace mutation, so the
			// partial-state checkpoint is recorded even though the move reports failure.
			expect(mockedCheckpointSave).toHaveBeenCalledOnce()
			// Restore the default readFile behavior for later tests.
			mockedFsPromises.default.readFile.mockResolvedValue("original file content")
		})

		it("materializes the target of a dangling destination symlink instead of replacing the link", async () => {
			const patch = `*** Begin Patch
*** Update File: src/old.ts
*** Move to: src/new.ts
@@
-original file content
+new content
*** End Patch`
			// The link points at a path that does not exist. There is nothing to back up, so the only
			// write is the staged rename, and it has to land at the target so that the link resolves
			// rather than being replaced by a regular file at the requested path.
			mockedFsPromises.default.lstat.mockResolvedValueOnce({ isSymbolicLink: (): boolean => true })
			mockedFsPromises.default.readlink.mockResolvedValueOnce("target.ts")
			mockedFsPromises.default.readFile.mockImplementation(async (p: unknown) => {
				if (String(p).includes("target.ts")) {
					throw Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" })
				}
				return "original file content"
			})

			await tool.execute({ patch }, mockTask as Task, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				toolCallId: "test-tool-call-id",
			})

			const linkPath = mockedFsPromises.default.lstat.mock.calls[0]?.[0]
			expect(mockedFsPromises.default.rename).toHaveBeenCalledWith(
				expect.stringContaining(".staging"),
				expect.stringContaining("target.ts"),
			)
			expect(mockedFsPromises.default.rename).not.toHaveBeenCalledWith(
				expect.stringContaining(".backup"),
				expect.any(String),
			)
			expect(mockedFsPromises.default.rename).not.toHaveBeenCalledWith(expect.any(String), linkPath)
			expect(mockHandleError).not.toHaveBeenCalled()
			// Restore the default readFile behavior for later tests.
			mockedFsPromises.default.readFile.mockResolvedValue("original file content")
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

		it("names the retained backup and records a checkpoint when the move write fails and the restore rename fails", async () => {
			const patch = `*** Begin Patch
*** Update File: src/old.ts
*** Move to: src/new.ts
@@
-original file content
+new content
*** End Patch`
			// The destination exists, so the write-catch path puts it back by renaming the
			// on-disk backup over the destination.
			mockedFsPromises.default.readFile.mockImplementation(async (p: unknown) => {
				if (String(p).includes("new.ts")) {
					return "existing destination content"
				}
				return "original file content\n"
			})
			// The staging write succeeds, the staging -> destination rename fails, and the
			// backup -> destination restore rename fails as well: the destination is now
			// missing and its content survives only under the backup name.
			mockedFsPromises.default.rename.mockImplementation(async (from: unknown, to: unknown) => {
				const source = String(from)
				const target = String(to)
				if (target.includes("new.ts") && source.includes(".staging")) {
					throw Object.assign(new Error("EACCES: permission denied, rename"), { code: "EACCES" })
				}
				if (target.includes("new.ts") && source.includes(".backup")) {
					throw Object.assign(new Error("EPERM: operation not permitted, restore"), { code: "EPERM" })
				}
				return undefined
			})

			await tool.execute({ patch }, mockTask as Task, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				toolCallId: "test-tool-call-id",
			})

			expect(mockPushToolResult).toHaveBeenCalledWith(expect.stringContaining("Failed to write move destination"))
			// A user who lost the destination has to be told where its bytes are.
			expect(mockPushToolResult).toHaveBeenCalledWith(expect.stringMatching(/preserved at '[^']*\.backup[^']*'/))
			// A missing destination is a workspace mutation: the partial-state checkpoint and
			// the queued-message handoff both have to run.
			expect(mockedCheckpointSave).toHaveBeenCalledWith(mockTask, false, true)
			expect(mockTask.processQueuedMessages).toHaveBeenCalledOnce()
			// Restore the default mock behavior for later tests.
			mockedFsPromises.default.readFile.mockResolvedValue("original file content\n")
			mockedFsPromises.default.rename.mockResolvedValue(undefined)
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
			// The first delete succeeds; the second fails. unlink is one shared double and
			// mockRejectedValueOnce orders by call, not by path, so the rejection has to be
			// armed after a resolved first call - otherwise this case exercises the wrong delete.
			mockedFsPromises.default.unlink
				.mockResolvedValueOnce(undefined)
				.mockRejectedValueOnce(new Error("EPERM: operation not permitted"))

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
			// A handoff that never happened used to be the strongest pass in the file: the
			// ?? Infinity default makes any checkpoint order beat an absent handoff, so the
			// count is asserted before the order is compared.
			expect(vi.mocked(mockTask.processQueuedMessages).mock.calls.length).toBeGreaterThan(0)
			expect(checkpointAt).toBeLessThan(handoffAt)
			// Which delete ran is what the mock ordering is for: both paths were attempted
			// and exactly two unlinks happened - a first-delete failure would have stopped
			// the loop before the second path was reached.
			expect(mockedFsPromises.default.unlink).toHaveBeenCalledTimes(2)
			expect(mockedFsPromises.default.unlink).toHaveBeenCalledWith(expect.stringMatching(/[\\/]obsolete\.ts$/))
			expect(mockedFsPromises.default.unlink).toHaveBeenCalledWith(expect.stringMatching(/[\\/]locked\.ts$/))
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
			// Same vacuity as the case above: assert the handoff happened, then its order.
			expect(vi.mocked(mockTask.processQueuedMessages).mock.calls.length).toBeGreaterThan(0)
			expect(checkpointAt).toBeLessThan(handoffAt)
			expect(mockHandleError).toHaveBeenCalled()
		})
		it("records the partial-state checkpoint when the add save rejects after its bytes landed", async () => {
			const patch = `*** Begin Patch
*** Add File: src/new.ts
+file content
*** End Patch`
			// The add does not exist yet, and the focus-preserving save path is enabled, so the
			// bytes are written by saveDirectly.
			mockedFileExistsAtPath.mockResolvedValueOnce(false)
			const provider = {
				getState: vi.fn().mockResolvedValue({ experiments: { preventFocusDisruption: true } }),
			}
			mockTask.providerRef = { deref: () => provider } as unknown as Task["providerRef"]
			// The file lands on disk inside the save, which then rejects while finishing the
			// document, so the handler never returns and never reaches its own tracking lines.
			vi.mocked(mockTask.diffViewProvider.saveDirectly).mockRejectedValueOnce(
				new Error("EPERM: operation not permitted, open 'src/new.ts'"),
			)

			await tool.execute({ patch }, mockTask as Task, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				toolCallId: "test-tool-call-id",
			})

			expect(mockTask.diffViewProvider.saveDirectly).toHaveBeenCalledOnce()
			// The failure is the save itself, not the bookkeeping after it.
			expect(mockTask.diffViewProvider.pushToolWriteResult).not.toHaveBeenCalled()
			expect(mockHandleError).toHaveBeenCalledWith("apply patch", expect.any(Error))
			// The retained file is a workspace mutation, so the partial-state checkpoint runs
			// before the queued-message handoff even though the patch reports failure.
			expect(mockedCheckpointSave).toHaveBeenCalledWith(mockTask, false, true)
			expect(mockTask.processQueuedMessages).toHaveBeenCalledOnce()
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
				flag: "wx",
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
