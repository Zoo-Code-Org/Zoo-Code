// npx vitest src/core/assistant-message/__tests__/presentAssistantMessage-tool-repetition.spec.ts

import { providerIdentifiers } from "@roo-code/types"

import type { ToolUse } from "../../../shared/tools"
import { ToolRepetitionDetector } from "../../tools/ToolRepetitionDetector"
import { presentAssistantMessage } from "../presentAssistantMessage"

type ToolBlock = {
	type: string
	id?: string
	name?: string
	params?: Record<string, string>
	nativeArgs?: Record<string, string>
	partial?: boolean
}

type ToolResultBlock = {
	type: string
	tool_use_id?: string
	content?: string
	is_error?: boolean
	text?: string
}

type MockTask = Record<string, unknown>

// Mock dependencies
vi.mock("../../task/Task")
vi.mock("../../tools/validateToolUse", () => ({
	validateToolUse: vi.fn(),
	isValidToolName: vi.fn(() => true),
}))

// Translations are not loaded under test (see src/i18n/setup.ts), so the real
// `t` returns only the bare key and drops interpolation options. Return the
// key plus serialized options instead, so tests can assert both which message
// was selected and which tool name was interpolated, without depending on the
// English wording.
vi.mock("../../../i18n", () => ({
	t: (key: string, options?: Record<string, unknown>) => (options ? `${key} ${JSON.stringify(options)}` : key),
}))

// Mock the read_file tool so we can assert the normal execution path is taken
// when the repetition detector allows a tool call. The handle spy simulates a
// successful tool run by pushing a tool_result, mirroring the real tool.
// `vi.hoisted` is required because `vi.mock` factories are hoisted above
// top-level variable declarations.
const { readFileHandle, attemptCompletionHandle } = vi.hoisted(() => ({
	readFileHandle: vi.fn(
		async (_cline: unknown, block: ToolBlock, { pushToolResult }: { pushToolResult: (result: string) => void }) => {
			pushToolResult(`[read_file for '${block?.params?.path ?? block?.nativeArgs?.path}'] Result`)
		},
	),
	attemptCompletionHandle: vi.fn(async () => {}),
}))

vi.mock("../../tools/ReadFileTool", () => ({
	readFileTool: {
		handle: readFileHandle,
		getReadFileToolDescription: vi.fn(() => "[read_file]"),
	},
}))

// Mock attempt_completion so we can show the repetition check runs before
// dispatch for every tool, not just read_file.
vi.mock("../../tools/AttemptCompletionTool", () => ({
	attemptCompletionTool: {
		handle: attemptCompletionHandle,
	},
}))

const captureConsecutiveMistakeError = vi.fn()
const captureException = vi.fn()
const captureToolUsage = vi.fn()

vi.mock("@roo-code/telemetry", () => ({
	TelemetryService: {
		instance: {
			get captureToolUsage() {
				return captureToolUsage
			},
			get captureConsecutiveMistakeError() {
				return captureConsecutiveMistakeError
			},
			get captureException() {
				return captureException
			},
			captureEvent: vi.fn(),
		},
	},
}))

// Small explicit limits keep the priming in each test short:
// - 1st identical call: allowed
// - 2nd identical call: soft blocked
// - 3rd identical call: hard blocked
const SOFT_LIMIT = 1
const HARD_LIMIT = 2

function makeReadFileBlock(id: string, path = "test.txt"): ToolUse<"read_file"> {
	return {
		type: "tool_use",
		id,
		name: "read_file",
		params: { path },
		nativeArgs: { path },
		partial: false,
	}
}

function makeAttemptCompletionBlock(id: string, result = "done"): ToolUse<"attempt_completion"> {
	return {
		type: "tool_use",
		id,
		name: "attempt_completion",
		params: { result },
		nativeArgs: { result },
		partial: false,
	}
}

/**
 * Feeds `times` identical calls into the detector, simulating the model having
 * already made the same tool call that many times in earlier turns.
 */
function primeDetector(detector: ToolRepetitionDetector, block: ToolUse, times: number) {
	for (let i = 0; i < times; i++) {
		detector.check({ ...block })
	}
}

