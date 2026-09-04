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
			saveDirectly: vi.fn().mockResolvedValue(undefined),
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
				// The missing-parameter tests inject `undefined` where
				// NativeToolArgs["write_to_file"] declares `string`, so the casts are required to
				// model a malformed payload.
				path: (Object.prototype.hasOwnProperty.call(params, "path") ? params.path : testFilePath) as any,
				content: (Object.prototype.hasOwnProperty.call(params, "content")
					? params.content
					: testContent) as any,
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

		it("finalizes the partial ask and clears per-task state when rooignore denies access", async () => {
			// handlePartial() has no rooignore guard, so streaming deltas for a denied path
			// still create a partial `tool` ask (partial: true) and open the diff view before
			// execute() reaches the access check. The denial must clean up all of that:
			// finalize the partial ask (spinner does not stick), revert the diff document so a
			// user save cannot persist the denied content, reset the diff view (reset failures
			// swallowed), and clear the per-task stream state (abort listener + entries).
			const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
			try {
				let abortCleanup: (() => void) | undefined
				mockCline.once.mockImplementation((event: RooCodeEventName, listener: () => void) => {
					if (event === RooCodeEventName.TaskAborted) {
						abortCleanup = listener
					}
					return mockCline
				})
				// Record the relative order of revertChanges() and reset(): vitest mocks expose
				// no invocationCallOrder, so the ordering assertion uses this sequence.
				const diffViewCallOrder: string[] = []
				mockCline.diffViewProvider.revertChanges.mockImplementation(async () => {
					diffViewCallOrder.push("revert")
				})
				mockCline.diffViewProvider.reset.mockImplementation(async () => {
					diffViewCallOrder.push("reset")
					throw new Error("reset failed")
				})

				// Stream two deltas so the path stabilizes: handlePartial registers the abort
				// cleanup and opens the partial ask + diff view for the (soon denied) path.
				await executeWriteFileTool({}, { fileExists: false, isPartial: true })
				await executeWriteFileTool({}, { fileExists: false, isPartial: true })
				expect(mockCline.ask).toHaveBeenCalledTimes(1)
				expect(mockCline.diffViewProvider.open).toHaveBeenCalledTimes(1)
				expect(abortCleanup).toBeTypeOf("function")

				// The completed block now reaches the access check, which denies the path.
				await executeWriteFileTool({}, { fileExists: false, accessAllowed: false })

				expect(mockCline.say).toHaveBeenCalledWith("rooignore_error", testFilePath)
				// The denial finalizes without a text match: any open partial tool ask is closed.
				expect(mockCline.finalizePartialToolAsk).toHaveBeenCalledWith(undefined)
				// The denied write's streamed content must be reverted from the diff document
				// BEFORE reset() clears the state revertChanges() relies on.
				expect(diffViewCallOrder).toEqual(["revert", "reset"])
				expect(mockHandleError).not.toHaveBeenCalled()
				expect(consoleErrorSpy).toHaveBeenCalledWith(
					"Error resetting write_to_file diff view:",
					expect.any(Error),
				)
				expect(mockCline.off).toHaveBeenCalledWith(RooCodeEventName.TaskAborted, abortCleanup)
			} finally {
				consoleErrorSpy.mockRestore()
			}
		})
	})

	describe("missing-parameter early-return cleanup", () => {
		// handlePartial() has no missing-parameter guard: two partial streaming calls
		// stabilize the path and open the partial `tool` ask + diff view. This establishes
		// the "partial ask is open" precondition for the missing-parameter branches below.
		async function streamPartialAsk() {
			await executeWriteFileTool({}, { fileExists: false, isPartial: true })
			await executeWriteFileTool({}, { fileExists: false, isPartial: true })
			expect(mockCline.ask).toHaveBeenCalledTimes(1)
		}

		it("finalizes the partial ask when content is missing after partial streaming", async () => {
			// Streaming deltas create a partial `tool` ask (partial: true), then the completed
			// payload is missing `content`. The missing-parameter branch must finalize the ask
			// (the spinner must not stick) and still perform the same diff-view revert / reset
			// and per-task-state cleanup as the other early-return paths.
			await streamPartialAsk()

			await executeWriteFileTool({ content: undefined }, { fileExists: false })

			expect(mockCline.sayAndCreateMissingParamError).toHaveBeenCalledWith("write_to_file", "content")
			// The missing-parameter path finalizes without a text match: any open partial ask is closed.
			expect(mockCline.finalizePartialToolAsk).toHaveBeenCalledWith(undefined)
			expect(mockCline.diffViewProvider.revertChanges).toHaveBeenCalled()
			expect(mockCline.diffViewProvider.reset).toHaveBeenCalled()
			expect(mockHandleError).not.toHaveBeenCalled()
		})

		it("finalizes the partial ask when path is missing after partial streaming", async () => {
			// Same scenario with the `path` field missing: the missing-`path` branch must run
			// the identical partial-ask + diff-view + per-task-state cleanup.
			await streamPartialAsk()

			await executeWriteFileTool({ path: undefined }, { fileExists: false })

			expect(mockCline.sayAndCreateMissingParamError).toHaveBeenCalledWith("write_to_file", "path")
			expect(mockCline.finalizePartialToolAsk).toHaveBeenCalledWith(undefined)
			expect(mockCline.diffViewProvider.revertChanges).toHaveBeenCalled()
			expect(mockCline.diffViewProvider.reset).toHaveBeenCalled()
			expect(mockHandleError).not.toHaveBeenCalled()
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

		it("does not report a successful write as failed when final diff reset rejects", async () => {
			const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
			try {
				mockCline.diffViewProvider.reset.mockRejectedValue(new Error("reset failed"))

				await executeWriteFileTool({}, { fileExists: false })

				expect(mockHandleError).not.toHaveBeenCalled()
				expect(mockPushToolResult).toHaveBeenCalledWith("Tool result message")
				expect(mockCline.didEditFile).toBe(true)
				expect(consoleErrorSpy).toHaveBeenCalledWith(
					"Error resetting write_to_file diff view:",
					expect.any(Error),
				)
			} finally {
				consoleErrorSpy.mockRestore()
			}
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
	})

	describe("path stabilization predicate", () => {
		// The predicate is exercised directly (it is private) because not all of its branches are
		// observable through handlePartial(): an undefined path reaches the same early return either
		// way, so the clause-by-clause behavior must be pinned at the predicate level.
		function makeState(lastSeenPartialPath: string | undefined) {
			return {
				lastSeenPartialPath,
				streamFailed: false,
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

		it("uses safe reset and clears partial state when path is missing", async () => {
			const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
			try {
				let abortCleanup: (() => void) | undefined
				mockCline.once.mockImplementation((event: RooCodeEventName, listener: () => void) => {
					if (event === RooCodeEventName.TaskAborted) {
						abortCleanup = listener
					}
					return mockCline
				})
				mockCline.diffViewProvider.reset.mockRejectedValue(new Error("reset failed"))

				await executeWriteFileTool({}, { isPartial: true })
				await executeWriteFileTool({ path: "" })

				expect(mockCline.recordToolError).toHaveBeenCalledWith("write_to_file")
				expect(mockPushToolResult).toHaveBeenCalledWith("Missing param error")
				expect(mockHandleError).not.toHaveBeenCalled()
				expect(consoleErrorSpy).toHaveBeenCalledWith(
					"Error resetting write_to_file diff view:",
					expect.any(Error),
				)
				expect(mockCline.off).toHaveBeenCalledWith(RooCodeEventName.TaskAborted, abortCleanup)
			} finally {
				consoleErrorSpy.mockRestore()
			}
		})

		it("uses safe reset and clears partial state when content is missing", async () => {
			const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
			try {
				let abortCleanup: (() => void) | undefined
				mockCline.once.mockImplementation((event: RooCodeEventName, listener: () => void) => {
					if (event === RooCodeEventName.TaskAborted) {
						abortCleanup = listener
					}
					return mockCline
				})
				mockCline.diffViewProvider.reset.mockRejectedValue(new Error("reset failed"))

				await executeWriteFileTool({}, { isPartial: true })
				await executeWriteFileTool({ content: undefined })

				expect(mockCline.recordToolError).toHaveBeenCalledWith("write_to_file")
				expect(mockPushToolResult).toHaveBeenCalledWith("Missing param error")
				expect(mockHandleError).not.toHaveBeenCalled()
				expect(consoleErrorSpy).toHaveBeenCalledWith(
					"Error resetting write_to_file diff view:",
					expect.any(Error),
				)
				expect(mockCline.off).toHaveBeenCalledWith(RooCodeEventName.TaskAborted, abortCleanup)
			} finally {
				consoleErrorSpy.mockRestore()
			}
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
			expect(mockCline.finalizePartialToolAsk).toHaveBeenCalledTimes(1)
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

				expect(mockCline.finalizePartialToolAsk).toHaveBeenCalledTimes(1)
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

		it("does not reset consecutive mistake count when directory creation fails", async () => {
			mockCline.consecutiveMistakeCount = 3
			mockedCreateDirectoriesForFile.mockRejectedValue(
				Object.assign(new Error("EACCES: permission denied, mkdir '/ro'"), { code: "EACCES" }),
			)

			await executeWriteFileTool({}, { fileExists: false })

			expect(mockHandleError).toHaveBeenCalledWith("writing file", expect.any(Error))
			expect(mockCline.consecutiveMistakeCount).toBe(3)
		})

		it("reverts the diff document when the write fails before approval", async () => {
			// Regression test for the dirty-diff leak: streaming already opened the diff view
			// with unapproved content, and the write then failed before the user could approve
			// it. reset() alone left the diff document dirty with the streamed content -- a
			// user save in the editor would persist a write the task never completed. The
			// error path must revert the document (like the approval-denied path does) before
			// resetting the provider state.
			mockedCreateDirectoriesForFile.mockRejectedValue(
				Object.assign(new Error("EACCES: permission denied, mkdir '/ro'"), { code: "EACCES" }),
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

			// Stream two deltas so the diff view is open with the unapproved content...
			await executeWriteFileTool({}, { fileExists: false, isPartial: true })
			await executeWriteFileTool({}, { fileExists: false, isPartial: true })
			// ...then the completed block fails before approval
			await executeWriteFileTool({}, { fileExists: false })

			expect(mockHandleError).toHaveBeenCalledWith("writing file", expect.any(Error))
			expect(diffViewCallOrder).toEqual(["revert", "reset"])
		})

		it("continues cleanup when reverting the diff document fails before approval", async () => {
			// Pins the .catch arm on revertChanges() in revertDiffChangesBeforeReset(): a failed
			// revert (e.g. the diff view was already closed) must only be logged so the
			// remaining cleanup (diff view reset + per-task state teardown) always completes.
			const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
			try {
				mockedCreateDirectoriesForFile.mockRejectedValue(
					Object.assign(new Error("EACCES: permission denied, mkdir '/ro'"), { code: "EACCES" }),
				)
				mockCline.diffViewProvider.revertChanges.mockRejectedValue(new Error("revert failed"))

				// Stream two deltas so the diff view opens with the unapproved content...
				await executeWriteFileTool({}, { fileExists: false, isPartial: true })
				await executeWriteFileTool({}, { fileExists: false, isPartial: true })
				// ...then the completed block fails before approval and the revert fails too.
				await executeWriteFileTool({}, { fileExists: false })

				expect(mockHandleError).toHaveBeenCalledWith("writing file", expect.any(Error))
				expect(consoleErrorSpy).toHaveBeenCalledWith(
					"Error reverting write_to_file diff view changes:",
					expect.any(Error),
				)
				// The diff view is still reset and the per-task stream state still torn down.
				expect(mockCline.diffViewProvider.reset).toHaveBeenCalled()
				expect(mockCline.off).toHaveBeenCalledWith(RooCodeEventName.TaskAborted, expect.any(Function))
			} finally {
				consoleErrorSpy.mockRestore()
			}
		})

		it("keeps approved diff content in the editor when saving fails after approval", async () => {
			// The reverse of the previous test: once the user approved the write, the diff
			// content is their accepted edit. A late failure (e.g. saveChanges rejecting)
			// must NOT revert it -- the document stays dirty so the user can save it manually.
			mockCline.diffViewProvider.saveChanges.mockRejectedValueOnce(new Error("save failed"))

			await executeWriteFileTool({}, { fileExists: false })

			expect(mockHandleError).toHaveBeenCalledWith("writing file", expect.any(Error))
			expect(mockCline.diffViewProvider.saveChanges).toHaveBeenCalled()
			expect(mockCline.diffViewProvider.revertChanges).not.toHaveBeenCalled()
			expect(mockCline.diffViewProvider.reset).toHaveBeenCalled()
		})

		it("continues execute error cleanup when finalizing partial ask fails", async () => {
			const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
			try {
				mockedCreateDirectoriesForFile.mockRejectedValue(
					Object.assign(new Error("EACCES: permission denied, mkdir '/ro'"), { code: "EACCES" }),
				)
				mockCline.finalizePartialToolAsk.mockRejectedValue(new Error("finalize failed"))

				await executeWriteFileTool({}, { fileExists: false })

				// The execute error path finalizes without a text match: any open partial
				// tool ask is closed.
				expect(mockCline.finalizePartialToolAsk).toHaveBeenCalledWith(undefined)
				expect(mockHandleError).toHaveBeenCalledWith("writing file", expect.any(Error))
				expect(mockCline.diffViewProvider.revertChanges).toHaveBeenCalledTimes(1)
				expect(mockCline.diffViewProvider.reset).toHaveBeenCalled()
				expect(consoleErrorSpy).toHaveBeenCalledWith(
					"Error finalizing write_to_file partial tool ask:",
					expect.any(Error),
				)
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

		it("swallows diff view reset errors during partial failure cleanup", async () => {
			const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
			try {
				mockCline.diffViewProvider.open.mockRejectedValue(
					Object.assign(new Error("EROFS: read-only file system, mkdir '/scratch'"), { code: "EROFS" }),
				)
				mockCline.diffViewProvider.reset.mockRejectedValue(new Error("reset failed"))

				await executeWriteFileTool({}, { fileExists: false, isPartial: true })
				await executeWriteFileTool({}, { fileExists: false, isPartial: true })

				expect(mockCline.finalizePartialToolAsk).toHaveBeenCalledWith(expectedPartialToolMessage)
				expect(mockCline.diffViewProvider.revertChanges).toHaveBeenCalledTimes(1)
				expect(mockCline.diffViewProvider.reset).toHaveBeenCalled()
				expect(mockHandleError).not.toHaveBeenCalled()
				expect(consoleErrorSpy).toHaveBeenCalledWith(
					"Error resetting write_to_file diff view:",
					expect.any(Error),
				)
			} finally {
				consoleErrorSpy.mockRestore()
			}
		})

		it("continues partial failure cleanup when finalizing partial ask fails", async () => {
			const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
			try {
				mockCline.diffViewProvider.open.mockRejectedValue(
					Object.assign(new Error("EROFS: read-only file system, mkdir '/scratch'"), { code: "EROFS" }),
				)
				mockCline.finalizePartialToolAsk.mockRejectedValue(new Error("finalize failed"))

				await executeWriteFileTool({}, { fileExists: false, isPartial: true })
				await executeWriteFileTool({}, { fileExists: false, isPartial: true })

				expect(mockCline.finalizePartialToolAsk).toHaveBeenCalledWith(expectedPartialToolMessage)
				expect(mockCline.diffViewProvider.revertChanges).toHaveBeenCalledTimes(1)
				expect(mockCline.diffViewProvider.reset).toHaveBeenCalled()
				expect(mockHandleError).not.toHaveBeenCalled()
				expect(consoleErrorSpy).toHaveBeenCalledWith(
					"Error finalizing write_to_file partial tool ask:",
					expect.any(Error),
				)
			} finally {
				consoleErrorSpy.mockRestore()
			}
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

		it("EROFS in execute() routes through handleError with cleanup rather than escaping unhandled", async () => {
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
		})

		it("finalizes partial tool message on error so the UI spinner does not get stuck", async () => {
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

			// finalizePartialToolAsk must have been called (no text: the execute error
			// path closes whichever partial tool ask is open) to dismiss the spinner
			expect(mockCline.finalizePartialToolAsk).toHaveBeenCalledWith(undefined)
			// The write was never approved, so the diff document is reverted before reset
			expect(mockCline.diffViewProvider.revertChanges).toHaveBeenCalledTimes(1)
		})
	})

	describe("prevent focus disruption experiment", () => {
		/**
		 * Enable the PREVENT_FOCUS_DISRUPTION experiment for the current task: the experiment
		 * branches in execute()/handlePartial() read it from the provider state they fetch.
		 */
		function enablePreventFocusDisruption(): void {
			mockCline.providerRef = {
				deref: vi.fn().mockReturnValue({
					getState: vi.fn().mockResolvedValue({
						diagnosticsEnabled: true,
						writeDelayMs: 1000,
						experiments: { preventFocusDisruption: true },
					}),
				}),
			}
		}

		it("saves through saveDirectly without diff editor interaction when the experiment is enabled", async () => {
			enablePreventFocusDisruption()

			await executeWriteFileTool({}, { fileExists: false })

			expect(mockCline.diffViewProvider.saveDirectly).toHaveBeenCalledWith(
				testFilePath,
				testContent,
				false,
				true,
				1000,
			)
			expect(mockCline.diffViewProvider.saveChanges).not.toHaveBeenCalled()
			expect(mockCline.ask).not.toHaveBeenCalled()
			expect(mockCline.didEditFile).toBe(true)
			expect(toolResult).toBe("Tool result message")
		})

		it("keeps approved diff content when saveDirectly fails after approval", async () => {
			// The experiment branch stamps writeApproved before saveDirectly, so a late failure
			// must NOT revert the document (the user approved the edit and can save it
			// manually) but must still finalize the partial ask and reset the diff view.
			const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
			try {
				enablePreventFocusDisruption()
				mockCline.diffViewProvider.saveDirectly.mockRejectedValue(new Error("save failed"))

				await executeWriteFileTool({}, { fileExists: false })

				expect(mockHandleError).toHaveBeenCalledWith("writing file", expect.any(Error))
				expect(mockCline.finalizePartialToolAsk).toHaveBeenCalledWith(undefined)
				expect(mockCline.diffViewProvider.saveDirectly).toHaveBeenCalled()
				expect(mockCline.diffViewProvider.revertChanges).not.toHaveBeenCalled()
				expect(mockCline.diffViewProvider.reset).toHaveBeenCalled()
				expect(mockCline.didEditFile).toBe(false)
			} finally {
				consoleErrorSpy.mockRestore()
			}
		})

		it("skips streaming diff view work when the experiment is enabled", async () => {
			// With the experiment enabled the tool preview is embedded in the complete message
			// built in execute(), so handlePartial must not open or update the diff view while
			// streaming.
			enablePreventFocusDisruption()

			// Delta 1 - stabilize path; delta 2 - path stabilized but the experiment short-circuits
			await executeWriteFileTool({}, { fileExists: false, isPartial: true })
			await executeWriteFileTool({}, { fileExists: false, isPartial: true })

			expect(mockCline.ask).not.toHaveBeenCalled()
			expect(mockCline.diffViewProvider.open).not.toHaveBeenCalled()
			expect(mockCline.diffViewProvider.update).not.toHaveBeenCalled()
		})
	})
})
