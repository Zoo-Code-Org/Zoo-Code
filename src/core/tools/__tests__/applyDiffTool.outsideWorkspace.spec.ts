// npx vitest run core/tools/__tests__/applyDiffTool.outsideWorkspace.spec.ts

import fs from "fs/promises"
import path from "path"

import type { ClineSayTool } from "@roo-code/types"

import type { ToolUse } from "../../../shared/tools"
import { isPathOutsideWorkspace } from "../../../utils/pathUtils"
import { checkAutoApproval } from "../../auto-approval"
import { baseState } from "../../auto-approval/__tests__/fixtures"
import type { Task } from "../../task/Task"
import type { ToolCallbacks } from "../BaseTool"
import { applyDiffTool } from "../ApplyDiffTool"

vi.mock("@roo-code/telemetry", () => ({
	TelemetryService: { instance: { captureDiffApplicationError: vi.fn() } },
}))

vi.mock("fs/promises", () => ({
	default: {
		readFile: vi.fn(),
	},
}))

vi.mock("../../../utils/fs", () => ({
	fileExistsAtPath: vi.fn().mockResolvedValue(true),
}))

vi.mock("../../../utils/path", () => ({
	getReadablePath: vi.fn((_cwd: string, relPath?: string) => relPath ?? ""),
}))

vi.mock("../../../utils/pathUtils", () => ({
	isPathOutsideWorkspace: vi.fn(),
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

const CWD = "/workspace"
const INSIDE_PATH = "src/index.ts"
const OUTSIDE_PATH = "/home/me/.zshrc"
const DIFF = "<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE"

const cases = [
	{ name: "a file outside the workspace", relPath: OUTSIDE_PATH, isOutside: true },
	{ name: "a file inside the workspace", relPath: INSIDE_PATH, isOutside: false },
]

const approvalPaths = [
	{ name: "diff view", preventFocusDisruption: false },
	{ name: "preventFocusDisruption", preventFocusDisruption: true },
]

describe("ApplyDiffTool isOutsideWorkspace", () => {
	let askApproval: ReturnType<typeof vi.fn<ToolCallbacks["askApproval"]>>

	function createTask(preventFocusDisruption = false): Task {
		const task = {
			cwd: CWD,
			consecutiveMistakeCount: 0,
			consecutiveMistakeCountForApplyDiff: new Map<string, number>(),
			didEditFile: false,
			api: { getModel: () => ({ id: "claude-test" }) },
			rooIgnoreController: { validateAccess: vi.fn().mockReturnValue(true) },
			rooProtectedController: { isWriteProtected: vi.fn().mockReturnValue(false) },
			providerRef: {
				deref: vi.fn().mockReturnValue({
					getState: vi.fn().mockResolvedValue({
						diagnosticsEnabled: false,
						writeDelayMs: 0,
						experiments: { preventFocusDisruption },
					}),
				}),
			},
			diffStrategy: {
				getName: () => "test",
				applyDiff: vi.fn().mockResolvedValue({ success: true, content: "new\n" }),
			},
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
			ask: vi.fn().mockResolvedValue(undefined),
			recordToolError: vi.fn(),
			processQueuedMessages: vi.fn(),
			sayAndCreateMissingParamError: vi.fn().mockResolvedValue("Missing param error"),
		}
		// The double provides only the Task members that ApplyDiffTool.execute and handlePartial read.
		return task as unknown as Task
	}

	async function runExecute(relPath: string, isOutside: boolean, preventFocusDisruption = false): Promise<string> {
		vi.mocked(isPathOutsideWorkspace).mockReturnValue(isOutside)

		await applyDiffTool.execute({ path: relPath, diff: DIFF }, createTask(preventFocusDisruption), {
			askApproval,
			handleError: vi.fn().mockResolvedValue(undefined),
			pushToolResult: vi.fn(),
			toolCallId: "tool-call-1",
		})

		expect(askApproval).toHaveBeenCalledTimes(1)
		return String(askApproval.mock.calls[0][1])
	}

	beforeEach(() => {
		vi.clearAllMocks()
		applyDiffTool.resetPartialState()
		vi.mocked(fs.readFile).mockResolvedValue("old\n")
		askApproval = vi.fn<ToolCallbacks["askApproval"]>().mockResolvedValue(true)
	})

	describe.each(approvalPaths)("approval payload ($name)", ({ preventFocusDisruption }) => {
		it.each(cases)("reports isOutsideWorkspace for $name", async ({ relPath, isOutside }) => {
			const payload = JSON.parse(await runExecute(relPath, isOutside, preventFocusDisruption)) as ClineSayTool

			expect(isPathOutsideWorkspace).toHaveBeenCalledWith(path.resolve(CWD, relPath))
			expect(payload.tool).toBe("appliedDiff")
			expect(payload.isOutsideWorkspace).toBe(isOutside)
		})
	})

	it.each(cases)("reports isOutsideWorkspace in the partial preview for $name", async ({ relPath, isOutside }) => {
		vi.mocked(isPathOutsideWorkspace).mockReturnValue(isOutside)
		const task = createTask()
		const block: ToolUse<"apply_diff"> = {
			type: "tool_use",
			name: "apply_diff",
			params: { path: relPath, diff: DIFF },
			partial: true,
		}

		// The first call records the path; the second call sees it stable and asks.
		await applyDiffTool.handlePartial(task, block)
		await applyDiffTool.handlePartial(task, block)

		expect(task.ask).toHaveBeenCalledTimes(1)
		const payload = JSON.parse(String(vi.mocked(task.ask).mock.calls[0][1])) as ClineSayTool
		expect(isPathOutsideWorkspace).toHaveBeenCalledWith(path.resolve(CWD, relPath))
		expect(payload.isOutsideWorkspace).toBe(isOutside)
	})

	describe("auto-approval decision with alwaysAllowWrite on", () => {
		it.each([
			{ ...cases[0], allowOutside: false, expected: "ask" },
			{ ...cases[0], allowOutside: true, expected: "approve" },
			{ ...cases[1], allowOutside: false, expected: "approve" },
		])(
			"returns $expected for $name when alwaysAllowWriteOutsideWorkspace is $allowOutside",
			async ({ relPath, isOutside, allowOutside, expected }) => {
				const text = await runExecute(relPath, isOutside)

				const result = await checkAutoApproval({
					state: {
						...baseState,
						alwaysAllowWrite: true,
						alwaysAllowWriteOutsideWorkspace: allowOutside,
					},
					cwd: CWD,
					ask: "tool",
					text,
				})

				expect(result).toEqual({ decision: expected })
			},
		)
	})
})
