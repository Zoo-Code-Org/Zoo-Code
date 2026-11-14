import fs from "fs/promises"
import path from "path"

import type { DiffResult, ToolResponse } from "../../../shared/tools"
import type { Task } from "../../task/Task"
import { fileExistsAtPath } from "../../../utils/fs"
import { MultiSearchReplaceDiffStrategy } from "../../diff/strategies/multi-search-replace"
import type { ToolCallbacks } from "../BaseTool"
import { applyDiffTool } from "../ApplyDiffTool"

vi.mock("@roo-code/telemetry", () => ({
	TelemetryService: { instance: { captureDiffApplicationError: vi.fn() } },
}))

vi.mock("fs/promises", () => ({
	default: {
		readFile: vi.fn().mockResolvedValue(Buffer.alloc(0)),
	},
}))

// ApplyDiffTool reads the file with no encoding, so the call the double stands in for is the
// byte-returning one: fs.readFile returns Buffer unless an encoding is passed. vi.mocked resolves
// the encoding overload, so the mock is typed against the signature the tool actually calls.
// readFile returns string or Buffer across its overloads; the tool calls the byte overload and the
// double answers both, so the double is typed against the union rather than against one overload.
const mockedReadFile = vi.mocked(fs.readFile as (path: string) => Promise<string | Buffer>)

vi.mock("../../../utils/fs", () => ({
	fileExistsAtPath: vi.fn().mockResolvedValue(true),
}))

vi.mock("../../../utils/path", () => ({
	getReadablePath: vi.fn().mockReturnValue("test/file.txt"),
}))

