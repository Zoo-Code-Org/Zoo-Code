// Regression coverage for the malformed-completion path.
//
// presentAssistantMessage emits its own tool_result and returns for a completed known-tool block
// that has no nativeArgs, so tool.handle() is never reached and BaseTool's parse-failure teardown
// - the one this chain added - never runs. These tests drive the presenter itself, which is how a
// malformed streamed write_to_file actually reaches the teardown.

import { RooCodeEventName } from "@roo-code/types"
import { afterEach, beforeEach, describe, expect, it, vi, type MockedFunction } from "vitest"

import { type Task } from "../../task/Task"
import { DispatchState } from "../../task/dispatchState"
import type { RequestPolicySnapshot } from "../../prompts/tools/effective-tool-policy"
import { isValidToolName } from "../../tools/validateToolUse"
import { writeToFileTool } from "../../tools/WriteToFileTool"
import { fileExistsAtPath } from "../../../utils/fs"

import { presentAssistantMessage } from "../presentAssistantMessage"

vi.mock("../../task/Task")
vi.mock("../../tools/validateToolUse", () => ({
	validateToolUse: vi.fn(),
	isValidToolName: vi.fn().mockReturnValue(true),
}))
// Only the filesystem probe and the readable-path helper have to be observable; every other
// export of those modules stays real, so the streaming path runs against the real code.
vi.mock("../../../utils/fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../utils/fs")>()
	return {
		...actual,
		fileExistsAtPath: vi.fn().mockResolvedValue(false),
		createDirectoriesForFile: vi.fn().mockResolvedValue([]),
	}
})
vi.mock("../../../utils/path", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../utils/path")>()
	return { ...actual, getReadablePath: (_cwd: string, relPath: string) => relPath }
})
vi.mock("../../../utils/pathUtils", () => ({
	isPathOutsideWorkspace: vi.fn().mockReturnValue(false),
}))
vi.mock("@roo-code/telemetry", () => ({
	TelemetryService: {
		instance: {
			captureToolUsage: vi.fn(),
			captureConsecutiveMistakeError: vi.fn(),
			captureException: vi.fn(),
		},
	},
}))

interface PushedToolResult {
	type: string
	tool_use_id: string
	content: string
	is_error?: boolean
}

// Structural double: the presenter and the streaming path only read these members. The double
// assertion in asTask() is the repo's existing pattern for presenter-level tests (see
// writeToFileTool-partial-state-cleanup.spec.ts); Task itself needs a live extension host.
interface PresenterTask {
	taskId: string
	instanceId: string
	cwd: string
	abort: boolean
	abandoned: boolean
	presentAssistantMessageLocked: boolean
	presentAssistantMessageHasPendingUpdates: boolean
	currentStreamingContentIndex: number
	currentStreamingDidCheckpoint: boolean
	assistantMessageContent: Array<Record<string, unknown>>
	userMessageContent: PushedToolResult[]
	didCompleteReadingStream: boolean
	userMessageContentReady: boolean
	activeToolContexts: Map<string, unknown>
	didRejectTool: boolean
	didAlreadyUseTool: boolean
	consecutiveMistakeCount: number
	api: { getModel: () => { id: string; info: Record<string, unknown> } }
	getTaskMode: MockedFunction<() => Promise<string>>
	recordToolUsage: MockedFunction<(name: string) => void>
	recordToolError: MockedFunction<(name: string, text?: string) => void>
	toolRepetitionDetector: { check: MockedFunction<() => { allowExecution: boolean }> }
	providerRef: { deref: () => { getState: () => Promise<Record<string, unknown>> } }
	say: MockedFunction<(type: string, text?: string, images?: unknown) => Promise<string | undefined>>
	ask: MockedFunction<(type: string, text?: string, partial?: boolean) => Promise<{ response: string }>>
	once: MockedFunction<(event: string, listener: () => void) => unknown>
	off: MockedFunction<(event: string, listener: () => void) => unknown>
	finalizePartialToolAsk: MockedFunction<(text?: string) => Promise<void>>
	pushToolResultToUserContent: MockedFunction<(result: PushedToolResult) => boolean>
	diffViewProvider: {
		editType: "modify" | "create" | undefined
		isEditing: boolean
		open: MockedFunction<(relPath: string) => Promise<void>>
		update: MockedFunction<(content: string, single: boolean) => Promise<void>>
		reset: MockedFunction<() => Promise<void>>
		revertChanges: MockedFunction<() => Promise<void>>
	}
}

