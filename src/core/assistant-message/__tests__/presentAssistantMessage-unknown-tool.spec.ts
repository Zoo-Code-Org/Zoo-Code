// npx vitest src/core/assistant-message/__tests__/presentAssistantMessage-unknown-tool.spec.ts

import { describe, it, expect, beforeEach, vi } from "vitest"
import { presentAssistantMessage } from "../presentAssistantMessage"
import { isValidToolName } from "../../tools/validateToolUse"

const mockNewTaskHandle = vi.hoisted(() => vi.fn())

// Mock dependencies
vi.mock("../../task/Task")
vi.mock("../../tools/validateToolUse", () => ({
	validateToolUse: vi.fn(),
	isValidToolName: vi.fn(() => false),
}))
vi.mock("../../tools/NewTaskTool", () => ({
	newTaskTool: { handle: mockNewTaskHandle },
}))
vi.mock("@roo-code/telemetry", () => ({
	TelemetryService: {
		instance: {
			captureToolUsage: vi.fn(),
			captureConsecutiveMistakeError: vi.fn(),
		},
	},
}))

describe("presentAssistantMessage - Unknown Tool Handling", () => {
	let mockTask: any

	beforeEach(() => {
		mockNewTaskHandle.mockReset()
		// Create a mock Task with minimal properties needed for testing
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
		}

		// Add pushToolResultToUserContent method after mockTask is created so 'this' binds correctly
		mockTask.pushToolResultToUserContent = vi.fn().mockImplementation((toolResult: any) => {
			const existingResult = mockTask.userMessageContent.find(
				(block: any) => block.type === "tool_result" && block.tool_use_id === toolResult.tool_use_id,
			)
			if (existingResult) {
				return false
			}
			mockTask.userMessageContent.push(toolResult)
			return true
		})
	})

	it("should return error for unknown tool in native protocol", async () => {
		// Set up a tool_use block with an unknown tool name and an ID (native tool calling)
		const toolCallId = "tool_call_unknown_123"
		mockTask.assistantMessageContent = [
			{
				type: "tool_use",
				id: toolCallId, // ID indicates native tool calling
				name: "nonexistent_tool",
				params: { some: "param" },
				partial: false,
			},
		]

		// Execute presentAssistantMessage
		await presentAssistantMessage(mockTask)

		// Verify that a tool_result with error was pushed
		const toolResult = mockTask.userMessageContent.find(
			(item: any) => item.type === "tool_result" && item.tool_use_id === toolCallId,
		)

		expect(toolResult).toBeDefined()
		expect(toolResult.tool_use_id).toBe(toolCallId)
		// The error is wrapped in JSON by formatResponse.toolError
		expect(toolResult.content).toContain("nonexistent_tool")
		expect(toolResult.content).toContain("does not exist")
		expect(toolResult.content).toContain("error")

		// Verify consecutiveMistakeCount was incremented
		expect(mockTask.consecutiveMistakeCount).toBe(1)

		// Verify recordToolError was called with a safe static key, never the
		// raw model-controlled tool name.
		expect(mockTask.recordToolError).toHaveBeenCalledWith(
			"invalid_tool_call",
			expect.stringContaining("Unknown tool"),
		)

		// Verify error message was shown to user (uses i18n key)
		expect(mockTask.say).toHaveBeenCalledWith("error", "unknownToolError")
	})

	it("should fail fast when tool_use is missing id (legacy/XML-style tool call)", async () => {
		// tool_use without an id is treated as legacy/XML-style tool call and must be rejected.
		mockTask.assistantMessageContent = [
			{
				type: "tool_use",
				name: "fake_tool_that_does_not_exist",
				params: { param1: "value1" },
				partial: false,
			},
		]

		// Execute presentAssistantMessage
		await presentAssistantMessage(mockTask)

		// Should not execute tool; should surface a clear error message.
		const textBlocks = mockTask.userMessageContent.filter((item: any) => item.type === "text")
		expect(textBlocks.length).toBeGreaterThan(0)
		expect(textBlocks.some((b: any) => String(b.text).includes("XML tool calls are no longer supported"))).toBe(
			true,
		)

		// Verify consecutiveMistakeCount was incremented
		expect(mockTask.consecutiveMistakeCount).toBe(1)

		// Verify recordToolError was called with a safe static key, never the
		// raw model-reported tool name ("fake_tool_that_does_not_exist").
		expect(mockTask.recordToolError).toHaveBeenCalledWith("invalid_tool_call", expect.anything())

		// Verify error message was shown to user
		expect(mockTask.say).toHaveBeenCalledWith("error", expect.anything())
	})

	it("should handle unknown tool without freezing (native tool calling)", async () => {
		// This test ensures the extension doesn't freeze when an unknown tool is called
		const toolCallId = "tool_call_freeze_test"
		mockTask.assistantMessageContent = [
			{
				type: "tool_use",
				id: toolCallId, // Native tool calling
				name: "this_tool_definitely_does_not_exist",
				params: {},
				partial: false,
			},
		]

		// The test will timeout if the extension freezes
		const timeoutPromise = new Promise<boolean>((_, reject) => {
			setTimeout(() => reject(new Error("Test timed out - extension likely froze")), 5000)
		})

		const resultPromise = presentAssistantMessage(mockTask).then(() => true)

		// Race between the function completing and the timeout
		const completed = await Promise.race([resultPromise, timeoutPromise])
		expect(completed).toBe(true)

		// Verify a tool_result was pushed (critical for API not to freeze)
		const toolResult = mockTask.userMessageContent.find(
			(item: any) => item.type === "tool_result" && item.tool_use_id === toolCallId,
		)
		expect(toolResult).toBeDefined()
	})

	it("should increment consecutiveMistakeCount for unknown tools", async () => {
		// Test with multiple unknown tools to ensure mistake count increments
		const toolCallId = "tool_call_mistake_test"
		mockTask.assistantMessageContent = [
			{
				type: "tool_use",
				id: toolCallId,
				name: "unknown_tool_1",
				params: {},
				partial: false,
			},
		]

		expect(mockTask.consecutiveMistakeCount).toBe(0)

		await presentAssistantMessage(mockTask)

		expect(mockTask.consecutiveMistakeCount).toBe(1)
	})

	it("should set userMessageContentReady after handling unknown tool", async () => {
		const toolCallId = "tool_call_ready_test"
		mockTask.assistantMessageContent = [
			{
				type: "tool_use",
				id: toolCallId,
				name: "unknown_tool",
				params: {},
				partial: false,
			},
		]

		mockTask.didCompleteReadingStream = true
		mockTask.userMessageContentReady = false

		await presentAssistantMessage(mockTask)

		// userMessageContentReady should be set after processing
		expect(mockTask.userMessageContentReady).toBe(true)
	})

	it("should still work with didRejectTool flag for unknown tool", async () => {
		const toolCallId = "tool_call_rejected_test"
		mockTask.assistantMessageContent = [
			{
				type: "tool_use",
				id: toolCallId,
				name: "unknown_tool",
				params: {},
				partial: false,
			},
		]

		mockTask.didRejectTool = true

		await presentAssistantMessage(mockTask)

		// When didRejectTool is true, should send error tool_result
		const toolResult = mockTask.userMessageContent.find(
			(item: any) => item.type === "tool_result" && item.tool_use_id === toolCallId,
		)

		expect(toolResult).toBeDefined()
		expect(toolResult.is_error).toBe(true)
		expect(toolResult.content).toContain("due to user rejecting a previous tool")
	})

	it("persists and acknowledges queued feedback through the native approval path", async () => {
		vi.mocked(isValidToolName).mockReturnValue(true)
		mockTask.assistantMessageContent = [
			{
				type: "tool_use",
				id: "call_new_task_queued_feedback",
				name: "new_task",
				params: { mode: "ask", message: "Child task" },
				nativeArgs: { mode: "ask", message: "Child task" },
				partial: false,
			},
		]
		mockTask.currentStreamingDidCheckpoint = false
		mockTask.checkpointSave = vi.fn().mockResolvedValue(undefined)
		mockTask.ask = vi.fn().mockResolvedValue({
			response: "messageResponse",
			text: "Handle this first",
			queuedMessageId: "queued-message-1",
		})
		mockTask.persistQueuedFeedbackAndAcknowledge = vi.fn().mockResolvedValue(true)
		mockNewTaskHandle.mockImplementation(
			async (
				_task: unknown,
				_block: unknown,
				callbacks: { askApproval: (type: "tool", text: string) => Promise<boolean> },
			) => {
				await callbacks.askApproval("tool", JSON.stringify({ tool: "newTask" }))
			},
		)

		await presentAssistantMessage(mockTask)

		expect(mockTask.persistQueuedFeedbackAndAcknowledge).toHaveBeenCalledWith(
			"queued-message-1",
			"Handle this first",
			undefined,
		)
		expect(mockTask.say).not.toHaveBeenCalledWith("user_feedback", expect.anything(), expect.anything())
	})

	it("acknowledges an empty queued denial instead of stranding its claim", async () => {
		vi.mocked(isValidToolName).mockReturnValue(true)
		mockTask.assistantMessageContent = [
			{
				type: "tool_use",
				id: "call_new_task_empty_denial",
				name: "new_task",
				params: { mode: "ask", message: "Child task" },
				nativeArgs: { mode: "ask", message: "Child task" },
				partial: false,
			},
		]
		mockTask.currentStreamingDidCheckpoint = false
		mockTask.checkpointSave = vi.fn().mockResolvedValue(undefined)
		mockTask.ask = vi.fn().mockResolvedValue({
			response: "noButtonClicked",
			queuedMessageId: "queued-empty-denial",
		})
		mockTask.persistQueuedFeedbackAndAcknowledge = vi.fn().mockResolvedValue(true)
		mockNewTaskHandle.mockImplementation(
			async (
				_task: unknown,
				_block: unknown,
				callbacks: { askApproval: (type: "tool", text: string) => Promise<boolean> },
			) => {
				expect(await callbacks.askApproval("tool", JSON.stringify({ tool: "newTask" }))).toBe(false)
			},
		)

		await presentAssistantMessage(mockTask)

		expect(mockTask.persistQueuedFeedbackAndAcknowledge).toHaveBeenCalledWith(
			"queued-empty-denial",
			undefined,
			undefined,
		)
		expect(mockTask.say).not.toHaveBeenCalledWith("user_feedback", expect.anything(), expect.anything())
	})

	it("merges ordinary approval feedback into a native tool result", async () => {
		vi.mocked(isValidToolName).mockReturnValue(true)
		mockTask.assistantMessageContent = [
			{
				type: "tool_use",
				id: "call_new_task_approval_feedback",
				name: "new_task",
				params: { mode: "ask", message: "Child task" },
				nativeArgs: { mode: "ask", message: "Child task" },
				partial: false,
			},
		]
		mockTask.currentStreamingDidCheckpoint = false
		mockTask.checkpointSave = vi.fn().mockResolvedValue(undefined)
		mockTask.ask = vi.fn().mockResolvedValue({ response: "yesButtonClicked", text: "Approved context" })
		mockNewTaskHandle.mockImplementation(
			async (
				_task: unknown,
				_block: unknown,
				callbacks: {
					askApproval: (type: "tool", text: string) => Promise<boolean>
					pushToolResult: (content: string) => void
				},
			) => {
				expect(await callbacks.askApproval("tool", JSON.stringify({ tool: "newTask" }))).toBe(true)
				callbacks.pushToolResult("Delegated")
			},
		)

		await presentAssistantMessage(mockTask)

		expect(mockTask.say).toHaveBeenCalledWith("user_feedback", "Approved context", undefined)
		expect(mockTask.userMessageContent).toContainEqual(
			expect.objectContaining({
				type: "tool_result",
				content: expect.stringContaining('"status":"approved"'),
			}),
		)
	})

	it("records ordinary image-only denial feedback and stops the tool", async () => {
		vi.mocked(isValidToolName).mockReturnValue(true)
		mockTask.assistantMessageContent = [
			{
				type: "tool_use",
				id: "call_new_task_image_denial",
				name: "new_task",
				params: { mode: "ask", message: "Child task" },
				nativeArgs: { mode: "ask", message: "Child task" },
				partial: false,
			},
		]
		mockTask.currentStreamingDidCheckpoint = false
		mockTask.checkpointSave = vi.fn().mockResolvedValue(undefined)
		mockTask.ask = vi.fn().mockResolvedValue({
			response: "noButtonClicked",
			images: ["data:image/png;base64,denied"],
		})
		const continueTool = vi.fn()
		mockNewTaskHandle.mockImplementation(
			async (
				_task: unknown,
				_block: unknown,
				callbacks: { askApproval: (type: "tool", text: string) => Promise<boolean> },
			) => {
				if (await callbacks.askApproval("tool", JSON.stringify({ tool: "newTask" }))) {
					continueTool()
				}
			},
		)

		await presentAssistantMessage(mockTask)

		expect(mockTask.say).toHaveBeenCalledWith("user_feedback", "", ["data:image/png;base64,denied"])
		expect(continueTool).not.toHaveBeenCalled()
		expect(mockTask.didRejectTool).toBe(true)
		expect(mockTask.userMessageContent).toContainEqual(
			expect.objectContaining({
				type: "tool_result",
				content: expect.stringContaining('"status":"denied"'),
			}),
		)
	})

	it("does not continue after queued denial persistence fails", async () => {
		vi.mocked(isValidToolName).mockReturnValue(true)
		mockTask.assistantMessageContent = [
			{
				type: "tool_use",
				id: "call_new_task_failed_denial_persistence",
				name: "new_task",
				params: { mode: "ask", message: "Child task" },
				nativeArgs: { mode: "ask", message: "Child task" },
				partial: false,
			},
		]
		mockTask.currentStreamingDidCheckpoint = false
		mockTask.checkpointSave = vi.fn().mockResolvedValue(undefined)
		mockTask.ask = vi.fn().mockResolvedValue({
			response: "messageResponse",
			text: "Do not delegate",
			queuedMessageId: "queued-failed-denial",
		})
		mockTask.persistQueuedFeedbackAndAcknowledge = vi.fn().mockResolvedValue(false)
		const continueTool = vi.fn()
		mockNewTaskHandle.mockImplementation(
			async (
				_task: unknown,
				_block: unknown,
				callbacks: { askApproval: (type: "tool", text: string) => Promise<boolean> },
			) => {
				await callbacks.askApproval("tool", JSON.stringify({ tool: "newTask" }))
				continueTool()
			},
		)

		await expect(presentAssistantMessage(mockTask)).rejects.toThrow(
			"Failed to persist queued approval feedback queued-failed-denial",
		)

		expect(mockTask.persistQueuedFeedbackAndAcknowledge).toHaveBeenCalledWith(
			"queued-failed-denial",
			"Do not delegate",
			undefined,
		)
		expect(continueTool).not.toHaveBeenCalled()
		expect(mockTask.userMessageContent).toEqual([])
	})

	it("merges queued image-only approval feedback without duplicating its chat row", async () => {
		vi.mocked(isValidToolName).mockReturnValue(true)
		mockTask.assistantMessageContent = [
			{
				type: "tool_use",
				id: "call_new_task_queued_image_approval",
				name: "new_task",
				params: { mode: "ask", message: "Child task" },
				nativeArgs: { mode: "ask", message: "Child task" },
				partial: false,
			},
		]
		mockTask.currentStreamingDidCheckpoint = false
		mockTask.checkpointSave = vi.fn().mockResolvedValue(undefined)
		mockTask.ask = vi.fn().mockResolvedValue({
			response: "yesButtonClicked",
			images: ["data:image/png;base64,approved"],
			queuedMessageId: "queued-image-approval",
		})
		mockTask.persistQueuedFeedbackAndAcknowledge = vi.fn().mockResolvedValue(true)
		mockNewTaskHandle.mockImplementation(
			async (
				_task: unknown,
				_block: unknown,
				callbacks: {
					askApproval: (type: "tool", text: string) => Promise<boolean>
					pushToolResult: (content: string) => void
				},
			) => {
				expect(await callbacks.askApproval("tool", JSON.stringify({ tool: "newTask" }))).toBe(true)
				callbacks.pushToolResult("Delegated once")
			},
		)

		await presentAssistantMessage(mockTask)

		expect(mockTask.persistQueuedFeedbackAndAcknowledge).toHaveBeenCalledWith("queued-image-approval", undefined, [
			"data:image/png;base64,approved",
		])
		expect(mockTask.say).not.toHaveBeenCalledWith("user_feedback", expect.anything(), expect.anything())
		expect(
			mockTask.userMessageContent.filter((item: { type: string }) => item.type === "tool_result"),
		).toHaveLength(1)
		expect(mockTask.userMessageContent).toContainEqual(
			expect.objectContaining({ type: "image", source: expect.any(Object) }),
		)
	})

	it("does not execute an approved tool when queued approval persistence fails", async () => {
		vi.mocked(isValidToolName).mockReturnValue(true)
		mockTask.assistantMessageContent = [
			{
				type: "tool_use",
				id: "call_new_task_failed_approval_persistence",
				name: "new_task",
				params: { mode: "ask", message: "Child task" },
				nativeArgs: { mode: "ask", message: "Child task" },
				partial: false,
			},
		]
		mockTask.currentStreamingDidCheckpoint = false
		mockTask.checkpointSave = vi.fn().mockResolvedValue(undefined)
		mockTask.ask = vi.fn().mockResolvedValue({
			response: "yesButtonClicked",
			text: "Approved after save",
			queuedMessageId: "queued-failed-approval",
		})
		mockTask.persistQueuedFeedbackAndAcknowledge = vi.fn().mockResolvedValue(false)
		const executeApprovedTool = vi.fn()
		mockNewTaskHandle.mockImplementation(
			async (
				_task: unknown,
				_block: unknown,
				callbacks: { askApproval: (type: "tool", text: string) => Promise<boolean> },
			) => {
				if (await callbacks.askApproval("tool", JSON.stringify({ tool: "newTask" }))) {
					executeApprovedTool()
				}
			},
		)

		await expect(presentAssistantMessage(mockTask)).rejects.toThrow(
			"Failed to persist queued approval feedback queued-failed-approval",
		)

		expect(executeApprovedTool).not.toHaveBeenCalled()
		expect(mockTask.say).not.toHaveBeenCalledWith("user_feedback", expect.anything(), expect.anything())
		expect(mockTask.userMessageContent).toEqual([])
	})

	it("handles an ordinary empty denial without recording a feedback row", async () => {
		vi.mocked(isValidToolName).mockReturnValue(true)
		mockTask.assistantMessageContent = [
			{
				type: "tool_use",
				id: "call_new_task_empty_ordinary_denial",
				name: "new_task",
				params: { mode: "ask", message: "Child task" },
				nativeArgs: { mode: "ask", message: "Child task" },
				partial: false,
			},
		]
		mockTask.currentStreamingDidCheckpoint = false
		mockTask.checkpointSave = vi.fn().mockResolvedValue(undefined)
		mockTask.ask = vi.fn().mockResolvedValue({ response: "noButtonClicked" })
		mockNewTaskHandle.mockImplementation(
			async (
				_task: unknown,
				_block: unknown,
				callbacks: { askApproval: (type: "tool", text: string) => Promise<boolean> },
			) => {
				expect(await callbacks.askApproval("tool", JSON.stringify({ tool: "newTask" }))).toBe(false)
			},
		)

		await presentAssistantMessage(mockTask)

		expect(mockTask.say).not.toHaveBeenCalledWith("user_feedback", expect.anything(), expect.anything())
		expect(mockTask.didRejectTool).toBe(true)
		expect(mockTask.userMessageContent).toContainEqual(
			expect.objectContaining({
				type: "tool_result",
				content: expect.stringContaining("The user denied this operation"),
			}),
		)
	})

	it("merges ordinary image-only approval feedback into one tool result", async () => {
		vi.mocked(isValidToolName).mockReturnValue(true)
		mockTask.assistantMessageContent = [
			{
				type: "tool_use",
				id: "call_new_task_image_approval",
				name: "new_task",
				params: { mode: "ask", message: "Child task" },
				nativeArgs: { mode: "ask", message: "Child task" },
				partial: false,
			},
		]
		mockTask.currentStreamingDidCheckpoint = false
		mockTask.checkpointSave = vi.fn().mockResolvedValue(undefined)
		mockTask.ask = vi.fn().mockResolvedValue({
			response: "yesButtonClicked",
			images: ["data:image/png;base64,ordinary-approved"],
		})
		mockNewTaskHandle.mockImplementation(
			async (
				_task: unknown,
				_block: unknown,
				callbacks: {
					askApproval: (type: "tool", text: string) => Promise<boolean>
					pushToolResult: (content: string) => void
				},
			) => {
				expect(await callbacks.askApproval("tool", JSON.stringify({ tool: "newTask" }))).toBe(true)
				callbacks.pushToolResult("Delegated once")
			},
		)

		await presentAssistantMessage(mockTask)

		expect(mockTask.say).toHaveBeenCalledWith("user_feedback", "", ["data:image/png;base64,ordinary-approved"])
		expect(
			mockTask.userMessageContent.filter((item: { type: string }) => item.type === "tool_result"),
		).toHaveLength(1)
		expect(mockTask.userMessageContent).toContainEqual(
			expect.objectContaining({ type: "image", source: expect.any(Object) }),
		)
	})
})
