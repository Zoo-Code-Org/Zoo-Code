import * as path from "path"

import type { MockedFunction } from "vitest"

import { fileExistsAtPath, createDirectoriesForFile } from "../../../utils/fs"
import { isPathOutsideWorkspace } from "../../../utils/pathUtils"
import { getReadablePath } from "../../../utils/path"
import { unescapeHtmlEntities } from "../../../utils/text-normalization"
import { everyLineHasLineNumbers, stripLineNumbers } from "../../../integrations/misc/extract-text"
import { ToolUse, ToolResponse, AskApproval, HandleError, PushToolResult } from "../../../shared/tools"
import { writeToFileTool } from "../WriteToFileTool"

vi.mock("path", async () => {
	const originalPath = await vi.importActual("path")
	return {
		...originalPath,
		resolve: vi.fn().mockImplementation((...args) => {
			// On Windows, use backslashes; on Unix, use forward slashes
			const separator = process.platform === "win32" ? "\\" : "/"
			return args.join(separator)
		}),
	}
})

vi.mock("delay", () => ({
	default: vi.fn(),
}))

vi.mock("../../../utils/fs", () => ({
	fileExistsAtPath: vi.fn().mockResolvedValue(false),
	createDirectoriesForFile: vi.fn().mockResolvedValue([]),
}))

vi.mock("../../prompts/responses", () => ({
	formatResponse: {
		toolError: vi.fn((msg) => `Error: ${msg}`),
		rooIgnoreError: vi.fn((path) => `Access denied: ${path}`),
		createPrettyPatch: vi.fn(() => "mock-diff"),
	},
}))

vi.mock("../../../utils/pathUtils", () => ({
	isPathOutsideWorkspace: vi.fn().mockReturnValue(false),
}))

vi.mock("../../../utils/path", () => ({
	getReadablePath: vi.fn().mockReturnValue("test/path.txt"),
}))

vi.mock("../../../utils/text-normalization", () => ({
	unescapeHtmlEntities: vi.fn().mockImplementation((content) => {
		return content
	}),
}))

vi.mock("../../../integrations/misc/extract-text", () => ({
	everyLineHasLineNumbers: vi.fn().mockReturnValue(false),
	stripLineNumbers: vi.fn().mockImplementation((content) => {
		return content
	}),
	addLineNumbers: vi.fn().mockImplementation((content: string) => {
		return content
			.split("\n")
			.map((line: string, i: number) => `${i + 1} | ${line}`)
			.join("\n")
	}),
}))

vi.mock("vscode", () => ({
	window: {
		showWarningMessage: vi.fn().mockResolvedValue(undefined),
	},
	env: {
		openExternal: vi.fn(),
	},
	Uri: {
		parse: vi.fn(),
	},
}))

vi.mock("../../ignore/RooIgnoreController", () => ({
	RooIgnoreController: class {
		initialize() {
			return Promise.resolve()
		}
		validateAccess() {
			return true
		}
	},
}))

