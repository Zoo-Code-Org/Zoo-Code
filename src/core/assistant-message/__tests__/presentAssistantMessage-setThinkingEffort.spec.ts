// npx vitest run src/core/assistant-message/__tests__/presentAssistantMessage-setThinkingEffort.spec.ts
//
// DTE series 3/5 — set_thinking_effort dispatch in presentAssistantMessage:
// a completed native tool_use block is routed to SetThinkingEffortTool.handle
// with the standard callbacks (no approval gate).

import { describe, it, expect, beforeEach, vi, type Mock } from "vitest"
import type { ModelInfo } from "@roo-code/types"

import { presentAssistantMessage } from "../presentAssistantMessage"
import { setThinkingEffortTool } from "../../tools/SetThinkingEffortTool"
import type { Task } from "../../task/Task"

// Mock dependencies
vi.mock("../../task/Task")
vi.mock("../../tools/validateToolUse", () => ({
	validateToolUse: vi.fn(),
	isValidToolName: vi.fn((toolName: string) => toolName === "set_thinking_effort"),
}))
// The mock handler mirrors the real tool: it pushes exactly one tool result
// through the callbacks (the pushToolResultToUserContent mock records it).
vi.mock("../../tools/SetThinkingEffortTool", () => ({
	setThinkingEffortTool: {
		handle: vi.fn(
			async (_task: unknown, _block: unknown, callbacks: { pushToolResult: (content: string) => void }) => {
				callbacks.pushToolResult("Thinking effort applied")
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

/** Structural double covering every Task surface this dispatch path touches. */
interface PamTaskDouble {
	taskId: string
	instanceId: string
	abort: boolean
	presentAssistantMessageLocked: boolean
	presentAssistantMessageHasPendingUpdates: boolean
	currentStreamingContentIndex: number
	assistantMessageContent: unknown[]
	userMessageContent: unknown[]
	didCompleteReadingStream: boolean
	didRejectTool: boolean
	didAlreadyUseTool: boolean
	consecutiveMistakeCount: number
	clineMessages: unknown[]
	api: { getModel: () => { id: string; info: ModelInfo } }
	recordToolUsage: Mock
	recordToolError: Mock
	toolRepetitionDetector: { check: Mock }
	providerRef: {
		deref: () => {
			getState: () => Promise<{ mode: string; customModes: unknown[] }>
		}
	}
	say: Mock
	ask: Mock
	pushToolResultToUserContent: Mock
}

describe("presentAssistantMessage - set_thinking_effort dispatch", () => {
	let mockTask: PamTaskDouble

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
			clineMessages: [],
			api: {
				getModel: () => ({
					id: "test-model",
					info: { contextWindow: 1, supportsPromptCache: false },
				}),
			},
			recordToolUsage: vi.fn(),
			recordToolError: vi.fn(),
			toolRepetitionDetector: {
				check: vi.fn().mockReturnValue({ allowExecution: true }),
			},
			providerRef: {
				deref: vi.fn().mockReturnValue({
					getState: vi.fn().mockResolvedValue({
						mode: "code",
						customModes: [],
					}),
				}),
			},
			say: vi.fn().mockResolvedValue(undefined),
			ask: vi.fn().mockResolvedValue({ response: "yesButtonClicked" }),
			// Records tool results so the dispatched tool_result can be asserted.
			pushToolResultToUserContent: vi.fn().mockImplementation((toolResult: unknown) => {
				mockTask.userMessageContent.push(toolResult)
				return true
			}),
		}
	})

	// The structural double covers every Task surface presentAssistantMessage
	// touches for this dispatch path; a full Task is not needed here.
	function asTask(): Task {
		return mockTask as unknown as Task
	}

	function toolCallId() {
		return "tool_call_dte_dispatch_1"
	}

	function makeBlock() {
		const id = toolCallId()
		return {
			type: "tool_use" as const,
			id,
			name: "set_thinking_effort" as const,
			params: { effort: "high", reason: "deep analysis ahead" },
			partial: false,
			nativeArgs: { effort: "high", reason: "deep analysis ahead" },
		}
	}

	function dispatchedToolResult(): unknown {
		return mockTask.userMessageContent.find(
			(item) =>
				typeof item === "object" &&
				item !== null &&
				(item as { type?: string; tool_use_id?: string }).type === "tool_result" &&
				(item as { type?: string; tool_use_id?: string }).tool_use_id === toolCallId(),
		)
	}

	it("routes a completed set_thinking_effort block to the tool handler", async () => {
		mockTask.assistantMessageContent = [makeBlock()]

		await presentAssistantMessage(asTask())

		const handle = vi.mocked(setThinkingEffortTool.handle)
		expect(handle).toHaveBeenCalledTimes(1)
		const [taskArg, blockArg, callbacksArg] = handle.mock.calls[0]
		expect(taskArg).toBe(mockTask)
		expect(blockArg).toMatchObject({
			name: "set_thinking_effort",
			nativeArgs: { effort: "high", reason: "deep analysis ahead" },
		})
		expect(callbacksArg).toEqual(
			expect.objectContaining({
				askApproval: expect.any(Function),
				handleError: expect.any(Function),
				pushToolResult: expect.any(Function),
			}),
		)

		// Usage is recorded under the real tool name (not a telemetry alias).
		expect(mockTask.recordToolUsage).toHaveBeenCalledWith("set_thinking_effort")
		// The handler pushes a tool_result for the tool call id.
		expect(dispatchedToolResult()).toBeDefined()
	})

	it("does not route other tools through the set_thinking_effort handler", async () => {
		mockTask.assistantMessageContent = [
			{
				type: "tool_use" as const,
				id: "tool_call_other_1",
				name: "nonexistent_tool",
				params: { some: "param" },
				partial: false,
			},
		]

		await presentAssistantMessage(asTask())
	})

	it("describes a skipped set_thinking_effort block via the tool description when the task already rejected a tool", async () => {
		mockTask.didRejectTool = true
		mockTask.assistantMessageContent = [makeBlock()]

		await presentAssistantMessage(asTask())

		const handle = vi.mocked(setThinkingEffortTool.handle)
		expect(handle).not.toHaveBeenCalled()
		const result = dispatchedToolResult()
		expect(result).toBeDefined()
		const content = (result as { content?: string }).content
		expect(content).toContain("set_thinking_effort to 'high'")
		expect(content).toContain("rejecting")
	})
})