vi.mock("../../../utils/pathUtils", () => ({
	isPathOutsideWorkspace: vi.fn().mockReturnValue(false),
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
		mockedReadFile.mockResolvedValue(Buffer.from("line one\nline two\nline three\n", "utf8"))

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

	describe("bytes the decoder cannot read", () => {
		async function runOnBytes(bytes: string | Buffer): Promise<{ output: string; appliedTo: unknown }> {
			mockedReadFile.mockResolvedValue(bytes)
			const applyDiff = vi.fn().mockResolvedValue({ success: true, content: "unused" })
			mockTask.diffStrategy = { getName: () => "test", applyDiff }
			await applyDiffTool.execute({ path: testFilePath, diff: buildDiffContent(1) }, mockTask, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				toolCallId: "tool-call-1",
				pushToolResult: vi.fn((result: ToolResponse) => {
					pushedResult = result
				}),
			})
			return {
				output: String(pushedResult ?? ""),
				appliedTo: applyDiff.mock.calls[0] ? applyDiff.mock.calls[0][0] : undefined,
			}
		}

		// A byte the UTF-8 decoder rejects sits at index 3; everything around it is plain ASCII, so the
		// offset the tool reports has to be that index and nothing else.
		const UNDECODABLE = Buffer.from([0x68, 0x69, 0x20, 0xff, 0x61, 0x0a])

		it("refuses the edit and names the file and the first undecodable byte", async () => {
			const { output } = await runOnBytes(UNDECODABLE)

			expect(output).toContain("is not valid UTF-8")
			expect(output).toContain("first undecodable byte at offset 3).")
			expect(mockTask.say).toHaveBeenCalledWith("error", output)
			expect(mockTask.recordToolError).toHaveBeenCalledWith("apply_diff")
			expect(mockTask.consecutiveMistakeCount).toBe(1)
			expect(mockTask.didToolFailInCurrentTurn).toBe(true)
		})

		it("refuses before the diff is computed, approved, or written", async () => {
			await runOnBytes(UNDECODABLE)

			expect(mockedReadFile).toHaveBeenCalledWith(path.resolve("/workspace", testFilePath))
			expect(mockAskApproval).not.toHaveBeenCalled()
			expect(mockTask.diffViewProvider.open).not.toHaveBeenCalled()
			expect(mockTask.diffViewProvider.saveChanges).not.toHaveBeenCalled()
			expect(mockTask.diffViewProvider.saveDirectly).not.toHaveBeenCalled()
			expect(mockTask.didEditFile).toBe(false)
		})

		it("still edits a file whose bytes are valid multi-byte UTF-8", async () => {
			const { output } = await runOnBytes(Buffer.from("héllo 中文 ✅\n", "utf8"))

			expect(output).not.toContain("is not valid UTF-8")
			expect(output).toContain("Changes successfully applied.")
			expect(mockTask.consecutiveMistakeCount).toBe(0)
			expect(mockTask.diffViewProvider.saveChanges).toHaveBeenCalled()
		})

		// The tolerance above is not free: it means a caller that pre-decoded the file keeps the lossy
		// behaviour. It exists because CI runs main's applyDiffTool.outsideWorkspace.spec.ts against this
		// file (the merge ref of 1910 onto main failed 9 of its rows under the strict read), and that spec
		// is main's, so this branch cannot edit it. This row is the pin: it says which side gives way.
		it("edits a file a caller already decoded, which is what the encoding overload hands back", async () => {
			const { output } = await runOnBytes("line one\nline two\nline three\n")

			expect(output).toContain("Changes successfully applied.")
			expect(mockTask.consecutiveMistakeCount).toBe(0)
			expect(mockTask.diffViewProvider.saveChanges).toHaveBeenCalled()
		})

		it("reports the first undecodable byte when invalid bytes repeat", async () => {
			const { output } = await runOnBytes(Buffer.from([0x41, 0xc3, 0x28, 0x42, 0xfe, 0x43, 0xff]))

			expect(output).toContain("first undecodable byte at offset 1).")
			expect(output).not.toContain("offset 4")
		})

		// A byte-order mark is three bytes that decode to one character, and a U+FFFD written in the file is
		// indistinguishable in the decoded output from a replacement the decoder produced. Both make a
		// count through the decoded string report the wrong byte, so the offsets below are asserted
		// against the byte positions a hex dump shows, not against anything derived from the string.
		it("counts a byte-order mark as the three bytes it is", async () => {
			const { output } = await runOnBytes(Buffer.from([0xef, 0xbb, 0xbf, 0x41, 0xff]))

			expect(output).toContain("first undecodable byte at offset 4).")
			expect(output).not.toContain("offset 1")
		})

		it("does not mistake a literal replacement character for an undecodable byte", async () => {
			const { output } = await runOnBytes(Buffer.from([0xef, 0xbf, 0xbd, 0x41, 0xff]))

			expect(output).toContain("first undecodable byte at offset 4).")
			expect(output).not.toContain("offset 0")
		})

		it("counts past a byte-order mark and a literal replacement character together", async () => {
			const { output } = await runOnBytes(Buffer.from([0xef, 0xbb, 0xbf, 0xef, 0xbf, 0xbd, 0xff]))

			expect(output).toContain("first undecodable byte at offset 6).")
		})

		// The BOM survives into the text the diff is applied to and the approval baseline is built from,
		// which is what fs.readFile with a utf-8 encoding used to hand over: the decoded string plus the
		// BOM character, and re-encoding it reproduces the file's bytes exactly.
		it("keeps a byte-order mark in the content the diff and the approval are built from", async () => {
			const bomFile = Buffer.from("\uFEFFhi\r\nthere\r\n", "utf8")
			const { output, appliedTo } = await runOnBytes(bomFile)

			expect(output).toContain("Changes successfully applied.")
			expect(typeof appliedTo).toBe("string")
			expect(String(appliedTo).startsWith("\uFEFF")).toBe(true)
			expect(Buffer.from(String(appliedTo), "utf8").equals(bomFile)).toBe(true)
		})
		// The row above shows a BOM or a file-written U+FFFD shifting a later failure; these two put a
		// truncated sequence next to a literal U+FFFD in both orders, and every offset below is asserted
		// against the position a hex dump shows. The closing `).` is included because a substring check on
		// "offset 1" is also satisfied by "offset 10", which would let a wrong offset pass.
		it("reports the truncated sequence itself when a literal replacement character follows it", async () => {
			const { output } = await runOnBytes(Buffer.from([0xe2, 0x82, 0xef, 0xbf, 0xbd]))

			expect(output).toContain("first undecodable byte at offset 0).")
		})

		it("counts past a literal replacement character into a truncated sequence", async () => {
			const { output } = await runOnBytes(Buffer.from([0x61, 0xef, 0xbf, 0xbd, 0xe2, 0x82]))

			expect(output).toContain("first undecodable byte at offset 4).")
			expect(output).not.toContain("first undecodable byte at offset 3).")
		})
	})

	describe("failure accumulation and rendering", () => {
		it("reports every failed block, not just the last one", async () => {
			const output = await runApplyDiff({ success: false, failParts: makeFailureSet(2) }, 2)

			expect(output).toContain("FAILURE-MARKER-1")
			expect(output).toContain("FAILURE-MARKER-2")
			expect(output).toContain("--- Failure 1 of 2 ---")
			expect(output).toContain("--- Failure 2 of 2 ---")
			expect(output).not.toContain("Diff block")
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

		it("never renders the details object of any failure", async () => {
			const failures = makeFailureSet(6)
			failures[0] = makeFailure("FAILURE-MARKER-1\nsecond line of failure 1", { bestMatch: "DETAIL-FIRST" })
			failures[5] = makeFailure("FAILURE-MARKER-6\nsecond line of failure 6", { bestMatch: "DETAIL-SIXTH" })

			const output = await runApplyDiff({ success: false, failParts: failures }, 6)

			expect(output).not.toContain("Details:")
			expect(output).not.toContain("DETAIL-FIRST")
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
				"<error_details>\n2 diff blocks failed to apply. Fix the failures below before retrying.\n\n--- Failure 1 of 2 ---\n",
			)
			expect(output).toContain("second line of failure 1\n\n--- Failure 2 of 2 ---\nFAILURE-MARKER-2")
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

	describe("file content exposure (real strategy)", () => {
		const FILE_SECRETS = ["FILE-SECRET-ORIGINAL", "FILE-SECRET-BESTMATCH"]
		const SEARCH_SECRET = "SEARCH-SECRET"
		const DETAIL_SECRET = "DETAIL-SECRET"
		const fileText = [
			"const header = 1",
			`token = "${FILE_SECRETS[0]}"`,
			`apiKey = "${FILE_SECRETS[1]}"`,
			"const footer = 2",
		].join("\n")

		function failingBlock(index: number): string {
			return `<<<<<<< SEARCH\n:start_line:2\n-------\napiKey = "${SEARCH_SECRET}-${index}"\n=======\nx${index}\n>>>>>>> REPLACE`
		}

		const applyingBlock = "<<<<<<< SEARCH\nconst header = 1\n=======\nconst header = 3\n>>>>>>> REPLACE"

		async function runRealStrategy(diff: string): Promise<string> {
			mockedReadFile.mockResolvedValue(Buffer.from(fileText, "utf8"))
			const strategy = new MultiSearchReplaceDiffStrategy()
			const realResult = await strategy.applyDiff(fileText, diff)
			// Synthetic details exercise the tool's own guard against forwarding strategy detail objects.
			const withDetails = (part: DiffResult): DiffResult =>
				part.success ? part : { ...part, details: { searchContent: DETAIL_SECRET, bestMatch: DETAIL_SECRET } }
			const result: DiffResult = realResult.success
				? { ...realResult, failParts: realResult.failParts?.map(withDetails) }
				: {
						...realResult,
						failParts: realResult.failParts?.map(withDetails) ?? [],
						details: { bestMatch: DETAIL_SECRET },
					}
			return runApplyDiff(result, 0, diff)
		}

		function collectUiAndModelOutputs(output: string): string {
			const sayText = vi.mocked(mockTask.say).mock.calls.map((call) => String(call[1] ?? ""))
			const recordedErrors = vi.mocked(mockTask.recordToolError).mock.calls.map((call) => String(call[1] ?? ""))
			return [output, ...sayText, ...recordedErrors].join("\n")
		}

		function expectNoSecrets(text: string): void {
			for (const secret of [...FILE_SECRETS, SEARCH_SECRET, DETAIL_SECRET]) {
				expect(text).not.toContain(secret)
			}
			expect(text).not.toMatch(/Search Content:|Best Match Found:|Original Content:|Details:/)
		}

		it("excludes file, search and detail text from a single failure in model and UI output", async () => {
			await runRealStrategy(failingBlock(1))
			const output = await runRealStrategy(failingBlock(1))

			expect(output).toContain("No sufficiently similar match found at line: 2")
			expect(output).toContain("- Similarity Score:")
			expect(mockTask.say).toHaveBeenCalledWith("diff_error", output)
			expectNoSecrets(collectUiAndModelOutputs(output))
		})

		it("excludes sensitive text from every block when multiple blocks fail", async () => {
			const diff = [1, 2, 3].map(failingBlock).join("\n")
			await runRealStrategy(diff)
			const output = await runRealStrategy(diff)

			expect(output).toContain("3 diff blocks failed to apply")
			expect(output).toContain("--- Failure 3 of 3 ---")
			expectNoSecrets(collectUiAndModelOutputs(output))
		})

		it("excludes sensitive text from the partial-apply result", async () => {
			const output = await runRealStrategy(`${applyingBlock}\n${failingBlock(1)}`)

			expect(output).toContain("Applied 1 of 2 diff blocks")
			expect(output).toContain("No sufficiently similar match found")
			expectNoSecrets(collectUiAndModelOutputs(output))
			// The approval payload intentionally echoes the model's own diff, so only detail text is checked.
			for (const call of vi.mocked(mockAskApproval).mock.calls) {
				expect(String(call[1])).not.toContain(DETAIL_SECRET)
			}
		})

		it("drops top-level details on the fallback path without failParts", async () => {
			const output = await runApplyDiff(
				{ success: false, error: "Invalid diff format", details: { bestMatch: DETAIL_SECRET } },
				1,
			)

			expect(output).toContain("Invalid diff format")
			expectNoSecrets(collectUiAndModelOutputs(output))
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

		it.each([
			{ name: "every block fails", failures: 2, blockCount: 2 },
			{ name: "failures outnumber parsed blocks", failures: 3, blockCount: 2 },
		])("reports zero applied blocks when $name", async ({ failures, blockCount }) => {
			const output = await runApplyDiff(
				{ success: true, content: "updated content", failParts: makeFailureSet(failures), blockCount },
				blockCount,
			)

			expect(output).toContain(`Applied 0 of ${blockCount} diff blocks`)
			expect(output).toContain(`The other ${failures} did NOT apply.`)
			expect(output).not.toMatch(/Applied -\d/)
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

	// The guard below decides, from the bytes, whether a replacement character already in the file is
	// stepped over or reported as the failure position: it steps over only when the three bytes at the
	// current offset really are the encoded form of U+FFFD. Each byte sequence below was run through
	// the tool and the offset it prints is asserted here. The offsets each case must not print are the
	// offsets a mutant that stops stepping over, or steps by the wrong width, prints instead, so the
	// bytes and the printed offset are the anchors and no report line number is relied on. The mutant
	// each case kills is named above it. The 0x41 and 0x3f cases are the shape where the replacement
	// character is not at the start of the file, so the reported offset is one.
	describe("the guard that steps past an encoded replacement character", () => {
		async function runBytesFor(bytes: Buffer): Promise<string> {
			mockedReadFile.mockResolvedValue(bytes)
			const applyDiff = vi.fn().mockResolvedValue({ success: true, content: "unused" })
			mockTask.diffStrategy = { getName: () => "test", applyDiff }
			await applyDiffTool.execute({ path: testFilePath, diff: buildDiffContent(1) }, mockTask, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				toolCallId: "tool-call-1",
				pushToolResult: vi.fn((result: ToolResponse) => {
					pushedResult = result
				}),
			})
			return String(pushedResult ?? "")
		}

		// kills first comparison outer_or_and, first comparison inner_or_and, second comparison clauseB_false
		it("reports offset 0 for the bytes 0xef 0xef 0xbd", async () => {
			const output = await runBytesFor(Buffer.from([0xef, 0xef, 0xbd]))

			expect(output).toContain("is not valid UTF-8")
			expect(output).toContain("first undecodable byte at offset 0).")
			expect(output).not.toContain("offset 3)")
		})

		// kills first comparison outer_or_and, third comparison clauseC_false
		it("reports offset 0 for the bytes 0xef 0xbf 0xef", async () => {
			const output = await runBytesFor(Buffer.from([0xef, 0xbf, 0xef]))

			expect(output).toContain("is not valid UTF-8")
			expect(output).toContain("first undecodable byte at offset 0).")
			expect(output).not.toContain("offset 3)")
		})

		// kills first comparison outer_or_and, third comparison clauseC_false
		it("reports offset 0 for the bytes 0xef 0xbf 0xff", async () => {
			const output = await runBytesFor(Buffer.from([0xef, 0xbf, 0xff]))

			expect(output).toContain("is not valid UTF-8")
			expect(output).toContain("first undecodable byte at offset 0).")
			expect(output).not.toContain("offset 3)")
		})

		// kills first comparison outer_or_and, third comparison clauseC_false
		it("reports offset 0 for the bytes 0xef 0xbf 0x41", async () => {
			const output = await runBytesFor(Buffer.from([0xef, 0xbf, 0x41]))

			expect(output).toContain("is not valid UTF-8")
			expect(output).toContain("first undecodable byte at offset 0).")
			expect(output).not.toContain("offset 4)")
		})

		// kills first comparison outer_or_and, third comparison clauseC_false
		it("reports offset 0 for the bytes 0xef 0xbf 0x3f", async () => {
			const output = await runBytesFor(Buffer.from([0xef, 0xbf, 0x3f]))

			expect(output).toContain("is not valid UTF-8")
			expect(output).toContain("first undecodable byte at offset 0).")
			expect(output).not.toContain("offset 4)")
		})

		// kills first comparison outer_or_and, first comparison inner_or_and, second comparison clauseB_false
		it("reports offset 0 for the bytes 0xef 0xff 0xbd", async () => {
			const output = await runBytesFor(Buffer.from([0xef, 0xff, 0xbd]))

			expect(output).toContain("is not valid UTF-8")
			expect(output).toContain("first undecodable byte at offset 0).")
			expect(output).not.toContain("offset 3)")
		})

		// kills first comparison outer_or_and, first comparison inner_or_and, second comparison clauseB_false
		it("reports offset 0 for the bytes 0xef 0x41 0xbd", async () => {
			const output = await runBytesFor(Buffer.from([0xef, 0x41, 0xbd]))

			expect(output).toContain("is not valid UTF-8")
			expect(output).toContain("first undecodable byte at offset 0).")
			expect(output).not.toContain("offset 4)")
		})

		// kills first comparison outer_or_and, first comparison inner_or_and, second comparison clauseB_false
		it("reports offset 0 for the bytes 0xef 0x3f 0xbd", async () => {
			const output = await runBytesFor(Buffer.from([0xef, 0x3f, 0xbd]))

			expect(output).toContain("is not valid UTF-8")
			expect(output).toContain("first undecodable byte at offset 0).")
			expect(output).not.toContain("offset 4)")
		})

		// kills first comparison outer_or_and, third comparison clauseC_false
		it("reports offset 1 for the bytes 0x41 0xef 0xbf", async () => {
			const output = await runBytesFor(Buffer.from([0x41, 0xef, 0xbf]))

			expect(output).toContain("is not valid UTF-8")
			expect(output).toContain("first undecodable byte at offset 1).")
			expect(output).not.toContain("offset 4)")
		})

		// kills first comparison outer_or_and, third comparison clauseC_false
		it("reports offset 1 for the bytes 0x3f 0xef 0xbf", async () => {
			const output = await runBytesFor(Buffer.from([0x3f, 0xef, 0xbf]))

			expect(output).toContain("is not valid UTF-8")
			expect(output).toContain("first undecodable byte at offset 1).")
			expect(output).not.toContain("offset 4)")
		})

		// kills first comparison inner_or_and, first comparison clauseA_false
		it("reports offset 0 for the bytes 0xbf 0xbf 0xbd", async () => {
			const output = await runBytesFor(Buffer.from([0xbf, 0xbf, 0xbd]))

			expect(output).toContain("is not valid UTF-8")
			expect(output).toContain("first undecodable byte at offset 0).")
			expect(output).not.toContain("offset 3)")
		})

		// kills first comparison inner_or_and, first comparison clauseA_false
		it("reports offset 0 for the bytes 0xbd 0xbf 0xbd", async () => {
			const output = await runBytesFor(Buffer.from([0xbd, 0xbf, 0xbd]))

			expect(output).toContain("is not valid UTF-8")
			expect(output).toContain("first undecodable byte at offset 0).")
			expect(output).not.toContain("offset 3)")
		})

		// kills first comparison inner_or_and, first comparison clauseA_false
		it("reports offset 0 for the bytes 0xff 0xbf 0xbd", async () => {
			const output = await runBytesFor(Buffer.from([0xff, 0xbf, 0xbd]))

			expect(output).toContain("is not valid UTF-8")
			expect(output).toContain("first undecodable byte at offset 0).")
			expect(output).not.toContain("offset 3)")
		})
	})
})
