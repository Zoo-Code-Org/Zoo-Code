// npx vitest run core/tools/__tests__/applyDiffTool.guardedWrite.spec.ts

import type { MockedFunction } from "vitest"

import * as fsPromises from "fs/promises"
import path from "path"

import { fileExistsAtPath } from "../../../utils/fs"
import type { Task } from "../../task/Task"
import { ApplyDiffTool } from "../ApplyDiffTool"

vi.mock("fs/promises", () => {
	// BigInt stats so the S4b observation (ReadFileTool contract) can build a
	// deterministic version token. Stable values = pre/post tokens agree. The
	// named `stat` export is the same double as `default.stat` (the tool imports
	// the default namespace; the spec asserts through the named one).
	const statMock = vi.fn().mockResolvedValue({
		dev: 7n,
		ino: 4242n,
		size: 1234n,
		mtimeNs: 1_700_000_000_123_456_789n,
		ctimeNs: 1_700_000_000_789_999_999n,
	})
	return {
		default: {
			readFile: vi.fn().mockResolvedValue("original file content\n"),
			stat: statMock,
		},
		stat: statMock,
	}
})

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
		| "diffViewProvider"
		| "providerRef"
		| "fileContextTracker"
		| "observationRegistry"
	>
	let mockSaveDirectly: MockedFunction<(...args: unknown[]) => Promise<unknown>>
	let mockObserve: MockedFunction<(...args: unknown[]) => void>
	let mockAskApproval: MockedFunction<(...args: unknown[]) => Promise<boolean>>
	let mockHandleError: MockedFunction<(...args: unknown[]) => Promise<void>>
	let mockPushToolResult: MockedFunction<(...args: unknown[]) => void>

	beforeEach(() => {
		vi.clearAllMocks()

		mockedFileExistsAtPath.mockResolvedValue(true)

		mockSaveDirectly = vi.fn().mockResolvedValue({
			newProblemsMessage: "",
			userEdits: undefined,
			finalContent: "new content",
		})

		// S2 observation registry double: the tool records its own read here before
		// the guarded edit publish (S4b trial addendum).
		mockObserve = vi.fn()

		// Structural stubs for the guarded-write path: the real DiffViewProvider is
		// out of scope here, so vi.fn() doubles stand in for the members the tool
		// touches (the saveDirectly double also records the writeKind plumbing).
		const diffViewProviderStub = {
			editType: undefined as "create" | "modify" | undefined,
			originalContent: undefined as string | undefined,
			saveDirectly: mockSaveDirectly,
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
			fileContextTracker: {
				trackFileContext: vi.fn().mockResolvedValue(undefined),
			} as unknown as Task["fileContextTracker"],
			observationRegistry: {
				observe: mockObserve,
			} as unknown as Task["observationRegistry"],
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
		// S4b (trial addendum): the tool's own read is recorded as an observation so
		// the guarded edit publish can CAS against the observed token.
		expect(mockObserve).toHaveBeenCalledTimes(1)
		expect(mockObserve.mock.calls[0]?.[0]).toBe(path.resolve(mockTask.cwd, "src/thing.ts"))
		expect(mockObserve.mock.calls[0]?.[1]).toBe("7:4242:1234:1700000000123456789:1700000000789999999")
		expect(mockPushToolResult).toHaveBeenCalledWith("Saved file")
		expect(mockTask.didEditFile).toBe(true)
		expect(mockHandleError).not.toHaveBeenCalled()
	})

	it("does not observe when the pre- and post-read tokens disagree", async () => {
		// A mutation between the two stats means the content the diff was applied
		// to is not the on-disk state: leave the target unobserved (ReadFileTool
		// contract) so the guarded write gets a stale rejection, not a false match.
		const preStats = { dev: 7n, ino: 4242n, size: 1234n, mtimeNs: 1n, ctimeNs: 2n }
		const postStats = { dev: 7n, ino: 4242n, size: 9999n, mtimeNs: 3n, ctimeNs: 4n }
		const mockedStat = vi.mocked(fsPromises.stat)
		mockedStat.mockResolvedValueOnce(preStats as unknown as Awaited<ReturnType<typeof fsPromises.stat>>)
		mockedStat.mockResolvedValueOnce(postStats as unknown as Awaited<ReturnType<typeof fsPromises.stat>>)

		await tool.execute({ path: "src/thing.ts", diff: "unified diff" }, mockTask as Task, {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
		})

		expect(mockObserve).not.toHaveBeenCalled()
		// The publish still runs (the saveDirectly double stands in for the guard);
		// the registry simply carries no observation for this path.
		expect(mockSaveDirectly).toHaveBeenCalled()
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
})
