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
			"creates parent directories when path has stabilized (partial)",
			async () => {
				// First call - path not yet stabilized
				await executeWriteFileTool({}, { fileExists: false, isPartial: true })
				expect(mockedCreateDirectoriesForFile).not.toHaveBeenCalled()

				// Second call with same path - path is now stabilized
				await executeWriteFileTool({}, { fileExists: false, isPartial: true })
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
			// Exact payload streamed as the partial tool ask for this scenario; a weaker
			// matcher would pass a mutant that finalizes with the wrong text and still
			// leaves the spinner stuck.
			const expectedPartialToolMessage = JSON.stringify({
				tool: "newFileCreated",
				path: "test/path.txt",
				content: testContent,
				isOutsideWorkspace: false,
				isProtected: false,
			})
			mockCline.diffViewProvider.saveChanges.mockRejectedValue(new Error("save failed"))

			await executeWriteFileTool({})

			expect(mockHandleError).toHaveBeenCalledWith("writing file", expect.any(Error))
			expect(mockCline.finalizePartialToolAsk).toHaveBeenCalledWith(expectedPartialToolMessage)
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

		it("handles partial streaming errors after path stabilizes", async () => {
			mockCline.diffViewProvider.open.mockRejectedValue(new Error("Open failed"))

			// First call - path not yet stabilized, no error yet
			await executeWriteFileTool({}, { isPartial: true })
			expect(mockHandleError).not.toHaveBeenCalled()

			// Second call with same path - path is now stabilized, error occurs
			await executeWriteFileTool({}, { isPartial: true })
			expect(mockHandleError).toHaveBeenCalledWith("handling partial write_to_file", expect.any(Error))

		})
	})
})
