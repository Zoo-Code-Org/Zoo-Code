// npx vitest run core/tools/__tests__/applyPatchTool.execute.spec.ts

import type { MockedFunction } from "vitest"

import { fileExistsAtPath } from "../../../utils/fs"
import { isPathOutsideWorkspace } from "../../../utils/pathUtils"
import path from "path"
import * as fsPromises from "fs/promises"
import type { Task } from "../../task/Task"
import { ObservationRegistry } from "../../task/observationRegistry"
import { guardedWrite } from "../guardedWrite"
import { ApplyPatchTool } from "../ApplyPatchTool"
import { PartialMoveError } from "../ApplyPatchTool"
import { PostCommitDurabilityError } from "../../../services/file-safety/safeWriteText"
import { withFileLock } from "../../../utils/fileLock"

// The vi.mock factory exposes the fs/promises functions under a `default`
// property (matching the SUT's default import), which the static module type
// does not declare; cast once at this boundary rather than at each call site.
const mockedFsPromises = vi.mocked(
	fsPromises as unknown as {
		default: {
			access: MockedFunction<typeof fsPromises.access>
			stat: ReturnType<typeof vi.fn>
			unlink: MockedFunction<typeof fsPromises.unlink>
			lstat: ReturnType<typeof vi.fn>
			readlink: ReturnType<typeof vi.fn>
			realpath: ReturnType<typeof vi.fn>
		}
	},
)

vi.mock("fs/promises", () => {
	// The SUT imports the module two ways: applyPatchTool uses the default
	// export, safeWriteText uses the namespace. Both must see the same doubles.
	const doubles = {
		// The target exists on disk, so the completeness gate applies to the
		// follow-up guarded write in the partial-observation test.
		access: vi.fn().mockResolvedValue(undefined),
		readFile: vi.fn().mockResolvedValue("original file content\n"),
		// Stable on-disk version for the S2 self-read observation (the hunk
		// read now stats before and after; equal tokens record the observe).
		stat: vi.fn().mockResolvedValue({
			dev: 7n,
			ino: 4242n,
			size: 1234n,
			mtimeNs: 1_700_000_000_123_456_789n,
			ctimeNs: 1_700_000_000_789_999_999n,
		}),
		unlink: vi.fn().mockResolvedValue(undefined),
		// resolveLockKey canonicalizes the lock key, so the guard needs these
		// even when no symlink is involved.
		lstat: vi.fn().mockResolvedValue({ isSymbolicLink: () => false }),
		readlink: vi.fn().mockRejectedValue(new Error("not a symbolic link")),
		realpath: vi.fn(async (p: string) => String(p)),
		// safeWriteText creates the backup directory before publishing.
		mkdir: vi.fn().mockResolvedValue(undefined),
	}
	return { default: doubles, ...doubles }
})

// Mock the shared advisory lock that the guarded-write path uses; the real
// proper-lockfile would try to create a lock directory on the mocked fs.
vi.mock("../../../utils/fileLock", () => ({
	withFileLock: vi.fn(async (filePath: string, operation: (p: string) => Promise<void>) => operation(filePath)),
}))

vi.mock("../../../utils/fs", () => ({
	fileExistsAtPath: vi.fn().mockResolvedValue(true),
}))