describe("presentAssistantMessage - Tool Repetition Detection", () => {
	let mockTask: MockTask
	let detector: ToolRepetitionDetector

	beforeEach(() => {
		vi.clearAllMocks()

		detector = new ToolRepetitionDetector(SOFT_LIMIT, HARD_LIMIT)

		mockTask = {
			taskId: "test-task-id",
			instanceId: "test-instance",
			abort: false,
			presentAssistantMessageLocked: false,
			presentAssistantMessageHasPendingUpdates: false,
			currentStreamingContentIndex: 0,
			assistantMessageContent: [],
			userMessageContent: [],
			didCompleteReadingStream: false,
			didRejectTool: false,
			didAlreadyUseTool: false,
			consecutiveMistakeCount: 0,
			consecutiveMistakeLimit: HARD_LIMIT,
			clineMessages: [],
			getTaskMode: vi.fn().mockResolvedValue("code"),
			apiConfiguration: { apiProvider: providerIdentifiers.anthropic },
			api: {
				getModel: () => ({ id: "test-model", info: {} }),
			},
			recordToolUsage: vi.fn(),
			recordToolError: vi.fn(),
			toolRepetitionDetector: detector,
			providerRef: {
				deref: () => ({
					getState: vi.fn().mockResolvedValue({
						mode: "code",
						customModes: [],
					}),
				}),
			},
			say: vi.fn().mockResolvedValue(undefined),
			ask: vi.fn().mockResolvedValue({ response: "yesButtonClicked" }),
		}

		mockTask.pushToolResultToUserContent = vi.fn().mockImplementation((toolResult: ToolResultBlock) => {
			const userMessageContent = mockTask.userMessageContent as ToolResultBlock[]
			const existingResult = userMessageContent.find(
				(block) => block.type === "tool_result" && block.tool_use_id === toolResult.tool_use_id,
			)
			if (existingResult) {
				return false
			}
			;(mockTask.userMessageContent as ToolResultBlock[]).push(toolResult)
			return true
		})
	})

	function findToolResult(toolCallId: string) {
		return (mockTask.userMessageContent as ToolResultBlock[]).find(
			(item) => item.type === "tool_result" && item.tool_use_id === toolCallId,
		)
	}

	async function present() {
		await presentAssistantMessage(mockTask as unknown as Parameters<typeof presentAssistantMessage>[0])
	}

	/**
	 * Resets the per-turn streaming state so a new assistant message can be
	 * presented, simulating the model's next turn.
	 */
	function startNextTurn(blocks: ToolUse[]) {
		mockTask.currentStreamingContentIndex = 0
		mockTask.presentAssistantMessageLocked = false
		mockTask.presentAssistantMessageHasPendingUpdates = false
		mockTask.didAlreadyUseTool = false
		mockTask.didRejectTool = false
		mockTask.userMessageContent = []
		mockTask.assistantMessageContent = blocks
	}

	it("should execute the tool normally on the first call", async () => {
		const toolCallId = "tool_call_allow"
		const block = makeReadFileBlock(toolCallId)
		mockTask.assistantMessageContent = [block]
		const checkSpy = vi.spyOn(detector, "check")

		await present()

		// The real detector should have been consulted with this block.
		expect(checkSpy).toHaveBeenCalledTimes(1)
		expect(checkSpy).toHaveBeenCalledWith(expect.objectContaining({ name: "read_file", id: toolCallId }))
		expect(checkSpy).toHaveReturnedWith({ action: "allow" })

		// No hard block ask should have occurred.
		expect(mockTask.ask).not.toHaveBeenCalledWith("mistake_limit_reached", expect.anything())

		// The tool must have actually continued into normal execution: the
		// read_file tool runner should have been dispatched with this block.
		expect(readFileHandle).toHaveBeenCalledTimes(1)
		const [, dispatchedBlock] = readFileHandle.mock.calls[0]
		expect(dispatchedBlock).toMatchObject({ name: "read_file", id: toolCallId })

		// And the normal execution path should have produced a tool_result
		// (no soft/hard block error message).
		const toolResult = findToolResult(toolCallId)
		expect(toolResult).toBeDefined()
		expect(toolResult?.content).toContain("read_file")
		expect(toolResult?.content).not.toContain("tools:toolRepetition")
		expect(toolResult?.is_error).toBeUndefined()
	})

	it("should execute the tool when the previous call had different arguments", async () => {
		primeDetector(detector, makeReadFileBlock("earlier", "other.txt"), SOFT_LIMIT + 1)

		const toolCallId = "tool_call_different_args"
		mockTask.assistantMessageContent = [makeReadFileBlock(toolCallId, "test.txt")]

		await present()

		expect(readFileHandle).toHaveBeenCalledTimes(1)
		expect(mockTask.ask).not.toHaveBeenCalled()
		expect(findToolResult(toolCallId)?.content).toContain("test.txt")
	})

	it("should soft block without involving the user and return an error to the model", async () => {
		const toolCallId = "tool_call_soft_block"
		const block = makeReadFileBlock(toolCallId)
		primeDetector(detector, block, SOFT_LIMIT)
		mockTask.assistantMessageContent = [block]

		await present()

		// The user should NOT have been asked anything for a soft block.
		expect(mockTask.ask).not.toHaveBeenCalled()

		// The tool must not be executed when it is soft blocked.
		expect(readFileHandle).not.toHaveBeenCalled()

		// A tool_result with the soft block message should have been pushed.
		const toolResult = findToolResult(toolCallId)
		// The content is the JSON produced by formatResponse.toolError(); the
		// detector's message is carried in its `error` field.
		expect(toolResult).toBeDefined()
		const { error } = JSON.parse(String(toolResult?.content)) as { error: string }
		expect(error).toBe(`tools:toolRepetitionSoftBlock ${JSON.stringify({ toolName: "read_file" })}`)

		// No telemetry escalation for a soft block.
		expect(captureConsecutiveMistakeError).not.toHaveBeenCalled()
		expect(captureException).not.toHaveBeenCalled()

		// A soft block is not counted as a consecutive mistake.
		expect(mockTask.consecutiveMistakeCount).toBe(0)

		// The detector keeps counting through the soft block, so presenting
		// the same call again escalates to a hard block (asking the user).
		const nextToolCallId = "tool_call_soft_block_repeat"
		startNextTurn([makeReadFileBlock(nextToolCallId)])

		await present()

		expect(mockTask.ask).toHaveBeenCalledTimes(1)
		expect(mockTask.ask).toHaveBeenCalledWith(
			"mistake_limit_reached",
			expect.stringContaining("tools:toolRepetitionLimitReached"),
		)
		expect(readFileHandle).not.toHaveBeenCalled()
		expect(captureConsecutiveMistakeError).toHaveBeenCalledWith("test-task-id")
		expect(findToolResult(nextToolCallId)).toBeDefined()
	})

	it("should apply repetition checks to attempt_completion as well", async () => {
		const firstId = "attempt_completion_1"
		mockTask.assistantMessageContent = [makeAttemptCompletionBlock(firstId)]

		await present()

		// First call is allowed and dispatched to the tool.
		expect(attemptCompletionHandle).toHaveBeenCalledTimes(1)
		expect(mockTask.ask).not.toHaveBeenCalled()

		// Second identical call is soft blocked before dispatch.
		const secondId = "attempt_completion_2"
		startNextTurn([makeAttemptCompletionBlock(secondId)])

		await present()

		expect(attemptCompletionHandle).toHaveBeenCalledTimes(1)
		expect(mockTask.ask).not.toHaveBeenCalled()
		const { error } = JSON.parse(String(findToolResult(secondId)?.content)) as { error: string }
		expect(error).toBe(`tools:toolRepetitionSoftBlock ${JSON.stringify({ toolName: "attempt_completion" })}`)

		// Third identical call escalates to a hard block.
		const thirdId = "attempt_completion_3"
		startNextTurn([makeAttemptCompletionBlock(thirdId)])

		await present()

		expect(attemptCompletionHandle).toHaveBeenCalledTimes(1)
		expect(mockTask.ask).toHaveBeenCalledWith(
			"mistake_limit_reached",
			expect.stringContaining('"toolName":"attempt_completion"'),
		)
	})

	it("should hard block, ask the user for guidance, and record telemetry", async () => {
		const toolCallId = "tool_call_hard_block"
		const block = makeReadFileBlock(toolCallId)
		primeDetector(detector, block, HARD_LIMIT)
		mockTask.assistantMessageContent = [block]

		mockTask.ask = vi.fn().mockResolvedValue({ response: "yesButtonClicked" })

		await present()

		// The user must be asked for guidance with the resolved message key
		// and a detail message naming the repeated tool.
		expect(mockTask.ask).toHaveBeenCalledTimes(1)
		expect(mockTask.ask).toHaveBeenCalledWith(
			"mistake_limit_reached",
			expect.stringContaining("tools:toolRepetitionLimitReached"),
		)
		expect(mockTask.ask).toHaveBeenCalledWith(
			"mistake_limit_reached",
			expect.stringContaining('"toolName":"read_file"'),
		)

		// The tool must not be executed when it is hard blocked.
		expect(readFileHandle).not.toHaveBeenCalled()

		// Telemetry escalation should have fired for a hard block.
		expect(captureConsecutiveMistakeError).toHaveBeenCalledWith("test-task-id")
		expect(captureException).toHaveBeenCalled()

		// A tool_result describing the repetition limit should have been pushed.
		const toolResult = findToolResult(toolCallId)
		expect(toolResult).toBeDefined()
		expect(toolResult?.content).toContain("read_file")
	})

	it("should incorporate user feedback when the user responds to a hard block", async () => {
		const toolCallId = "tool_call_hard_block_feedback"
		const block = makeReadFileBlock(toolCallId)
		primeDetector(detector, block, HARD_LIMIT)
		mockTask.assistantMessageContent = [block]

		mockTask.ask = vi.fn().mockResolvedValue({
			response: "messageResponse",
			text: "try a different file",
			images: [],
		})

		await present()

		// The tool must not be executed when it is hard blocked.
		expect(readFileHandle).not.toHaveBeenCalled()

		// User feedback should have been surfaced to the chat.
		expect(mockTask.say).toHaveBeenCalledWith("user_feedback", "try a different file", [])

		// And appended to the user message content.
		const feedbackBlock = (mockTask.userMessageContent as ToolResultBlock[]).find(
			(item) => item.type === "text" && String(item.text).includes("try a different file"),
		)
		expect(feedbackBlock).toBeDefined()
		expect(feedbackBlock?.text).toContain("Tool repetition limit reached")
	})
})