describe("writeToFileTool", () => {
	// Test data
	const testFilePath = "test/file.txt"
	const absoluteFilePath = process.platform === "win32" ? "C:\\test\\file.txt" : "/test/file.txt"
	const testContent = "Line 1\nLine 2\nLine 3"
	const testContentWithMarkdown = "```javascript\nLine 1\nLine 2\n```"

	// Mocked functions with correct types
	const mockedFileExistsAtPath = fileExistsAtPath as MockedFunction<typeof fileExistsAtPath>
	const mockedCreateDirectoriesForFile = createDirectoriesForFile as MockedFunction<typeof createDirectoriesForFile>
	const mockedIsPathOutsideWorkspace = isPathOutsideWorkspace as MockedFunction<typeof isPathOutsideWorkspace>
	const mockedGetReadablePath = getReadablePath as MockedFunction<typeof getReadablePath>
	const mockedUnescapeHtmlEntities = unescapeHtmlEntities as MockedFunction<typeof unescapeHtmlEntities>
	const mockedEveryLineHasLineNumbers = everyLineHasLineNumbers as MockedFunction<typeof everyLineHasLineNumbers>
	const mockedStripLineNumbers = stripLineNumbers as MockedFunction<typeof stripLineNumbers>
	const mockedPathResolve = path.resolve as MockedFunction<typeof path.resolve>

	const mockCline: any = {}
	let mockAskApproval: ReturnType<typeof vi.fn<AskApproval>>
	let mockHandleError: ReturnType<typeof vi.fn<HandleError>>
	let mockPushToolResult: ReturnType<typeof vi.fn<PushToolResult>>
	let toolResult: ToolResponse | undefined

	beforeEach(() => {
		vi.clearAllMocks()
		writeToFileTool.resetPartialState()

		mockedPathResolve.mockReturnValue(absoluteFilePath)
		mockedFileExistsAtPath.mockResolvedValue(false)
		mockedIsPathOutsideWorkspace.mockReturnValue(false)
		mockedGetReadablePath.mockReturnValue("test/path.txt")
		mockedUnescapeHtmlEntities.mockImplementation((content) => {
			return content
		})
		mockedEveryLineHasLineNumbers.mockReturnValue(false)
		mockedStripLineNumbers.mockImplementation((content) => {
			return content
		})

		mockCline.cwd = "/"
		mockCline.consecutiveMistakeCount = 0
		mockCline.didEditFile = false
		mockCline.diffStrategy = undefined
		mockCline.providerRef = {
			deref: vi.fn().mockReturnValue({
				getState: vi.fn().mockResolvedValue({
					diagnosticsEnabled: true,
					writeDelayMs: 1000,
				}),
			}),
		}
		mockCline.rooIgnoreController = {
			validateAccess: vi.fn().mockReturnValue(true),
		}
		mockCline.diffViewProvider = {
			editType: undefined,
			isEditing: false,
			originalContent: "",
			open: vi.fn().mockResolvedValue(undefined),
			update: vi.fn().mockResolvedValue(undefined),
			reset: vi.fn().mockResolvedValue(undefined),
			revertChanges: vi.fn().mockResolvedValue(undefined),
			saveChanges: vi.fn().mockResolvedValue({
				newProblemsMessage: "",
				userEdits: null,
				finalContent: "final content",
			}),
			scrollToFirstDiff: vi.fn(),
			updateDiagnosticSettings: vi.fn(),
			pushToolWriteResult: vi.fn().mockImplementation(async function (
				this: any,
				task: any,
				cwd: string,
				isNewFile: boolean,
			) {
				// Simulate the behavior of pushToolWriteResult
				if (this.userEdits) {
					await task.say(
						"user_feedback_diff",
						JSON.stringify({
							tool: isNewFile ? "newFileCreated" : "editedExistingFile",
							path: "test/path.txt",
							diff: this.userEdits,
						}),
					)
				}
				return "Tool result message"
			}),
		}
		mockCline.api = {
			getModel: vi.fn().mockReturnValue({ id: "claude-3" }),
		}
		mockCline.fileContextTracker = {
			trackFileContext: vi.fn().mockResolvedValue(undefined),
		}
		mockCline.say = vi.fn().mockResolvedValue(undefined)
		mockCline.ask = vi.fn().mockResolvedValue(undefined)
		mockCline.finalizePartialToolAsk = vi.fn().mockResolvedValue(undefined)
		mockCline.recordToolError = vi.fn()
		mockCline.sayAndCreateMissingParamError = vi.fn().mockResolvedValue("Missing param error")

		mockAskApproval = vi.fn().mockResolvedValue(true)
		mockHandleError = vi.fn().mockResolvedValue(undefined)

		toolResult = undefined
	})

	/**
	 * Helper function to execute the write file tool with different parameters
	 */
	async function executeWriteFileTool(
		params: Partial<ToolUse["params"]> = {},
		options: {
			fileExists?: boolean
			isPartial?: boolean
			accessAllowed?: boolean
		} = {},
	): Promise<ToolResponse | undefined> {
		// Configure mocks based on test scenario
		const fileExists = options.fileExists ?? false
		const isPartial = options.isPartial ?? false
		const accessAllowed = options.accessAllowed ?? true

		mockedFileExistsAtPath.mockResolvedValue(fileExists)
		mockCline.rooIgnoreController.validateAccess.mockReturnValue(accessAllowed)

		// Create a tool use object
		const toolUse: ToolUse = {
			type: "tool_use",
			name: "write_to_file",
			params: {
				path: testFilePath,
				content: testContent,
				...params,
			},
			nativeArgs: {
				path: (params.path ?? testFilePath) as any,
				content: (params.content ?? testContent) as any,
			},
			partial: isPartial,
		}

		mockPushToolResult = vi.fn((result: ToolResponse) => {
			toolResult = result
		})

		await writeToFileTool.handle(mockCline, toolUse as ToolUse<"write_to_file">, {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
		})

		return toolResult
	}

	describe("access control", () => {
		it("validates and allows access when rooIgnoreController permits", async () => {
			await executeWriteFileTool({}, { accessAllowed: true })

			expect(mockCline.rooIgnoreController.validateAccess).toHaveBeenCalledWith(testFilePath)
			expect(mockCline.diffViewProvider.open).toHaveBeenCalledWith(testFilePath)
		})
	})

	describe("file existence detection", () => {
		it.skipIf(process.platform === "win32")("detects existing file and sets editType to modify", async () => {
			await executeWriteFileTool({}, { fileExists: true })

			expect(mockedFileExistsAtPath).toHaveBeenCalledWith(absoluteFilePath)
			expect(mockCline.diffViewProvider.editType).toBe("modify")
		})

		it.skipIf(process.platform === "win32")("detects new file and sets editType to create", async () => {
			await executeWriteFileTool({}, { fileExists: false })

			expect(mockedFileExistsAtPath).toHaveBeenCalledWith(absoluteFilePath)
			expect(mockCline.diffViewProvider.editType).toBe("create")
		})

		it("uses cached editType without filesystem check", async () => {
			mockCline.diffViewProvider.editType = "modify"

			await executeWriteFileTool({})

			expect(mockedFileExistsAtPath).not.toHaveBeenCalled()
		})
	})

	describe("directory creation for new files", () => {
		it.skipIf(process.platform === "win32")(
			"creates parent directories early when file does not exist (execute)",
			async () => {
				await executeWriteFileTool({}, { fileExists: false })

				expect(mockedCreateDirectoriesForFile).toHaveBeenCalledWith(absoluteFilePath)
			},
		)

		it.skipIf(process.platform === "win32")(
			"does not create directories in handlePartial -- only execute() creates them",
			async () => {
				// First call - path not yet stabilized, early return
				await executeWriteFileTool({}, { fileExists: false, isPartial: true })
				expect(mockedCreateDirectoriesForFile).not.toHaveBeenCalled()

				// Second call with same path - path stabilized, handlePartial runs but
				// must NOT call createDirectoriesForFile (directory creation belongs in execute)
				await executeWriteFileTool({}, { fileExists: false, isPartial: true })
				expect(mockedCreateDirectoriesForFile).not.toHaveBeenCalled()
			},
		)

		it("does not create directories when file exists", async () => {
			await executeWriteFileTool({}, { fileExists: true })

			expect(mockedCreateDirectoriesForFile).not.toHaveBeenCalled()
		})

		it("does not create directories when editType is cached as modify", async () => {
			mockCline.diffViewProvider.editType = "modify"

			await executeWriteFileTool({})

			expect(mockedCreateDirectoriesForFile).not.toHaveBeenCalled()
		})

		it.skipIf(process.platform === "win32")("creates directories when editType is cached as create", async () => {
			mockCline.diffViewProvider.editType = "create"

			await executeWriteFileTool({})

			expect(mockedCreateDirectoriesForFile).toHaveBeenCalledWith(absoluteFilePath)
		})
	})

	describe("content preprocessing", () => {
		it("removes markdown code block markers from content", async () => {
			await executeWriteFileTool({ content: testContentWithMarkdown })

			expect(mockCline.diffViewProvider.update).toHaveBeenCalledWith("Line 1\nLine 2", true)
		})

		it("passes through empty content unchanged", async () => {
			await executeWriteFileTool({ content: "" })

			expect(mockCline.diffViewProvider.update).toHaveBeenCalledWith("", true)
		})

		it("unescapes HTML entities for non-Claude models", async () => {
			mockCline.api.getModel.mockReturnValue({ id: "gpt-4" })

			await executeWriteFileTool({ content: "&lt;test&gt;" })

			expect(mockedUnescapeHtmlEntities).toHaveBeenCalledWith("&lt;test&gt;")
		})

		it("skips HTML unescaping for Claude models", async () => {
			mockCline.api.getModel.mockReturnValue({ id: "claude-3" })

			await executeWriteFileTool({ content: "&lt;test&gt;" })

			expect(mockedUnescapeHtmlEntities).not.toHaveBeenCalled()
		})

		it("strips line numbers from numbered content", async () => {
			const contentWithLineNumbers = "1 | line one\n2 | line two"
			mockedEveryLineHasLineNumbers.mockReturnValue(true)
			mockedStripLineNumbers.mockReturnValue("line one\nline two")

			await executeWriteFileTool({ content: contentWithLineNumbers })

			expect(mockedEveryLineHasLineNumbers).toHaveBeenCalledWith(contentWithLineNumbers)
			expect(mockedStripLineNumbers).toHaveBeenCalledWith(contentWithLineNumbers)
			expect(mockCline.diffViewProvider.update).toHaveBeenCalledWith("line one\nline two", true)
		})
	})

	describe("file operations", () => {
		it("successfully creates new files with full workflow", async () => {
			await executeWriteFileTool({}, { fileExists: false })

			expect(mockCline.consecutiveMistakeCount).toBe(0)
			expect(mockCline.diffViewProvider.open).toHaveBeenCalledWith(testFilePath)
			expect(mockCline.diffViewProvider.update).toHaveBeenCalledWith(testContent, true)
			expect(mockAskApproval).toHaveBeenCalled()
			expect(mockCline.diffViewProvider.saveChanges).toHaveBeenCalled()
			expect(mockCline.fileContextTracker.trackFileContext).toHaveBeenCalledWith(testFilePath, "roo_edited")
			expect(mockCline.didEditFile).toBe(true)
		})

		it("processes files outside workspace boundary", async () => {
			mockedIsPathOutsideWorkspace.mockReturnValue(true)

			await executeWriteFileTool({})

			expect(mockedIsPathOutsideWorkspace).toHaveBeenCalled()
		})

		it("processes files with large content", async () => {
			const largeContent = "Line\n".repeat(10000)
			await executeWriteFileTool({ content: largeContent })

			// Should process normally without issues
			expect(mockCline.consecutiveMistakeCount).toBe(0)
		})
	})

	describe("partial block handling", () => {
		it("returns early when path is missing in partial block", async () => {
			await executeWriteFileTool({ path: undefined }, { isPartial: true })

			expect(mockCline.diffViewProvider.open).not.toHaveBeenCalled()
		})

		it("returns early when content is undefined in partial block", async () => {
			await executeWriteFileTool({ content: undefined }, { isPartial: true })

			expect(mockCline.diffViewProvider.open).not.toHaveBeenCalled()
		})

		it("streams content updates during partial execution after path stabilizes", async () => {
			// First call - path not yet stabilized, early return (no file operations)
			await executeWriteFileTool({}, { isPartial: true })
			expect(mockCline.ask).not.toHaveBeenCalled()
			expect(mockCline.diffViewProvider.open).not.toHaveBeenCalled()

			// Second call with same path - path is now stabilized, file operations proceed
			await executeWriteFileTool({}, { isPartial: true })
			expect(mockCline.ask).toHaveBeenCalled()
			expect(mockCline.diffViewProvider.open).toHaveBeenCalledWith(testFilePath)
			expect(mockCline.diffViewProvider.update).toHaveBeenCalledWith(testContent, false)
		})
	})

	describe("user interaction", () => {
		it("reverts changes when user rejects approval", async () => {
			mockAskApproval.mockResolvedValue(false)

			await executeWriteFileTool({})

			expect(mockCline.diffViewProvider.revertChanges).toHaveBeenCalled()
			expect(mockCline.diffViewProvider.saveChanges).not.toHaveBeenCalled()
		})

		it("reports user edits with diff feedback", async () => {
			const userEditsValue = "- old line\n+ new line"
			mockCline.diffViewProvider.saveChanges.mockResolvedValue({
				newProblemsMessage: " with warnings",
				userEdits: userEditsValue,
				finalContent: "modified content",
			})
			// Set the userEdits property on the diffViewProvider mock to simulate user edits
			mockCline.diffViewProvider.userEdits = userEditsValue

			await executeWriteFileTool({}, { fileExists: true })

			expect(mockCline.say).toHaveBeenCalledWith(
				"user_feedback_diff",
				expect.stringContaining("editedExistingFile"),
			)
		})
	})

	describe("error handling", () => {
		it("handles general file operation errors", async () => {
			mockCline.diffViewProvider.open.mockRejectedValue(new Error("General error"))

			await executeWriteFileTool({})

			expect(mockHandleError).toHaveBeenCalledWith("writing file", expect.any(Error))
			expect(mockCline.diffViewProvider.reset).toHaveBeenCalled()
		})

		it("swallows partial streaming errors instead of surfacing a duplicate error bubble", async () => {
			// The same filesystem operation is retried in execute() once the block completes,
			// and that authoritative non-partial path reports the error to the user. Surfacing
			// it during streaming too would show the same error twice, so handlePartial must NOT
			// route streaming errors through handleError.
			mockCline.diffViewProvider.open.mockRejectedValue(new Error("Open failed"))

			// First call - path not yet stabilized, no error yet
			await executeWriteFileTool({}, { isPartial: true })
			expect(mockHandleError).not.toHaveBeenCalled()

			// Second call with same path - path is now stabilized, error occurs but is swallowed
			await executeWriteFileTool({}, { isPartial: true })
			expect(mockHandleError).not.toHaveBeenCalled()
		})

		it("finalizes partial tool message and resets diff view when handlePartial open() fails", async () => {
			// Regression test: when diffViewProvider.open() throws during streaming (e.g. EACCES/EROFS
			// on a read-only path), the partial tool ask created at the top of handlePartial leaves the
			// UI spinner stuck. handlePartial must finalize the partial message and reset the diff view,
			// and must NOT surface a duplicate error (execute() reports the authoritative one).
			mockCline.diffViewProvider.open.mockRejectedValue(
				Object.assign(new Error("EACCES: permission denied, open '/ro/test.py'"), { code: "EACCES" }),
			)

			// First call - path not yet stabilized
			await executeWriteFileTool({}, { isPartial: true })
			expect(mockCline.finalizePartialToolAsk).not.toHaveBeenCalled()

			// Second call - path stabilized, open() rejects
			await executeWriteFileTool({}, { isPartial: true })

			expect(mockCline.finalizePartialToolAsk).toHaveBeenCalled()
			expect(mockCline.diffViewProvider.reset).toHaveBeenCalled()
			expect(mockHandleError).not.toHaveBeenCalled()
		})

		it("finalizes partial tool message and resets diff view when handlePartial update() fails", async () => {
			// Same regression as above but for the streaming update() call failing after open() succeeds.
			mockCline.diffViewProvider.update.mockRejectedValue(
				Object.assign(new Error("EROFS: read-only file system, write '/ro/test.py'"), { code: "EROFS" }),
			)

			// First call - path not yet stabilized
			await executeWriteFileTool({}, { isPartial: true })

			// Second call - path stabilized, update() rejects
			await executeWriteFileTool({}, { isPartial: true })

			expect(mockCline.finalizePartialToolAsk).toHaveBeenCalled()
			expect(mockCline.diffViewProvider.reset).toHaveBeenCalled()
			expect(mockHandleError).not.toHaveBeenCalled()
		})

		it("does not spawn a new partial tool message on each streaming delta after a failure", async () => {
			// Regression test: after diffViewProvider.open() throws and the partial message is
			// finalized + diff view reset, the next streaming delta saw a non-partial last message
			// and created a brand new "Zoo wants to edit this file" message -- repeating once per
			// delta. After the fix, partialStreamFailed short-circuits subsequent deltas so only
			// the single initial partial ask is issued.
			mockCline.diffViewProvider.open.mockRejectedValue(
				Object.assign(new Error("EROFS: read-only file system, mkdir '/scratch'"), { code: "EROFS" }),
			)

			// Delta 1 - stabilize path (no ask yet)
			await executeWriteFileTool({}, { fileExists: false, isPartial: true })
			// Delta 2 - path stabilized, ask issued once, open() fails, stream marked failed
			await executeWriteFileTool({}, { fileExists: false, isPartial: true })
			// Deltas 3..5 - must be short-circuited, no further asks
			await executeWriteFileTool({}, { fileExists: false, isPartial: true })
			await executeWriteFileTool({}, { fileExists: false, isPartial: true })
			await executeWriteFileTool({}, { fileExists: false, isPartial: true })

			// Only the single partial ask from delta 2 should have been issued
			expect(mockCline.ask).toHaveBeenCalledTimes(1)
			// open() must not be retried after the first failure
			expect(mockCline.diffViewProvider.open).toHaveBeenCalledTimes(1)
		})

		it("reports a filesystem error only once across the streaming and execute phases", async () => {
			// Regression test for the double-error UX defect: a single write_to_file call to a
			// read-only path failed twice -- once in handlePartial ("handling partial write_to_file")
			// and once in execute() ("writing file"). handlePartial now swallows its error so only
			// the authoritative execute() error is surfaced.
			const erofs = () =>
				Object.assign(new Error("EROFS: read-only file system, mkdir '/scratch'"), { code: "EROFS" })
			mockCline.diffViewProvider.open.mockRejectedValue(erofs())
			mockedCreateDirectoriesForFile.mockRejectedValue(erofs())

			// Streaming phase: stabilize path then fail (swallowed, no handleError)
			await executeWriteFileTool({}, { fileExists: false, isPartial: true })
			await executeWriteFileTool({}, { fileExists: false, isPartial: true })

			// Final phase: execute() reports the single authoritative error
			await executeWriteFileTool({}, { fileExists: false })

			expect(mockHandleError).toHaveBeenCalledTimes(1)
			expect(mockHandleError).toHaveBeenCalledWith("writing file", expect.any(Error))
		})

		it.skipIf(process.platform === "win32")(
			"EROFS in handlePartial does not stall agent loop -- createDirectoriesForFile is not called",
			async () => {
				// Regression test: before the fix, createDirectoriesForFile was called in handlePartial
				// with no .catch() guard. An EROFS throw escaped to BaseTool.handle(), which called
				// handleError but did not set didRejectTool/didAlreadyUseTool, so the advancement gate
				// in presentAssistantMessage was never reached and the agent loop stalled permanently.
				// After the fix the call is removed entirely -- handlePartial never touches the filesystem.
				mockedCreateDirectoriesForFile.mockRejectedValue(
					Object.assign(new Error("EROFS: read-only file system, mkdir '/scratch'"), { code: "EROFS" }),
				)

				// First call -- path not yet stabilized, returns early
				await executeWriteFileTool({}, { fileExists: false, isPartial: true })
				expect(mockHandleError).not.toHaveBeenCalled()

				// Second call -- path stabilized; createDirectoriesForFile must NOT be called from
				// handlePartial, so the mock rejection must not trigger and handleError must not be called
				await executeWriteFileTool({}, { fileExists: false, isPartial: true })
				expect(mockedCreateDirectoriesForFile).not.toHaveBeenCalled()
				expect(mockHandleError).not.toHaveBeenCalled()
			},
		)

		it.skipIf(process.platform === "win32")(
			"EROFS in execute() routes through handleError with cleanup rather than escaping unhandled",
			async () => {
				// Regression test: before the fix, createDirectoriesForFile in execute() sat outside
				// the try block (lines 70-74), so an EROFS error escaped the catch at line 188 entirely.
				// After the fix the call is inside the try block, so filesystem errors are caught and
				// routed through handleError with proper diffViewProvider.reset() cleanup.
				mockedCreateDirectoriesForFile.mockRejectedValue(
					Object.assign(new Error("EROFS: read-only file system, mkdir '/scratch'"), { code: "EROFS" }),
				)

				await executeWriteFileTool({}, { fileExists: false })

				expect(mockHandleError).toHaveBeenCalledWith("writing file", expect.any(Error))
				expect(mockCline.diffViewProvider.reset).toHaveBeenCalled()
				// The tool must not have proceeded to open or save
				expect(mockCline.diffViewProvider.open).not.toHaveBeenCalled()
				expect(mockCline.diffViewProvider.saveChanges).not.toHaveBeenCalled()
			},
		)

		it.skipIf(process.platform === "win32")(
			"finalizes partial tool message on error so the UI spinner does not get stuck",
			async () => {
				// Regression test: when a filesystem error is thrown in execute() the webview
				// message created during handlePartial (or the early ask in execute) is stuck in
				// partial: true state, showing an indefinite spinner alongside the error bubble.
				// The catch block must call finalizePartialToolAsk() to close the spinner without
				// blocking for user input.
				mockedCreateDirectoriesForFile.mockRejectedValue(
					Object.assign(new Error("EACCES: permission denied, mkdir '/ro'"), { code: "EACCES" }),
				)

				await executeWriteFileTool({}, { fileExists: false })

				// handleError must still be called
				expect(mockHandleError).toHaveBeenCalledWith("writing file", expect.any(Error))

				// finalizePartialToolAsk must have been called to dismiss the spinner
				expect(mockCline.finalizePartialToolAsk).toHaveBeenCalled()
			},
		)
	})
})
