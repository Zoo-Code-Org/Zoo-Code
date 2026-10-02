// npx vitest run core/tools/__tests__/editSearchReplaceTool.changeCard.spec.ts

import type { MockedFunction } from "vitest"

import { fileExistsAtPath } from "../../../utils/fs"
import { checkAutoApproval } from "../../auto-approval"
import { checkpointSave } from "../../checkpoints"
import type { Task } from "../../task/Task"
import { EditTool } from "../EditTool"
import type { ToolCallbacks } from "../BaseTool"
import { SearchReplaceTool } from "../SearchReplaceTool"

/**
 * The shared surface of the two string-replacement edit tools: both execute a
 * single `old_string` -> `new_string` replacement and report through the same
 * ToolCallbacks, which is all the change-card tests exercise.
 */
interface EditLikeTool {
	execute(
		params: { file_path: string; old_string: string; new_string: string },
		task: Task,
		callbacks: ToolCallbacks,
	): Promise<void>
}

vi.mock("fs/promises", () => ({
	default: {
		// Contains exactly one occurrence of the old_string below.
		readFile: vi.fn().mockResolvedValue("old line\n"),
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

interface Stubs {
	mockTask: Pick<
		Task,
		| "cwd"
		| "consecutiveMistakeCount"
		| "recordToolError"
		| "rooIgnoreController"
		| "rooProtectedController"
		| "processQueuedMessages"
		| "didEditFile"
		| "diffViewProvider"
		| "providerRef"
		| "fileContextTracker"
	>
	mockSaveDirectly: MockedFunction<(...args: unknown[]) => Promise<unknown>>
	mockGetState: MockedFunction<() => Promise<Record<string, unknown>>>
}

/**
 * Structural stubs for the prevent-focus-disruption save path: the real
 * DiffViewProvider is out of scope here, so vi.fn() doubles stand in for the
 * members the edit tools touch.
 */
function buildStubs(): Stubs {
	const mockSaveDirectly = vi.fn().mockResolvedValue({
		newProblemsMessage: "",
		userEdits: undefined,
		finalContent: "new line\n",
	})
	const diffViewProviderStub = {
		editType: undefined as "create" | "modify" | undefined,
		originalContent: undefined as string | undefined,
		open: vi.fn().mockResolvedValue(undefined),
		update: vi.fn().mockResolvedValue(undefined),
		scrollToFirstDiff: vi.fn(),
		saveDirectly: mockSaveDirectly,
		saveChanges: vi.fn().mockResolvedValue({
			newProblemsMessage: "",
			userEdits: undefined,
			finalContent: "new line\n",
		}),
		revertChanges: vi.fn().mockResolvedValue(undefined),
		pushToolWriteResult: vi.fn().mockResolvedValue("Saved file"),
		reset: vi.fn().mockResolvedValue(undefined),
	}
	const mockGetState = vi.fn().mockResolvedValue({
		diagnosticsEnabled: true,
		writeDelayMs: 1000,
		// Exercise the focus-disruption (saveDirectly) save path.
		experiments: { preventFocusDisruption: true },
	})
	const mockTask: Stubs["mockTask"] = {
		cwd: "/workspace/project",
		consecutiveMistakeCount: 0,
		recordToolError: vi.fn(),
		rooIgnoreController: {
			validateAccess: vi.fn().mockReturnValue(true),
		} as unknown as Task["rooIgnoreController"],
		rooProtectedController: {
			isWriteProtected: vi.fn().mockReturnValue(false),
		} as unknown as Task["rooProtectedController"],
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
	return { mockTask, mockSaveDirectly, mockGetState }
}

function cardTests(getTool: () => EditLikeTool) {
	const mockedFileExistsAtPath = fileExistsAtPath as MockedFunction<typeof fileExistsAtPath>
	const mockCheckpointSave = checkpointSave as MockedFunction<typeof checkpointSave>
	const mockCheckAutoApproval = checkAutoApproval as MockedFunction<typeof checkAutoApproval>

	let tool: EditLikeTool
	let stubs: Stubs
	let mockAskApproval: MockedFunction<(...args: unknown[]) => Promise<boolean>>
	let mockHandleError: MockedFunction<(...args: unknown[]) => Promise<void>>
	let mockPushToolResult: MockedFunction<(...args: unknown[]) => void>

	beforeEach(() => {
		vi.clearAllMocks()
		mockedFileExistsAtPath.mockResolvedValue(true)
		stubs = buildStubs()
		tool = getTool()
		mockAskApproval = vi.fn().mockResolvedValue(true)
		mockHandleError = vi.fn().mockResolvedValue(undefined)
		mockPushToolResult = vi.fn()
	})

	it("records a per-write checkpoint with the approval diff after a successful write", async () => {
		await tool.execute(
			{ file_path: "src/thing.ts", old_string: "old line", new_string: "new line" },
			stubs.mockTask as Task,
			{
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
			},
		)

		expect(mockCheckpointSave).toHaveBeenCalledTimes(1)
		expect(mockCheckpointSave).toHaveBeenCalledWith(stubs.mockTask, false, true, {
			path: "src/thing.ts",
			operation: "update",
			diffStats: { additions: 1, deletions: 1 },
			diff: "mock-diff",
		})
	})

	it("marks auto-approved steps so the card renders compact", async () => {
		mockCheckAutoApproval.mockResolvedValueOnce({ decision: "approve" })

		await tool.execute(
			{ file_path: "src/thing.ts", old_string: "old line", new_string: "new line" },
			stubs.mockTask as Task,
			{
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
			},
		)

		expect(mockCheckpointSave).toHaveBeenCalledTimes(1)
		expect(mockCheckpointSave.mock.calls[0]?.[3]).toEqual(expect.objectContaining({ autoApproved: true }))
	})

	it("skips the checkpoint when perWriteCheckpoints is explicitly disabled", async () => {
		stubs.mockGetState.mockResolvedValueOnce({
			diagnosticsEnabled: true,
			writeDelayMs: 1000,
			experiments: { preventFocusDisruption: true },
			perWriteCheckpoints: false,
		})

		await tool.execute(
			{ file_path: "src/thing.ts", old_string: "old line", new_string: "new line" },
			stubs.mockTask as Task,
			{
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
			},
		)

		expect(mockCheckpointSave).not.toHaveBeenCalled()
		// The write itself still happens (the setting gates the checkpoint only),
		// and auto-approval is never consulted when there is no card to build.
		expect(stubs.mockSaveDirectly).toHaveBeenCalled()
		expect(mockCheckAutoApproval).not.toHaveBeenCalled()
	})

	it("records nothing when the approval is declined", async () => {
		mockAskApproval.mockResolvedValue(false)

		await tool.execute(
			{ file_path: "src/thing.ts", old_string: "old line", new_string: "new line" },
			stubs.mockTask as Task,
			{
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
			},
		)

		expect(mockCheckpointSave).not.toHaveBeenCalled()
		expect(stubs.mockSaveDirectly).not.toHaveBeenCalled()
	})
}

describe("EditTool.execute - per-write checkpoint and change card (B3a, epic #1375)", () => {
	cardTests(() => new EditTool())
})

describe("SearchReplaceTool.execute - per-write checkpoint and change card (B3a, epic #1375)", () => {
	cardTests(() => new SearchReplaceTool())
})
