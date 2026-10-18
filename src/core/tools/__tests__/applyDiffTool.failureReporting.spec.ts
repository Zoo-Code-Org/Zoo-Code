import fs from "fs/promises"
import path from "path"

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

type FailPart = Extract<DiffResult, { success: false }>

describe("ApplyDiffTool failure reporting", () => {
	const testFilePath = "test/file.txt"

	let mockTask: Task
	let mockAskApproval: ReturnType<typeof vi.fn<ToolCallbacks["askApproval"]>>
	let mockHandleError: ReturnType<typeof vi.fn<ToolCallbacks["handleError"]>>
	let pushedResult: ToolResponse | undefined

	beforeEach(() => {
		vi.clearAllMocks()
		pushedResult = undefined
		vi.mocked(fileExistsAtPath).mockResolvedValue(true)
		vi.mocked(fs.readFile).mockResolvedValue("line one\nline two\nline three\n")

		mockAskApproval = vi.fn().mockResolvedValue(true)
		mockHandleError = vi.fn().mockResolvedValue(undefined)

		// Only the provider, edit tracking, and diff-view members used by execute are needed.
		mockTask = {
			cwd: "/workspace",
			consecutiveMistakeCount: 0,
			consecutiveMistakeCountForApplyDiff: new Map<string, number>(),
			didEditFile: false,
			api: { getModel: () => ({ id: "claude-test" }) },
			rooIgnoreController: { validateAccess: vi.fn().mockReturnValue(true) },
			rooProtectedController: { isWriteProtected: vi.fn().mockReturnValue(false) },
			providerRef: {
				deref: vi.fn().mockReturnValue({
					getState: vi.fn().mockResolvedValue({
						diagnosticsEnabled: true,
						writeDelayMs: 0,
						experiments: {},
					}),
				}),
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
			recordToolUsage: vi.fn(),
			processQueuedMessages: vi.fn(),
			sayAndCreateMissingParamError: vi.fn().mockResolvedValue("Missing param error"),
			diffStrategy: undefined,
		} as unknown as Task
	})

	function makeFailure(errorText: string | undefined, details?: FailPart["details"]): FailPart {
		return { success: false, error: errorText, details, failParts: [] }
	}

	function buildDiffContent(blockCount: number): string {
		const blocks: string[] = []
		for (let blockIndex = 0; blockIndex < blockCount; blockIndex++) {
			blocks.push(`<<<<<<< SEARCH\nsearch-${blockIndex}\n=======\nreplace-${blockIndex}\n>>>>>>> REPLACE`)
		}
		return blocks.join("\n")
	}

	async function runApplyDiff(diffResult: DiffResult, blockCount: number, diffOverride?: string): Promise<string> {
		mockTask.diffStrategy = {
			getName: () => "test",
			applyDiff: vi.fn().mockResolvedValue(diffResult),
			getProgressStatus: vi.fn().mockReturnValue({ icon: "diff-multiple", text: "x" }),
		}

		const diff = diffOverride ?? buildDiffContent(blockCount)
		await applyDiffTool.execute({ path: testFilePath, diff }, mockTask, {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			toolCallId: "tool-call-1",
			pushToolResult: vi.fn((result: ToolResponse) => {
				pushedResult = result
			}),
		})

		expect(mockHandleError).not.toHaveBeenCalled()
		return String(pushedResult ?? "")
	}

	function makeFailureSet(count: number): FailPart[] {
		const failures: FailPart[] = []
		for (let failureIndex = 1; failureIndex <= count; failureIndex++) {
			failures.push(makeFailure(`FAILURE-MARKER-${failureIndex}\nsecond line of failure ${failureIndex}`))
		}
		return failures
	}

	describe("failure accumulation and rendering", () => {
		it("reports every failed block, not just the last one", async () => {
			const output = await runApplyDiff({ success: false, failParts: makeFailureSet(2) }, 2)

			expect(output).toContain("FAILURE-MARKER-1")
			expect(output).toContain("FAILURE-MARKER-2")
			expect(output).toContain("--- Diff block 1 of 2 ---")
			expect(output).toContain("--- Diff block 2 of 2 ---")
		})

		it("names the target file before the multi-block failure details", async () => {
			const output = await runApplyDiff({ success: false, failParts: makeFailureSet(2) }, 2)

			const expectedPrefix = `Unable to apply diff to file: ${path.resolve("/workspace", testFilePath)}\n\n<error_details>\n`
			expect(output.startsWith(expectedPrefix)).toBe(true)
		})

		it("records every failure and shows the same details on the second consecutive error", async () => {
			const result: DiffResult = { success: false, failParts: makeFailureSet(2) }
			const firstOutput = await runApplyDiff(result, 2)
			expect(mockTask.say).not.toHaveBeenCalled()
			expect(mockTask.recordToolError).toHaveBeenLastCalledWith("apply_diff", firstOutput)

			const secondOutput = await runApplyDiff(result, 2)
			expect(mockTask.say).toHaveBeenCalledWith("diff_error", secondOutput)
			expect(secondOutput).toContain("FAILURE-MARKER-1")
			expect(secondOutput).toContain("FAILURE-MARKER-2")
		})

		it("renders exactly five failures in full detail with no abbreviation trailer", async () => {
			const output = await runApplyDiff({ success: false, failParts: makeFailureSet(5) }, 5)

			for (let failureIndex = 1; failureIndex <= 5; failureIndex++) {
				expect(output).toContain(`FAILURE-MARKER-${failureIndex}`)
				expect(output).toContain(`second line of failure ${failureIndex}`)
			}
			expect(output).not.toContain("are shown as a single summary line each")
		})

		it("abbreviates the sixth failure and emits a trailer naming the range", async () => {
			const output = await runApplyDiff({ success: false, failParts: makeFailureSet(6) }, 6)

			expect(output).toContain("FAILURE-MARKER-6")
			expect(output).not.toContain("second line of failure 6")
			expect(output).toContain("second line of failure 5")
			expect(output).toContain("(Failures 6-6 are shown as a single summary line each")
		})

		it("omits the diff block label when there is a single failure", async () => {
			const output = await runApplyDiff({ success: false, failParts: makeFailureSet(1) }, 1)

			expect(output).toContain("FAILURE-MARKER-1")
			expect(output).not.toContain("--- Diff block")
		})

		it("produces no stray separators for an empty failures array", async () => {
			const output = await runApplyDiff({ success: false, failParts: [], error: "nothing applied" }, 1)

			expect(output).not.toContain("--- Diff block")
			expect(output).not.toContain("are shown as a single summary line each")
		})

		it("substitutes a placeholder when a failure has no error text", async () => {
			const output = await runApplyDiff({ success: false, failParts: [makeFailure(undefined)] }, 1)

			expect(output).toContain("Unknown apply_diff failure")
		})

		it("appends Details for detailed failures and omits them for abbreviated ones", async () => {
			const failures = makeFailureSet(6)
			failures[0] = makeFailure("FAILURE-MARKER-1\nsecond line of failure 1", { bestMatch: "DETAIL-FIRST" })
			failures[5] = makeFailure("FAILURE-MARKER-6\nsecond line of failure 6", { bestMatch: "DETAIL-SIXTH" })

			const output = await runApplyDiff({ success: false, failParts: failures }, 6)

			expect(output).toContain("Details:")
			expect(output).toContain("DETAIL-FIRST")
			expect(output).not.toContain("DETAIL-SIXTH")
		})

		it("truncates a detailed failure that exceeds the character cap", async () => {
			const oversizedError = `FAILURE-MARKER-1\n${"x".repeat(6000)}`
			const output = await runApplyDiff({ success: false, failParts: [makeFailure(oversizedError)] }, 1)

			expect(output).toContain("characters omitted — retry this block alone for full detail")
			expect(output).not.toContain("x".repeat(5000))
		})

		it("leaves a detailed failure just under the character cap untruncated", async () => {
			const nearCapError = `FAILURE-MARKER-1\n${"x".repeat(3900)}`
			const output = await runApplyDiff({ success: false, failParts: [makeFailure(nearCapError)] }, 1)

			expect(output).not.toContain("[truncated")
			expect(output).toContain("x".repeat(3900))
		})

		it("truncates an abbreviated one-line summary that exceeds the summary cap", async () => {
			const failures = makeFailureSet(6)
			failures[5] = makeFailure(`FAILURE-MARKER-6 ${"y".repeat(500)}\nsecond line of failure 6`)

			const output = await runApplyDiff({ success: false, failParts: failures }, 6)

			expect(output).not.toContain("y".repeat(400))
			expect(output).toContain("characters omitted — retry this block alone for full detail")
		})

		it("emits a real trailer range when eight failures are reported", async () => {
			const output = await runApplyDiff({ success: false, failParts: makeFailureSet(8) }, 8)

			expect(output).toContain("(Failures 6-8 are shown as a single summary line each")
			expect(output).toContain("FAILURE-MARKER-8")
			expect(output).not.toContain("second line of failure 8")
		})

		it("prefixes multiple failures with a count summary that ignores successful parts", async () => {
			const mixedParts: DiffResult[] = [{ success: true, content: "applied" }, ...makeFailureSet(2)]
			const output = await runApplyDiff({ success: false, failParts: mixedParts }, 3)

			expect(output).toContain(
				"<error_details>\n2 diff blocks failed to apply. Fix the failures below before retrying.\n\n--- Diff block 1 of 2 ---\n",
			)
			expect(output).toContain("second line of failure 1\n\n--- Diff block 2 of 2 ---\nFAILURE-MARKER-2")
		})

		it("renders a single failure verbatim with no summary, label, details or trailer", async () => {
			const output = await runApplyDiff({ success: false, failParts: makeFailureSet(1) }, 1)

			expect(output).toContain("<error_details>\nFAILURE-MARKER-1\nsecond line of failure 1\n</error_details>")
		})

		it("separates the abbreviated trailer from the last summary and omits the remainder trailer", async () => {
			const output = await runApplyDiff({ success: false, failParts: makeFailureSet(6) }, 6)

			expect(output).toContain("FAILURE-MARKER-6\n\n(Failures 6-6 are shown")
			expect(output).not.toContain("more failures not shown")
		})

		it("does not truncate a detailed failure of exactly the character cap", async () => {
			const exactCapError = "z".repeat(4000)
			const output = await runApplyDiff({ success: false, failParts: [makeFailure(exactCapError)] }, 1)

			expect(output).not.toContain("[truncated")
			expect(output).toContain(`${exactCapError}\n</error_details>`)
		})

		it("reports the exact number of omitted characters when truncating", async () => {
			const oversizedError = `FAILURE-MARKER-1\n${"x".repeat(6000)}`
			const output = await runApplyDiff({ success: false, failParts: [makeFailure(oversizedError)] }, 1)

			expect(output).toContain(`[truncated; ${oversizedError.length - 4000} characters omitted`)
		})

		it("caps the number of abbreviated failures and reports the remainder as a count", async () => {
			const output = await runApplyDiff({ success: false, failParts: makeFailureSet(60) }, 60)

			expect(output).toContain("(Failures 6-50 are shown as a single summary line each")
			expect(output).toContain("(+10 more failures not shown")
			expect(output).not.toContain("FAILURE-MARKER-51")
		})
	})

	describe("file content exposure", () => {
		const SECRET = "SECRET_TOKEN=abc123"

		function makeContentFailure(index: number): FailPart {
			return makeFailure(
				`No sufficiently similar match found ${index}\n\nDebug Info:\n- Similarity Score: 10%` +
					`\n\nSearch Content:\nsearch-${index}\n\nBest Match Found:\n${SECRET}\n\nOriginal Content:\n${SECRET}`,
				{ similarity: 0.1 },
			)
		}

		it("keeps file content for only the first failed block on the failure path", async () => {
			const output = await runApplyDiff(
				{ success: false, failParts: [1, 2, 3].map((index) => makeContentFailure(index)) },
				3,
			)

			expect(output.split("Original Content:").length - 1).toBe(1)
			expect(output.split(SECRET).length - 1).toBe(2)
			expect(output.split("Details:").length - 1).toBe(1)
			expect(output).toContain("No sufficiently similar match found 2\n\nDebug Info:\n- Similarity Score: 10%")
			expect(output).toContain("No sufficiently similar match found 3\n\nDebug Info:\n- Similarity Score: 10%")
		})

		it("keeps the full content of a single failed block", async () => {
			const output = await runApplyDiff({ success: false, failParts: [makeContentFailure(1)] }, 1)

			expect(output).toContain(`Original Content:\n${SECRET}`)
		})

		it("cuts at the strategy heading even when the search text repeats it", async () => {
			const repeated = makeFailure(
				`Diagnostics kept\n\nSearch Content:\nx\n\nSearch Content:\ny\n\nOriginal Content:\n${SECRET}`,
			)
			const output = await runApplyDiff({ success: false, failParts: [makeContentFailure(1), repeated] }, 2)
			const secondSection = output.split("--- Diff block 2 of 2 ---\n")[1]

			expect(secondSection).toContain("Diagnostics kept")
			expect(secondSection).not.toContain("Search Content:")
			expect(secondSection).not.toContain(SECRET)
		})

		it("shows the same content-limited text in the diff_error message", async () => {
			const result: DiffResult = { success: false, failParts: [1, 2].map((index) => makeContentFailure(index)) }
			await runApplyDiff(result, 2)
			const secondOutput = await runApplyDiff(result, 2)

			expect(mockTask.say).toHaveBeenCalledWith("diff_error", secondOutput)
			expect(secondOutput.split(SECRET).length - 1).toBe(2)
		})

		it("excludes all file content from the partial-apply result", async () => {
			const output = await runApplyDiff(
				{ success: true, content: "x", blockCount: 3, failParts: [makeContentFailure(1)] },
				3,
			)

			expect(output).toContain("Applied 2 of 3 diff blocks")
			expect(output).toContain("No sufficiently similar match found 1\n\nDebug Info:\n- Similarity Score: 10%")
			expect(output).not.toContain("Search Content:")
			expect(output).not.toContain("Best Match Found:")
			expect(output).not.toContain("Original Content:")
			expect(output).not.toContain("Details:")
			expect(output).not.toContain(SECRET)
		})
	})

	describe("partial apply path", () => {
		function partialResult(failures: FailPart[]): DiffResult {
			return { success: true, content: "updated content", failParts: failures }
		}

		it("reports how many blocks applied and asks for only the failed blocks to be resent", async () => {
			const output = await runApplyDiff(partialResult(makeFailureSet(1)), 2)

			expect(output).toContain("Applied 1 of 2")
			expect(output).toContain("FAILURE-MARKER-1")
			expect(output).toContain("resend ONLY the failed blocks that are still needed")
		})

		it("does not tell the model to use read_file to re-apply the diffs", async () => {
			const output = await runApplyDiff(partialResult(makeFailureSet(1)), 2)

			expect(output).not.toContain("re-apply")
		})

		it.each(["\n", "\r\n"])(
			"counts only unescaped line-level SEARCH markers with %j endings",
			async (lineEnding) => {
				const diff = [
					"<<<<<<< SEARCH>  ",
					"\\<<<<<<< SEARCH",
					"inline <<<<<<< SEARCH",
					"<<<<<<< SEARCHING",
					"=======",
					"replacement",
					">>>>>>> REPLACE",
					buildDiffContent(1),
				]
					.join("\n")
					.replace(/\n/g, lineEnding)
				const output = await runApplyDiff(partialResult(makeFailureSet(1)), 2, diff)

				expect(output).toContain("Applied 1 of 2 diff blocks")
			},
		)

		it("prefers the parser-reported block count over the raw marker count", async () => {
			const output = await runApplyDiff(
				{ success: true, content: "updated content", failParts: makeFailureSet(1), blockCount: 2 },
				1,
				buildDiffContent(1),
			)

			expect(output).toContain("Applied 1 of 2 diff blocks")
			expect(output).toContain("The other 1 did NOT apply.")
		})

		it("states how many blocks did not apply", async () => {
			const output = await runApplyDiff(partialResult(makeFailureSet(2)), 3)

			expect(output).toContain(`Applied 1 of 3 diff blocks to ${path.resolve("/workspace", testFilePath)}. `)
			expect(output).toContain(
				"The other 2 did NOT apply. Inspect the saved file before retrying, since an earlier block may already contain the intended change. ",
			)
			expect(output).not.toContain("NOT in the file")
		})

		it("tolerates a successful result without failParts or SEARCH markers", async () => {
			const output = await runApplyDiff(
				{ success: true, content: "updated content" },
				0,
				"diff text without block markers",
			)

			expect(output).not.toContain("Applied")
			expect(output).not.toContain("Making multiple related changes")
			expect(output).toContain("Changes successfully applied.")
		})

		it("applies the abbreviation cap on the partial path as well", async () => {
			const output = await runApplyDiff(partialResult(makeFailureSet(6)), 8)

			expect(output).toContain("Applied 2 of 8")
			expect(output).toContain("(Failures 6-6 are shown as a single summary line each")
			expect(output).not.toContain("second line of failure 6")
		})

		it("emits no partial-apply hint when every block applies", async () => {
			const output = await runApplyDiff({ success: true, content: "updated content", failParts: [] }, 1)

			expect(output).not.toContain("Applied")
			expect(output).toContain("Changes successfully applied.")
			expect(output).toContain("Making multiple related changes in a single apply_diff is more efficient")
		})

		it("counts and renders only the unsuccessful entries in failParts", async () => {
			const mixedParts: DiffResult[] = [
				{ success: true, content: "first change" },
				makeFailure("FAILURE-MARKER-1\nsecond line of failure 1"),
				{ success: true, content: "third change" },
			]
			const output = await runApplyDiff({ success: true, content: "updated content", failParts: mixedParts }, 3)

			expect(output).toContain("Applied 2 of 3")
			expect(output).toContain("FAILURE-MARKER-1")
			expect(output).not.toContain("--- Diff block")
		})
	})
})