vi.mock("../../../utils/pathUtils", () => ({
	isPathOutsideWorkspace: vi.fn().mockReturnValue(false),
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
		| "observationRegistry"
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
			observationRegistry: new ObservationRegistry(),
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
})

describe("ApplyPatchTool.execute - guarded write (S4b, epic #1375)", () => {
	const mockedFileExistsAtPath = fileExistsAtPath as MockedFunction<typeof fileExistsAtPath>

	let tool: ApplyPatchTool
	let mockTask: Pick<
		Task,
		| "cwd"
		| "consecutiveMistakeCount"
		| "recordToolError"
		| "rooIgnoreController"
		| "rooProtectedController"
		| "say"
		| "processQueuedMessages"
		| "didEditFile"
		| "diffViewProvider"
		| "providerRef"
		| "fileContextTracker"
		| "observationRegistry"
	>
	let mockSaveDirectly: MockedFunction<(...args: unknown[]) => Promise<unknown>>
	let mockSaveChanges: MockedFunction<(...args: unknown[]) => Promise<unknown>>
	let mockGetState: MockedFunction<() => Promise<unknown>>
	let mockAskApproval: MockedFunction<(...args: unknown[]) => Promise<boolean>>
	let mockHandleError: MockedFunction<(...args: unknown[]) => Promise<void>>
	let mockPushToolResult: MockedFunction<(...args: unknown[]) => void>

	const updatePatch = `*** Begin Patch
*** Update File: src/thing.ts
@@
-original file content
+modified file content
*** End Patch`

	const addPatch = `*** Begin Patch
*** Add File: src/new.ts
+new line one
+new line two
*** End Patch`

	const movePatch = `*** Begin Patch
*** Update File: src/old.ts
*** Move to: src/new.ts
@@
-original file content
+modified file content
*** End Patch`

	beforeEach(() => {
		vi.clearAllMocks()

		mockedFileExistsAtPath.mockResolvedValue(true)

		mockSaveDirectly = vi.fn().mockResolvedValue({
			newProblemsMessage: "",
			userEdits: undefined,
			finalContent: "new content",
		})
		mockSaveChanges = vi.fn().mockResolvedValue({
			newProblemsMessage: "",
			userEdits: undefined,
			finalContent: "new content",
		})
		mockGetState = vi.fn().mockResolvedValue({
			diagnosticsEnabled: true,
			writeDelayMs: 1000,
			// Exercise the focus-disruption (saveDirectly) save path.
			experiments: { preventFocusDisruption: true },
		})

		// Structural stubs for the guarded-write path: the real DiffViewProvider is
		// out of scope here, so vi.fn() doubles stand in for the members the tool
		// touches (the saveDirectly double also records the writeKind plumbing).
		const diffViewProviderStub = {
			editType: undefined as "create" | "modify" | undefined,
			originalContent: undefined as string | undefined,
			saveDirectly: mockSaveDirectly,
			saveChanges: mockSaveChanges,
			open: vi.fn().mockResolvedValue(undefined),
			update: vi.fn().mockResolvedValue(undefined),
			scrollToFirstDiff: vi.fn(),
			pushToolWriteResult: vi.fn().mockResolvedValue("Saved file"),
			reset: vi.fn().mockResolvedValue(undefined),
		}
		mockTask = {
			cwd: "/workspace/project",
			consecutiveMistakeCount: 0,
			observationRegistry: new ObservationRegistry(),
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
			diffViewProvider: diffViewProviderStub as unknown as Task["diffViewProvider"],
			providerRef: {
				deref: vi.fn().mockReturnValue({
					getState: mockGetState,
				}),
			} as unknown as Task["providerRef"],
			fileContextTracker: {
				trackFileContext: vi.fn().mockResolvedValue(undefined),
			} as unknown as Task["fileContextTracker"],
		}

		mockAskApproval = vi.fn().mockResolvedValue(true)
		mockHandleError = vi.fn().mockResolvedValue(undefined)
		mockPushToolResult = vi.fn()

		tool = new ApplyPatchTool()
	})

	it("update: publishes the targeted hunk through the guarded saveDirectly with edit kind", async () => {
		await tool.execute({ patch: updatePatch }, mockTask as Task, {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
			toolCallId: "test-tool-call-id",
		})

		expect(mockSaveDirectly).toHaveBeenCalledWith(
			"src/thing.ts",
			"modified file content\n",
			false,
			true,
			1000,
			"edit",
		)
		expect(mockPushToolResult).toHaveBeenCalledWith("Saved file")
		expect(mockTask.didEditFile).toBe(true)
		expect(mockHandleError).not.toHaveBeenCalled()
	})

	it("update: keeps a partial observation partial so a later full-file write is still rejected", async () => {
		// The hunk read is the tool's own read, not a model read. Upgrading the
		// model's partial view to complete here would let a later write_to_file
		// replace the file with content built from the slice the model saw.
		const key = path.resolve("/workspace/project", "src/thing.ts")
		const reg = mockTask.observationRegistry
		reg.observe(key, "7:4242:1234:1700000000123456789:1700000000789999999", false)

		await tool.execute({ patch: updatePatch }, mockTask as Task, {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
			toolCallId: "test-tool-call-id",
		})

		expect(reg.get(key)?.complete).toBe(false)
		// The targeted hunk itself is still allowed, guarded as an edit.
		expect(mockSaveDirectly).toHaveBeenCalledWith(
			"src/thing.ts",
			"modified file content\n",
			false,
			true,
			1000,
			"edit",
		)

		await expect(guardedWrite(mockTask as Task, "src/thing.ts", "full replacement", "update")).rejects.toThrow(
			"File was only partially read (line slice, range, truncated view, or indentation block) -- " +
				"a full-file replacement needs the complete content; re-read the whole file, then retry.",
		)
	})

	it("update: keeps a complete observation complete across the tool's own hunk read", async () => {
		// Completeness is the model's, not the tool's: a complete read stays complete
		// and a partial one stays partial, so a later full-file write is still gated.
		const key = path.resolve("/workspace/project", "src/thing.ts")
		const reg = mockTask.observationRegistry
		reg.observe(key, "7:4242:1234:1700000000123456789:1700000000789999999", true)

		await tool.execute({ patch: updatePatch }, mockTask as Task, {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
			toolCallId: "test-tool-call-id",
		})

		expect(reg.get(key)?.complete).toBe(true)
	})

	it("update: a hunk read with no prior observation records a partial observation", async () => {
		// Nothing was earned before, so there is nothing to carry. The tool read the whole
		// file for its own hunk matching, but the model only ever saw the patch context, so
		// this read cannot grant authority for a later full-file replacement. The targeted
		// patch itself is still allowed: the "edit" guard accepts a partial observation.
		const key = path.resolve("/workspace/project", "src/thing.ts")
		const reg = mockTask.observationRegistry

		await tool.execute({ patch: updatePatch }, mockTask as Task, {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
			toolCallId: "test-tool-call-id",
		})

		expect(reg.get(key)?.complete).toBe(false)
		// The guard reads the same entry: a partial observation authorizes targeted edits on
		// the view the model saw, but not a full-file replacement.
		expect(reg.has(key)).toBe(true)
	})

	it("update: does not carry completeness across a version the model never read", async () => {
		// The model earned completeness on a different version than the one the patch
		// helper read: the intervening change was never seen, so a later full-file
		// replacement must still fail closed.
		const key = path.resolve("/workspace/project", "src/thing.ts")
		const reg = mockTask.observationRegistry
		reg.observe(key, "7:4242:1234:1700000000123456789:1700000000789999998", true)

		await tool.execute({ patch: updatePatch }, mockTask as Task, {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
			toolCallId: "test-tool-call-id",
		})

		expect(reg.get(key)?.complete).toBe(false)

		await expect(guardedWrite(mockTask as Task, "src/thing.ts", "full replacement", "update")).rejects.toThrow(
			"File was only partially read (line slice, range, truncated view, or indentation block) -- " +
				"a full-file replacement needs the complete content; re-read the whole file, then retry.",
		)
	})

	it("update: observes the hunk read so the guarded publish is not unobserved", async () => {
		await tool.execute({ patch: updatePatch }, mockTask as Task, {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
			toolCallId: "test-tool-call-id",
		})

		// The hunk read doubles as the S2 observation (ReadFileTool contract):
		// stable pre/post stats record the version token, so the in-place modify
		// publish is not rejected as an unobserved write.
		const observed = mockTask.observationRegistry.get(path.resolve("/workspace/project", "src/thing.ts"))
		expect(observed?.version).toBe("7:4242:1234:1700000000123456789:1700000000789999999")
	})

	it("update: does not observe when the pre- and post-read tokens disagree", async () => {
		// The file changed mid-read: pre/post stats differ, so no observation is
		// recorded and the guarded publish surfaces the unobserved-existing
		// remediation instead of publishing against a stale version.
		const statMock = mockedFsPromises.default.stat
		statMock.mockResolvedValueOnce({ dev: 7n, ino: 4242n, size: 1234n, mtimeNs: 1n, ctimeNs: 2n })
		statMock.mockResolvedValueOnce({ dev: 7n, ino: 4242n, size: 9999n, mtimeNs: 3n, ctimeNs: 4n })

		const guardError = new Error(
			"File already exists at src/thing.ts and was not read before this write -- read the file first, then retry.",
		)
		mockSaveDirectly.mockRejectedValue(guardError)

		await tool.execute({ patch: updatePatch }, mockTask as Task, {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
			toolCallId: "test-tool-call-id",
		})

		expect(mockTask.observationRegistry.has(path.resolve("/workspace/project", "src/thing.ts"))).toBe(false)
		// The rejection value is controlled here, so assert the exact error that
		// reached handleError instead of any call: a stat or parse failure would
		// otherwise satisfy a bare toHaveBeenCalled().
		expect(mockHandleError).toHaveBeenCalledWith("apply patch", guardError)
	})

	it("update: does not observe when the post-read stat rejects", async () => {
		// The pre-read stat succeeds and the read itself succeeds, but the post-read
		// stat fails, so the read cannot be tied to a version token and no
		// observation is recorded. The guarded publish then fails closed against the
		// existing, unobserved file rather than publishing content built from an
		// unverifiable read.
		const statMock = mockedFsPromises.default.stat
		statMock.mockResolvedValueOnce({ dev: 7n, ino: 4242n, size: 1234n, mtimeNs: 1n, ctimeNs: 2n })
		statMock.mockRejectedValueOnce(new Error("EACCES: permission denied"))

		const guardError = new Error(
			"File already exists at src/thing.ts and was not read before this write -- read the file first, then retry.",
		)
		mockSaveDirectly.mockRejectedValue(guardError)

		await tool.execute({ patch: updatePatch }, mockTask as Task, {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
			toolCallId: "test-tool-call-id",
		})

		expect(mockTask.observationRegistry.has(path.resolve("/workspace/project", "src/thing.ts"))).toBe(false)
		expect(mockHandleError).toHaveBeenCalledWith("apply patch", guardError)
	})
	it("add: publishes the new file through the guarded saveDirectly with create kind", async () => {
		mockedFileExistsAtPath.mockResolvedValueOnce(false)

		await tool.execute({ patch: addPatch }, mockTask as Task, {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
			toolCallId: "test-tool-call-id",
		})

		expect(mockSaveDirectly).toHaveBeenCalledWith(
			"src/new.ts",
			"new line one\nnew line two\n",
			true,
			true,
			1000,
			"create",
		)
		expect(mockPushToolResult).toHaveBeenCalledWith("Saved file")
		expect(mockTask.didEditFile).toBe(true)
		expect(mockHandleError).not.toHaveBeenCalled()
	})

	it("move: publishes the destination through the guarded saveDirectly with create kind", async () => {
		await tool.execute({ patch: movePatch }, mockTask as Task, {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
			toolCallId: "test-tool-call-id",
		})

		// The source had no prior observation, so the hunk read records a partial
		// observation: the model only saw the patch context, not the whole source. The
		// destination is still published (create kind), but the completeness flag stays false.
		expect(mockSaveDirectly).toHaveBeenCalledWith(
			"src/new.ts",
			"modified file content\n",
			false,
			true,
			1000,
			"create",
			false,
		)
	})

	it("move: keeps the source when the destination landed but durability failed, and reports the failure", async () => {
		// A PostCommitDurabilityError means the commit rename landed but the
		// destination's directory entry is not known to be durable: after a
		// crash the destination may not survive. Unlinking the source could
		// then leave NEITHER path available, so the source is kept and the
		// durability error surfaces - the model sees the move did not complete
		// and both paths still hold the content.
		mockSaveDirectly.mockRejectedValue(
			new PostCommitDurabilityError(path.resolve("/workspace/project", "src/new.ts"), new Error("fsync failed")),
		)

		await tool.execute({ patch: movePatch }, mockTask as Task, {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
			toolCallId: "test-tool-call-id",
		})

		// The source is NOT unlinked: crash-availability beats tidiness - the
		// destination may not survive without its directory entry, and a removed
		// source would then leave neither path available.
		expect(mockedFsPromises.default.unlink).not.toHaveBeenCalledWith(
			path.resolve("/workspace/project", "src/old.ts"),
		)
		// And the durability failure is reported - not a completed move.
		expect(mockHandleError).toHaveBeenCalledWith("apply patch", expect.any(PostCommitDurabilityError))
	})

	it("move: reports a source-unlink failure as a partial move instead of a success", async () => {
		// The destination is published but the source survives: the content now
		// exists at BOTH paths. Logging the unlink failure and continuing reported
		// a completed move; the dedicated failure class must surface instead, and
		// edit tracking must not claim the moved file.
		mockedFsPromises.default.unlink.mockRejectedValueOnce(Object.assign(new Error("EIO"), { code: "EIO" }))

		await tool.execute({ patch: movePatch }, mockTask as Task, {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
			toolCallId: "test-tool-call-id",
		})

		expect(mockHandleError).toHaveBeenCalledWith("apply patch", expect.any(PartialMoveError))
		expect(mockTask.fileContextTracker.trackFileContext).not.toHaveBeenCalledWith("src/new.ts", "roo_edited")
	})

	it("move: rejects a partial source onto an observed destination before changing any state", async () => {
		// The destination content is the source file plus one hunk, so it can only be
		// as complete as the view the model had of the source. Rejecting before the
		// registry is modified keeps a full destination read intact, and the message
		// must name the source, because re-reading the destination cannot restore the
		// source's completeness and would loop.
		const sourceKey = path.resolve("/workspace/project", "src/old.ts")
		const destKey = path.resolve("/workspace/project", "src/new.ts")
		const reg = mockTask.observationRegistry
		reg.observe(sourceKey, "7:4242:1234:1700000000123456789:1700000000789999999", false)
		reg.observe(destKey, "7:4242:1234:1700000000123456789:1700000000789999999", true)

		await tool.execute({ patch: movePatch }, mockTask as Task, {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
			toolCallId: "test-tool-call-id",
		})

		// Nothing was downgraded: the destination keeps the completeness the model earned.
		expect(reg.get(destKey)?.complete).toBe(true)
		expect(mockSaveDirectly).not.toHaveBeenCalled()
		expect(mockHandleError).toHaveBeenCalledWith(
			"apply patch",
			expect.objectContaining({
				message:
					"Cannot move a partially read file onto src/new.ts: re-read the whole source (src/old.ts) first, then retry.",
			}),
		)
	})

	it("move: carries the source's completeness when the observed destination was deleted", async () => {
		// The destination was read and then deleted, so its observation is stale but the
		// create guard permits the publish. Rejecting here would refuse a move onto an
		// absent path; the content is still only as complete as the source view, so the
		// source's completeness is carried instead of the destination's stale one.
		const sourceKey = path.resolve("/workspace/project", "src/old.ts")
		const destKey = path.resolve("/workspace/project", "src/new.ts")
		const reg = mockTask.observationRegistry
		reg.observe(sourceKey, "7:4242:1234:1700000000123456789:1700000000789999999", false)
		reg.observe(destKey, "7:4242:1234:1700000000123456789:1700000000789999999", true)
		mockedFsPromises.default.access.mockRejectedValueOnce(
			Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" }),
		)
		const completeAtPublish: Array<boolean | undefined> = []
		mockSaveDirectly.mockImplementationOnce(async () => {
			completeAtPublish.push(reg.get(destKey)?.complete)
			return { newProblemsMessage: "", userEdits: undefined, finalContent: "new content" }
		})

		await tool.execute({ patch: movePatch }, mockTask as Task, {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
			toolCallId: "test-tool-call-id",
		})

		expect(completeAtPublish).toEqual([false])
		expect(mockHandleError).not.toHaveBeenCalled()
	})

	it("move: propagates a non-ENOENT destination access error before changing the observation", async () => {
		// An ELOOP is not an absence verdict. Reading it as "the destination is gone"
		// would mark the observation partial and let the publish run against a path the
		// tool never actually observed.
		const sourceKey = path.resolve("/workspace/project", "src/old.ts")
		const destKey = path.resolve("/workspace/project", "src/new.ts")
		const reg = mockTask.observationRegistry
		reg.observe(sourceKey, "7:4242:1234:1700000000123456789:1700000000789999999", false)
		reg.observe(destKey, "7:4242:1234:1700000000123456789:1700000000789999999", true)
		mockedFsPromises.default.access.mockRejectedValueOnce(
			Object.assign(new Error("ELOOP: too many symbolic links"), { code: "ELOOP" }),
		)

		await tool.execute({ patch: movePatch }, mockTask as Task, {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
			toolCallId: "test-tool-call-id",
		})

		expect(reg.get(destKey)?.complete).toBe(true)
		expect(mockSaveDirectly).not.toHaveBeenCalled()
		expect(mockHandleError).toHaveBeenCalledWith(
			"apply patch",
			expect.objectContaining({ message: "ELOOP: too many symbolic links" }),
		)
	})

	it("move: a complete source read keeps the destination complete", async () => {
		const sourceKey = path.resolve("/workspace/project", "src/old.ts")
		const destKey = path.resolve("/workspace/project", "src/new.ts")
		const reg = mockTask.observationRegistry
		reg.observe(sourceKey, "7:4242:1234:1700000000123456789:1700000000789999999", true)
		mockSaveDirectly.mockImplementationOnce(async () => {
			reg.observe(destKey, "7:4242:1234:1700000000123456789:1700000000789999999", true)
			return { newProblemsMessage: "", userEdits: undefined, finalContent: "new content" }
		})

		await tool.execute({ patch: movePatch }, mockTask as Task, {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
			toolCallId: "test-tool-call-id",
		})

		expect(reg.get(destKey)?.complete).toBe(true)
		expect(mockHandleError).not.toHaveBeenCalled()
	})

	it("move: the destination cannot claim completeness when the source was never observed", async () => {
		// The hunk read records no observation when its stat fails, so the model has
		// no authority over the source content the move carried over. Nothing is
		// recorded for the destination before the write chain runs, so the guard still
		// refuses a full-file write to a file the model never read. Without a usable
		// observation the protected deletion also refuses to unlink the source: the
		// move is reported half-applied rather than a success.
		const destKey = path.resolve("/workspace/project", "src/new.ts")
		const reg = mockTask.observationRegistry
		mockedFsPromises.default.stat.mockImplementationOnce(() => Promise.reject(new Error("stat failed")))
		const observedAtPublish: boolean[] = []
		mockSaveDirectly.mockImplementationOnce(async () => {
			observedAtPublish.push(reg.has(destKey))
			return { newProblemsMessage: "", userEdits: undefined, finalContent: "new content" }
		})

		await tool.execute({ patch: movePatch }, mockTask as Task, {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
			toolCallId: "test-tool-call-id",
		})

		expect(reg.get(path.resolve("/workspace/project", "src/old.ts"))).toBeUndefined()
		expect(observedAtPublish).toEqual([false])
		await expect(guardedWrite(mockTask as Task, "src/new.ts", "full replacement", "create")).rejects.toThrow(
			"File already exists at " +
				"src/new.ts" +
				" and was not read before this write -- read the file first, then retry.",
		)
		// No usable observation authorizes the source deletion, so the source is
		// kept and the move surfaces as half-applied - not a completed success.
		expect(mockHandleError).toHaveBeenCalledWith("apply patch", expect.any(PartialMoveError))
		expect(mockedFsPromises.default.unlink).not.toHaveBeenCalledWith(
			path.resolve("/workspace/project", "src/old.ts"),
		)
		expect(mockTask.fileContextTracker.trackFileContext).not.toHaveBeenCalledWith("src/new.ts", "roo_edited")
	})

	it("move: leaves an unobserved destination alone when the source read was partial", async () => {
		// The publish records an observation only when it can compute the new on-disk
		// token. With nothing recorded for the destination there is nothing to
		// downgrade, and the carry must not dereference a missing observation.
		const destKey = path.resolve("/workspace/project", "src/new.ts")
		const reg = mockTask.observationRegistry
		reg.observe(
			path.resolve("/workspace/project", "src/old.ts"),
			"7:4242:1234:1700000000123456789:1700000000789999999",
			false,
		)

		await tool.execute({ patch: movePatch }, mockTask as Task, {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
			toolCallId: "test-tool-call-id",
		})

		expect(reg.get(destKey)).toBeUndefined()
		expect(mockHandleError).not.toHaveBeenCalled()
	})

	it("move: keeps the source when it changed after the destination was published", async () => {
		// The move was built from the observed version. A peer rewrote the source
		// before the deletion ran: the destination no longer holds the whole source,
		// so the deletion must not destroy the peer bytes - the move is reported
		// half-applied and moved-file tracking stays untouched.
		const sourceKey = path.resolve("/workspace/project", "src/old.ts")
		const reg = mockTask.observationRegistry
		reg.observe(sourceKey, "7:4242:1234:1700000000123456789:1700000000789999999", true)
		const stable = {
			dev: 7n,
			ino: 4242n,
			size: 1234n,
			mtimeNs: 1_700_000_000_123_456_789n,
			ctimeNs: 1_700_000_000_789_999_999n,
		}
		const changed = { ...stable, dev: 8n }
		// The hunk read stats the source twice; the third stat is the deletion
		// check under the advisory lock and sees the peer version.
		mockedFsPromises.default.stat
			.mockResolvedValueOnce(stable)
			.mockResolvedValueOnce(stable)
			.mockResolvedValueOnce(changed)

		await tool.execute({ patch: movePatch }, mockTask as Task, {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
			toolCallId: "test-tool-call-id",
		})

		expect(mockHandleError).toHaveBeenCalledWith("apply patch", expect.any(PartialMoveError))
		expect(mockedFsPromises.default.unlink).not.toHaveBeenCalledWith(sourceKey)
		expect(mockTask.fileContextTracker.trackFileContext).not.toHaveBeenCalledWith("src/new.ts", "roo_edited")
	})

	it("move: keeps the source when it vanished before the deletion", async () => {
		// Whoever removed the source owns that removal: the move reports itself
		// half-applied (destination committed, source already gone) instead of
		// unlinking a path it no longer understands or claiming success.
		const sourceKey = path.resolve("/workspace/project", "src/old.ts")
		const reg = mockTask.observationRegistry
		reg.observe(sourceKey, "7:4242:1234:1700000000123456789:1700000000789999999", true)
		const stable = {
			dev: 7n,
			ino: 4242n,
			size: 1234n,
			mtimeNs: 1_700_000_000_123_456_789n,
			ctimeNs: 1_700_000_000_789_999_999n,
		}
		mockedFsPromises.default.stat
			.mockResolvedValueOnce(stable)
			.mockResolvedValueOnce(stable)
			.mockRejectedValueOnce(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))

		await tool.execute({ patch: movePatch }, mockTask as Task, {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
			toolCallId: "test-tool-call-id",
		})

		expect(mockHandleError).toHaveBeenCalledWith("apply patch", expect.any(PartialMoveError))
		expect(mockedFsPromises.default.unlink).not.toHaveBeenCalledWith(sourceKey)
	})

	it("move: deletes the source under the advisory lock for the source path", async () => {
		// The deletion must serialize with the guarded writers of the SOURCE path
		// (safeWriteJson, task-history deletion), not just the destination: without
		// the lock a peer could stage a write to the source between the version
		// check and the unlink.
		const sourceKey = path.resolve("/workspace/project", "src/old.ts")

		await tool.execute({ patch: movePatch }, mockTask as Task, {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
			toolCallId: "test-tool-call-id",
		})

		expect(mockHandleError).not.toHaveBeenCalled()
		const lockKeys = vi.mocked(withFileLock).mock.calls.map((call) => String(call[0]))
		// Exact key, not a suffix match: a key such as /elsewhere/old.ts would have
		// satisfied the old assertion while serializing the wrong path.
		expect(lockKeys).toContain(sourceKey)
		// The source name is what the deletion names; nothing else may be unlinked.
		expect(mockedFsPromises.default.unlink).toHaveBeenCalledWith(sourceKey)
		for (const call of mockedFsPromises.default.unlink.mock.calls) {
			expect(String(call[0])).toBe(sourceKey)
		}
	})

	it("move: locks the symlink referent but unlinks only the named source path", async () => {
		// resolveLockKey returns the symlink REFERENT for a symlinked source. The
		// lock must use that key, but the deletion must still name the source path:
		// unlinking the referent would destroy a file the user never moved.
		const sourceKey = path.resolve("/workspace/project", "src/old.ts")
		const referentKey = path.resolve("/workspace/project", "src/real/old.ts")
		const reg = mockTask.observationRegistry
		reg.observe(sourceKey, "7:4242:1234:1700000000123456789:1700000000789999999", true)
		mockedFsPromises.default.lstat.mockImplementation(async (p: unknown) => ({
			isSymbolicLink: () => String(p) === sourceKey,
		}))
		mockedFsPromises.default.readlink.mockImplementation(async (p: unknown) => {
			if (String(p) === sourceKey) return "real/old.ts"
			throw new Error("not a symbolic link")
		})
		// The referent is a distinct path: resolvePublishTarget follows the link, so
		// resolveLockKey returns the referent key the lock must use.
		mockedFsPromises.default.realpath.mockImplementation(async (p: unknown) => {
			const value = String(p)
			if (value === sourceKey) return referentKey
			if (value === path.resolve("/workspace/project", "src/real"))
				return path.resolve("/workspace/project", "src/real")
			return value
		})

		await tool.execute({ patch: movePatch }, mockTask as Task, {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
			toolCallId: "test-tool-call-id",
		})

		// Both halves of the contract: the advisory lock is taken on the referent
		// (the path a peer writer of the real file uses) while the deletion names only
		// the source path this move asked to remove.
		const lockKeys = vi.mocked(withFileLock).mock.calls.map((call) => String(call[0]))
		expect(lockKeys).toContain(referentKey)
		const unlinked = mockedFsPromises.default.unlink.mock.calls.map((call) => String(call[0]))
		expect(unlinked).toContain(sourceKey)
		expect(unlinked).not.toContain(referentKey)
	})

	it("update: surfaces the unobserved-existing remediation as a tool error", async () => {
		const guardError = new Error(
			"File already exists at src/thing.ts and was not read before this write -- read the file first, then retry.",
		)
		mockSaveDirectly.mockRejectedValue(guardError)

		await tool.execute({ patch: updatePatch }, mockTask as Task, {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
			toolCallId: "test-tool-call-id",
		})

		expect(mockHandleError).toHaveBeenCalledWith("apply patch", guardError)
		expect(vi.mocked(mockTask.diffViewProvider.reset)).toHaveBeenCalled()
		expect(mockTask.didEditFile).toBe(false)
		expect(mockPushToolResult).not.toHaveBeenCalledWith("Saved file")
	})

	it("update: surfaces the stale-version remediation as a tool error", async () => {
		const guardError = new Error(
			"Stale version -- the file changed since you read it (expected v1, current v2); re-read the file, then retry.",
		)
		mockSaveDirectly.mockRejectedValue(guardError)

		await tool.execute({ patch: updatePatch }, mockTask as Task, {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
			toolCallId: "test-tool-call-id",
		})

		expect(mockHandleError).toHaveBeenCalledWith("apply patch", guardError)
		expect(vi.mocked(mockTask.diffViewProvider.reset)).toHaveBeenCalled()
		expect(mockTask.didEditFile).toBe(false)
	})

	it("update: the diff-view save selects the same edit guard as the guarded save", async () => {
		// With focus-disruption prevention off the tool saves through the diff view.
		// A partial read must not be rejected there, otherwise the patch the user
		// approved is thrown away.
		mockGetState.mockResolvedValue({ diagnosticsEnabled: true, writeDelayMs: 1000, experiments: {} })

		await tool.execute({ patch: updatePatch }, mockTask as Task, {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
			toolCallId: "test-tool-call-id",
		})

		expect(mockSaveChanges).toHaveBeenCalledWith(true, 1000, "edit")
		expect(mockSaveDirectly).not.toHaveBeenCalled()
		expect(mockPushToolResult).toHaveBeenCalledWith("Saved file")
		expect(mockHandleError).not.toHaveBeenCalled()
	})

	it("add: the diff-view save uses the create guard for a new file", async () => {
		mockedFileExistsAtPath.mockResolvedValueOnce(false)
		mockGetState.mockResolvedValue({ diagnosticsEnabled: true, writeDelayMs: 1000, experiments: {} })

		await tool.execute({ patch: addPatch }, mockTask as Task, {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
			toolCallId: "test-tool-call-id",
		})

		expect(mockSaveChanges).toHaveBeenCalledWith(true, 1000, "create")
		expect(mockPushToolResult).toHaveBeenCalledWith("Saved file")
		expect(mockHandleError).not.toHaveBeenCalled()
	})
})
