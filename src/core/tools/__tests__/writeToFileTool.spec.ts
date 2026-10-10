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

		it("releases the per-task stream state when provider state rejects during a partial delta", async () => {
			// handlePartial() registers the entry and the TaskAborted listener, then awaits
			// provider.getState(). A rejection there never reaches the diff view or execute(), so
			// nothing else released what the registration acquired. The error still has to surface,
			// so the boundary rethrows and BaseTool.handle() reports it once.
			await executeWriteFileTool({}, { fileExists: false, isPartial: true })
			await executeWriteFileTool({}, { fileExists: false, isPartial: true })
			expect(writeToFileTool["taskPartialStreamState"].size).toBe(1)
			mockCline.providerRef.deref.mockReturnValue({
				getState: vi.fn().mockRejectedValue(new Error("provider state unavailable")),
			})

			await executeWriteFileTool({}, { fileExists: false, isPartial: true })

			expect(writeToFileTool["taskPartialStreamState"].size).toBe(0)
			const abortListener = mockCline.once.mock.calls.find(
				([event]: unknown[]) => event === RooCodeEventName.TaskAborted,
			)?.[1]
			expect(abortListener).toBeInstanceOf(Function)
			expect(mockCline.off).toHaveBeenCalledWith(RooCodeEventName.TaskAborted, abortListener)
			expect(mockHandleError).toHaveBeenCalledWith(
				"handling partial write_to_file",
				expect.objectContaining({ message: "provider state unavailable" }),
			)
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

	describe("parse-failure reporting and early-return cleanup", () => {
		it("reports the captured streaming failure once instead of the incidental parse error", async () => {
			// A streaming delta hit a fatal filesystem error and the finalized block then
			// arrives without nativeArgs: execute() never runs, so its authoritative retry of
			// the same filesystem operation never happens either. The captured error is the one
			// the user can act on, and it must surface exactly once.
			const state = writeToFileTool["getTaskPartialStreamState"](mockCline as never)
			// The stream opened a diff view: that is what makes the rollback meaningful.
			mockCline.diffViewProvider.isEditing = true
			state.streamFailed = true
			const streamFailure = new Error("EACCES: stream open failed")
			state.streamError = streamFailure

			const block = {
				type: "tool_use",
				name: "write_to_file",
				params: {},
				partial: false,
			} as ToolUse<"write_to_file">
			await writeToFileTool.handle(mockCline, block, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
			})

			expect(mockHandleError).toHaveBeenCalledTimes(1)
			expect(mockHandleError).toHaveBeenCalledWith("writing file", streamFailure)
			expect(mockHandleError).not.toHaveBeenCalledWith("parsing write_to_file args", expect.any(Error))
			expect(writeToFileTool["taskPartialStreamState"].size).toBe(0)
			// The stream may have left a diff view open with content that was never approved.
			expect(mockCline.diffViewProvider.revertChanges).toHaveBeenCalled()
			expect(mockCline.diffViewProvider.reset).toHaveBeenCalled()
		})
		it("releases the per-task stream state when execute() returns early on a denied path", async () => {
			// The rooignore branch returns before execute()'s success/catch cleanup; without
			// this the abort listener and the streamFailed guard outlive the call and suppress
			// the diff preview of every later write_to_file in this task.
			writeToFileTool["getTaskPartialStreamState"](mockCline as never).streamFailed = true

			await executeWriteFileTool({}, { accessAllowed: false })

			expect(writeToFileTool["taskPartialStreamState"].size).toBe(0)
			// The exact listener this task registered, not just any function: a mismatched
			// off() argument would leave the real listener attached.
			const abortListener = mockCline.once.mock.calls.find(
				([event]: unknown[]) => event === RooCodeEventName.TaskAborted,
			)?.[1]
			expect(abortListener).toBeInstanceOf(Function)
			expect(mockCline.off).toHaveBeenCalledWith(RooCodeEventName.TaskAborted, abortListener)
		})

		it("releases the per-task stream state when the rooignore ask itself rejects", async () => {
			// task.say() can reject when the task is cancelled or disposed mid-ask. The release sits
			// in a finally, so the stream state and its TaskAborted listener still go away even though
			// the ask threw; without it the streamFailed guard suppresses every later diff preview in
			// this task.
			writeToFileTool["getTaskPartialStreamState"](mockCline as never).streamFailed = true
			mockCline.say = vi.fn().mockRejectedValue(new Error("task cancelled during the rooignore ask"))

			await expect(executeWriteFileTool({}, { accessAllowed: false })).rejects.toThrow(
				"task cancelled during the rooignore ask",
			)

			expect(writeToFileTool["taskPartialStreamState"].size).toBe(0)
			const abortListener = mockCline.once.mock.calls.find(
				([event]: unknown[]) => event === RooCodeEventName.TaskAborted,
			)?.[1]
			expect(abortListener).toBeInstanceOf(Function)
			expect(mockCline.off).toHaveBeenCalledWith(RooCodeEventName.TaskAborted, abortListener)
			// The ask threw, so the denial result was never pushed: the release cannot depend on it.
			expect(mockPushToolResult).not.toHaveBeenCalled()
		})

		it("does not revert the diff view when the parse-failure teardown has no edit in progress", async () => {
			// One unstabilized delta registers this task's stream state without ever opening a diff
			// view; the finalized block then arrives without nativeArgs. DiffViewProvider keeps the
			// PREVIOUS edit's relPath, so reverting here would roll back - and for a new file delete -
			// a file this write never opened. The teardown still resets the view and releases state.
			await executeWriteFileTool({}, { isPartial: true })
			expect(writeToFileTool["taskPartialStreamState"].size).toBe(1)
			mockCline.diffViewProvider.isEditing = false

			const block = {
				type: "tool_use",
				name: "write_to_file",
				params: {},
				// No nativeArgs: this drives BaseTool's parse-failure path.
				partial: false,
			} as ToolUse<"write_to_file">
			await writeToFileTool.handle(mockCline, block, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
			})

			expect(mockCline.diffViewProvider.revertChanges).not.toHaveBeenCalled()
			expect(mockCline.diffViewProvider.reset).toHaveBeenCalled()
			expect(writeToFileTool["taskPartialStreamState"].size).toBe(0)
		})

		it("releases the per-task stream state when the path is missing", async () => {
			// The missing-path return sits before execute()'s guarded scope, so it needs its own
			// release. The state is seeded first so the assertion proves a release happened rather
			// than an empty map.
			writeToFileTool["getTaskPartialStreamState"](mockCline as never)
			expect(writeToFileTool["taskPartialStreamState"].size).toBe(1)

			const toolUse = {
				type: "tool_use",
				name: "write_to_file",
				params: { content: testContent },
				nativeArgs: { path: "", content: testContent },
				// An empty path is what the streaming parser produces for a not-yet-complete
				// argument object; the typed params cannot express it - hence the double assertion.
				partial: false,
			} as unknown as ToolUse<"write_to_file">
			await writeToFileTool.handle(mockCline, toolUse, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
			})

			expect(mockCline.recordToolError).toHaveBeenCalledWith("write_to_file")
			expect(writeToFileTool["taskPartialStreamState"].size).toBe(0)
			const abortListener = mockCline.once.mock.calls.find(
				([event]: unknown[]) => event === RooCodeEventName.TaskAborted,
			)?.[1]
			expect(abortListener).toBeInstanceOf(Function)
			expect(mockCline.off).toHaveBeenCalledWith(RooCodeEventName.TaskAborted, abortListener)
		})

		it("releases the per-task stream state when content is missing", async () => {
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
			await writeToFileTool.handle(mockCline, toolUse, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
			})

			expect(mockCline.sayAndCreateMissingParamError).toHaveBeenCalledWith("write_to_file", "content")
			expect(writeToFileTool["taskPartialStreamState"].size).toBe(0)
			const abortListener = mockCline.once.mock.calls.find(
				([event]: unknown[]) => event === RooCodeEventName.TaskAborted,
			)?.[1]
			expect(abortListener).toBeInstanceOf(Function)
			expect(mockCline.off).toHaveBeenCalledWith(RooCodeEventName.TaskAborted, abortListener)
		})
	})
	describe("per-task stream state isolation", () => {
		// A second task streaming through the same singleton while mockCline runs.
		// Structural double, same pattern as the partial-state-cleanup spec.
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

		it("releases this task's stream state when the completed block fails to parse", async () => {
			// A streaming delta had failed, so the guard is set; the final block then
			// arrives without nativeArgs, so execute() never runs.
			const state = writeToFileTool["getTaskPartialStreamState"](mockCline as never)
			state.streamFailed = true
			const other = buildStreamingTask("task-2", "instance-2")
			writeToFileTool["getTaskPartialStreamState"](other as never).streamFailed = true

			const block = {
				type: "tool_use",
				name: "write_to_file",
				params: {},
				partial: false,
			} as ToolUse<"write_to_file">
			await writeToFileTool.handle(mockCline, block, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
			})

			expect(mockHandleError).toHaveBeenCalledWith("parsing write_to_file args", expect.any(Error))
			// Otherwise the retained streamFailed suppresses the diff preview of every
			// later write_to_file in this task.
			expect(writeToFileTool["taskPartialStreamState"].has(`${mockCline.taskId}.${mockCline.instanceId}`)).toBe(
				false,
			)
			// ...and the cleanup must stay scoped: the other task is still streaming.
			expect(writeToFileTool["taskPartialStreamState"].get("task-2.instance-2")?.streamFailed).toBe(true)
		})
		it("releases this task's stream state when prevent-focus-disruption skips the partial preview", async () => {
			// handlePartial() registers the per-task entry (and its TaskAborted listener) before it
			// checks the experiment. With the experiment on, the delta returns without ever opening a
			// preview and never reaches execute()'s teardown, so the entry and the listener would stay
			// attached for the rest of the task's life - and a streamFailed mark armed by an earlier
			// delta would keep suppressing this task's later diff previews.
			mockCline.providerRef.deref.mockReturnValue({
				getState: vi.fn().mockResolvedValue({
					diagnosticsEnabled: true,
					writeDelayMs: 1000,
					experiments: { preventFocusDisruption: true },
				}),
			})

			const delta = (content: string) =>
				writeToFileTool.handle(
					mockCline,
					{
						type: "tool_use",
						name: "write_to_file",
						params: { path: testFilePath, content },
						nativeArgs: { path: testFilePath, content },
						partial: true,
					} as ToolUse<"write_to_file">,
					{
						askApproval: mockAskApproval,
						handleError: mockHandleError,
						pushToolResult: mockPushToolResult,
					},
				)

			// The first delta only pins the path; the second is the one that reaches the check.
			await delta("Line 1")
			await delta("Line 1\nLine 2")

			expect(mockCline.diffViewProvider.open).not.toHaveBeenCalled()
			expect(writeToFileTool["taskPartialStreamState"].size).toBe(0)
			// The exact listener this task registered, not just any function: a mismatched
			// off() argument would leave the real listener attached.
			const abortListener = mockCline.once.mock.calls.find(
				([event]: unknown[]) => event === RooCodeEventName.TaskAborted,
			)?.[1]
			expect(abortListener).toBeInstanceOf(Function)
			expect(mockCline.off).toHaveBeenCalledWith(RooCodeEventName.TaskAborted, abortListener)
		})

		it("releases the per-task stream state when the user rejects the diff-view approval", async () => {
			// The diff-view denial returns from inside execute()'s try. Without a release on that
			// path the entry and its TaskAborted listener survive a rejected write, and a
			// streamFailed mark armed by an earlier delta keeps suppressing this task's later
			// diff previews.
			writeToFileTool["getTaskPartialStreamState"](mockCline as never).streamFailed = true
			mockAskApproval.mockResolvedValueOnce(false)

			await executeWriteFileTool({})

			expect(mockCline.diffViewProvider.revertChanges).toHaveBeenCalled()
			expect(writeToFileTool["taskPartialStreamState"].size).toBe(0)
			// The exact listener this task registered, not just any function: a mismatched
			// off() argument would leave the real listener attached.
			const abortListener = mockCline.once.mock.calls.find(
				([event]: unknown[]) => event === RooCodeEventName.TaskAborted,
			)?.[1]
			expect(abortListener).toBeInstanceOf(Function)
			expect(mockCline.off).toHaveBeenCalledWith(RooCodeEventName.TaskAborted, abortListener)
		})

		it("releases the per-task stream state when the prevent-focus-disruption approval is rejected", async () => {
			// Same leak on the experiment branch: the denial returns without a teardown, so the
			// listener stays attached for the rest of the task's life.
			mockCline.providerRef.deref.mockReturnValue({
				getState: vi.fn().mockResolvedValue({
					diagnosticsEnabled: true,
					writeDelayMs: 1000,
					experiments: { preventFocusDisruption: true },
				}),
			})
			writeToFileTool["getTaskPartialStreamState"](mockCline as never).streamFailed = true
			mockAskApproval.mockResolvedValueOnce(false)

			await executeWriteFileTool({})

			expect(mockAskApproval).toHaveBeenCalled()
			expect(writeToFileTool["taskPartialStreamState"].size).toBe(0)
			// The exact listener this task registered, not just any function: a mismatched
			// off() argument would leave the real listener attached.
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

		it("keeps a failed rollback as the stream failure instead of dropping it", async () => {
			// Streaming failed (open() rejected) and the rollback that follows failed too: the
			// placeholder and any created directories are still on disk. Logging the revert failure
			// and dropping it leaves the next execute() to treat that debris as an existing file, so
			// the rollback failure has to become the failure this stream reports.
			mockCline.diffViewProvider.open.mockRejectedValue(
				Object.assign(new Error("EACCES: permission denied, open '/ro/test.py'"), { code: "EACCES" }),
			)
			mockCline.diffViewProvider.revertChanges.mockRejectedValue(
				Object.assign(new Error("EACCES: rollback failed"), { code: "EACCES" }),
			)

			// First delta pins the path, second reaches open().
			await executeWriteFileTool({}, { isPartial: true })
			await executeWriteFileTool({}, { isPartial: true })

			const state = writeToFileTool["taskPartialStreamState"].get(`${mockCline.taskId}.${mockCline.instanceId}`)
			expect(state?.streamFailed).toBe(true)
			expect(state?.streamError?.message).toContain("rollback failed")
			// The original streaming error must stay reachable behind the reported one.
			expect((state?.streamError?.cause as Error | undefined)?.message).toBe(
				"EACCES: permission denied, open '/ro/test.py'",
			)
		})

		it("reports only the execute() failure when the write is retried after a failed stream", async () => {
			// Combined path: a streaming delta failed (the failure is captured, not reported), then
			// the completed block arrives with valid nativeArgs, so execute() runs and retries the
			// same operation. Its failure is the single failure the user hears about - the captured
			// streaming error must not also surface, or the same write reports twice.
			mockCline.diffViewProvider.open.mockRejectedValue(
				Object.assign(new Error("EACCES: permission denied, open '/ro/test.py'"), { code: "EACCES" }),
			)

			// First delta pins the path, second reaches open() and captures the failure.
			await executeWriteFileTool({}, { isPartial: true })
			await executeWriteFileTool({}, { isPartial: true })
			expect(mockHandleError).not.toHaveBeenCalled()
			const state = writeToFileTool["taskPartialStreamState"].get(`${mockCline.taskId}.${mockCline.instanceId}`)
			expect(state?.streamFailed).toBe(true)
			expect(state?.streamError?.message).toBe("EACCES: permission denied, open '/ro/test.py'")

			// The completed block: open() works now, the write itself fails.
			mockCline.diffViewProvider.open.mockResolvedValue(undefined)
			mockCline.diffViewProvider.saveChanges.mockRejectedValue(new Error("EROFS: read-only file system, write"))

			await executeWriteFileTool({})

			expect(mockHandleError).toHaveBeenCalledTimes(1)
			expect(mockHandleError).toHaveBeenCalledWith(
				"writing file",
				expect.objectContaining({ message: "EROFS: read-only file system, write" }),
			)
			expect(mockHandleError).not.toHaveBeenCalledWith(
				"writing file",
				expect.objectContaining({ message: "EACCES: permission denied, open '/ro/test.py'" }),
			)
			expect(writeToFileTool["taskPartialStreamState"].size).toBe(0)
		})

		it("reports the rollback failure once when the parse-failure cleanup cannot revert the diff", async () => {
			// A streaming delta captured a fatal error; the finalized block then fails to parse, so
			// the parse-failure cleanup runs - and its revertChanges() fails too. The rollback
			// failure is the actionable one: it must be reported exactly once, with the captured
			// streaming error kept as its cause, and the incidental parse error must stay silent.
			mockCline.diffViewProvider.open.mockRejectedValue(new Error("EACCES: stream open failed"))
			await executeWriteFileTool({}, { isPartial: true })
			await executeWriteFileTool({}, { isPartial: true })
			const state = writeToFileTool["taskPartialStreamState"].get(`${mockCline.taskId}.${mockCline.instanceId}`)
			const captured = state?.streamError
			expect(captured?.message).toBe("EACCES: stream open failed")

			// The stream had a diff view open - that is the state a rollback is for.
			mockCline.diffViewProvider.isEditing = true
			mockCline.diffViewProvider.revertChanges.mockRejectedValue(new Error("EACCES: rollback failed"))

			const block = {
				type: "tool_use",
				name: "write_to_file",
				params: {},
				partial: false,
			} as ToolUse<"write_to_file">
			await writeToFileTool.handle(mockCline, block, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
			})

			expect(mockHandleError).toHaveBeenCalledTimes(1)
			const [context, reported] = mockHandleError.mock.calls[0]
			expect(context).toBe("writing file")
			expect(reported.message).toContain("rollback failed")
			expect(reported.cause).toBe(captured)
			expect(mockHandleError).not.toHaveBeenCalledWith("parsing write_to_file args", expect.any(Error))
			expect(writeToFileTool["taskPartialStreamState"].size).toBe(0)
		})

		it("reports the captured streaming error once when two real deltas fail and the rollback succeeds", async () => {
			// The capture-to-report path end to end: two real partial deltas with open() rejecting,
			// then the completed block without nativeArgs so execute() never runs and
			// onParameterParseFailure() is the only reporter. The rollback succeeds, so the captured
			// streaming error - not the incidental parse error - must reach the user exactly once.
			mockCline.diffViewProvider.open.mockRejectedValue(new Error("EACCES: stream open failed"))
			await executeWriteFileTool({}, { isPartial: true })
			await executeWriteFileTool({}, { isPartial: true })
			const state = writeToFileTool["taskPartialStreamState"].get(`${mockCline.taskId}.${mockCline.instanceId}`)
			const captured = state?.streamError
			expect(captured?.message).toBe("EACCES: stream open failed")

			// The stream left a diff view open; revertChanges() keeps its resolved default, so the
			// rollback succeeds and nothing re-stamps the captured error.
			mockCline.diffViewProvider.isEditing = true

			const block = {
				type: "tool_use",
				name: "write_to_file",
				params: {},
				partial: false,
			} as ToolUse<"write_to_file">
			await writeToFileTool.handle(mockCline, block, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
			})

			expect(mockHandleError).toHaveBeenCalledTimes(1)
			// Identity, not just text: the report must be the original streaming error object.
			expect(mockHandleError.mock.calls[0][0]).toBe("writing file")
			expect(mockHandleError.mock.calls[0][1]).toBe(captured)
			expect(mockHandleError).not.toHaveBeenCalledWith("parsing write_to_file args", expect.any(Error))
			expect(writeToFileTool["taskPartialStreamState"].size).toBe(0)
		})

		it("reports a rollback failure under its own message and keeps the parse error when no stream failed", async () => {
			// The diff view opened without any streaming failure; the completed block then fails to
			// parse and the rollback itself fails. Reporting "after a streaming error" would describe
			// a failure that never happened and would swallow the malformed tool call, so the rollback
			// reports under its own message and the parse error is still delivered.
			writeToFileTool["getTaskPartialStreamState"](mockCline as never)
			mockCline.diffViewProvider.isEditing = true
			mockCline.diffViewProvider.revertChanges.mockRejectedValue(new Error("EACCES: rollback failed"))

			const block = {
				type: "tool_use",
				name: "write_to_file",
				params: {},
				partial: false,
			} as ToolUse<"write_to_file">
			await writeToFileTool.handle(mockCline, block, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
			})

			expect(mockHandleError).toHaveBeenCalledTimes(2)
			const [context, reported] = mockHandleError.mock.calls[0]
			expect(context).toBe("writing file")
			expect(reported.message).toBe("write_to_file rollback failed: EACCES: rollback failed")
			expect(reported.message).not.toContain("streaming error")
			expect(reported.cause).toBeInstanceOf(Error)
			// The parse error is the actionable report for the model: it must still be delivered.
			expect(mockHandleError.mock.calls[1][0]).toBe("parsing write_to_file args")
			expect(writeToFileTool["taskPartialStreamState"].size).toBe(0)
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
})
