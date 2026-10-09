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
		// Per-task entries are released by the tool's own teardown paths (execute() exits, the
		// handle() parse-failure hook, clearTaskState). The suite clears them explicitly so no
		// test inherits another test's stream state or abort listener.
		for (const state of [...writeToFileTool["taskPartialStreamState"].values()]) {
			writeToFileTool.clearTaskState(state.task)
		}

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
		it("resets only the singleton path and leaves every task's stream state alone", async () => {
			// The tool instance is a module-level singleton shared by concurrent tasks, so the
			// base-class reset owns only lastSeenPartialPath. Clearing every task's entry from here
			// would drop another task's streamFailed/streamError while it is still streaming; the
			// per-task teardown (execute() exits, the parse-failure hook, clearTaskState) owns those.
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

			writeToFileTool["lastSeenPartialPath"] = "stale-path"
			writeToFileTool.resetPartialState()

			expect(writeToFileTool["lastSeenPartialPath"]).toBeUndefined()
			expect(mockCline.off).not.toHaveBeenCalled()
			// The entry survives, and with it the per-task path stabilization: the next delta is
			// still the same live stream, so it goes straight to the partial ask instead of
			// restarting an un-stabilized sequence.
			await executeWriteFileTool({}, { isPartial: true })
			expect(mockCline.ask).toHaveBeenCalledTimes(2)
			expect(writeToFileTool["taskPartialStreamState"].size).toBe(1)

			// The task-scoped teardown is what releases it.
			writeToFileTool.clearTaskState(mockCline)
			expect(writeToFileTool["taskPartialStreamState"].size).toBe(0)
			expect(mockCline.off).toHaveBeenCalledWith(RooCodeEventName.TaskAborted, abortCleanup)
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

	describe("early-exit stream state cleanup", () => {

		it("releases this task's stream state when the completed block fails to parse", async () => {
			// The streaming deltas registered this task's entry; the finalized block then arrives
			// without nativeArgs, so execute() never runs and none of its teardown runs either.
			// Without a parse-failure boundary the entry and its TaskAborted listener survive for
			// the rest of the task's life, and the diff view keeps unapproved partial content.
			await executeWriteFileTool({}, { isPartial: true })
			await executeWriteFileTool({}, { isPartial: true })
			expect(writeToFileTool["taskPartialStreamState"].size).toBe(1)

			const block = {
				type: "tool_use",
				name: "write_to_file",
				params: {},
				// No nativeArgs at all: that is what drives BaseTool's parse-failure path, where
				// execute() and all of its teardown are skipped.
			} as ToolUse<"write_to_file">
			await writeToFileTool.handle(mockCline, block, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
			})

			expect(writeToFileTool["taskPartialStreamState"].size).toBe(0)
			const abortListener = mockCline.once.mock.calls.find(
				([event]: unknown[]) => event === RooCodeEventName.TaskAborted,
			)?.[1]
			expect(abortListener).toBeInstanceOf(Function)
			expect(mockCline.off).toHaveBeenCalledWith(RooCodeEventName.TaskAborted, abortListener)
			// The stream may have left a diff view open with content that was never approved.
			expect(mockCline.diffViewProvider.revertChanges).toHaveBeenCalled()
			expect(mockCline.diffViewProvider.reset).toHaveBeenCalled()
			// Nothing was captured from the stream, so the parse error is still what the user sees.
			expect(mockHandleError).toHaveBeenCalledWith("parsing write_to_file args", expect.any(Error))
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
		it("releases the per-task stream state when a rooignore denial returns early", async () => {
			// A partial delta creates the per-task state and registers the abort listener; the
			// denial then returns before the cleanup, which used to leave both behind for the
			// task's lifetime (a retained streamFailed also suppresses later diff previews).
			await executeWriteFileTool({}, { isPartial: true })
			expect(writeToFileTool["taskPartialStreamState"].size).toBe(1)

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

		it("releases the per-task stream state when a missing parameter returns early", async () => {
			await executeWriteFileTool({}, { isPartial: true })
			expect(writeToFileTool["taskPartialStreamState"].size).toBe(1)

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
		it("releases the per-task stream state when the user rejects the diff-view approval", async () => {
			// A partial delta registers the entry and the TaskAborted listener. The denial then
			// returns from inside the try block, skipping the success-path teardown, so both stay
			// attached for the rest of the task's life (and a retained streamFailed would keep
			// suppressing this task's later diff previews).
			await executeWriteFileTool({}, { isPartial: true })
			expect(writeToFileTool["taskPartialStreamState"].size).toBe(1)
			mockAskApproval.mockResolvedValue(false)
			await executeWriteFileTool({})
			expect(mockCline.diffViewProvider.revertChanges).toHaveBeenCalledTimes(1)
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
			// The experiment branch asks for approval without ever opening a diff view, so the
			// only teardown for this call is the one at the end of the try block - which the
			// denial return skips.
			await executeWriteFileTool({}, { isPartial: true })
			expect(writeToFileTool["taskPartialStreamState"].size).toBe(1)
			mockCline.providerRef.deref.mockReturnValue({
				getState: vi.fn().mockResolvedValue({
					diagnosticsEnabled: true,
					writeDelayMs: 1000,
					experiments: { preventFocusDisruption: true },
				}),
			})
			mockCline.diffViewProvider.saveDirectly = vi.fn().mockResolvedValue(undefined)
			mockAskApproval.mockResolvedValue(false)
			await executeWriteFileTool({})
			expect(mockCline.diffViewProvider.saveDirectly).not.toHaveBeenCalled()
			expect(writeToFileTool["taskPartialStreamState"].size).toBe(0)
			// The exact listener this task registered, not just any function: a mismatched
			// off() argument would leave the real listener attached.
			const abortListener = mockCline.once.mock.calls.find(
				([event]: unknown[]) => event === RooCodeEventName.TaskAborted,
			)?.[1]
			expect(abortListener).toBeInstanceOf(Function)
			expect(mockCline.off).toHaveBeenCalledWith(RooCodeEventName.TaskAborted, abortListener)
		})
		it("releases the per-task stream state when prevent-focus-disruption skips the partial preview", async () => {
			// The first delta only pins the path, so the entry is still live after it (the stream
			// is in flight). The second delta reaches the experiment check: handlePartial() then
			// returns without ever showing a preview, and nothing else would ever release the
			// entry or detach the TaskAborted listener for this task.
			mockCline.providerRef.deref.mockReturnValue({
				getState: vi.fn().mockResolvedValue({ experiments: { preventFocusDisruption: true } }),
			})

			await executeWriteFileTool({}, { isPartial: true })
			expect(writeToFileTool["taskPartialStreamState"].size).toBe(1)

			await executeWriteFileTool({}, { isPartial: true })

			expect(mockCline.ask).not.toHaveBeenCalled()
			expect(writeToFileTool["taskPartialStreamState"].size).toBe(0)
			// The exact listener this task registered, not just any function: a mismatched
			// off() argument would leave the real listener attached.
			const abortListener = mockCline.once.mock.calls.find(
				([event]: unknown[]) => event === RooCodeEventName.TaskAborted,
			)?.[1]
			expect(abortListener).toBeInstanceOf(Function)
			expect(mockCline.off).toHaveBeenCalledWith(RooCodeEventName.TaskAborted, abortListener)
		})

		it("stops the partial delta when the task aborts while directory creation is in flight", async () => {
			// handlePartial() awaits createDirectoriesForFile() for a new file, then asks and streams
			// the diff view. An abandonment that lands during that await has already released this
			// task's stream state; without a re-check after the await the delta keeps going and puts a
			// partial tool ask and a diff-view update on screen for a task that no longer exists.
			let abortCleanup: (() => void) | undefined
			mockCline.once.mockImplementation((event: RooCodeEventName, listener: () => void) => {
				if (event === RooCodeEventName.TaskAborted) {
					abortCleanup = listener
				}
				return mockCline
			})
			await executeWriteFileTool({}, { fileExists: false, isPartial: true })

			let releaseGate: (() => void) | undefined
			const gate = new Promise<void>((resolve) => {
				releaseGate = resolve
			})
			mockedCreateDirectoriesForFile.mockImplementationOnce(() => gate.then(() => []))
			const streaming = executeWriteFileTool({}, { fileExists: false, isPartial: true })
			await new Promise<void>((resolve) => setImmediate(resolve))
			expect(mockedCreateDirectoriesForFile).toHaveBeenCalledTimes(1)

			abortCleanup?.()
			releaseGate?.()
			await streaming

			expect(writeToFileTool["taskPartialStreamState"].size).toBe(0)
			expect(mockCline.ask).not.toHaveBeenCalled()
			expect(mockCline.diffViewProvider.open).not.toHaveBeenCalled()
			expect(mockCline.diffViewProvider.update).not.toHaveBeenCalled()
		})

		it("releases the per-task stream state when provider state rejects during a partial delta", async () => {
			// handlePartial() registers the entry and the TaskAborted listener, then awaits
			// provider.getState(). A rejection there never reaches the diff view or execute(), so
			// nothing else releases what the registration acquired. The error still has to surface,
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

		it("reports the captured stream error once when the finalized block fails to parse", async () => {
			// A streaming delta already hit a fatal filesystem error; the finalized block then fails
			// to parse. The stream error is what the user can act on, so it takes the report slot and
			// the incidental parse error is suppressed - reporting both would show two bubbles for one
			// failure, reporting only the parse error would drop the actionable one.
			await executeWriteFileTool({}, { isPartial: true })
			await executeWriteFileTool({}, { isPartial: true })
			const streamError = new Error("EROFS: read-only file system, open '/ro/test.py'")
			;[...writeToFileTool["taskPartialStreamState"].values()][0].streamError = streamError

			const block = {
				type: "tool_use",
				name: "write_to_file",
				params: {},
				// No nativeArgs at all: that is what drives BaseTool's parse-failure path.
				partial: false,
			} as ToolUse<"write_to_file">
			await writeToFileTool.handle(mockCline, block, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
			})

			expect(mockHandleError).toHaveBeenCalledTimes(1)
			expect(mockHandleError).toHaveBeenCalledWith("writing file", streamError)
			expect(mockHandleError).not.toHaveBeenCalledWith("parsing write_to_file args", expect.any(Error))
			expect(writeToFileTool["taskPartialStreamState"].size).toBe(0)
		})

		it("reports a failed rollback as the cleanup failure when the finalized block fails to parse", async () => {
			// The rollback is what keeps unapproved streamed content off disk. When it fails, the
			// debris is the more actionable failure: it takes the report slot with the stream error
			// kept behind it as the cause, instead of being logged and continued past.
			await executeWriteFileTool({}, { isPartial: true })
			await executeWriteFileTool({}, { isPartial: true })
			const streamError = new Error("EACCES: permission denied, open '/ro/test.py'")
			;[...writeToFileTool["taskPartialStreamState"].values()][0].streamError = streamError
			mockCline.diffViewProvider.revertChanges.mockRejectedValue(
				new Error("EACCES: could not remove the directory created for this write"),
			)

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
			expect(mockHandleError).toHaveBeenCalledWith(
				"writing file",
				expect.objectContaining({ message: expect.stringContaining("rollback failed") }),
			)
			expect(mockHandleError.mock.calls[0]?.[1]).toHaveProperty("cause", streamError)
			expect(mockHandleError).not.toHaveBeenCalledWith("parsing write_to_file args", expect.any(Error))
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
