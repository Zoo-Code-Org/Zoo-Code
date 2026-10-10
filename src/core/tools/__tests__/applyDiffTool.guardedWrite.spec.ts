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

	it("keeps the edit alive when the stat before its read fails, and records no observation", async () => {
		// The bracketing stats are best-effort: a stat that fails must not take the whole edit
		// down with it. What it must not do is leave an authorization the tool never earned -
		// with no pre-read stats there is no version to compare, so nothing is observed.
		const stat = vi.mocked((await import("fs/promises")).default.stat)
		stat.mockRejectedValueOnce(Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }))

		await tool.execute({ path: "src/thing.ts", diff: "unified diff" }, mockTask as Task, {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
		})

		expect(mockTask.observationRegistry.get(path.resolve(mockTask.cwd, "src/thing.ts"))).toBeUndefined()
		// The tool did not treat a stat failure as its own failure...
		expect(mockHandleError).not.toHaveBeenCalled()
		// ...and the edit the model asked for still reached the guarded save.
		expect(mockSaveDirectly).toHaveBeenCalledWith(
			"src/thing.ts",
			"modified file content\n",
			false,
			true,
			1000,
			"edit",
		)
		expect(mockPushToolResult).toHaveBeenCalledWith("Saved file")
		expect(stat).toHaveBeenCalledTimes(2)
	})

	it("keeps the edit alive when the stat after its read fails, and records no observation", async () => {
		// The post-read stat is the other half of the bracket. If it fails the read cannot be
		// shown to be stable, so no observation may be recorded - but the edit still runs and the
		// stat failure is not reported as a tool error.
		const stat = vi.mocked((await import("fs/promises")).default.stat)
		// Queue the pre-read stat as a success and reject only the second one, so the branch this
		// test is about - the post-read bracket - is the one that fails.
		stat.mockResolvedValueOnce({
			dev: 1n,
			ino: 2n,
			size: 22n,
			mtimeNs: 100n,
			ctimeNs: 100n,
		} as unknown as BigIntStats).mockRejectedValueOnce(
			Object.assign(new Error("EBUSY: resource busy"), { code: "EBUSY" }),
		)

		await tool.execute({ path: "src/thing.ts", diff: "unified diff" }, mockTask as Task, {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
		})

		expect(mockTask.observationRegistry.get(path.resolve(mockTask.cwd, "src/thing.ts"))).toBeUndefined()
		expect(mockHandleError).not.toHaveBeenCalled()
		expect(mockSaveDirectly).toHaveBeenCalledWith(
			"src/thing.ts",
			"modified file content\n",
			false,
			true,
			1000,
			"edit",
		)
		expect(mockPushToolResult).toHaveBeenCalledWith("Saved file")
		expect(stat).toHaveBeenCalledTimes(2)
	})
})
