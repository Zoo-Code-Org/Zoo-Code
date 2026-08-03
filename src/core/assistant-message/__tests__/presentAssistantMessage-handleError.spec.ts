// npx vitest src/core/assistant-message/__tests__/presentAssistantMessage-handleError.spec.ts

import { describe, it, expect, beforeEach, vi } from "vitest"
import type { Task } from "../../task/Task"
import { presentAssistantMessage } from "../presentAssistantMessage"

// The error the mocked execute_command tool fails with; reset per test.
let mockError: Error

// Mock dependencies
vi.mock("../../task/Task")
vi.mock("../../tools/validateToolUse", () => ({
	validateToolUse: vi.fn(),
	isValidToolName: vi.fn(() => true),
}))
vi.mock("../../tools/ExecuteCommandTool", () => ({
	executeCommandTool: {
		handle: vi.fn(
			async (
				_task: unknown,
				_block: unknown,
				callbacks: { handleError: (action: string, error: Error) => Promise<void> },
			) => {
				await callbacks.handleError("executing command", mockError)
			},
		),
	},
}))
vi.mock("@roo-code/telemetry", () => ({
	TelemetryService: {
		instance: {
			captureToolUsage: vi.fn(),
			captureConsecutiveMistakeError: vi.fn(),
		},
	},
}))

interface MockTask {
	taskId: string
	instanceId: string
	abort: boolean
	presentAssistantMessageLocked: boolean
	presentAssistantMessageHasPendingUpdates: boolean
	currentStreamingContentIndex: number
	assistantMessageContent: unknown[]
	userMessageContent: Array<Record<string, unknown>>
	userMessageContentReady: boolean
	didCompleteReadingStream: boolean
	didRejectTool: boolean
	didAlreadyUseTool: boolean
	consecutiveMistakeCount: number
	clineMessages: unknown[]
	api: { getModel: () => { id: string; info: Record<string, unknown> } }
	recordToolUsage: ReturnType<typeof vi.fn>
	recordToolError: ReturnType<typeof vi.fn>
	toolRepetitionDetector: { check: ReturnType<typeof vi.fn> }
	providerRef: { deref: () => { getState: () => Promise<{ mode: string; customModes: never[] }> } }
	say: ReturnType<typeof vi.fn>
	ask: ReturnType<typeof vi.fn>
	pushToolResultToUserContent: (toolResult: Record<string, unknown>) => boolean
}

function createMockTask(): MockTask {
	const mockTask: MockTask = {
		taskId: "test-task-id",
		instanceId: "test-instance",
		abort: false,
		presentAssistantMessageLocked: false,
		presentAssistantMessageHasPendingUpdates: false,
		currentStreamingContentIndex: 0,
		assistantMessageContent: [],
		userMessageContent: [],
		userMessageContentReady: false,
		didCompleteReadingStream: true,
		didRejectTool: false,
		didAlreadyUseTool: false,
		consecutiveMistakeCount: 0,
		clineMessages: [],
		api: {
			getModel: () => ({ id: "test-model", info: {} }),
		},
		recordToolUsage: vi.fn(),
		recordToolError: vi.fn(),
		toolRepetitionDetector: {
			check: vi.fn().mockReturnValue({ allowExecution: true }),
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
		pushToolResultToUserContent: (toolResult) => {
			const existingResult = mockTask.userMessageContent.find(
				(block) => block.type === "tool_result" && block.tool_use_id === toolResult.tool_use_id,
			)
			if (existingResult) {
				return false
			}
			mockTask.userMessageContent.push(toolResult)
			return true
		},
	}
	return mockTask
}

function executeCommandBlock(toolCallId: string) {
	return {
		type: "tool_use",
		id: toolCallId,
		name: "execute_command",
		params: { command: "ls" },
		nativeArgs: { command: "ls" },
		partial: false,
	}
}

function findToolResult(mockTask: MockTask, toolCallId: string): Record<string, unknown> {
	const toolResult = mockTask.userMessageContent.find(
		(item) => item.type === "tool_result" && item.tool_use_id === toolCallId,
	)
	if (!toolResult) {
		throw new Error(`expected a tool_result for ${toolCallId}`)
	}
	return toolResult
}

describe("presentAssistantMessage - tool handleError structured error", () => {
	let mockTask: MockTask

	beforeEach(() => {
		mockTask = createMockTask()
		mockError = new Error("TERMINAL/PROVIDER_SWITCH/003 provider switch failed")
	})

	it("marks the error tool_result with is_error and honest non-retryable guidance", async () => {
		const toolCallId = "tool_call_err_1"
		mockTask.assistantMessageContent = [executeCommandBlock(toolCallId)]

		// The cast is required because the mock only implements the subset of
		// Task that presentAssistantMessage touches.
		await presentAssistantMessage(mockTask as unknown as Task)

		const toolResult = findToolResult(mockTask, toolCallId)
		expect(toolResult.is_error).toBe(true)

		const content = String(toolResult.content)
		expect(content).toContain("<error_details>")
		expect(content).toContain('"retryable": false')
		expect(content).toContain('"occurrence": 1')
		expect(content).toContain('"recovery_disposition": "change_strategy"')
		expect(content).toContain('"type": "tool_execution.error_execution.002"')

		// The user-visible message is concise and does not embed the JSON blob.
		const sayCalls = mockTask.say.mock.calls.filter((call: unknown[]) => call[0] === "error")
		expect(sayCalls).toHaveLength(1)
		const sayMessage = String(sayCalls[0][1])
		expect(sayMessage).toContain("TERMINAL/PROVIDER_SWITCH/003")
		expect(sayMessage).not.toContain("<error_details>")
	})

	it("reports ordinary errors as retryable correct_once on first occurrence", async () => {
		mockError = new Error("boom")
		const toolCallId = "tool_call_err_2"
		mockTask.assistantMessageContent = [executeCommandBlock(toolCallId)]

		await presentAssistantMessage(mockTask as unknown as Task)

		const content = String(findToolResult(mockTask, toolCallId).content)
		expect(content).toContain('"retryable": true')
		expect(content).toContain('"occurrence": 1')
		expect(content).toContain('"recovery_disposition": "correct_once"')
	})

	it("increments the occurrence for repeated identical failures within the same task", async () => {
		mockError = new Error("identical failure")

		mockTask.assistantMessageContent = [executeCommandBlock("tool_call_err_3a")]
		await presentAssistantMessage(mockTask as unknown as Task)

		// Present a second, identical failure in the same task.
		mockTask.assistantMessageContent = [executeCommandBlock("tool_call_err_3b")]
		mockTask.currentStreamingContentIndex = 0
		mockTask.userMessageContent = []
		await presentAssistantMessage(mockTask as unknown as Task)

		const content = String(findToolResult(mockTask, "tool_call_err_3b").content)
		expect(content).toContain('"occurrence": 2')
	})
})