const CALL_ID = "toolu_write_to_file_malformed"
const STREAM_FAILURE = "EACCES: permission denied, open 'src/demo.ts'"

function buildTask(): PresenterTask {
	const diffViewProvider: PresenterTask["diffViewProvider"] = {
		editType: undefined,
		isEditing: false,
		open: vi.fn().mockResolvedValue(undefined),
		update: vi.fn().mockResolvedValue(undefined),
		reset: vi.fn().mockResolvedValue(undefined),
		revertChanges: vi.fn().mockResolvedValue(undefined),
	}
	// Mirror the real provider: an open edit is what the rollback below is allowed to revert,
	// and both revert and reset end the edit.
	diffViewProvider.open.mockImplementation(async () => {
		diffViewProvider.isEditing = true
	})
	diffViewProvider.revertChanges.mockImplementation(async () => {
		diffViewProvider.isEditing = false
	})
	diffViewProvider.reset.mockImplementation(async () => {
		diffViewProvider.isEditing = false
	})

	const task: PresenterTask = {
		taskId: "task-1",
		instanceId: "instance-1",
		cwd: "/mock/cwd",
		abort: false,
		abandoned: false,
		presentAssistantMessageLocked: false,
		presentAssistantMessageHasPendingUpdates: false,
		currentStreamingContentIndex: 0,
		currentStreamingDidCheckpoint: true,
		assistantMessageContent: [],
		userMessageContent: [],
		didCompleteReadingStream: false,
		userMessageContentReady: false,
		didRejectTool: false,
		didAlreadyUseTool: false,
		consecutiveMistakeCount: 0,
		api: { getModel: () => ({ id: "test-model", info: {} }) },
		getTaskMode: vi.fn().mockResolvedValue("code"),
		recordToolUsage: vi.fn(),
		recordToolError: vi.fn(),
		toolRepetitionDetector: { check: vi.fn().mockReturnValue({ allowExecution: true }) },
		providerRef: { deref: () => ({ getState: async () => ({ experiments: {}, customModes: [] }) }) },
		say: vi.fn().mockResolvedValue(undefined),
		ask: vi.fn().mockResolvedValue({ response: "yesButtonClicked" }),
		once: vi.fn(),
		off: vi.fn(),
		finalizePartialToolAsk: vi.fn().mockResolvedValue(undefined),
		pushToolResultToUserContent: vi.fn((result: PushedToolResult) => {
			task.userMessageContent.push(result)
			return true
		}),
		diffViewProvider,
		activeToolContexts: new Map(),
		dispatchState: DispatchState.IDLE,
		pendingWork: null,
	}
	return task
}

// The double above is the documented shape of every presenter test in this directory.
const asTask = (task: PresenterTask): Task => task as unknown as Task

// The presenter validates against the request's frozen policy snapshot; the double has no policy.
const baseSnapshot: RequestPolicySnapshot = { disabledTools: [], customModes: [], experiments: {} }

async function present(task: PresenterTask, block: Record<string, unknown>): Promise<void> {
	task.assistantMessageContent = [block]
	task.currentStreamingContentIndex = 0
	await presentAssistantMessage(asTask(task), baseSnapshot)
}

const partialDelta = (content: string): Record<string, unknown> => ({
	type: "tool_use",
	id: CALL_ID,
	name: "write_to_file",
	params: { path: "src/demo.ts", content },
	partial: true,
})

