// npx vitest src/core/assistant-message/__tests__/presentAssistantMessage-tool-repetition.spec.ts

import { providerIdentifiers } from "@roo-code/types"

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

type MockRepetitionDetector = { check: ReturnType<typeof vi.fn> }

// Mock dependencies
vi.mock("../../task/Task")
vi.mock("../../tools/validateToolUse", () => ({
	validateToolUse: vi.fn(),
	isValidToolName: vi.fn(() => true),
}))

// Mock the read_file tool so we can assert the normal execution path is taken
// when the repetition detector allows a tool call. The handle spy simulates a
// successful tool run by pushing a tool_result, mirroring the real tool.
// `vi.hoisted` is required because `vi.mock` factories are hoisted above
// top-level variable declarations.
const { readFileHandle } = vi.hoisted(() => ({
	readFileHandle: vi.fn(
		async (
			_cline: unknown,
			block: ToolBlock,
			{ pushToolResult }: { pushToolResult: (result: string) => void },
		) => {
			pushToolResult(`[read_file for '${block?.params?.path ?? block?.nativeArgs?.path}'] Result`)
		},
	),
}))

vi.mock("../../tools/ReadFileTool", () => ({
	readFileTool: {
		handle: readFileHandle,
		getReadFileToolDescription: vi.fn(() => "[read_file]"),
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

describe("presentAssistantMessage - Tool Repetition Detection", () => {
	let mockTask: MockTask

	beforeEach(() => {
		vi.clearAllMocks()

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
			consecutiveMistakeLimit: 5,
			clineMessages: [],
			getTaskMode: vi.fn().mockResolvedValue("code"),
			apiConfiguration: { apiProvider: providerIdentifiers.anthropic },
			api: {
				getModel: () => ({ id: "test-model", info: {} }),
			},
			recordToolUsage: vi.fn(),
			recordToolError: vi.fn(),
			toolRepetitionDetector: {
				check: vi.fn().mockReturnValue({ action: "allow" }),
			},
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

	it("should soft block without involving the user and return an error to the model", async () => {
		const toolCallId = "tool_call_soft_block"
		mockTask.assistantMessageContent = [
			{
				type: "tool_use",
				id: toolCallId,
				name: "read_file",
				params: { path: "test.txt" },
				nativeArgs: { path: "test.txt" },
				partial: false,
			},
		]

		;(mockTask.toolRepetitionDetector as MockRepetitionDetector).check = vi.fn().mockReturnValue({
			action: "soft_block",
			message: "The tool 'read_file' was blocked because it was just called with identical parameters.",
		})

		await presentAssistantMessage(mockTask as unknown as Parameters<typeof presentAssistantMessage>[0])

		// The user should NOT have been asked anything for a soft block.
		expect(mockTask.ask).not.toHaveBeenCalled()

		// The tool must not be executed when it is soft blocked.
		expect(readFileHandle).not.toHaveBeenCalled()

		// A tool_result with the soft block message should have been pushed.
		const toolResult = (mockTask.userMessageContent as ToolResultBlock[]).find(
			(item) => item.type === "tool_result" && item.tool_use_id === toolCallId,
		)
		expect(toolResult).toBeDefined()
		expect(toolResult?.content).toContain("read_file")
		expect(toolResult?.content).toContain("identical parameters")

		// No telemetry escalation for a soft block.
		expect(captureConsecutiveMistakeError).not.toHaveBeenCalled()
		expect(captureException).not.toHaveBeenCalled()
	})

	it("should hard block, ask the user for guidance, and record telemetry", async () => {
		const toolCallId = "tool_call_hard_block"
		mockTask.assistantMessageContent = [
			{
				type: "tool_use",
				id: toolCallId,
				name: "read_file",
				params: { path: "test.txt" },
				nativeArgs: { path: "test.txt" },
				partial: false,
			},
		]

		;(mockTask.toolRepetitionDetector as MockRepetitionDetector).check = vi.fn().mockReturnValue({
			action: "hard_block",
			askUser: {
				messageKey: "mistake_limit_reached",
				messageDetail: "Roo appears to be stuck in a loop calling {toolName} repeatedly.",
			},
		})

		mockTask.ask = vi.fn().mockResolvedValue({ response: "yesButtonClicked" })

		await presentAssistantMessage(mockTask as unknown as Parameters<typeof presentAssistantMessage>[0])

		// The user must be asked for guidance with the resolved message key.
		expect(mockTask.ask).toHaveBeenCalledWith(
			"mistake_limit_reached",
			expect.stringContaining("read_file"),
		)

		// The tool must not be executed when it is hard blocked.
		expect(readFileHandle).not.toHaveBeenCalled()

		// Telemetry escalation should have fired for a hard block.
		expect(captureConsecutiveMistakeError).toHaveBeenCalledWith("test-task-id")
		expect(captureException).toHaveBeenCalled()

		// A tool_result describing the repetition limit should have been pushed.
		const toolResult = (mockTask.userMessageContent as ToolResultBlock[]).find(
			(item) => item.type === "tool_result" && item.tool_use_id === toolCallId,
		)
		expect(toolResult).toBeDefined()
		expect(toolResult?.content).toContain("read_file")
	})

	it("should incorporate user feedback when the user responds to a hard block", async () => {
		const toolCallId = "tool_call_hard_block_feedback"
		mockTask.assistantMessageContent = [
			{
				type: "tool_use",
				id: toolCallId,
				name: "read_file",
				params: { path: "test.txt" },
				nativeArgs: { path: "test.txt" },
				partial: false,
			},
		]

		;(mockTask.toolRepetitionDetector as MockRepetitionDetector).check = vi.fn().mockReturnValue({
			action: "hard_block",
			askUser: {
				messageKey: "mistake_limit_reached",
				messageDetail: "Stuck calling {toolName} repeatedly.",
			},
		})

		mockTask.ask = vi.fn().mockResolvedValue({
			response: "messageResponse",
			text: "try a different file",
			images: [],
		})

		await presentAssistantMessage(mockTask as unknown as Parameters<typeof presentAssistantMessage>[0])

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

	it("should execute the tool normally when the detector allows it", async () => {
		const toolCallId = "tool_call_allow"
		mockTask.assistantMessageContent = [
			{
				type: "tool_use",
				id: toolCallId,
				name: "read_file",
				params: { path: "test.txt" },
				nativeArgs: { path: "test.txt" },
				partial: false,
			},
		]

		;(mockTask.toolRepetitionDetector as MockRepetitionDetector).check = vi
			.fn()
			.mockReturnValue({ action: "allow" })

		await presentAssistantMessage(mockTask as unknown as Parameters<typeof presentAssistantMessage>[0])

		// The detector should have been consulted.
		expect((mockTask.toolRepetitionDetector as { check: ReturnType<typeof vi.fn> }).check).toHaveBeenCalled()
		// No hard block ask should have occurred.
		expect(mockTask.ask).not.toHaveBeenCalledWith("mistake_limit_reached", expect.anything())

		// The tool must have actually continued into normal execution: the
		// read_file tool runner should have been dispatched with this block.
		expect(readFileHandle).toHaveBeenCalledTimes(1)
		const [, dispatchedBlock] = readFileHandle.mock.calls[0]
		expect(dispatchedBlock).toMatchObject({ name: "read_file", id: toolCallId })

		// And the normal execution path should have produced a tool_result
		// (no soft/hard block error message).
		const toolResult = (mockTask.userMessageContent as ToolResultBlock[]).find(
			(item) => item.type === "tool_result" && item.tool_use_id === toolCallId,
		)
		expect(toolResult).toBeDefined()
		expect(toolResult?.content).toContain("read_file")
		expect(toolResult?.is_error).toBeUndefined()
	})
})
