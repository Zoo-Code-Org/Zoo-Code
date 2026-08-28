// npx vitest run core/tools/__tests__/applyDiffTool.changeCard.spec.ts

import type { MockedFunction } from "vitest"

import { fileExistsAtPath } from "../../../utils/fs"
import { checkAutoApproval } from "../../auto-approval"
import { checkpointSave } from "../../checkpoints"
import type { Task } from "../../task/Task"
import { ApplyDiffTool } from "../ApplyDiffTool"

vi.mock("fs/promises", () => ({
	default: {
		readFile: vi.fn().mockResolvedValue("original file content\n"),
		// The trial aggregate adds the S4b stat-pair self-observation around this
		// read (ApplyDiffTool records its own read under the ReadFileTool contract);
		// its `.catch(() => undefined)` fallback keeps the observation no-op when
		// stat rejects, so this spec stays green on both the component branch and
		// the trial aggregate.
		stat: vi.fn().mockRejectedValue(new Error("stat unavailable in this spec")),
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
	// The real DiffStats shape is { added, removed } (the tool maps it to the
	// change-card { additions, deletions } pair).
	sanitizeUnifiedDiff: vi.fn((diff: string) => diff),
	computeDiffStats: vi.fn(() => ({ added: 1, removed: 1 })),
}))

vi.mock("../../checkpoints", () => ({
	checkpointSave: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("../../auto-approval", () => ({
	checkAutoApproval: vi.fn().mockResolvedValue({ decision: "ask" }),
}))

describe("ApplyDiffTool.execute - per-write checkpoint and change card (B3a, epic #1375)", () => {
	const mockedFileExistsAtPath = fileExistsAtPath as MockedFunction<typeof fileExistsAtPath>
	const mockCheckpointSave = checkpointSave as MockedFunction<typeof checkpointSave>
	const mockCheckAutoApproval = checkAutoApproval as MockedFunction<typeof checkAutoApproval>

	let tool: ApplyDiffTool
	let mockTask: Pick<
		Task,
		| "cwd"
		| "consecutiveMistakeCount"
		| "consecutiveMistakeCountForApplyDiff"
		| "recordToolError"
		| "rooIgnoreController"
		| "rooProtectedController"
		| "processQueuedMessages"
		| "didEditFile"
		| "api"
		| "diffStrategy"
		| "diffViewProvider"
		| "providerRef"
		| "fileContextTracker"
	>
	let mockSaveDirectly: MockedFunction<(...args: unknown[]) => Promise<unknown>>
	let mockGetState: MockedFunction<() => Promise<Record<string, unknown>>>
	let mockAskApproval: MockedFunction<(...args: unknown[]) => Promise<boolean>>
	let mockHandleError: MockedFunction<(...args: unknown[]) => Promise<void>>
	let mockPushToolResult: MockedFunction<(...args: unknown[]) => void>

	beforeEach(() => {
		vi.clearAllMocks()

		mockedFileExistsAtPath.mockResolvedValue(true)

		// Structural stubs for the prevent-focus-disruption save path: the real
		// DiffViewProvider is out of scope here, so vi.fn() doubles stand in for
		// the members the tool touches.
		mockSaveDirectly = vi.fn().mockResolvedValue({
			newProblemsMessage: "",
			userEdits: undefined,
			finalContent: "new content",
		})
		const diffViewProviderStub = {
			editType: undefined as "create" | "modify" | undefined,
			originalContent: undefined as string | undefined,
			saveDirectly: mockSaveDirectly,
			pushToolWriteResult: vi.fn().mockResolvedValue("Saved file"),
			reset: vi.fn().mockResolvedValue(undefined),
		}

		mockGetState = vi.fn().mockResolvedValue({
			diagnosticsEnabled: true,
			writeDelayMs: 1000,
			// Exercise the focus-disruption (saveDirectly) save path.
			experiments: { preventFocusDisruption: true },
		})

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

		tool = new ApplyDiffTool()
	})

	it("records a per-write checkpoint with the applied diff after a successful write", async () => {
		await tool.execute({ path: "src/thing.ts", diff: "unified diff" }, mockTask as Task, {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
		})

		expect(mockCheckpointSave).toHaveBeenCalledTimes(1)
		expect(mockCheckpointSave).toHaveBeenCalledWith(mockTask, false, true, {
			path: "src/thing.ts",
			operation: "update",
			diffStats: { additions: 1, deletions: 1 },
			diff: "mock-diff",
		})
	})

	it("marks auto-approved steps so the card renders compact", async () => {
		mockCheckAutoApproval.mockResolvedValueOnce({ decision: "approve" })

		await tool.execute({ path: "src/thing.ts", diff: "unified diff" }, mockTask as Task, {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
		})

		expect(mockCheckpointSave).toHaveBeenCalledTimes(1)
		expect(mockCheckpointSave.mock.calls[0]?.[3]).toEqual(expect.objectContaining({ autoApproved: true }))
	})

	it("skips the checkpoint when perWriteCheckpoints is explicitly disabled", async () => {
		mockGetState.mockResolvedValueOnce({
			diagnosticsEnabled: true,
			writeDelayMs: 1000,
			experiments: { preventFocusDisruption: true },
			perWriteCheckpoints: false,
		})

		await tool.execute({ path: "src/thing.ts", diff: "unified diff" }, mockTask as Task, {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
		})

		expect(mockCheckpointSave).not.toHaveBeenCalled()
		// The write itself still happens (the setting gates the checkpoint only),
		// and auto-approval is never consulted when there is no card to build.
		expect(mockSaveDirectly).toHaveBeenCalled()
		expect(mockCheckAutoApproval).not.toHaveBeenCalled()
	})

	it("records nothing when the approval is declined", async () => {
		mockAskApproval.mockResolvedValue(false)

		await tool.execute({ path: "src/thing.ts", diff: "unified diff" }, mockTask as Task, {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
		})

		expect(mockCheckpointSave).not.toHaveBeenCalled()
		expect(mockSaveDirectly).not.toHaveBeenCalled()
	})
})
