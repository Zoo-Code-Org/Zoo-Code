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
		// ApplyDiffTool stats around its read so the guarded publish is authorised against the
		// version the diff was computed from; one shared stats object means the file did not change
		// underneath the read. Same fixture shape as applyDiffTool.failureReporting.spec.ts.
		// Merging main changed this row rather than dropping it: main's fixture rejected ENOENT to
		// describe a tree where ApplyDiffTool made no stat call at all, and the merged tree's code -
		// this unit's, at ApplyDiffTool.ts:88 and :90 - does stat around the read, so the double has
		// to resolve for the read-time version token to exist. No main-side assertion in this file
		// depended on the rejection: its rows assert only isPathOutsideWorkspace.
		stat: vi.fn().mockResolvedValue({ dev: 1n, ino: 2n, size: 4n, mtimeNs: 100n, ctimeNs: 100n }),
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
	workspace: {
		get workspaceFolders() {
			return [{ uri: { fsPath: path.resolve(CWD) } }]
		},
	},
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

	function createTask(preventFocusDisruption = false, relPath: string = INSIDE_PATH): Task {
		// The diff-view double mirrors the one behaviour execute now depends on: open() re-reads the
		// file and records that text as the save baseline, which is what the stale-base guard in
		// ApplyDiffTool compares. Reading through the same fs mock the tool reads through keeps the
		// fixture's base consistent; a double that leaves originalContent at "" reports a stale base
		// that never happened. Stale-base itself is covered by applyDiffTool.guardedWrite.spec.ts,
		// which overrides open() with a different content.
		const diffViewProviderStub = {
			editType: undefined as "create" | "modify" | undefined,
			originalContent: "" as string | undefined,
			open: vi.fn(async () => {
				diffViewProviderStub.originalContent = String(await vi.mocked(fs.readFile)(relPath as never))
			}),
			update: vi.fn().mockResolvedValue(undefined),
			reset: vi.fn().mockResolvedValue(undefined),
			revertChanges: vi.fn().mockResolvedValue(undefined),
			saveChanges: vi.fn().mockResolvedValue(undefined),
			saveDirectly: vi.fn().mockResolvedValue(undefined),
			scrollToFirstDiff: vi.fn(),
			pushToolWriteResult: vi.fn().mockResolvedValue("Changes successfully applied."),
		}
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
			diffViewProvider: diffViewProviderStub,
			// execute records the read-time version token here on the preventFocusDisruption save path.
			// Merging main kept this branch's stub rather than main's inline double. Both emulate the
			// real open() re-read that records the save baseline, and both land on "old\n" because the
			// fs mock resolves that text, so main's fail-closed assertion survives; the stub is kept
			// because its re-read goes through the same fs double the tool reads through, which is what
			// keeps a stale base from being reported that never happened. The observe field stays on
			// this double because the merged product code calls task.observationRegistry.observe here.
			observationRegistry: { observe: vi.fn() },
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

		await applyDiffTool.execute({ path: relPath, diff: DIFF }, createTask(preventFocusDisruption, relPath), {
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
		vi.mocked(isPathOutsideWorkspace).mockReset()
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

	describe("with the real workspace check", () => {
		it.each([
			{
				name: "a ../ path that resolves outside",
				relPath: "../outside/config.json",
				isOutside: true,
				expected: "ask",
			},
			{ name: "a path inside", relPath: "src/index.ts", isOutside: false, expected: "approve" },
		])("marks $name the workspace and returns $expected", async ({ relPath, isOutside, expected }) => {
			const actual = await vi.importActual<typeof import("../../../utils/pathUtils")>("../../../utils/pathUtils")
			vi.mocked(isPathOutsideWorkspace).mockImplementation(actual.isPathOutsideWorkspace)

			await applyDiffTool.execute({ path: relPath, diff: DIFF }, createTask(), {
				askApproval,
				handleError: vi.fn().mockResolvedValue(undefined),
				pushToolResult: vi.fn(),
				toolCallId: "tool-call-1",
			})

			const text = String(askApproval.mock.calls[0][1])
			const payload = JSON.parse(text) as ClineSayTool
			expect(payload.isOutsideWorkspace).toBe(isOutside)

			const result = await checkAutoApproval({
				state: { ...baseState, alwaysAllowWrite: true },
				cwd: CWD,
				ask: "tool",
				text,
			})
			expect(result).toEqual({ decision: expected })
		})
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
