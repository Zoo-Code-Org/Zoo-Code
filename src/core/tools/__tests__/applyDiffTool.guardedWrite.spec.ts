// npx vitest run core/tools/__tests__/applyDiffTool.guardedWrite.spec.ts

import path from "path"
import type { BigIntStats } from "fs"

import type { MockedFunction } from "vitest"

import { fileExistsAtPath } from "../../../utils/fs"
import type { Task } from "../../task/Task"
import { ApplyDiffTool } from "../ApplyDiffTool"
import { ObservationRegistry } from "../../task/observationRegistry"

vi.mock("fs/promises", () => ({
	default: {
		readFile: vi.fn().mockResolvedValue("original file content\n"),
		// The tool stats around its read to authorize the save against the version it
		// actually read; one shared stats object means the file did not change.
		stat: vi.fn().mockResolvedValue({
			dev: 1n,
			ino: 2n,
			size: 22n,
			mtimeNs: 100n,
			ctimeNs: 100n,
		}),
	},
}))

vi.mock("../../../utils/fs", () => ({
	fileExistsAtPath: vi.fn().mockResolvedValue(true),
}))

vi.mock("../../prompts/responses", () => ({
	formatResponse: {
		toolError: vi.fn((msg: string) => `Error: ${msg}`),
		rooIgnoreError: vi.fn((filePath: string) => `Access denied: ${filePath}`),
		createPrettyPatch: vi.fn(() => "mock-diff"),
	},
}))

vi.mock("../../diff/stats", () => ({
	sanitizeUnifiedDiff: vi.fn((diff: string) => diff),
	computeDiffStats: vi.fn(() => ({ additions: 1, deletions: 1 })),
}))

