import fs from "fs/promises"

import type { DiffResult, ToolResponse } from "../../../shared/tools"
import type { Task } from "../../task/Task"
import { fileExistsAtPath } from "../../../utils/fs"
import type { ToolCallbacks } from "../BaseTool"
import { applyDiffTool } from "../ApplyDiffTool"

vi.mock("@roo-code/telemetry", () => ({
	TelemetryService: { instance: { captureDiffApplicationError: vi.fn() } },
}))

vi.mock("fs/promises", () => ({
	default: {
		readFile: vi.fn().mockResolvedValue(""),
	},
}))

vi.mock("../../../utils/fs", () => ({
	fileExistsAtPath: vi.fn().mockResolvedValue(true),
}))

vi.mock("../../../utils/path", () => ({
	getReadablePath: vi.fn().mockReturnValue("test/file.txt"),
}))

vi.mock("../../prompts/responses", () => ({
	formatResponse: {
		toolError: vi.fn((message: string) => `Error: ${message}`),
		rooIgnoreError: vi.fn((filePath: string) => `Access denied: ${filePath}`),
		createPrettyPatch: vi.fn(() => "mock-diff"),
	},
}))

vi.mock("../../diff/stats", () => ({
	sanitizeUnifiedDiff: vi.fn((diff: string) => diff),
	computeDiffStats: vi.fn(() => ({ additions: 1, deletions: 1 })),
}))

vi.mock("vscode", () => ({
	window: { showWarningMessage: vi.fn() },
	env: { openExternal: vi.fn() },
	Uri: { parse: vi.fn() },
}))

describe("ApplyDiffTool focus-disruption routing (L2)", () => {
	const testFilePath = "test/file.txt"
	const diffContent = "<<<<<<< SEARCH\nline one\n=======\nline one edited\n>>>>>>> REPLACE"

	let mockTask: Task
	let mockAskApproval: ReturnType<typeof vi.fn<ToolCallbacks["askApproval"]>>
	let mockHandleError: ReturnType<typeof vi.fn<ToolCallbacks["handleError"]>>
	let pushedResult: ToolResponse | undefined
	let approved: boolean

	beforeEach(() => {
		vi.clearAllMocks()
		pushedResult = undefined
		approved = true
		vi.mocked(fileExistsAtPath).mockResolvedValue(true)
		vi.mocked(fs.readFile).mockResolvedValue("line one\nline two\nline three\n")

		mockAskApproval = vi.fn().mockImplementation(async () => approved)
		mockHandleError = vi.fn().mockResolvedValue(undefined)

		mockTask = {
			cwd: "/workspace",
			api: { getModel: () => ({ id: "claude-test" }) },
			consecutiveMistakeCount: 0,
			consecutiveMistakeCountForApplyDiff: new Map<string, number>(),
			didEditFile: false,
			rooIgnoreController: { validateAccess: vi.fn().mockReturnValue(true) },
			rooProtectedController: { isWriteProtected: vi.fn().mockReturnValue(false) },
			providerRef: { deref: vi.fn().mockReturnValue({ getState: vi.fn().mockResolvedValue({}) }) },
			diffViewProvider: {
				editType: undefined,
				originalContent: "",
				open: vi.fn().mockResolvedValue(undefined),
				update: vi.fn().mockResolvedValue(undefined),
				reset: vi.fn().mockResolvedValue(undefined),
				revertChanges: vi.fn().mockResolvedValue(undefined),
				saveChanges: vi.fn().mockResolvedValue(undefined),
				saveDirectly: vi.fn().mockResolvedValue(undefined),
				scrollToFirstDiff: vi.fn(),
				pushToolWriteResult: vi.fn().mockResolvedValue("Changes successfully applied."),
			},
			fileContextTracker: { trackFileContext: vi.fn().mockResolvedValue(undefined) },
			say: vi.fn().mockResolvedValue(undefined),
			recordToolError: vi.fn(),
			sayAndCreateMissingParamError: vi.fn().mockResolvedValue("Missing param error"),
			processQueuedMessages: vi.fn(),
			diffStrategy: {
				getName: () => "test",
				applyDiff: vi.fn().mockResolvedValue({ success: true, content: "updated content" } as DiffResult),
			},
		} as unknown as Task
	})

	function setExperiments(experiments: Record<string, boolean>) {
		mockTask.providerRef.deref = vi.fn().mockReturnValue({
			getState: vi.fn().mockResolvedValue({ experiments }),
		}) as unknown as Task["providerRef"]["deref"]
	}

	async function runApplyDiff() {
		await applyDiffTool.execute({ path: testFilePath, diff: diffContent }, mockTask, {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			toolCallId: "tool-call-1",
			pushToolResult: vi.fn((result: ToolResponse) => {
				pushedResult = result
			}),
		})
		expect(mockHandleError).not.toHaveBeenCalled()
	}

	it("uses the direct chat-diff save when no experiment value is stored", async () => {
		setExperiments({})

		await runApplyDiff()

		expect(mockTask.diffViewProvider.saveDirectly).toHaveBeenCalledWith(
			testFilePath,
			"updated content",
			false,
			true,
			0,
		)
		expect(mockTask.diffViewProvider.open).not.toHaveBeenCalled()
		expect(mockTask.diffViewProvider.saveChanges).not.toHaveBeenCalled()
		expect(mockTask.didEditFile).toBe(true)
		expect(String(pushedResult)).toContain("Changes successfully applied.")
	})

	it("uses the diff-editor path when the user opted out", async () => {
		setExperiments({ preventFocusDisruption: false })

		await runApplyDiff()

		expect(mockTask.diffViewProvider.open).toHaveBeenCalledWith(testFilePath)
		expect(mockTask.diffViewProvider.update).toHaveBeenCalledWith("updated content", true)
		expect(mockTask.diffViewProvider.saveChanges).toHaveBeenCalled()
		expect(mockTask.diffViewProvider.saveDirectly).not.toHaveBeenCalled()
	})

	it("does not save when the direct chat-diff approval is rejected", async () => {
		approved = false
		setExperiments({})

		await runApplyDiff()

		expect(mockAskApproval).toHaveBeenCalled()
		expect(mockTask.diffViewProvider.saveDirectly).not.toHaveBeenCalled()
		expect(mockTask.diffViewProvider.open).not.toHaveBeenCalled()
		expect(mockTask.diffViewProvider.saveChanges).not.toHaveBeenCalled()
		expect(pushedResult).toBeUndefined()
	})

	it("reverts the diff editor and does not save when the opt-out approval is rejected", async () => {
		approved = false
		setExperiments({ preventFocusDisruption: false })

		await runApplyDiff()

		expect(mockTask.diffViewProvider.revertChanges).toHaveBeenCalled()
		expect(mockTask.diffViewProvider.saveChanges).not.toHaveBeenCalled()
		expect(mockTask.diffViewProvider.saveDirectly).not.toHaveBeenCalled()
	})
})