// The completed block the parser could not finalize: no nativeArgs.
const malformedCompletion = (): Record<string, unknown> => ({
	type: "tool_use",
	id: CALL_ID,
	name: "write_to_file",
	params: {},
	partial: false,
})

const toolResultsFor = (task: PresenterTask): PushedToolResult[] =>
	task.userMessageContent.filter((block) => block.type === "tool_result" && block.tool_use_id === CALL_ID)

const errorSays = (task: PresenterTask): unknown[][] => task.say.mock.calls.filter(([type]) => type === "error")

// The listener this task registered, read from the registration itself rather than any function.
const registeredAbortListener = (task: PresenterTask): unknown =>
	task.once.mock.calls.find(([event]) => event === RooCodeEventName.TaskAborted)?.[1]

// Streams a delta whose diff-view update fails: handlePartial marks the stream failed and keeps
// the error for the authoritative report. The path only counts as stable once it has been seen
// twice, so the first delta only registers the entry and the second reaches the diff view.
async function streamFailedDelta(task: PresenterTask): Promise<void> {
	task.diffViewProvider.update.mockRejectedValueOnce(new Error(STREAM_FAILURE))
	await present(task, partialDelta("partial content"))
	await present(task, partialDelta("partial content"))
}

describe("presentAssistantMessage - abandoned write_to_file stream", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.mocked(isValidToolName).mockReturnValue(true)
		vi.mocked(fileExistsAtPath).mockReset().mockResolvedValue(false)
		vi.spyOn(console, "error").mockImplementation(() => {})
		writeToFileTool.resetPartialState()
	})

	afterEach(() => {
		writeToFileTool["taskPartialStreamState"].clear()
		vi.restoreAllMocks()
	})

	it("releases the abandoned stream state and reports the captured failure once", async () => {
		const task = buildTask()
		await streamFailedDelta(task)
		expect(writeToFileTool["taskPartialStreamState"].size).toBe(1)
		const abortListener = registeredAbortListener(task)
		expect(abortListener).toBeInstanceOf(Function)
		// The stream's own rollback already ran; clear it so the counts below only describe the
		// completion path.
		task.diffViewProvider.revertChanges.mockClear()
		task.diffViewProvider.reset.mockClear()

		await present(task, malformedCompletion())

		// The leak: the entry and its TaskAborted listener outlived the call.
		expect(writeToFileTool["taskPartialStreamState"].size).toBe(0)
		expect(task.off).toHaveBeenCalledWith(RooCodeEventName.TaskAborted, abortListener)
		// Exactly one tool_result for this tool_use_id, carrying the failure the user can act on
		// rather than the incidental "missing nativeArgs" text.
		const results = toolResultsFor(task)
		expect(results).toHaveLength(1)
		expect(results[0].is_error).toBe(true)
		expect(results[0].content).toContain(STREAM_FAILURE)
		expect(results[0].content).not.toContain("missing nativeArgs")
		// Counted by channel rather than toHaveBeenCalledWith: a count of matching says cannot
		// auto-pass when the error row is emitted more than once.
		const says = errorSays(task)
		expect(says).toHaveLength(1)
		expect(says[0][1]).toContain("Error writing file:")
		// The stream had already reverted, so only the reset is left to do.
		expect(task.diffViewProvider.revertChanges).not.toHaveBeenCalled()
		expect(task.diffViewProvider.reset).toHaveBeenCalledTimes(1)
	})

	it("restores the diff document an abandoned stream left open", async () => {
		const task = buildTask()
		writeToFileTool["getTaskPartialStreamState"](asTask(task))
		task.diffViewProvider.isEditing = true

		await present(task, malformedCompletion())

		// revertChanges() must run before reset(): reset clears the state the rollback reads, and
		// a dirty streamed buffer that survives it is saved by the next open() before approval.
		expect(task.diffViewProvider.revertChanges).toHaveBeenCalledTimes(1)
		expect(task.diffViewProvider.reset).toHaveBeenCalledTimes(1)
		expect(task.diffViewProvider.revertChanges.mock.invocationCallOrder[0]).toBeLessThan(
			task.diffViewProvider.reset.mock.invocationCallOrder[0],
		)
		expect(writeToFileTool["taskPartialStreamState"].size).toBe(0)
		// No streaming failure was captured, so the malformed-call report stays the actionable one.
		const results = toolResultsFor(task)
		expect(results).toHaveLength(1)
		expect(results[0].content).toContain("missing nativeArgs")
		expect(errorSays(task)).toHaveLength(0)
	})

	it("keeps the missing-nativeArgs result for a task that never streamed", async () => {
		const task = buildTask()

		await present(task, malformedCompletion())

		const results = toolResultsFor(task)
		expect(results).toHaveLength(1)
		expect(results[0].is_error).toBe(true)
		expect(results[0].content).toContain("missing nativeArgs")
		expect(errorSays(task)).toHaveLength(0)
		// The cleanup must not create state, touch the diff view, or register a listener for a
		// task that never streamed a write.
		expect(writeToFileTool["taskPartialStreamState"].size).toBe(0)
		expect(task.once).not.toHaveBeenCalled()
		expect(task.diffViewProvider.revertChanges).not.toHaveBeenCalled()
		expect(task.diffViewProvider.reset).not.toHaveBeenCalled()
	})

	it("lets the next write in the same task stream its diff preview again", async () => {
		const task = buildTask()
		await streamFailedDelta(task)
		const opensAfterFailure = task.diffViewProvider.open.mock.calls.length

		await present(task, malformedCompletion())

		// A retained streamFailed mark makes handlePartial() skip its work for every later delta,
		// so this task would never show a diff preview again.
		await present(task, partialDelta("next write"))
		await present(task, partialDelta("next write"))

		expect(task.diffViewProvider.open.mock.calls.length).toBe(opensAfterFailure + 1)
		expect(writeToFileTool["taskPartialStreamState"].size).toBe(1)
	})

	it("still emits the required tool_result when the error row cannot be saved", async () => {
		const task = buildTask()
		await streamFailedDelta(task)
		task.say.mockRejectedValue(new Error("chat row unavailable"))

		await expect(present(task, malformedCompletion())).resolves.toBeUndefined()

		// A rejected chat row must not strand the turn: the provider still needs exactly one
		// tool_result for this tool_use_id, and the block still has to be marked complete.
		const results = toolResultsFor(task)
		expect(results).toHaveLength(1)
		expect(results[0].content).toContain(STREAM_FAILURE)
		// The lost chat row must not change which failure is reported: the hook still answered
		// that its failure replaces the parse error.
		expect(results[0].content).not.toContain("missing nativeArgs")
		expect(writeToFileTool["taskPartialStreamState"].size).toBe(0)
		expect(task.userMessageContentReady).toBe(true)
	})

	it("keeps the malformed-call error when the rollback itself failed", async () => {
		const task = buildTask()
		writeToFileTool["getTaskPartialStreamState"](asTask(task))
		task.diffViewProvider.isEditing = true
		task.diffViewProvider.revertChanges.mockRejectedValue(new Error("restore refused"))

		await present(task, malformedCompletion())

		// A refused rollback is a second, distinct failure: the hook reports it and still returns
		// false, so the one tool_result has to carry both it and the malformed-call error - the
		// model otherwise never learns the call could not be finalized.
		const results = toolResultsFor(task)
		expect(results).toHaveLength(1)
		expect(results[0].content).toContain("write_to_file rollback failed: restore refused")
		expect(results[0].content).toContain("missing nativeArgs")
		const says = errorSays(task)
		expect(says).toHaveLength(1)
		expect(says[0][1]).toContain("Error writing file:")
		expect(writeToFileTool["taskPartialStreamState"].size).toBe(0)
	})
})