describe("ApplyDiffTool.execute - guarded write (S4b, epic #1375)", () => {
	const mockedFileExistsAtPath = fileExistsAtPath as MockedFunction<typeof fileExistsAtPath>

	let tool: ApplyDiffTool
	let mockTask: Pick<
		Task,
		| "cwd"
		| "consecutiveMistakeCount"
		| "consecutiveMistakeCountForApplyDiff"
		| "recordToolError"
		| "rooIgnoreController"
		| "rooProtectedController"
		| "say"
		| "processQueuedMessages"
		| "didEditFile"
		| "api"
		| "diffStrategy"
		| "observationRegistry"
		| "diffViewProvider"
		| "providerRef"
		| "fileContextTracker"
	>
	let mockSaveDirectly: MockedFunction<(...args: unknown[]) => Promise<unknown>>
	let mockSaveChanges: MockedFunction<(...args: unknown[]) => Promise<unknown>>
	let mockAskApproval: MockedFunction<(...args: unknown[]) => Promise<boolean>>
	let mockHandleError: MockedFunction<(...args: unknown[]) => Promise<void>>
	let mockPushToolResult: MockedFunction<(...args: unknown[]) => void>

	afterEach(async () => {
		// clearAllMocks drops call records but not queued once-values, so stats queued by
		// one test would otherwise be handed to the next test's reads. Restore the default.
		const stat = vi.mocked((await import("fs/promises")).default.stat)
		stat.mockReset()
		stat.mockResolvedValue({ dev: 1n, ino: 2n, size: 22n, mtimeNs: 100n, ctimeNs: 100n } as unknown as BigIntStats)
		// The role-aware stat mock above also drives readFile, so its implementation is reset here too:
		// a leaked implementation would decide which stat call the NEXT test sees as pre-read.
		const readFile = vi.mocked((await import("fs/promises")).default.readFile)
		readFile.mockReset()
		readFile.mockResolvedValue("original file content\n")
	})

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
			consecutiveMistakeCountForApplyDiff: new Map(),
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
			api: {
				getModel: () => ({ id: "claude-sonnet-4-5" }),
			} as unknown as Task["api"],
			diffStrategy: {
				applyDiff: vi.fn().mockResolvedValue({ success: true, content: "modified file content\n" }),
			} as unknown as Task["diffStrategy"],
			diffViewProvider: diffViewProviderStub as unknown as Task["diffViewProvider"],
			providerRef: {
				deref: vi.fn().mockReturnValue({
					getState: vi.fn().mockResolvedValue({
						diagnosticsEnabled: true,
						writeDelayMs: 1000,
						// Exercise the focus-disruption (saveDirectly) save path.
						experiments: { preventFocusDisruption: true },
					}),
				}),
			} as unknown as Task["providerRef"],
			observationRegistry: new ObservationRegistry(),
			fileContextTracker: {
				trackFileContext: vi.fn().mockResolvedValue(undefined),
			} as unknown as Task["fileContextTracker"],
		}

		mockAskApproval = vi.fn().mockResolvedValue(true)
		mockHandleError = vi.fn().mockResolvedValue(undefined)
		mockPushToolResult = vi.fn()

		tool = new ApplyDiffTool()
	})

	it("publishes through the guarded saveDirectly with edit kind", async () => {
		await tool.execute({ path: "src/thing.ts", diff: "unified diff" }, mockTask as Task, {
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

	it("surfaces the unobserved edit remediation as a tool error", async () => {
		const guardError = new Error("File not read yet -- read the file, then retry.")
		mockSaveDirectly.mockRejectedValue(guardError)

		await tool.execute({ path: "src/thing.ts", diff: "unified diff" }, mockTask as Task, {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
		})

		expect(mockHandleError).toHaveBeenCalledWith("applying diff", guardError)
		expect(vi.mocked(mockTask.diffViewProvider.reset)).toHaveBeenCalled()
		expect(mockTask.didEditFile).toBe(false)
		expect(mockPushToolResult).not.toHaveBeenCalledWith("Saved file")
	})

	it("passes the edit kind to the diff-view save path", async () => {
		// Without focus disruption the tool saves through the diff view, and the
		// kind it passes must carry its intent: a targeted edit, not the default
		// full-file replacement.
		// The settings double is rebuilt for this test so the focus-disruption
		// experiment is off and the tool takes the diff-view save path.
		mockTask.providerRef = {
			deref: () => ({
				getState: vi.fn().mockResolvedValue({
					diagnosticsEnabled: true,
					writeDelayMs: 1000,
					experiments: {},
				}),
			}),
		} as unknown as Task["providerRef"]

		await tool.execute({ path: "src/thing.ts", diff: "unified diff" }, mockTask as Task, {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
		})

		expect(mockSaveChanges).toHaveBeenCalledWith(true, 1000, "edit")
		expect(mockSaveDirectly).not.toHaveBeenCalled()
		expect(mockPushToolResult).toHaveBeenCalledWith("Saved file")
		expect(mockHandleError).not.toHaveBeenCalled()
	})

	it("authorizes the save against the version its own read was built on", async () => {
		// The model never read this file, so the only authorization available at save
		// time is the one the tool earns from its own hunk read. Without it the guarded
		// save falls back to the preview's version token, which can describe a version
		// the diff was never computed against.
		await tool.execute({ path: "src/thing.ts", diff: "unified diff" }, mockTask as Task, {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
		})

		const observation = mockTask.observationRegistry.get(path.resolve(mockTask.cwd, "src/thing.ts"))
		expect(observation?.version).toBe("1:2:22:100:100")
		// A tool read is not a model read, so completeness stays unearned.
		expect(observation?.complete).toBe(false)
	})

	it("does not authorize a read that changed underneath it", async () => {
		// Only the fields versionTokenOfStat reads; a full BigIntStats cannot be built
		// against the mocked fs, so the double assertion is the narrowest option.
		const stat = vi.mocked((await import("fs/promises")).default.stat)
		stat.mockResolvedValueOnce({
			dev: 1n,
			ino: 2n,
			size: 22n,
			mtimeNs: 100n,
			ctimeNs: 100n,
		} as unknown as BigIntStats).mockResolvedValueOnce({
			dev: 1n,
			ino: 2n,
			size: 30n,
			mtimeNs: 200n,
			ctimeNs: 100n,
		} as unknown as BigIntStats)

		await tool.execute({ path: "src/thing.ts", diff: "unified diff" }, mockTask as Task, {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
		})

		expect(mockTask.observationRegistry.get(path.resolve(mockTask.cwd, "src/thing.ts"))).toBeUndefined()
		// Exactly the two bracketing stats: no queued value left over for the next test.
		expect(stat).toHaveBeenCalledTimes(2)
	})

	it("keeps a complete model observation complete when the tool read matches its version", async () => {
		// The model read the file in full first. The tool's own read of the same version
		// must not downgrade that earned completeness to a partial observation.
		const key = path.resolve(mockTask.cwd, "src/thing.ts")
		mockTask.observationRegistry.observe(key, "1:2:22:100:100", true)

		await tool.execute({ path: "src/thing.ts", diff: "unified diff" }, mockTask as Task, {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
		})

		const observation = mockTask.observationRegistry.get(key)
		expect(observation?.version).toBe("1:2:22:100:100")
		expect(observation?.complete).toBe(true)
	})

	it("does not refresh an observation the model earned on an older version", async () => {
		// Refreshing a stale observation to the current version would authorize content the
		// model built from the older read. The observation is left as the model earned it,
		// so the save's compare-and-swap fails and the model is told to re-read.
		const key = path.resolve(mockTask.cwd, "src/thing.ts")
		mockTask.observationRegistry.observe(key, "1:2:9:9:9", true)

		await tool.execute({ path: "src/thing.ts", diff: "unified diff" }, mockTask as Task, {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
		})

		const observation = mockTask.observationRegistry.get(key)
		expect(observation?.version).toBe("1:2:9:9:9")
		expect(observation?.complete).toBe(true)
	})

	it("still performs the diff read when the pre-read stat fails, and records no observation", async () => {
		// A stat failure is not a tool failure: the read still happens, the diff still
		// applies, and the save still goes through the guard (which fails closed without
		// an observation). What must not happen is an observation recorded for a version
		// the tool could not bracket.
		const fsMock = await import("fs/promises")
		const stat = vi.mocked(fsMock.default.stat)
		const readFile = vi.mocked(fsMock.default.readFile)
		// Pin WHICH of the two bracketing stats fails. Both run against the same path, so a
		// once-value cannot express the role: verified by flipping the injected failure to the
		// post-read stat, which leaves this test green while testing a different scenario. The
		// pre-read stat is the one that runs before the read, so the failure is keyed to that
		// interleaving rather than to a call index.
		let readStarted = false
		readFile.mockImplementation(async () => {
			readStarted = true
			return "original file content\n"
		})
		const statRoles: string[] = []
		stat.mockImplementation(async () => {
			if (!readStarted) {
				statRoles.push("pre:threw")
				throw Object.assign(new Error("EACCES"), { code: "EACCES" })
			}
			statRoles.push("post:ok")
			return { dev: 1n, ino: 2n, size: 22n, mtimeNs: 100n, ctimeNs: 100n } as unknown as BigIntStats
		})

		await tool.execute({ path: "src/thing.ts", diff: "unified diff" }, mockTask as Task, {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
		})

		expect(mockTask.observationRegistry.get(path.resolve(mockTask.cwd, "src/thing.ts"))).toBeUndefined()
		// Both bracketing stats ran, and the one that failed was the PRE-read one. The
		// roles are recorded from the interleaving with the read, so flipping which call throws
		// makes this assertion fail - the outcome assertions alone cannot tell the two apart.
		expect(statRoles).toEqual(["pre:threw", "post:ok"])
		// The read itself is unaffected: the diff was computed and the save attempted.
		expect(mockTask.diffStrategy?.applyDiff).toHaveBeenCalled()
		expect(mockSaveDirectly).toHaveBeenCalledWith(
			"src/thing.ts",
			"modified file content\n",
			false,
			true,
			1000,
			"edit",
		)
		expect(mockHandleError).not.toHaveBeenCalled()
		// Both bracketing stats were still attempted - the failure is not swallowed into
		// skipping the second one.
		expect(stat).toHaveBeenCalledTimes(2)
	})

	it("records no observation when the post-read stat fails", async () => {
		// The file changed or vanished between the read and the second stat; with no
		// post-read token the tool cannot prove the version it read, so the read
		// authorizes nothing and the save falls back to the re-read remediation.
		const stat = vi.mocked((await import("fs/promises")).default.stat)
		stat.mockRejectedValue(Object.assign(new Error("EACCES"), { code: "EACCES" }))

		await tool.execute({ path: "src/thing.ts", diff: "unified diff" }, mockTask as Task, {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
		})

		expect(mockTask.observationRegistry.get(path.resolve(mockTask.cwd, "src/thing.ts"))).toBeUndefined()
		expect(mockSaveDirectly).toHaveBeenCalled()
		expect(mockHandleError).not.toHaveBeenCalled()
		expect(stat).toHaveBeenCalledTimes(2)
	})
})
