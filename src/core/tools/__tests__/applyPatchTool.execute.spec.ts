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
import { CommittedWriteBufferConflictError } from "../../../integrations/editor/committedWriteBufferConflictError"
import { PostCommitDurabilityError } from "../../../services/file-safety/safeWriteText"

// The vi.mock factory exposes the fs/promises functions under a `default`
// property (matching the SUT's default import), which the static module type
// does not declare; cast once at this boundary rather than at each call site.
const mockedFsPromises = vi.mocked(
	fsPromises as unknown as {
		default: {
			access: MockedFunction<typeof fsPromises.access>
			readFile: ReturnType<typeof vi.fn>
			stat: ReturnType<typeof vi.fn>
			unlink: MockedFunction<typeof fsPromises.unlink>
			// Added for the outside-workspace refusal row: the refused destination must not be canonicalised.
			realpath: ReturnType<typeof vi.fn>
			// Added for the same-file move rows, which ask whether any write landed at the destination.
			// Typed loosely because fsPromises.writeFile carries an overload set that MockedFunction
			// would collapse to one arbitrary member; the rows only ever ask whether it was called.
			writeFile: ReturnType<typeof vi.fn>
			// Added for the flag-off move rows: the raw branch mkdirs the destination's parent before
			// writing, and the rows ask whether that mkdir ran. Typed loosely for the same reason as
			// writeFile above - fsPromises.mkdir is overloaded and the rows only ever ask about calls.
			mkdir: ReturnType<typeof vi.fn>
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
		// Raw bytes: the SUT reads without an encoding so a strict decoder can see the file as
		// the file is, and this double has to answer the same way the real readFile() does.
		readFile: vi.fn().mockResolvedValue(Buffer.from("original file content\n")),
		// On-disk identity for the S2 self-read observation (the hunk read stats before and after;
		// equal tokens record the observe) and for the move handler's same-file check. Answered per
		// path by _identityOf below.
		stat: vi.fn((target: unknown) => Promise.resolve(_identityOf(String(target)))),
		unlink: vi.fn().mockResolvedValue(undefined),
		// resolveLockKey canonicalizes the lock key, so the guard needs these
		// even when no symlink is involved.
		lstat: vi.fn().mockResolvedValue({ isSymbolicLink: () => false }),
		readlink: vi.fn().mockRejectedValue(new Error("not a symbolic link")),
		realpath: vi.fn(async (p: string) => String(p)),
		// safeWriteText creates the backup directory before publishing.
		mkdir: vi.fn().mockResolvedValue(undefined),
		// The flag-off move branch (ApplyPatchTool.ts:610-:612) publishes with a raw
		// fs.writeFile, so the double set needs writeFile as well as mkdir.
		writeFile: vi.fn().mockResolvedValue(undefined),
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

// The identity a path answers with. It used to be ONE identity for every path (ino 4242
// everywhere), which was harmless only because nothing asked the question: two names on a
// filesystem are two files unless something links them, and the move handler now asks which of the
// two its source and its destination are. The double distinguishes exactly the pair the move rows
// publish onto - src/new.ts, and the same basename reached through a link of its directory - and
// leaves every other path the identity the registry token strings below spell out. A row that wants
// two names for one file re-arms stat and says so in its own comment.
const _MOVE_SOURCE_INO = 4242n
const _MOVE_DESTINATION_INO = 4343n
const _MOVE_ALIAS_DESTINATION_INO = 4444n

interface FileIdentity {
	dev: bigint
	ino: bigint
	size: bigint
	mtimeNs: bigint
	ctimeNs: bigint
}

function _identityOf(target: string): FileIdentity {
	const resolvedNew = path.resolve("/workspace/project", "src/new.ts")
	const resolvedAliasNew = path.resolve("/workspace/project", "src/aliasDir/new.ts")
	const ino =
		target === resolvedNew
			? _MOVE_DESTINATION_INO
			: target === resolvedAliasNew
				? _MOVE_ALIAS_DESTINATION_INO
				: _MOVE_SOURCE_INO
	return {
		dev: 7n,
		ino,
		size: 1234n,
		mtimeNs: 1_700_000_000_123_456_789n,
		ctimeNs: 1_700_000_000_789_999_999n,
	}
}

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
	// The destination spelled through a link of the same directory, naming its own file: the other
	// direction of the pair the same-file rows pin below.
	const moveThroughAliasPatch = `*** Begin Patch
*** Update File: src/old.ts
*** Move to: src/aliasDir/new.ts
@@
-original file content
+modified file content
*** End Patch`

	const mismatchedSecondPatch = `*** Begin Patch
*** Update File: src/first.ts
@@
-original file content
+modified first content
*** Update File: src/second.ts
@@
-context the mocked file does not contain
+modified second content
*** End Patch`

	const twoUpdatePatch = `*** Begin Patch
*** Update File: src/first.ts
@@
-original file content
+modified first content
*** Update File: src/second.ts
@@
-original file content
+modified second content
*** End Patch`

	beforeEach(() => {
		vi.clearAllMocks()

		mockedFileExistsAtPath.mockResolvedValue(true)

		// The outside-workspace double is module-level, and vi.clearAllMocks() keeps implementations,
		// so a row that flips it has to find it back at false. Restored here rather than per row so the
		// next row does not have to know a neighbour changed it.
		vi.mocked(isPathOutsideWorkspace).mockReturnValue(false)
		// vi.clearAllMocks() keeps implementations, and rows below re-arm stat with a one-file-two-
		// names answer. Restoring the default here means a row does not have to know what a neighbour
		// installed.
		mockedFsPromises.default.stat.mockImplementation((target: unknown) =>
			Promise.resolve(_identityOf(String(target))),
		)
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
			undefined,
			false,
			undefined,
		)
		expect(mockPushToolResult).toHaveBeenCalledWith("Saved file")
		expect(mockTask.didEditFile).toBe(true)
		expect(mockHandleError).not.toHaveBeenCalled()
	})

	// Row 4507764645: the finally sweep withdraws the read behind a publish that never
	// landed. When the guarded commit landed and only the durability step failed, the guard
	// re-records at the committed token, and the sweep must leave that entry alone - the
	// stored entry is no longer the one the tool recorded, so the withdrawal does not fit.
	it("update: a publish that committed without durability keeps the re-recorded observation", async () => {
		const targetKey = path.resolve("/workspace/project", "src/thing.ts")
		const reg = mockTask.observationRegistry
		// The double stands in for the guard's own pair of actions - re-record at the
		// committed token, then report the durability failure - so this row tests the sweep's
		// identity key, which is ApplyPatchTool's half of the rule.
		mockSaveDirectly.mockImplementationOnce(async () => {
			reg.observe(targetKey, "committed-token", false)
			throw new PostCommitDurabilityError(
				targetKey,
				new Error("EBADF: bad file descriptor"),
				null,
				"committed-token",
			)
		})

		await tool.execute({ patch: updatePatch }, mockTask as Task, {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
			toolCallId: "test-tool-call-id",
		})

		expect(mockHandleError).toHaveBeenCalledWith(
			"apply patch",
			expect.objectContaining({ name: "PostCommitDurabilityError" }),
		)
		expect(reg.get(targetKey)?.version).toBe("committed-token")
		expect(mockPushToolResult).not.toHaveBeenCalled()
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
			undefined,
			false,
			undefined,
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
	it("update: withdraws the hunk-read observation when the user denies the publish", async () => {
		// apply_patch read the file to compute the hunk, so the tool owns that observation.
		// The user said no, nothing published, and a leftover partial entry would let a later
		// edit, search_replace, edit_file or apply_diff publish against a version the model
		// never read. This is the exit that made apply_patch the remaining tool-read path.
		const key = path.resolve(mockTask.cwd, "src/thing.ts")
		const reg = mockTask.observationRegistry
		mockAskApproval.mockResolvedValue(false)

		await tool.execute({ patch: updatePatch }, mockTask as Task, {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
			toolCallId: "test-tool-call-id",
		})

		expect(mockPushToolResult).toHaveBeenCalledWith("Changes were rejected by the user.")
		expect(reg.has(key)).toBe(false)
	})

	it("update: withdraws the hunk-read observation when the publish throws", async () => {
		// The outer-catch exit: the hunk read happened, the save blew up before publishing,
		// and the observation must not survive as authority for a later write.
		const key = path.resolve(mockTask.cwd, "src/thing.ts")
		const reg = mockTask.observationRegistry
		mockSaveDirectly.mockRejectedValue(new Error("extension host went away"))

		await tool.execute({ patch: updatePatch }, mockTask as Task, {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
			toolCallId: "test-tool-call-id",
		})

		expect(mockHandleError).toHaveBeenCalled()
		expect(reg.has(key)).toBe(false)
	})

	it("withdraws observations for files read before a hunk failure", async () => {
		// processAllHunks throws on the second file context mismatch, so the first file was
		// read, observed and then never published. Its leftover entry is the state a later
		// targeted edit would wrongly accept.
		const firstKey = path.resolve(mockTask.cwd, "src/first.ts")
		const secondKey = path.resolve(mockTask.cwd, "src/second.ts")
		const reg = mockTask.observationRegistry

		await tool.execute({ patch: mismatchedSecondPatch }, mockTask as Task, {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
			toolCallId: "test-tool-call-id",
		})

		expect(mockPushToolResult).toHaveBeenCalledWith(expect.stringContaining("Failed to process patch"))
		expect(reg.has(firstKey)).toBe(false)
		expect(reg.has(secondKey)).toBe(false)
	})

	it("keeps the observation of a path that published while withdrawing a denied one", async () => {
		// Two updates in one patch: the first approves and publishes, the second is denied.
		// Withdrawal is scoped by path and by the exact stored entry, so the published file
		// keeps the observation its publish ran on (partial, as the hunk read recorded it)
		// while the denied path is left with nothing.
		const publishedKey = path.resolve(mockTask.cwd, "src/first.ts")
		const deniedKey = path.resolve(mockTask.cwd, "src/second.ts")
		const reg = mockTask.observationRegistry
		mockAskApproval.mockResolvedValueOnce(true).mockResolvedValueOnce(false)

		await tool.execute({ patch: twoUpdatePatch }, mockTask as Task, {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
			toolCallId: "test-tool-call-id",
		})

		expect(reg.has(publishedKey)).toBe(true)
		expect(reg.get(publishedKey)?.complete).toBe(false)
		expect(reg.has(deniedKey)).toBe(false)
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

	it("update: does not observe when the pre-read stat rejects", async () => {
		// The mirror of the post-read case: the FIRST bracketing stat fails, so there is
		// no baseline token to compare the read against. The hunk read still happens and
		// the patch still reaches the guarded publish, but nothing is observed - the
		// publish fails closed against the existing, unobserved file.
		const statMock = mockedFsPromises.default.stat
		statMock.mockRejectedValueOnce(new Error("EACCES: permission denied"))
		statMock.mockResolvedValueOnce({ dev: 7n, ino: 4242n, size: 1234n, mtimeNs: 1n, ctimeNs: 2n })

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
		// The read was not skipped: the publish was still attempted through the guard.
		expect(mockSaveDirectly).toHaveBeenCalled()
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
			undefined,
			false,
			undefined,
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
			false,
			undefined,
		)
	})

	it("move: refuses a destination that names the same file as its source, and writes nothing to it", async () => {
		// One file under two names: on a real filesystem that is a hard link, or the destination
		// spelled through a link of the source's own directory. The filesystem in this spec is its
		// doubles, so the row states the geometry outright - one identity armed for both spellings -
		// and the row below pins the opposite geometry, a destination spelled through an alias that
		// is its own file. Which of the two it is cannot be read off the strings.
		const sourceKey = path.resolve("/workspace/project", "src/old.ts")
		const destKey = path.resolve("/workspace/project", "src/new.ts")
		mockedFsPromises.default.stat.mockImplementation(() => Promise.resolve(_identityOf(sourceKey)))

		await tool.execute({ patch: movePatch }, mockTask as Task, {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
			toolCallId: "move-destination-is-the-source",
		})

		// Consequence one, the file at the shared path: the patched content never lands there. The
		// save is what would have written it and the refusal runs before the save, so the file keeps
		// the bytes it had before the patch and the tool claims no edit.
		expect(mockSaveDirectly).not.toHaveBeenCalled()
		expect(mockSaveChanges).not.toHaveBeenCalled()
		expect(mockedFsPromises.default.writeFile).not.toHaveBeenCalled()
		expect(mockTask.didEditFile).toBe(false)
		expect(mockPushToolResult).toHaveBeenCalledWith(expect.stringContaining("the two paths name the same file"))
		expect(mockHandleError).not.toHaveBeenCalled()
		// Both spellings were put to the filesystem: the check asks about the pair, not about one of
		// them while taking the strings' word for the other.
		expect(mockedFsPromises.default.stat).toHaveBeenCalledWith(sourceKey, { bigint: true })
		expect(mockedFsPromises.default.stat).toHaveBeenCalledWith(destKey, { bigint: true })
	})

	it("move: does not unlink the source when the destination names the same file", async () => {
		// Consequence two. The unlink at the end of this branch is the statement that deleted what
		// the publish had just written to the same inode; with the pair refused before the publish,
		// the file is still where both names point and nothing has been removed.
		const sourceKey = path.resolve("/workspace/project", "src/old.ts")
		mockedFsPromises.default.stat.mockImplementation(() => Promise.resolve(_identityOf(sourceKey)))

		await tool.execute({ patch: movePatch }, mockTask as Task, {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
			toolCallId: "move-destination-is-the-source-no-unlink",
		})

		expect(mockedFsPromises.default.unlink).not.toHaveBeenCalled()
		// The opened diff view is discarded rather than left open over an un-published file.
		expect(mockTask.diffViewProvider.reset).toHaveBeenCalled()
		expect(mockTask.recordToolError).toHaveBeenCalledWith("apply_patch")
	})

	it("move: reports one refusal rather than two published files for one changed file", async () => {
		// Consequence three, and the half a reviewer can check without a filesystem: the tool's own
		// report. pushToolWriteResult builds the published-files message and trackFileContext is what
		// records each published path as edited, so a move that published onto the source and then
		// unlinked it would have reported two files for the one file the patch changed.
		const sourceKey = path.resolve("/workspace/project", "src/old.ts")
		mockedFsPromises.default.stat.mockImplementation(() => Promise.resolve(_identityOf(sourceKey)))

		await tool.execute({ patch: movePatch }, mockTask as Task, {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
			toolCallId: "move-destination-is-the-source-report",
		})

		expect(mockPushToolResult).toHaveBeenCalledTimes(1)
		expect(mockPushToolResult).toHaveBeenCalledWith(
			expect.stringContaining("Cannot move src/old.ts onto src/new.ts"),
		)
		expect(mockTask.diffViewProvider.pushToolWriteResult).not.toHaveBeenCalled()
		expect(mockTask.fileContextTracker.trackFileContext).not.toHaveBeenCalled()
		expect(mockTask.didEditFile).toBe(false)
		// The mistake counter is deliberately not asserted. This refusal raises it and the end-of-
		// loop statement at ApplyPatchTool.ts:242 clears it again inside the same call, so reading
		// the counter after the call would pin :242 rather than the refusal.
	})

	it("move: two files whose identities differ above the safe-integer range are not treated as one", async () => {
		// Why the identity is read as bigints rather than numbers. An NTFS or ReFS file identity can
		// sit above Number.MAX_SAFE_INTEGER, and two such files one apart round to the same
		// Number: 2^53 and 2^53 + 1 are one double. A compare that goes through Number would call these
		// two files one file and refuse this move; the compare beside this row keeps them apart.
		const sourceKey = path.resolve("/workspace/project", "src/old.ts")
		const destKey = path.resolve("/workspace/project", "src/new.ts")
		const BASE_INO = 2n ** 53n
		const NEIGHBOUR_INO = BASE_INO + 1n
		mockedFsPromises.default.stat.mockImplementation((target: unknown) =>
			Promise.resolve(
				String(target) === destKey
					? { ..._identityOf(destKey), ino: NEIGHBOUR_INO }
					: { ..._identityOf(sourceKey), ino: BASE_INO },
			),
		)

		await tool.execute({ patch: movePatch }, mockTask as Task, {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
			toolCallId: "move-identities-above-safe-integer-range",
		})

		expect(Number(BASE_INO), "the fixture no longer demonstrates a rounded collision").toBe(Number(NEIGHBOUR_INO))
		expect(mockSaveDirectly).toHaveBeenCalledWith(
			"src/new.ts",
			"modified file content\n",
			false,
			true,
			1000,
			"create",
			false,
			false,
			undefined,
		)
		expect(mockedFsPromises.default.unlink).toHaveBeenCalledWith(sourceKey)
	})

	it("move: publishes a destination spelled through a link of the source's directory when it is its own file", async () => {
		// The other direction of the same rule, and the one a string compare gets wrong:
		// src/aliasDir/new.ts is its own file even though its spelling runs through a link of the
		// source's directory, so the move has to happen: content published at the destination, the
		// source unlinked, a report produced. Refusing this pair would be the spelling-instead-of-
		// identity bug in reverse, and it is why the check asks the filesystem.
		await tool.execute({ patch: moveThroughAliasPatch }, mockTask as Task, {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
			toolCallId: "move-destination-through-directory-alias",
		})

		expect(mockSaveDirectly).toHaveBeenCalledWith(
			"src/aliasDir/new.ts",
			"modified file content\n",
			false,
			true,
			1000,
			"create",
			false,
			false,
			undefined,
		)
		expect(mockedFsPromises.default.unlink).toHaveBeenCalledWith(path.resolve("/workspace/project", "src/old.ts"))
		expect(mockTask.didEditFile).toBe(true)
		expect(mockPushToolResult).toHaveBeenCalledWith(expect.stringContaining("Saved file"))
		expect(mockTask.fileContextTracker.trackFileContext).toHaveBeenCalledWith("src/aliasDir/new.ts", "roo_edited")
	})

	it("move: refuses with a tool error when the filesystem will not say what the destination refers to", async () => {
		// The failure surface the identity check adds, pinned where it is visible. A destination
		// whose identity the filesystem withholds used to be moved blindly; now the move is refused,
		// and refused as a tool error - the shape the note above the outside-workspace refusal says a
		// destination read failure should produce, rather than an exception reaching handleError.
		const destKey = path.resolve("/workspace/project", "src/new.ts")
		const eacces = Object.assign(new Error("EACCES: permission denied, stat '" + destKey + "'"), {
			code: "EACCES",
		})
		mockedFsPromises.default.stat.mockImplementation((target: unknown) =>
			String(target) === destKey ? Promise.reject(eacces) : Promise.resolve(_identityOf(String(target))),
		)

		await tool.execute({ patch: movePatch }, mockTask as Task, {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
			toolCallId: "move-destination-identity-refused",
		})

		expect(mockPushToolResult).toHaveBeenCalledWith(
			expect.stringContaining("the filesystem would not say what either path refers to"),
		)
		expect(mockHandleError).not.toHaveBeenCalled()
		expect(mockSaveDirectly).not.toHaveBeenCalled()
		expect(mockedFsPromises.default.unlink).not.toHaveBeenCalled()
		expect(mockTask.didEditFile).toBe(false)
	})

	it("move: refuses a same-file destination on the raw write path too, not only the guarded one", async () => {
		// The refusal sits above the isPreventFocusDisruptionEnabled split (:646 vs. :727), so a
		// flag-off run refuses for the same reason a flag-on run does. Until this row every test in
		// this file ran with the flag on, which made that symmetry a claim about line numbers rather
		// than something anyone had checked. The flag-off branch publishes with a raw mkdir plus
		// fs.writeFile rather than through the diff view, so those are the calls this row expects not
		// to see.
		const sourceKey = path.resolve("/workspace/project", "src/old.ts")
		const destKey = path.resolve("/workspace/project", "src/new.ts")
		// The harness arms preventFocusDisruption on for every row. The binding holds the function
		// object the provider stub captured, so a row has to change what that function resolves
		// to rather than re-point the binding.
		mockGetState.mockResolvedValue({
			diagnosticsEnabled: true,
			writeDelayMs: 1000,
			experiments: { preventFocusDisruption: false },
		})

		mockedFsPromises.default.stat.mockImplementation(() => Promise.resolve(_identityOf(sourceKey)))

		await tool.execute({ patch: movePatch }, mockTask as Task, {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
			toolCallId: "flag-off-move-destination-is-the-source",
		})

		expect(mockPushToolResult).toHaveBeenCalledWith(expect.stringContaining("the two paths name the same file"))
		expect(mockedFsPromises.default.writeFile).not.toHaveBeenCalled()
		expect(mockedFsPromises.default.mkdir).not.toHaveBeenCalled()
		expect(mockedFsPromises.default.unlink).not.toHaveBeenCalled()
		expect(mockSaveDirectly).not.toHaveBeenCalled()
		expect(mockTask.didEditFile).toBe(false)
		// Both spellings went to the filesystem before the refusal, here as on the other path.
		expect(mockedFsPromises.default.stat).toHaveBeenCalledWith(sourceKey, { bigint: true })
		expect(mockedFsPromises.default.stat).toHaveBeenCalledWith(destKey, { bigint: true })
	})

	it("move: publishes through the raw write path when the flag is off and the two spellings name different files", async () => {
		// The other half of the coverage, and the half that says the refusal did not become a ban:
		// with different inodes this is an ordinary move, and the branch that answers for it is the
		// mkdir + fs.writeFile one. The saveDirectly double staying unused is what pins the branch.
		const sourceKey = path.resolve("/workspace/project", "src/old.ts")
		const destKey = path.resolve("/workspace/project", "src/new.ts")
		// The harness arms preventFocusDisruption on for every row. The binding holds the function
		// object the provider stub captured, so a row has to change what that function resolves
		// to rather than re-point the binding.
		mockGetState.mockResolvedValue({
			diagnosticsEnabled: true,
			writeDelayMs: 1000,
			experiments: { preventFocusDisruption: false },
		})

		await tool.execute({ patch: movePatch }, mockTask as Task, {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
			toolCallId: "flag-off-move-between-different-files",
		})

		expect(mockedFsPromises.default.mkdir).toHaveBeenCalledWith(path.dirname(destKey), { recursive: true })
		expect(mockedFsPromises.default.writeFile).toHaveBeenCalledWith(destKey, "modified file content\n", "utf8")
		expect(mockedFsPromises.default.unlink).toHaveBeenCalledWith(sourceKey)
		expect(mockSaveDirectly).not.toHaveBeenCalled()
		expect(mockPushToolResult).toHaveBeenCalledWith(expect.stringContaining("Saved file"))
		expect(mockTask.didEditFile).toBe(true)
	})

	it("move: treats a destination that is not there as not-the-source on the raw write path", async () => {
		// Absence is answered the same way on both paths: a destination that is not there is not the
		// source, so the identity read returns "absent" and the move proceeds. The row that arms an
		// EACCES destination pins the other answer the filesystem can give.
		const sourceKey = path.resolve("/workspace/project", "src/old.ts")
		const destKey = path.resolve("/workspace/project", "src/new.ts")
		const enoent = Object.assign(new Error("ENOENT: no such file or directory, stat '" + destKey + "'"), {
			code: "ENOENT",
		})
		// The harness arms preventFocusDisruption on for every row. The binding holds the function
		// object the provider stub captured, so a row has to change what that function resolves
		// to rather than re-point the binding.
		mockGetState.mockResolvedValue({
			diagnosticsEnabled: true,
			writeDelayMs: 1000,
			experiments: { preventFocusDisruption: false },
		})

		mockedFsPromises.default.stat.mockImplementation((target: unknown) =>
			String(target) === destKey ? Promise.reject(enoent) : Promise.resolve(_identityOf(String(target))),
		)

		await tool.execute({ patch: movePatch }, mockTask as Task, {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
			toolCallId: "flag-off-move-destination-absent",
		})

		expect(mockTask.recordToolError).not.toHaveBeenCalled()
		expect(mockHandleError).not.toHaveBeenCalled()
		expect(mockedFsPromises.default.writeFile).toHaveBeenCalledWith(destKey, "modified file content\n", "utf8")
		expect(mockedFsPromises.default.unlink).toHaveBeenCalledWith(sourceKey)
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
		reg.observe(destKey, "7:4343:1234:1700000000123456789:1700000000789999999", true)

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
		reg.observe(destKey, "7:4343:1234:1700000000123456789:1700000000789999999", true)
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
		reg.observe(destKey, "7:4343:1234:1700000000123456789:1700000000789999999", true)
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

	it("move: refuses a destination outside every workspace root without canonicalising or publishing it", async () => {
		// Row 4507855163. The refusal at ApplyPatchTool.ts:564 sits above the experiment-flag branch at :575,
		// so both modes share one code path and the flag-off twin below is the other half of that claim.
		// Only the destination reads as outside a root: leaving the source inside means a canonicalisation
		// of the source cannot stand in for the destination being canonicalised.
		const destKey = path.resolve("/workspace/project", "src/new.ts")
		const outside = vi.mocked(isPathOutsideWorkspace)
		outside.mockImplementation((candidate: string) => candidate === destKey)

		await tool.execute({ patch: movePatch }, mockTask as Task, {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
			toolCallId: "move-outside-workspace-destination",
		})

		expect(outside).toHaveBeenCalledWith(destKey)
		expect(mockPushToolResult).toHaveBeenCalledWith(
			expect.stringContaining("Cannot move file to path outside workspace: src/new.ts"),
		)
		// The refused destination is never canonicalised. realpathNearest used to run at this point, so a
		// destination whose name could not be resolved surfaced an exception where the user should get the
		// tool error above.
		expect(mockedFsPromises.default.realpath).not.toHaveBeenCalled()
		expect(mockSaveDirectly).not.toHaveBeenCalled()
		expect(mockSaveChanges).not.toHaveBeenCalled()
		expect(mockedFsPromises.default.unlink).not.toHaveBeenCalled()
		expect(mockTask.diffViewProvider.reset).toHaveBeenCalled()
		expect(mockTask.recordToolError).toHaveBeenCalledWith("apply_patch")
		// The mistake counter is deliberately not asserted here. The refusal raises it at :565 and the
		// end-of-loop statement at :242 clears it again inside the same call, so reading the counter
		// after this call would pin :242 rather than the refusal.
		expect(mockHandleError).not.toHaveBeenCalled()
	})

	it("move: a complete source read keeps the destination complete", async () => {
		const sourceKey = path.resolve("/workspace/project", "src/old.ts")
		const destKey = path.resolve("/workspace/project", "src/new.ts")
		const reg = mockTask.observationRegistry
		reg.observe(sourceKey, "7:4242:1234:1700000000123456789:1700000000789999999", true)
		mockSaveDirectly.mockImplementationOnce(async () => {
			reg.observe(destKey, "7:4343:1234:1700000000123456789:1700000000789999999", true)
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
	// Rows 4507760687 follow-up (4507979054): the rows above pin what the registry holds at publish time.
	// These two pin the value the tool hands the guard as its completeness authorization - the seventh
	// argument - which the registry rows cannot see because a mocked save does not consult it. That is
	// the whole case for keeping both: one row reads the state, these read the argument that state came
	// from, and the false case below is the only situation where production passes false at all.
	it("move: authorizes the destination publish as complete when the source was read in full", async () => {
		const sourceKey = path.resolve("/workspace/project", "src/old.ts")
		mockTask.observationRegistry.observe(sourceKey, "7:4242:1234:1700000000123456789:1700000000789999999", true)

		await tool.execute({ patch: movePatch }, mockTask as Task, {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
			toolCallId: "move-complete-source-argument",
		})

		expect(mockSaveDirectly).toHaveBeenCalledWith(
			"src/new.ts",
			"modified file content\n",
			false,
			true,
			1000,
			"create",
			true,
			false,
			undefined,
		)
	})

	it("move: authorizes the destination publish as partial when the source view was partial and the destination was absent", async () => {
		// The create guard permits publishing onto an absent path, so the partial source view has to travel
		// with the publish instead of being refused: this is the case the argument exists to express, and
		// it is the one case in which the shipped code passes false (ApplyPatchTool.ts:584, :635).
		const sourceKey = path.resolve("/workspace/project", "src/old.ts")
		const destKey = path.resolve("/workspace/project", "src/new.ts")
		const reg = mockTask.observationRegistry
		reg.observe(sourceKey, "7:4242:1234:1700000000123456789:1700000000789999999", false)
		reg.observe(destKey, "7:4343:1234:1700000000123456789:1700000000789999999", true)
		mockedFsPromises.default.access.mockRejectedValueOnce(
			Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" }),
		)

		await tool.execute({ patch: movePatch }, mockTask as Task, {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
			toolCallId: "move-partial-source-absent-destination-argument",
		})

		// The destination's own stale completeness is not what authorizes the publish - the source view is -
		// so the argument is false even though the destination had been read as complete before it vanished.
		expect(mockSaveDirectly.mock.calls[0]?.[6]).toBe(false)
		expect(mockSaveDirectly.mock.calls[0]?.[5]).toBe("create")
		expect(mockHandleError).not.toHaveBeenCalled()
	})

	// Row 4507855182 (measured): the destination commits and the source unlink below never runs,
	// so a move that hits a buffer conflict is half-applied. The report has to name both paths
	// and keep the shared error's no-retry guidance, because the model's next instinct is to
	// re-apply the patch - which would duplicate the change at the destination.
	it("move: a committed destination with the source still on disk names both paths", async () => {
		const sourceKey = path.resolve("/workspace/project", "src/old.ts")
		const destKey = path.resolve("/workspace/project", "src/new.ts")
		const reg = mockTask.observationRegistry
		reg.observe(sourceKey, "7:4242:1234:1700000000123456789:1700000000789999999", true)
		mockSaveDirectly.mockRejectedValueOnce(
			new CommittedWriteBufferConflictError(
				destKey,
				"saveDirectly: the buffer held unsaved edits that differ from the content the guard published.",
			),
		)
		mockedFsPromises.default.unlink.mockClear()

		await tool.execute({ patch: movePatch }, mockTask as Task, {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
			toolCallId: "test-tool-call-id",
		})

		expect(mockHandleError).toHaveBeenCalledWith(
			"apply patch",
			expect.objectContaining({ name: "CommittedWriteBufferConflictError" }),
		)
		const reported = (mockHandleError.mock.calls[0]?.[1] ?? new Error("")) as Error
		expect(reported.message).toContain("src/new.ts committed but")
		expect(reported.message).toContain("src/old.ts was not removed")
		expect(reported.message).toContain("do not retry")
		// The half-applied state is stated, not implied: the source was never unlinked, and the
		// destination's tool-recorded observation is withdrawn by the finally sweep, so it cannot
		// authorize a later edit of content the model never read.
		expect(mockedFsPromises.default.unlink).not.toHaveBeenCalled()
		expect(reg.get(destKey)).toBeUndefined()
	})

	it("move: the destination cannot claim completeness when the source was never observed", async () => {
		// The hunk read records no observation when its stat fails, so the model has
		// no authority over the source content the move carried over. Nothing is
		// recorded for the destination before the write chain runs, so the guard still
		// refuses a full-file write to a file the model never read.
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
		expect(mockHandleError).not.toHaveBeenCalled()
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

	// The destination publishes before the source unlink is attempted, so a failed unlink
	// leaves the source sitting on disk with its original bytes. Nothing was published at
	// that path, and the only thing still able to authorize a later edit is the partial
	// observation this call recorded for itself, so it has to be withdrawn here.
	it("move: withdraws the source observation when its unlink fails after the destination published", async () => {
		const sourceKey = path.resolve("/workspace/project", "src/old.ts")
		const reg = mockTask.observationRegistry
		mockedFsPromises.default.unlink.mockRejectedValueOnce(
			Object.assign(new Error("EPERM: operation not permitted, unlink"), { code: "EPERM" }),
		)

		await tool.execute({ patch: movePatch }, mockTask as Task, {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
			toolCallId: "test-tool-call-id",
		})

		expect(mockSaveDirectly).toHaveBeenCalled()
		expect(reg.has(sourceKey)).toBe(false)
		// The consequence the finding names: with the source observation gone, a follow-up
		// targeted write to the source needs a real read instead of riding on the leftover.
		await expect(guardedWrite(mockTask as Task, "src/old.ts", "full replacement", "update")).rejects.toThrow(
			"File already exists at src/old.ts and was not read before this write -- read the file first, then retry.",
		)
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

		expect(mockSaveChanges).toHaveBeenCalledWith(true, 1000, "edit", false, undefined)
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

		expect(mockSaveChanges).toHaveBeenCalledWith(true, 1000, "create", false, undefined)
		expect(mockPushToolResult).toHaveBeenCalledWith("Saved file")
		expect(mockHandleError).not.toHaveBeenCalled()
	})
	// The two rows below pin the flag-off move branch as it ships: a raw fs.mkdir plus
	// fs.writeFile, with no guard, no completeness carry and no compare-and-swap. They
	// document current behaviour - main's ApplyPatchTool (blob 2713e08ffe8d) writes the
	// flag-off move with `await fs.writeFile(moveAbsolutePath, newContent, "utf8")` at
	// :422 - and they are not a claim that this is the contract the branch should keep.
	// Routing this branch through the guarded publish is a deliberate improvement and
	// should turn these rows red; reading them as endorsement of the raw write would
	// make that improvement look like a regression.
	it("flag-off move: publishes through fs.mkdir then fs.writeFile, with no guard and no completeness carry", async () => {
		mockGetState.mockResolvedValue({ diagnosticsEnabled: true, writeDelayMs: 1000, experiments: {} })
		// The cast above declares access/stat/unlink only because nothing else on the
		// mocked module was reached before this branch was exercised; writeFile is read
		// through its own narrow view of the doubles.
		const writeDoubles = vi.mocked(
			fsPromises as unknown as {
				default: { writeFile: ReturnType<typeof vi.fn>; mkdir: ReturnType<typeof vi.fn> }
			},
		)

		await tool.execute({ patch: movePatch }, mockTask as Task, {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
			toolCallId: "flag-off-move-plain-write",
		})

		expect(writeDoubles.default.mkdir).toHaveBeenCalledWith(
			path.dirname(path.resolve("/workspace/project", "src/new.ts")),
			{ recursive: true },
		)
		expect(writeDoubles.default.writeFile).toHaveBeenCalledWith(
			path.resolve("/workspace/project", "src/new.ts"),
			"modified file content\n",
			"utf8",
		)
		// No guard runs here: the guarded publish lives behind saveDirectly, and this
		// shape reaches neither the guarded save nor the diff-view save.
		expect(mockSaveDirectly).not.toHaveBeenCalled()
		expect(mockSaveChanges).not.toHaveBeenCalled()
		expect(mockHandleError).not.toHaveBeenCalled()
		expect(mockPushToolResult).toHaveBeenCalled()
	})

	it("flag-off move: an existing destination is never consulted before the write", async () => {
		mockGetState.mockResolvedValue({ diagnosticsEnabled: true, writeDelayMs: 1000, experiments: {} })

		await tool.execute({ patch: movePatch }, mockTask as Task, {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
			toolCallId: "flag-off-move-destination-present",
		})

		// The access double resolves, so the destination reads as present on disk, yet
		// nothing asks: the branch does not read it, stat it, or guard against publishing
		// over content the model never saw.
		expect(mockedFsPromises.default.access).not.toHaveBeenCalled()
		expect(mockSaveDirectly).not.toHaveBeenCalled()
		expect(mockHandleError).not.toHaveBeenCalled()
		expect(mockPushToolResult).toHaveBeenCalled()
	})

	it("flag-off move: refuses a destination outside every workspace root before mkdir or writeFile", async () => {
		// The twin of the guarded row above. The refusal is above the experiment-flag branch, so the raw
		// publish path never sees an outside-workspace destination either: no directory is created, nothing
		// is written, and the source is left where it was.
		mockGetState.mockResolvedValue({ diagnosticsEnabled: true, writeDelayMs: 1000, experiments: {} })
		const destKey = path.resolve("/workspace/project", "src/new.ts")
		vi.mocked(isPathOutsideWorkspace).mockImplementation((candidate: string) => candidate === destKey)
		const writeDoubles = vi.mocked(
			fsPromises as unknown as {
				default: { writeFile: ReturnType<typeof vi.fn>; mkdir: ReturnType<typeof vi.fn> }
			},
		)

		await tool.execute({ patch: movePatch }, mockTask as Task, {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
			toolCallId: "flag-off-move-outside-workspace-destination",
		})

		expect(mockPushToolResult).toHaveBeenCalledWith(
			expect.stringContaining("Cannot move file to path outside workspace: src/new.ts"),
		)
		expect(writeDoubles.default.mkdir).not.toHaveBeenCalled()
		expect(writeDoubles.default.writeFile).not.toHaveBeenCalled()
		expect(mockSaveDirectly).not.toHaveBeenCalled()
		expect(mockedFsPromises.default.unlink).not.toHaveBeenCalled()
		expect(mockTask.recordToolError).toHaveBeenCalledWith("apply_patch")
		expect(mockHandleError).not.toHaveBeenCalled()
	})

	// The hunk read is the content the guarded publish republishes. An ASCII hunk can match a
	// file whose bytes somewhere else cannot be decoded, and reading those bytes as UTF-8
	// substitutes them, so the write would change bytes the patch never mentioned. The refusal has
	// to land before the read is recorded as an observation, or the substituted version becomes
	// the version a later full-file write is allowed to publish.
	const undecodableTail = (): Buffer =>
		Buffer.concat([Buffer.from("original file content\n"), Buffer.from([0xc3, 0x28])])
	const undecodableUpdatePatch = `*** Begin Patch
*** Update File: src/thing.ts
@@
-original file content
+modified file content
*** End Patch`
	const deleteThingPatch = `*** Begin Patch
*** Delete File: src/thing.ts
*** End Patch`
	const runPatch = async (patch: string): Promise<void> => {
		await tool.execute({ patch }, mockTask as Task, {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
			toolCallId: "test-tool-call-id",
		})
	}

	it("update: refuses a file it cannot decode rather than publishing replacement characters", async () => {
		mockedFsPromises.default.readFile.mockResolvedValue(undecodableTail())

		await runPatch(undecodableUpdatePatch)

		const pushed = String(mockPushToolResult.mock.calls[0]?.[0] ?? "")
		expect(pushed).toContain("not valid UTF-8")
		// 0xC3 0x28 is not a valid sequence and it sits at byte 22 - past the line the hunk
		// matched. The hunk is ASCII and matched fine, which is the case the row is about: the
		// bytes at fault are ones the patch never mentions.
		expect(pushed).toContain("byte 22")
		expect(pushed).toContain("src/thing.ts")
		// Nothing published and nothing asked: the refusal happens while the hunks are still
		// being processed, before any publish prompt exists.
		expect(mockAskApproval).not.toHaveBeenCalled()
		expect(mockSaveDirectly).not.toHaveBeenCalled()
		expect(mockSaveChanges).not.toHaveBeenCalled()
		// The read must not survive as an observation: the version it saw is the version a
		// later full-file write would be permitted to publish.
		expect(mockTask.observationRegistry.get(path.resolve("/workspace/project", "src/thing.ts"))).toBeUndefined()
		expect(mockTask.consecutiveMistakeCount).toBe(1)
		expect(mockTask.didEditFile).toBe(false)
	})

	it("update: a file that legitimately contains a replacement character still publishes", async () => {
		// U+FFFD written as EF BF BD is valid UTF-8. The refusal is about bytes that cannot be
		// decoded, not about a character appearing in the text - a check on the decoded string
		// would refuse this file for no reason.
		// EF BF BD is U+FFFD written as bytes: the file legitimately contains the character, and
		// those bytes are valid UTF-8. (A \uFFFD... escape here would be ambiguous - FFFE is a
		// legal 4-digit escape - so the sequence is spelled in bytes on purpose.)
		const replacementCharacterIsLegitimate = Buffer.concat([
			Buffer.from("original file content\n"),
			Buffer.from([0xef, 0xbf, 0xbd]),
			Buffer.from("end\n"),
		])
		mockedFsPromises.default.readFile.mockResolvedValue(replacementCharacterIsLegitimate)

		await runPatch(undecodableUpdatePatch)

		expect(mockSaveDirectly).toHaveBeenCalledWith(
			"src/thing.ts",
			"modified file content\n\uFFFDend\n",
			// The tail the patch never mentioned travels through the publish unchanged:
			// that is what a file that legitimately contains a replacement character looks like.
			false,
			true,
			1000,
			"edit",
			undefined,
			false,
			undefined,
		)
		expect(mockTask.consecutiveMistakeCount).toBe(0)
	})

	it("delete: an undecodable file is still deleted, because nothing republishes its bytes", async () => {
		// Narrowing, not blanket refusal: the delete publishes by unlinking, so the reading is a
		// snapshot and the bytes nobody can name are not rewritten by anything this tool does.
		mockedFsPromises.default.readFile.mockResolvedValue(undecodableTail())

		await runPatch(deleteThingPatch)

		expect(mockedFsPromises.default.unlink).toHaveBeenCalledWith(path.resolve("/workspace/project", "src/thing.ts"))
		expect(mockPushToolResult).toHaveBeenCalledWith(expect.stringContaining("Successfully deleted"))
		expect(mockTask.consecutiveMistakeCount).toBe(0)
	})
})
