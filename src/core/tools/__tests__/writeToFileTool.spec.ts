import * as path from "path"

import { RooCodeEventName } from "@roo-code/types"
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

	// The exact payload handlePartial() streams as the partial `tool` ask for the default
	// test scenario (new file, readable path, in-workspace, not write-protected).
	// finalizePartialToolAsk() no-ops on a text mismatch, so finalize assertions must
	// match this exactly: a weaker matcher (e.g. expect.any(String), which a relPath also
	// satisfies) would pass a mutant that passes the wrong text and leaves the spinner stuck.
	const expectedPartialToolMessage = JSON.stringify({
		tool: "newFileCreated",
		path: "test/path.txt",
		content: testContent,
		isOutsideWorkspace: false,
		isProtected: false,
	})

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
		// vi.clearAllMocks() keeps the last mock implementation; reset the factory default here
		// so no test depends on declaration order or an earlier test's rejection.
		mockedCreateDirectoriesForFile.mockResolvedValue([])
		mockedIsPathOutsideWorkspace.mockReturnValue(false)
		mockedGetReadablePath.mockReturnValue("test/path.txt")
		mockedUnescapeHtmlEntities.mockImplementation((content) => {
			return content
		})
		mockedEveryLineHasLineNumbers.mockReturnValue(false)
		mockedStripLineNumbers.mockImplementation((content) => {
			return content
		})

		mockCline.taskId = "task-1"
		mockCline.instanceId = "instance-1"
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
		adoptCreatedDirs: vi.fn(),
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
		mockCline.once = vi.fn()
		mockCline.off = vi.fn()
		mockCline.finalizePartialToolAsk = vi.fn().mockResolvedValue(undefined)
		mockCline.recordToolError = vi.fn()
		mockCline.sayAndCreateMissingParamError = vi.fn().mockResolvedValue("Missing param error")
		mockCline.processQueuedMessages = vi.fn()

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
			"defers parent directory creation to execute() while streaming",
			async () => {
				// Streaming deltas must not touch the filesystem at all. An unguarded
				// createDirectoriesForFile here threw EROFS up into BaseTool.handle(), which never
				// set didRejectTool/didAlreadyUseTool, so the agent loop stalled permanently.
				// The directories are still created - by the authoritative non-partial execute().
				await executeWriteFileTool({}, { fileExists: false, isPartial: true })
				await executeWriteFileTool({}, { fileExists: false, isPartial: true })
				expect(mockedCreateDirectoriesForFile).not.toHaveBeenCalled()

				await executeWriteFileTool({}, { fileExists: false })
				expect(mockedCreateDirectoriesForFile).toHaveBeenCalledWith(absoluteFilePath)
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
		it("does not share path stabilization between tasks with the same path", async () => {
			await executeWriteFileTool({}, { fileExists: false, isPartial: true })
			expect(mockCline.ask).not.toHaveBeenCalled()

			mockCline.taskId = "task-2"
			mockCline.instanceId = "instance-2"
			await executeWriteFileTool({}, { fileExists: false, isPartial: true })
			expect(mockCline.ask).not.toHaveBeenCalled()

			mockCline.taskId = "task-1"
			mockCline.instanceId = "instance-1"
			await executeWriteFileTool({}, { fileExists: false, isPartial: true })
			expect(mockCline.ask).toHaveBeenCalledTimes(1)

			mockCline.taskId = "task-2"
			mockCline.instanceId = "instance-2"
			await executeWriteFileTool({}, { fileExists: false, isPartial: true })
			expect(mockCline.ask).toHaveBeenCalledTimes(2)
		})

		it("cleans per-task partial state when the task aborts before execute finalization", async () => {
			let abortCleanup: (() => void) | undefined
			mockCline.once.mockImplementation((event: RooCodeEventName, listener: () => void) => {
				if (event === RooCodeEventName.TaskAborted) {
					abortCleanup = listener
				}
				return mockCline
			})

			await executeWriteFileTool({}, { fileExists: false, isPartial: true })
			await executeWriteFileTool({}, { fileExists: false, isPartial: true })
			expect(mockCline.ask).toHaveBeenCalledTimes(1)
			expect(mockCline.once).toHaveBeenCalledWith(RooCodeEventName.TaskAborted, expect.any(Function))

			abortCleanup?.()
			expect(mockCline.off).toHaveBeenCalledWith(RooCodeEventName.TaskAborted, abortCleanup)

			await executeWriteFileTool({}, { fileExists: false, isPartial: true })
			expect(mockCline.ask).toHaveBeenCalledTimes(1)

			await executeWriteFileTool({}, { fileExists: false, isPartial: true })
			expect(mockCline.ask).toHaveBeenCalledTimes(2)
		})

		it("does not treat a changed path between deltas as stabilized", async () => {
			// Delta 1 streams "alpha.txt"; delta 2 streams "beta.txt" for the same task. The path changed
			// between deltas, so it must not count as stabilized and no partial `tool` ask may be issued for
			// the still-changing second path.
			await executeWriteFileTool({ path: "alpha.txt" }, { isPartial: true })
			await executeWriteFileTool({ path: "beta.txt" }, { isPartial: true })

			expect(mockCline.ask).not.toHaveBeenCalled()
			expect(mockCline.diffViewProvider.open).not.toHaveBeenCalled()
		})

		it("does not issue a partial ask when content is undefined after path stabilization", async () => {
			// Delta 1 stabilizes the path. Delta 2 repeats it but carries no content yet: the
			// `newContent === undefined` clause must short-circuit the ask even though the path itself has
			// stabilized.
			await executeWriteFileTool({}, { isPartial: true })
			await executeWriteFileTool({ content: undefined }, { isPartial: true })

			expect(mockCline.ask).not.toHaveBeenCalled()
			expect(mockCline.diffViewProvider.update).not.toHaveBeenCalled()
		})

		it("does not reopen an already open diff view during streaming", async () => {
			// The diff view is already open for this task (isEditing). A stabilized delta must still update
			// the streamed content but must not call open() again -- reopening would discard the view's
			// current state.
			mockCline.diffViewProvider.isEditing = true

			await executeWriteFileTool({}, { isPartial: true })
			await executeWriteFileTool({}, { isPartial: true })

			expect(mockCline.ask).toHaveBeenCalledTimes(1)
			expect(mockCline.diffViewProvider.open).not.toHaveBeenCalled()
			expect(mockCline.diffViewProvider.update).toHaveBeenCalledWith(testContent, false)
		})

		it("logs the streaming diff view failure with the write_to_file context", async () => {
			// The catch arm logs a context-specific message before swallowing the error (execute() reports
			// the authoritative one). The message must keep the write_to_file context so the log is
			// actionable.
			mockCline.diffViewProvider.open.mockRejectedValue(new Error("EACCES: permission denied"))
			const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
			try {
				await executeWriteFileTool({}, { isPartial: true })
				await executeWriteFileTool({}, { isPartial: true })

				expect(consoleErrorSpy).toHaveBeenCalledWith(
					"Error streaming write_to_file diff view:",
					expect.anything(),
				)
			} finally {
				consoleErrorSpy.mockRestore()
			}
		})

		it("reports the captured streaming error instead of the parse error when the final block fails to parse, and clears the per-task state", async () => {
			// A streaming delta fails with a filesystem error (streamFailed + streamError are
			// captured). The final block then arrives without nativeArgs, so execute() never
			// runs: the parse-failure teardown boundary must report the original filesystem
			// error under the "writing file" context (not the incidental parse error) and tear
			// down the per-task state, so the next write_to_file stream in this task is not
			// blocked by the stale streamFailed guard and no abort listener leaks.
			const fsError = new Error("EACCES: permission denied")
			mockCline.diffViewProvider.open.mockRejectedValue(fsError)
			// Capture the abort listener of the state created by the first deltas: it is the
			// exact reference that the parse-failure teardown must detach.
			let abortListener: (() => void) | undefined
			mockCline.once.mockImplementation((event: RooCodeEventName, listener: () => void) => {
				if (event === RooCodeEventName.TaskAborted && abortListener === undefined) {
					abortListener = listener
				}
				return mockCline
			})
			const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
			try {
				await executeWriteFileTool({}, { isPartial: true })
				await executeWriteFileTool({}, { isPartial: true })

				const toolUse: ToolUse = {
					type: "tool_use",
					name: "write_to_file",
					params: { path: testFilePath, content: testContent },
					nativeArgs: undefined,
					partial: false,
				}
				await writeToFileTool.handle(mockCline, toolUse as ToolUse<"write_to_file">, {
					askApproval: mockAskApproval,
					handleError: mockHandleError,
					pushToolResult: vi.fn(),
				})

				expect(mockHandleError).toHaveBeenCalledTimes(1)
				expect(mockHandleError).toHaveBeenCalledWith("writing file", fsError)
				expect(mockHandleError).not.toHaveBeenCalledWith(
					expect.stringContaining("parsing write_to_file"),
					expect.anything(),
				)
				// The parse-failure teardown also restores the diff document: the
				// streaming failure above already reverted it once (revert + reset),
				// and the parse path runs the same cleanup again because execute()
				// never runs on this path.
				expect(mockCline.diffViewProvider.revertChanges).toHaveBeenCalledTimes(2)
				expect(mockCline.diffViewProvider.reset).toHaveBeenCalledTimes(2)
				// Per-task state torn down at this boundary: guard cleared, the exact
				// registered abort listener detached.
				expect(writeToFileTool["taskPartialStreamState"].size).toBe(0)
				expect(abortListener).toBeTypeOf("function")
				expect(mockCline.off).toHaveBeenCalledWith(RooCodeEventName.TaskAborted, abortListener)

				// The next stream for the same task must issue a partial ask again (the stale
				// streamFailed guard is gone).
				mockCline.diffViewProvider.open.mockResolvedValue(undefined)
				await executeWriteFileTool({}, { isPartial: true })
				await executeWriteFileTool({}, { isPartial: true })
				expect(mockCline.ask).toHaveBeenCalledTimes(2)
			} finally {
				consoleErrorSpy.mockRestore()
			}
		})

		it("restores the diff document when the final block fails to parse after successful streaming", async () => {
			// Streaming opened the diff view with unapproved partial content (open and
			// update both succeeded, so no streaming error was captured). The final block
			// then arrives without nativeArgs: execute() never runs, so its error cleanup
			// never fires. The parse-failure teardown must still restore the document
			// (revert before reset) or a user save could persist content the write never
			// completed, and must report the generic parse error (no streaming error to
			// surface instead).
			let abortListener: (() => void) | undefined
			mockCline.once.mockImplementation((event: RooCodeEventName, listener: () => void) => {
				if (event === RooCodeEventName.TaskAborted && abortListener === undefined) {
					abortListener = listener
				}
				return mockCline
			})
			const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
			try {
				// Delta 1 - stabilize path; delta 2 - streams the partial content into the
				// diff view (open + update resolve).
				await executeWriteFileTool({}, { isPartial: true })
				await executeWriteFileTool({}, { isPartial: true })
				expect(mockCline.diffViewProvider.open).toHaveBeenCalledTimes(1)
				expect(mockCline.diffViewProvider.update).toHaveBeenCalledTimes(1)

				const toolUse: ToolUse = {
					type: "tool_use",
					name: "write_to_file",
					params: { path: testFilePath, content: testContent },
					nativeArgs: undefined,
					partial: false,
				}
				await writeToFileTool.handle(mockCline, toolUse as ToolUse<"write_to_file">, {
					askApproval: mockAskApproval,
					handleError: mockHandleError,
					pushToolResult: vi.fn(),
				})

				// No streaming error was captured: the generic parse error is reported.
				expect(mockHandleError).toHaveBeenCalledTimes(1)
				expect(mockHandleError).toHaveBeenCalledWith("parsing write_to_file args", expect.any(Error))
				// The diff document is restored by the parse path itself (no streaming
				// failure happened, so this is the only revert + reset in the test).
				expect(mockCline.diffViewProvider.revertChanges).toHaveBeenCalledTimes(1)
				expect(mockCline.diffViewProvider.reset).toHaveBeenCalledTimes(1)
				// Per-task state torn down: guard cleared, exact listener detached.
				expect(writeToFileTool["taskPartialStreamState"].size).toBe(0)
				expect(abortListener).toBeTypeOf("function")
				expect(mockCline.off).toHaveBeenCalledWith(RooCodeEventName.TaskAborted, abortListener)
			} finally {
				consoleErrorSpy.mockRestore()
			}
		})

		it("leaves the teardown in charge when the stream state is cleared while update() is in flight", async () => {
			// The path is stabilized, so this delta streams. The task is disposed while update()
			// awaits: the TaskAborted handler releases this task's state (and reverts or closes the
			// diff view itself), and the in-flight update then rejects. Marking the released state
			// failed, finalizing the ask, or running the failed-stream cleanup again would resurrect
			// UI and roll back twice for a task the user cancelled.
			await executeWriteFileTool({}, { isPartial: true })
			await executeWriteFileTool({}, { isPartial: true })
			expect(writeToFileTool["taskPartialStreamState"].size).toBe(1)
			mockCline.diffViewProvider.revertChanges.mockClear()
			mockCline.diffViewProvider.update.mockImplementationOnce(async () => {
				writeToFileTool["resetTaskPartialState"](mockCline as never)
				throw new Error("update rejected after the task was disposed")
			})

			await executeWriteFileTool({}, { isPartial: true })

			// The cleanup did not run: no revert, no finalize, and the released state stayed gone.
			expect(mockCline.diffViewProvider.revertChanges).not.toHaveBeenCalled()
			expect(mockCline.finalizePartialToolAsk).not.toHaveBeenCalled()
			expect(writeToFileTool["taskPartialStreamState"].size).toBe(0)
			expect(mockHandleError).not.toHaveBeenCalled()
		})
	})

	describe("path stabilization predicate", () => {
		// The predicate is exercised directly (it is private) because not all of its branches are
		// observable through handlePartial(): an undefined path reaches the same early return either
		// way, so the clause-by-clause behavior must be pinned at the predicate level.
		function makeState(lastSeenPartialPath: string | undefined) {
			return {
				lastSeenPartialPath,
				streamFailed: false,
				streamError: undefined,
				task: mockCline,
				abortCleanup: () => {},
			}
		}

		it("reports a first delta as not stabilized and records the seen path", () => {
			const state = makeState(undefined)

			expect(writeToFileTool["hasPathStabilizedForTask"](state, "a.txt")).toBe(false)
			expect(state.lastSeenPartialPath).toBe("a.txt")
		})

		it("reports a repeated path as stabilized", () => {
			const state = makeState("a.txt")

			expect(writeToFileTool["hasPathStabilizedForTask"](state, "a.txt")).toBe(true)
		})

		it("reports a changed path as not stabilized", () => {
			const state = makeState("a.txt")

			expect(writeToFileTool["hasPathStabilizedForTask"](state, "b.txt")).toBe(false)
			expect(state.lastSeenPartialPath).toBe("b.txt")
		})
	})

	describe("resetPartialState", () => {
		it("resets the base partial path and detaches every task's abort listener", async () => {
			let abortCleanup: (() => void) | undefined
			mockCline.once.mockImplementation((event: RooCodeEventName, listener: () => void) => {
				if (event === RooCodeEventName.TaskAborted) {
					abortCleanup = listener
				}
				return mockCline
			})

			// Seed one per-task state with an abort listener attached.
			await executeWriteFileTool({}, { isPartial: true })
			await executeWriteFileTool({}, { isPartial: true })
			expect(mockCline.ask).toHaveBeenCalledTimes(1)
			expect(abortCleanup).toBeTypeOf("function")

			// The base-class singleton field is reset by super.resetPartialState().
			writeToFileTool["lastSeenPartialPath"] = "stale-path"
			writeToFileTool.resetPartialState()

			expect(writeToFileTool["lastSeenPartialPath"]).toBeUndefined()
			expect(mockCline.off).toHaveBeenCalledWith(RooCodeEventName.TaskAborted, abortCleanup)

			// The per-task map was cleared too: a fresh delta sequence starts un-stabilized, so no
			// second partial ask is issued.
			await executeWriteFileTool({}, { isPartial: true })
			expect(mockCline.ask).toHaveBeenCalledTimes(1)
		})
	})

	describe("per-task stream state isolation", () => {
		// A second task streaming through the same singleton while mockCline's execute()
		// runs. Structural double, same pattern as the partial-state-cleanup spec.
		function buildStreamingTask(taskId: string, instanceId: string) {
			return {
				taskId,
				instanceId,
				once: vi.fn(),
				off: vi.fn(),
				diffViewProvider: {
					reset: vi.fn().mockResolvedValue(undefined),
					revertChanges: vi.fn().mockResolvedValue(undefined),
				},
				finalizePartialToolAsk: vi.fn().mockResolvedValue(undefined),
			}
		}

		it("leaves another task's stream state intact when execute() completes", async () => {
			const other = buildStreamingTask("task-2", "instance-2")
			const otherState = writeToFileTool["getTaskPartialStreamState"](other as never)
			otherState.streamFailed = true
			otherState.streamError = new Error("other task stream failure")

			await executeWriteFileTool({})

			// The other task is still streaming: its failure state must survive, or its
			// next delta re-opens the diff view and spawns a duplicate partial ask.
			const retained = writeToFileTool["taskPartialStreamState"].get("task-2.instance-2")
			expect(retained).toBeDefined()
			expect(retained?.streamFailed).toBe(true)
			expect(retained?.streamError?.message).toBe("other task stream failure")
			expect(other.off).not.toHaveBeenCalled()
		})

		it("finalizes the partial ask when the write itself fails", async () => {
			mockCline.diffViewProvider.saveChanges.mockRejectedValue(new Error("save failed"))

			await executeWriteFileTool({})

			expect(mockHandleError).toHaveBeenCalledWith("writing file", expect.any(Error))
			// The diff-view branch opened a partial ask for this write; without the
			// finalize the spinner and Save/Reject stay live after the failure.
			expect(mockCline.finalizePartialToolAsk).toHaveBeenCalledWith(expectedPartialToolMessage)
		})
	})

	describe("early-return stream state cleanup", () => {
		it("releases the per-task stream state when a rooignore denial returns early", async () => {
			// The denial returns before the try/catch teardown: without the release the abort
			// listener stays for the task's lifetime and a retained streamFailed suppresses the
			// diff preview of every later write_to_file in this task.
			writeToFileTool["getTaskPartialStreamState"](mockCline as never).streamFailed = true

			await executeWriteFileTool({}, { accessAllowed: false })

			expect(writeToFileTool["taskPartialStreamState"].size).toBe(0)
			// The exact listener this task registered, not just any function: a mismatched off()
			// argument would leave the real listener attached.
			const abortListener = mockCline.once.mock.calls.find(
				([event]: unknown[]) => event === RooCodeEventName.TaskAborted,
			)?.[1]
			expect(abortListener).toBeInstanceOf(Function)
			expect(mockCline.off).toHaveBeenCalledWith(RooCodeEventName.TaskAborted, abortListener)
		})

		it("releases the per-task stream state when a missing parameter returns early", async () => {
			writeToFileTool["getTaskPartialStreamState"](mockCline as never).streamFailed = true

			await writeToFileTool.execute({ path: "", content: "mock content" }, mockCline, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
			})

			expect(writeToFileTool["taskPartialStreamState"].size).toBe(0)
			expect(mockCline.diffViewProvider.reset).toHaveBeenCalled()
		})

		it("stops before the filesystem probe when the state is released while provider state is in flight", async () => {
			// handlePartial() awaits provider.getState() before any side effect. A cancellation
			// during that await runs the TaskAborted teardown; the delta already in flight must
			// stop there instead of probing, asking and opening a diff view for a dead task.
			await executeWriteFileTool({}, { fileExists: false, isPartial: true })
			await executeWriteFileTool({}, { fileExists: false, isPartial: true })
			expect(writeToFileTool["taskPartialStreamState"].size).toBe(1)
			mockCline.diffViewProvider.open.mockClear()
			mockCline.providerRef.deref.mockReturnValue({
				getState: vi.fn(async () => {
					writeToFileTool.clearTaskState(mockCline)
					return {}
				}),
			})

			await executeWriteFileTool({}, { fileExists: false, isPartial: true })

			expect(mockCline.ask).toHaveBeenCalledTimes(1)
			expect(mockCline.diffViewProvider.open).not.toHaveBeenCalled()
			expect(writeToFileTool["taskPartialStreamState"].size).toBe(0)
		})

		it("stops before the partial ask when the state is released during the filesystem probe", async () => {
			// Same teardown, one await later. The first delta pins editType, so clear it to
			// take the fileExistsAtPath branch again and abort inside it.
			await executeWriteFileTool({}, { fileExists: false, isPartial: true })
			await executeWriteFileTool({}, { fileExists: false, isPartial: true })
			expect(writeToFileTool["taskPartialStreamState"].size).toBe(1)
			mockCline.diffViewProvider.open.mockClear()
			mockCline.diffViewProvider.editType = undefined
			// mockImplementationOnce: executeWriteFileTool re-arms the default resolved value
			// on every call, so a plain mockImplementation would be overwritten.
			mockedFileExistsAtPath.mockImplementationOnce(async () => {
				writeToFileTool.clearTaskState(mockCline)
				return false
			})

			await executeWriteFileTool({}, { fileExists: false, isPartial: true })

			expect(mockCline.ask).toHaveBeenCalledTimes(1)
			expect(mockCline.diffViewProvider.open).not.toHaveBeenCalled()
			expect(writeToFileTool["taskPartialStreamState"].size).toBe(0)
		})

		it("stops before touching the diff view when the stream state is released during an in-flight ask", async () => {
			// A cancellation while task.ask() is in flight runs the TaskAborted teardown. The
			// delta that was already in flight must not then re-open the diff view for a task
			// the user cancelled - that resurrects the state the teardown just released.
			await executeWriteFileTool({}, { fileExists: false, isPartial: true })
			await executeWriteFileTool({}, { fileExists: false, isPartial: true })
			expect(writeToFileTool["taskPartialStreamState"].size).toBe(1)
			mockCline.diffViewProvider.open.mockClear()
			mockCline.diffViewProvider.update.mockClear()
			mockCline.ask.mockImplementation(async () => {
				writeToFileTool.clearTaskState(mockCline)
			})

			await executeWriteFileTool({}, { fileExists: false, isPartial: true })

			expect(mockCline.diffViewProvider.open).not.toHaveBeenCalled()
			expect(mockCline.diffViewProvider.update).not.toHaveBeenCalled()
			expect(writeToFileTool["taskPartialStreamState"].size).toBe(0)
		})

		it("stops before updating the diff view when the task is cancelled while open() is in flight", async () => {
			// open() is the first provider await after the partial ask. If TaskAborted lands
			// while it is in flight, the teardown has already released this task's stream
			// state (and may have reverted or closed this very view), so the delta that is
			// already in flight must not stream partial content into a cancelled task's view.
			await executeWriteFileTool({}, { fileExists: false, isPartial: true })
			await executeWriteFileTool({}, { fileExists: false, isPartial: true })
			expect(writeToFileTool["taskPartialStreamState"].size).toBe(1)
			expect(mockCline.diffViewProvider.open).toHaveBeenCalledTimes(1)
			mockCline.diffViewProvider.open.mockClear()
			mockCline.diffViewProvider.update.mockClear()
			mockCline.diffViewProvider.open.mockImplementationOnce(async () => {
				writeToFileTool.clearTaskState(mockCline)
			})

			await executeWriteFileTool({}, { fileExists: false, isPartial: true })

			expect(mockCline.diffViewProvider.open).toHaveBeenCalledTimes(1)
			expect(mockCline.diffViewProvider.update).not.toHaveBeenCalled()
			expect(writeToFileTool["taskPartialStreamState"].size).toBe(0)
		})
		it("does not finalize the ask or roll back twice when open() rejects after a cancellation", async () => {
			// A cancellation during open() releases the stream state through the TaskAborted
			// teardown (which also reverts or closes this diff view) AND can reject the call in
			// flight. The catch used to mark the released state failed, finalize the ask and run
			// the failed-stream cleanup again - a second rollback and a fresh ask row for a task
			// the user already cancelled.
			await executeWriteFileTool({}, { fileExists: false, isPartial: true })
			await executeWriteFileTool({}, { fileExists: false, isPartial: true })
			expect(writeToFileTool["taskPartialStreamState"].size).toBe(1)
			mockCline.diffViewProvider.open.mockClear()
			mockCline.diffViewProvider.update.mockClear()
			mockCline.diffViewProvider.revertChanges.mockClear()
			mockCline.finalizePartialToolAsk.mockClear()
			mockCline.diffViewProvider.open.mockImplementationOnce(async () => {
				writeToFileTool.clearTaskState(mockCline)
				throw new Error("EACCES: permission denied, open mock-file")
			})

			await executeWriteFileTool({}, { fileExists: false, isPartial: true })

			expect(mockCline.diffViewProvider.update).not.toHaveBeenCalled()
			// The teardown that already ran owns the outcome: no finalize and no second rollback.
			expect(mockCline.finalizePartialToolAsk).not.toHaveBeenCalled()
			expect(mockCline.diffViewProvider.revertChanges).not.toHaveBeenCalled()
			expect(writeToFileTool["taskPartialStreamState"].size).toBe(0)
		})

		it("releases the per-task stream state when prevent-focus-disruption skips the partial preview", async () => {
			// Delta 1 only pins the path, so the entry is still live afterwards (the stream is in
			// flight). Delta 2 reaches the experiment check and returns without ever showing a
			// preview: nothing else would release the entry or detach the TaskAborted listener.
			mockCline.providerRef = {
				deref: vi.fn().mockReturnValue({
					getState: vi.fn().mockResolvedValue({
						diagnosticsEnabled: true,
						writeDelayMs: 1000,
						experiments: { preventFocusDisruption: true },
					}),
				}),
			}

			await executeWriteFileTool({}, { fileExists: false, isPartial: true })
			expect(writeToFileTool["taskPartialStreamState"].size).toBe(1)

			await executeWriteFileTool({}, { fileExists: false, isPartial: true })

			expect(mockCline.ask).not.toHaveBeenCalled()
			expect(writeToFileTool["taskPartialStreamState"].size).toBe(0)
			// The exact listener this task registered, not just any function: a mismatched off()
			// argument would leave the real listener attached.
			const abortListener = mockCline.once.mock.calls.find(
				([event]: unknown[]) => event === RooCodeEventName.TaskAborted,
			)?.[1]
			expect(abortListener).toBeInstanceOf(Function)
			expect(mockCline.off).toHaveBeenCalledWith(RooCodeEventName.TaskAborted, abortListener)
		})

		it("releases the per-task stream state when content is missing", async () => {
			// The missing-content return sits before execute()'s guarded scope, so it needs its own
			// release. The state is seeded first so the assertion proves a release happened rather
			// than an empty map.
			writeToFileTool["getTaskPartialStreamState"](mockCline as never)
			expect(writeToFileTool["taskPartialStreamState"].size).toBe(1)

			const toolUse = {
				type: "tool_use",
				name: "write_to_file",
				params: { path: testFilePath },
				nativeArgs: { path: testFilePath, content: undefined },
				// The fixture's point is a nativeArgs object whose content never arrived, which the
				// typed params cannot express - hence the double assertion.
				partial: false,
			} as unknown as ToolUse<"write_to_file">
			const pushToolResult = vi.fn()
			await writeToFileTool.handle(mockCline, toolUse, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult,
			})

			expect(mockCline.sayAndCreateMissingParamError).toHaveBeenCalledWith("write_to_file", "content")
			expect(pushToolResult).toHaveBeenCalledWith("Missing param error")
			expect(writeToFileTool["taskPartialStreamState"].size).toBe(0)
			const abortListener = mockCline.once.mock.calls.find(
				([event]: unknown[]) => event === RooCodeEventName.TaskAborted,
			)?.[1]
			expect(abortListener).toBeInstanceOf(Function)
			expect(mockCline.off).toHaveBeenCalledWith(RooCodeEventName.TaskAborted, abortListener)
			// A stream may have opened a diff view for this call; the early return still closes it.
			expect(mockCline.diffViewProvider.reset).toHaveBeenCalled()
		})

		it("releases the per-task stream state when the write completes", async () => {
			// Seed first: without the seed the map is empty either way and the assertion is vacuous.
			writeToFileTool["getTaskPartialStreamState"](mockCline as never)
			expect(writeToFileTool["taskPartialStreamState"].size).toBe(1)

			await executeWriteFileTool({})

			expect(writeToFileTool["taskPartialStreamState"].size).toBe(0)
			const abortListener = mockCline.once.mock.calls.find(
				([event]: unknown[]) => event === RooCodeEventName.TaskAborted,
			)?.[1]
			expect(abortListener).toBeInstanceOf(Function)
			expect(mockCline.off).toHaveBeenCalledWith(RooCodeEventName.TaskAborted, abortListener)
			expect(mockCline.diffViewProvider.reset).toHaveBeenCalled()
		})

		it("releases the per-task stream state when the write itself fails", async () => {
			// The catch path tears down too: a failed write must not leave the entry (and its
			// streamFailed guard) attached to the task.
			writeToFileTool["getTaskPartialStreamState"](mockCline as never)
			expect(writeToFileTool["taskPartialStreamState"].size).toBe(1)
			mockCline.diffViewProvider.saveChanges.mockRejectedValue(new Error("save failed"))

			await executeWriteFileTool({})

			expect(mockHandleError).toHaveBeenCalledWith("writing file", expect.any(Error))
			expect(writeToFileTool["taskPartialStreamState"].size).toBe(0)
			const abortListener = mockCline.once.mock.calls.find(
				([event]: unknown[]) => event === RooCodeEventName.TaskAborted,
			)?.[1]
			expect(abortListener).toBeInstanceOf(Function)
			expect(mockCline.off).toHaveBeenCalledWith(RooCodeEventName.TaskAborted, abortListener)
		})

		it("releases the per-task stream state when the preflight directory creation throws", async () => {
			// The preflight filesystem work sits before execute()'s guarded scope today: when it
			// throws, nothing reports the failure and the stream state leaks. It has to be handled
			// like any other write failure - reported once, teardown run.
			writeToFileTool["getTaskPartialStreamState"](mockCline as never).streamFailed = true
			mockedCreateDirectoriesForFile.mockRejectedValueOnce(
				Object.assign(new Error("EACCES: permission denied, mkdir '/new-parent'"), { code: "EACCES" }),
			)

			await executeWriteFileTool({})

			expect(mockHandleError).toHaveBeenCalledWith("writing file", expect.any(Error))
			expect(writeToFileTool["taskPartialStreamState"].size).toBe(0)
		})

		it("rolls the diff-view debris back when open() fails mid-execute", async () => {
			// open() creates the parent directories and an empty placeholder before it awaits
			// openDiffEditor(). When it rejects, the write failed but the debris did not: the catch
			// has to await the rollback (which removes the placeholder and only the directories this
			// operation created) before resetting the view, or the next execute() mistakes the
			// placeholder for an existing file.
			writeToFileTool["getTaskPartialStreamState"](mockCline as never)
			mockCline.diffViewProvider.open.mockRejectedValue(
				Object.assign(new Error("EACCES: permission denied, open '/ro/test.py'"), { code: "EACCES" }),
			)

			await executeWriteFileTool({})

			expect(mockHandleError).toHaveBeenCalledWith("writing file", expect.any(Error))
			expect(mockCline.diffViewProvider.revertChanges).toHaveBeenCalled()
			const revertOrder = mockCline.diffViewProvider.revertChanges.mock.invocationCallOrder[0]
			const resetOrder = mockCline.diffViewProvider.reset.mock.invocationCallOrder.at(-1)
			expect(resetOrder).toBeGreaterThan(revertOrder)
			expect(writeToFileTool["taskPartialStreamState"].size).toBe(0)
		})

		it("reports the rollback hazard when execute()'s own cleanup cannot revert the diff", async () => {
			// execute() failed after the diff view was opened, and the rollback that follows the
			// catch failed too. The debris (placeholder, created directories) is still on disk and the
			// editor may still hold unapproved content, so the user has to be told - the same report
			// the parse-failure teardown and cleanupFailedPartialStream() make.
			mockCline.diffViewProvider.saveChanges.mockRejectedValue(new Error("save failed"))
			mockCline.diffViewProvider.revertChanges.mockRejectedValue(new Error("rollback failed"))

			await executeWriteFileTool({})

			expect(mockHandleError).toHaveBeenCalledWith("writing file", expect.any(Error))
			expect(mockCline.say).toHaveBeenCalledWith(
				"error",
				expect.stringContaining("could not be restored after the failed tool call"),
			)
		})
	})

	describe("user interaction", () => {
		it("reverts changes when user rejects approval", async () => {
			mockAskApproval.mockResolvedValue(false)

			await executeWriteFileTool({})

			expect(mockCline.diffViewProvider.revertChanges).toHaveBeenCalled()
			expect(mockCline.diffViewProvider.saveChanges).not.toHaveBeenCalled()
		})

		it("clears this task's stream state when the write is rejected", async () => {
			// A failed delta earlier in the same task arms the streamFailed guard. If the
			// rejection exit returns without the teardown, every later write_to_file in this
			// task loses its diff preview and the TaskAborted listener leaks.
			const state = writeToFileTool["getTaskPartialStreamState"](mockCline as never)
			state.streamFailed = true
			state.streamError = new Error("stream failure before the rejected write")
			mockAskApproval.mockResolvedValue(false)

			await executeWriteFileTool({})

			expect(writeToFileTool["taskPartialStreamState"].get(`${mockCline.taskId}.${mockCline.instanceId}`)).toBeUndefined()
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
			// Record the relative order of revertChanges() and reset() (vitest mocks expose
			// no invocationCallOrder).
			const diffViewCallOrder: string[] = []
			mockCline.diffViewProvider.revertChanges.mockImplementation(async () => {
				diffViewCallOrder.push("revert")
			})
			mockCline.diffViewProvider.reset.mockImplementation(async () => {
				diffViewCallOrder.push("reset")
			})

			// First call - path not yet stabilized
			await executeWriteFileTool({}, { isPartial: true })
			expect(mockCline.finalizePartialToolAsk).not.toHaveBeenCalled()

			// Second call - path stabilized, open() rejects
			await executeWriteFileTool({}, { isPartial: true })

			// Exact streamed payload: finalizePartialToolAsk() no-ops on a text mismatch, so
			// a wrong argument (e.g. relPath) would leave the spinner stuck.
			expect(mockCline.finalizePartialToolAsk).toHaveBeenCalledWith(expectedPartialToolMessage)
			// The failed write's streamed content must be reverted before reset() clears the
			// state revertChanges() relies on.
			expect(diffViewCallOrder).toEqual(["revert", "reset"])
			expect(mockHandleError).not.toHaveBeenCalled()
		})

		it("finalizes partial tool message and resets diff view when handlePartial update() fails", async () => {
			// Same regression as above but for the streaming update() call failing after open() succeeds.
			mockCline.diffViewProvider.update.mockRejectedValue(
				Object.assign(new Error("EROFS: read-only file system, write '/ro/test.py'"), { code: "EROFS" }),
			)
			// Record the relative order of revertChanges() and reset() (vitest mocks expose
			// no invocationCallOrder).
			const diffViewCallOrder: string[] = []
			mockCline.diffViewProvider.revertChanges.mockImplementation(async () => {
				diffViewCallOrder.push("revert")
			})
			mockCline.diffViewProvider.reset.mockImplementation(async () => {
				diffViewCallOrder.push("reset")
			})

			// First call - path not yet stabilized
			await executeWriteFileTool({}, { isPartial: true })

			// Second call - path stabilized, update() rejects
			await executeWriteFileTool({}, { isPartial: true })

			// Exact streamed payload: finalizePartialToolAsk() no-ops on a text mismatch, so
			// a wrong argument (e.g. relPath) would leave the spinner stuck.
			expect(mockCline.finalizePartialToolAsk).toHaveBeenCalledWith(expectedPartialToolMessage)
			// The failed write's streamed content must be reverted before reset() clears the
			// state revertChanges() relies on.
			expect(diffViewCallOrder).toEqual(["revert", "reset"])
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

		it("finalizes any open partial tool ask when final args cannot be parsed", async () => {
			// Regression test: a write_to_file block whose final args fail to parse (e.g. the
			// tool call was truncated mid-JSON by the output token limit) never reaches
			// execute(). A streaming delta for that block may already have opened a partial
			// `tool` ask (partial: true) -- BaseTool.handle must finalize it, otherwise the
			// UI spinner stays stuck even though the parse error bubble was shown.
			// Delta 1 - stabilize path (no ask yet)
			await executeWriteFileTool({}, { fileExists: false, isPartial: true })
			// Delta 2 - path stabilized, partial ask issued once
			await executeWriteFileTool({}, { fileExists: false, isPartial: true })
			expect(mockCline.ask).toHaveBeenCalledTimes(1)
			expect(mockCline.finalizePartialToolAsk).not.toHaveBeenCalled()

			// Final block arrives but its native args cannot be parsed, so execute() is skipped.
			const toolUse: ToolUse = {
				type: "tool_use",
				name: "write_to_file",
				params: {
					path: testFilePath,
					content: testContent,
				},
				partial: false,
			}
			await writeToFileTool.handle(mockCline, toolUse as ToolUse<"write_to_file">, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
			})

			// The parse error is still reported, and the open partial ask is finalized first.
			// No argument: BaseTool.handle() calls finalizePartialToolAsk() with no text, so a
			// mutation passing wrong text would leave findLast() unmatched and the spinner
			// stuck. (toHaveBeenCalledWith(undefined) does not match a no-arg call under
			// vitest's matcher semantics: [] is not equal to [undefined].)
			expect(mockCline.finalizePartialToolAsk).toHaveBeenCalledTimes(1)
			expect(mockCline.finalizePartialToolAsk).toHaveBeenCalledWith()
			expect(mockHandleError).toHaveBeenCalledWith("parsing write_to_file args", expect.any(Error))
		})

		it("continues parse failure cleanup when finalizing the partial ask fails", async () => {
			// Pins the .catch arm on task.finalizePartialToolAsk() in BaseTool.handle(): when the
			// final args cannot be parsed and finalizing the open partial ask also fails, the
			// failure must only be logged so the parse error is still reported to the user.
			const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
			try {
				mockCline.finalizePartialToolAsk.mockRejectedValue(new Error("finalize failed"))

				// Final block arrives but its native args cannot be parsed, so execute() is skipped.
				const toolUse: ToolUse = {
					type: "tool_use",
					name: "write_to_file",
					params: {
						path: testFilePath,
						content: testContent,
					},
					partial: false,
				}
				await writeToFileTool.handle(mockCline, toolUse as ToolUse<"write_to_file">, {
					askApproval: mockAskApproval,
					handleError: mockHandleError,
					pushToolResult: vi.fn(),
				})

				// Same no-argument contract as the sibling test above: the finalize call in
				// BaseTool.handle() carries no text.
				expect(mockCline.finalizePartialToolAsk).toHaveBeenCalledTimes(1)
				expect(mockCline.finalizePartialToolAsk).toHaveBeenCalledWith()
				expect(consoleErrorSpy).toHaveBeenCalledWith(
					"Error finalizing write_to_file partial tool ask:",
					expect.any(Error),
				)
				// The parse error is still reported despite the failed finalization.
				expect(mockHandleError).toHaveBeenCalledWith("parsing write_to_file args", expect.any(Error))
			} finally {
				consoleErrorSpy.mockRestore()
			}
		})







		it("keeps partial stream failures isolated per task", async () => {
			mockCline.diffViewProvider.open.mockRejectedValueOnce(
				Object.assign(new Error("EROFS: read-only file system, mkdir '/task-a'"), { code: "EROFS" }),
			)

			await executeWriteFileTool({}, { fileExists: false, isPartial: true })
			await executeWriteFileTool({}, { fileExists: false, isPartial: true })
			expect(mockCline.ask).toHaveBeenCalledTimes(1)

			mockCline.taskId = "task-2"
			mockCline.instanceId = "instance-2"
			mockCline.diffViewProvider.open.mockResolvedValue(undefined)
			mockCline.diffViewProvider.update.mockResolvedValue(undefined)
			mockCline.diffViewProvider.editType = undefined

			await executeWriteFileTool({}, { fileExists: false, isPartial: true })
			expect(mockCline.ask).toHaveBeenCalledTimes(1)

			await executeWriteFileTool({}, { fileExists: false, isPartial: true })

			expect(mockCline.ask).toHaveBeenCalledTimes(2)
			expect(mockCline.diffViewProvider.open).toHaveBeenCalledTimes(2)
		})



		it("EROFS in handlePartial does not stall agent loop -- createDirectoriesForFile is not called", async () => {
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
		})




	})

	describe("partial-stream failure teardown and directory ownership", () => {
		it("hands the directories it created to the diff view so a rollback removes them", async () => {
			// revertChanges() removes only the directories the provider recorded, and its own
			// mkdir returns nothing once execute() has made them. Without the hand-off a
			// rolled-back new-file write left the parent directories on disk.
			const created = ["/new-parent", "/new-parent/nested"]
			mockedCreateDirectoriesForFile.mockResolvedValue(created)

			await executeWriteFileTool({}, { fileExists: false })

			expect(mockCline.diffViewProvider.adoptCreatedDirs).toHaveBeenCalledWith(created)
		})

		it("does not hand directories over when the file already exists", async () => {
			// An existing file has no directories to roll back; adopting an empty list from
			// an unrelated mkdir would still be wrong, but adopting a populated one would
			// make a denial rmdir directories the user already had.
			await executeWriteFileTool({}, { fileExists: true })

			expect(mockCline.diffViewProvider.adoptCreatedDirs).not.toHaveBeenCalled()
		})

		it("releases the per-task stream state when a partial-stream await throws", async () => {
			// An uncaught failure below the state creation used to leave the entry and its
			// TaskAborted listener registered: the stale streamFailed flag then suppressed
			// every later preview for the task, and the listener could never fire for a
			// stream that had already ended.
			mockCline.providerRef.deref.mockReturnValue({
				getState: vi.fn().mockRejectedValue(new Error("state read failed")),
			})

			await executeWriteFileTool({}, { fileExists: false, isPartial: true })
			await executeWriteFileTool({}, { fileExists: false, isPartial: true })

			const abortListener = mockCline.once.mock.calls.find(
				([event]: unknown[]) => event === RooCodeEventName.TaskAborted,
			)?.[1]
			expect(abortListener).toBeInstanceOf(Function)
			expect(mockCline.off).toHaveBeenCalledWith(RooCodeEventName.TaskAborted, abortListener)
			expect(writeToFileTool["taskPartialStreamState"].size).toBe(0)
		})

		it("keeps a newer stream entry when an older partial failure releases by identity", async () => {
			// Identity, not presence: dropping whatever sits under the key would detach the
			// live stream's abort listener while cleaning up after a superseded one.
			const stale = writeToFileTool["getTaskPartialStreamState"](mockCline as never)
			const newer = { ...stale }
			mockCline.providerRef.deref.mockImplementation(() => ({
				getState: async () => {
					writeToFileTool["taskPartialStreamState"].set("task-1.instance-1", newer)
					throw new Error("state read failed")
				},
			}))

			await executeWriteFileTool({}, { fileExists: false, isPartial: true })
			await executeWriteFileTool({}, { fileExists: false, isPartial: true })

			expect(writeToFileTool["taskPartialStreamState"].get("task-1.instance-1")).toBe(newer)
			expect(mockCline.off).not.toHaveBeenCalled()
		})
	})
})
