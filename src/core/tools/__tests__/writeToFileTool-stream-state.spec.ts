// The five describes below are the #1931 unit's own tests, kept out of writeToFileTool.spec.ts so
// that file carries only main's tests plus this unit's edits to them. They were children of
// describe("writeToFileTool") before and remain children of it here, so every full test name is
// unchanged. The prelude below is a copy of that spec's module setup and describe-level doubles,
// pruned to what these tests use. No suppression and no Stryker directive appears in this file.

import * as path from "path"

import { RooCodeEventName } from "@roo-code/types"
import type { Mock, MockedFunction } from "vitest"
import type { Task } from "../../task/Task"

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

// The cline double below is a structural mirror of the members this unit's tests touch, so no
// `any` is needed: the copied prelude from writeToFileTool.spec.ts declares its double as
// `any` under a suppression, and a new file cannot inherit that suppression. The single double
// assertion below (cline to Task) is the repo's existing pattern for private-method tests
// (see src/core/tools/__tests__/writeToFileTool-partial-state-cleanup.spec.ts).
interface ClineDouble {
	api: { getModel: Mock }
	ask: Mock
	consecutiveMistakeCount: number
	cwd: string
	didEditFile: boolean
	diffStrategy: unknown
	diffViewProvider: {
		adoptCreatedDirs: Mock
		editType: string | undefined
		isEditing: boolean
		open: Mock
		originalContent: string
		pushToolWriteResult: Mock
		reset: Mock
		revertChanges: Mock
		saveChanges: Mock
		scrollToFirstDiff: Mock
		update: Mock
		updateDiagnosticSettings: Mock
	}
	fileContextTracker: { trackFileContext: Mock }
	finalizePartialToolAsk: Mock
	instanceId: string
	off: Mock
	once: Mock
	processQueuedMessages: Mock
	providerRef: { deref: Mock }
	recordToolError: Mock
	rooIgnoreController: { validateAccess: Mock }
	say: Mock
	sayAndCreateMissingParamError: Mock
	taskId: string
}
describe("writeToFileTool", () => {
	// Test data
	const testFilePath = "test/file.txt"
	const absoluteFilePath = process.platform === "win32" ? "C:\\test\\file.txt" : "/test/file.txt"
	const testContent = "Line 1\nLine 2\nLine 3"

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

	const mockCline = {} as ClineDouble
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
				this: { userEdits?: string | null },
				task: Task,
				_cwd: string,
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
		// Assigned here rather than inside executeWriteFileTool(): the rows in this file call execute()
		// directly and bypass that helper, so a callback created only there is undefined for them and
		// the tool dies on "pushToolResult is not a function" before it reaches the state release the
		// row is about. Fresh per test, so the call count below is this test's own.
		mockPushToolResult = vi.fn((result: ToolResponse) => {
			toolResult = result
		})
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
		const toolUse: ToolUse<"write_to_file"> = {
			type: "tool_use",
			name: "write_to_file",
			params: {
				path: testFilePath,
				content: testContent,
				...params,
			},
			nativeArgs: {
				path: params.path ?? testFilePath,
				content: params.content ?? testContent,
			},
			partial: isPartial,
		}

		// The double above mirrors only the members these tests exercise; the tool reads the
		// full Task at runtime.
		await writeToFileTool.handle(mockCline as unknown as Task, toolUse, {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
			toolCallId: "test-tool-call-id",
		})

		return toolResult
	}

	describe("path stabilization predicate", () => {
		// The predicate is exercised directly (it is private) because not all of its branches are
		// observable through handlePartial(): an undefined path reaches the same early return either
		// way, so the clause-by-clause behavior must be pinned at the predicate level.
		function makeState(lastSeenPartialPath: string | undefined) {
			return {
				lastSeenPartialPath,
				streamFailed: false,
				streamError: undefined,
				task: mockCline as unknown as Task,
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

			await writeToFileTool.execute({ path: "", content: "mock content" }, mockCline as unknown as Task, {
				askApproval: mockAskApproval,
				toolCallId: "test-tool-call-id",
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
			})

			expect(writeToFileTool["taskPartialStreamState"].size).toBe(0)
			expect(mockCline.diffViewProvider.reset).toHaveBeenCalled()
			// The early return reports the missing parameter through the callback it was handed, and only
			// then reaches the release the two rows above pin. Asserting the report keeps the row from
			// passing on a call that skipped both.
			expect(mockPushToolResult).toHaveBeenCalledTimes(1)
			expect(mockPushToolResult).toHaveBeenCalledWith("Missing param error")
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
					writeToFileTool.clearTaskState(mockCline as unknown as Task)
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
				writeToFileTool.clearTaskState(mockCline as unknown as Task)
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
				writeToFileTool.clearTaskState(mockCline as unknown as Task)
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
				writeToFileTool.clearTaskState(mockCline as unknown as Task)
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
				writeToFileTool.clearTaskState(mockCline as unknown as Task)
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
			await writeToFileTool.handle(mockCline as unknown as Task, toolUse, {
				askApproval: mockAskApproval,
				toolCallId: "test-tool-call-id",
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

		it("still rolls back and resets when the error report throws because the task is aborted", async () => {
			// say() throws once the task is aborted, and handleError reports through it. The
			// rollback and reset still have to run, or the diff view keeps unapproved content.
			mockCline.diffViewProvider.saveChanges.mockRejectedValue(new Error("save failed"))
			// Asserted by identity to the exact rejection the failing report produced, not by a bare
			// abort substring: a substring also matches a raw SDK error, which is what the
			// abortSubstringSelector that arrived on main now rejects in every spec lane.
			const reportFailure = new Error("aborted")
			mockHandleError.mockRejectedValueOnce(reportFailure)

			const surfaced = await executeWriteFileTool({}).catch((error: unknown) => error)
			expect(surfaced).toBe(reportFailure)

			expect(mockCline.diffViewProvider.revertChanges).toHaveBeenCalled()
			expect(mockCline.diffViewProvider.reset).toHaveBeenCalled()
			expect(writeToFileTool["taskPartialStreamState"].size).toBe(0)
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
