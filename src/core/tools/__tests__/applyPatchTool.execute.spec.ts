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

// The vi.mock factory exposes the fs/promises functions under a `default`
// property (matching the SUT's default import), which the static module type
// does not declare; cast once at this boundary rather than at each call site.
const mockedFsPromises = vi.mocked(
	fsPromises as unknown as {
		default: {
			access: MockedFunction<typeof fsPromises.access>
			stat: ReturnType<typeof vi.fn>
			unlink: MockedFunction<typeof fsPromises.unlink>
		}
	},
)

vi.mock("fs/promises", () => ({
	default: {
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
	},
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
		})

		expect(reg.get(key)?.complete).toBe(true)
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
			"File already exists at /workspace/project/src/thing.ts and was not read before this write -- read the file first, then retry.",
		)
		mockSaveDirectly.mockRejectedValue(guardError)

		await tool.execute({ patch: updatePatch }, mockTask as Task, {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
		})

		expect(mockTask.observationRegistry.has(path.resolve("/workspace/project", "src/thing.ts"))).toBe(false)
		// The rejection value is controlled here, so assert the exact error that
		// reached handleError instead of any call: a stat or parse failure would
		// otherwise satisfy a bare toHaveBeenCalled().
		expect(mockHandleError).toHaveBeenCalledWith("apply patch", guardError)
	})

	it("add: publishes the new file through the guarded saveDirectly with create kind", async () => {
		mockedFileExistsAtPath.mockResolvedValueOnce(false)

		await tool.execute({ patch: addPatch }, mockTask as Task, {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
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
		})

		expect(mockSaveDirectly).toHaveBeenCalledWith(
			"src/new.ts",
			"modified file content\n",
			false,
			true,
			1000,
			"create",
		)
	})

	it("move: carries the source's partial completeness to the destination", async () => {
		// The destination is the source file plus one hunk. The create publish records
		// it as complete, but the model only saw a slice of the source, so the
		// destination must not gain completeness the model never earned.
		const sourceKey = path.resolve("/workspace/project", "src/old.ts")
		const destKey = path.resolve("/workspace/project", "src/new.ts")
		const reg = mockTask.observationRegistry
		reg.observe(sourceKey, "7:4242:1234:1700000000123456789:1700000000789999999", false)
		// The real saveDirectly publishes through guardedWrite, which refreshes the
		// destination observation as complete for a create; the double mirrors that.
		mockSaveDirectly.mockImplementationOnce(async () => {
			reg.observe(destKey, "7:4242:1234:1700000000123456789:1700000000789999999", true)
			return { newProblemsMessage: "", userEdits: undefined, finalContent: "new content" }
		})

		await tool.execute({ patch: movePatch }, mockTask as Task, {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
		})

		expect(reg.get(destKey)?.complete).toBe(false)
		await expect(guardedWrite(mockTask as Task, "src/new.ts", "full replacement", "create")).rejects.toThrow(
			"File was only partially read (line slice, range, truncated view, or indentation block) -- " +
				"a full-file replacement needs the complete content; re-read the whole file, then retry.",
		)
		expect(mockHandleError).not.toHaveBeenCalled()
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
		})

		expect(reg.get(destKey)?.complete).toBe(true)
		expect(mockHandleError).not.toHaveBeenCalled()
	})

	it("move: the destination cannot claim completeness when the source was never observed", async () => {
		// The hunk read records no observation when its stat fails, so the model has
		// no authority over the source content the move carried over.
		const destKey = path.resolve("/workspace/project", "src/new.ts")
		const reg = mockTask.observationRegistry
		mockedFsPromises.default.stat.mockImplementationOnce(() => Promise.reject(new Error("stat failed")))
		mockSaveDirectly.mockImplementationOnce(async () => {
			reg.observe(destKey, "7:4242:1234:1700000000123456789:1700000000789999999", true)
			return { newProblemsMessage: "", userEdits: undefined, finalContent: "new content" }
		})

		await tool.execute({ patch: movePatch }, mockTask as Task, {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
		})

		expect(reg.get(path.resolve("/workspace/project", "src/old.ts"))).toBeUndefined()
		expect(reg.get(destKey)?.complete).toBe(false)
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
		})

		expect(reg.get(destKey)).toBeUndefined()
		expect(mockHandleError).not.toHaveBeenCalled()
	})

	it("update: surfaces the unobserved-existing remediation as a tool error", async () => {
		const guardError = new Error(
			"File already exists at /workspace/project/src/thing.ts and was not read before this write -- read the file first, then retry.",
		)
		mockSaveDirectly.mockRejectedValue(guardError)

		await tool.execute({ patch: updatePatch }, mockTask as Task, {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
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
		})

		expect(mockSaveChanges).toHaveBeenCalledWith(true, 1000, "create")
		expect(mockPushToolResult).toHaveBeenCalledWith("Saved file")
		expect(mockHandleError).not.toHaveBeenCalled()
	})
})
