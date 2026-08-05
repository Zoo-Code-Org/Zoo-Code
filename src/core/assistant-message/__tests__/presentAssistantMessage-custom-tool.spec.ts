// npx vitest src/core/assistant-message/__tests__/presentAssistantMessage-custom-tool.spec.ts

import { describe, it, expect, beforeEach, vi } from "vitest"
import { parametersSchema as z, type CustomToolDefinition } from "@roo-code/types"
import { presentAssistantMessage } from "../presentAssistantMessage"
import { validateToolUse } from "../../tools/validateToolUse"
import { readFileTool } from "../../tools/ReadFileTool"
import { writeToFileTool } from "../../tools/WriteToFileTool"

// Mock dependencies
vi.mock("../../task/Task")
vi.mock("../../tools/validateToolUse", () => ({
	validateToolUse: vi.fn(),
	isValidToolName: vi.fn((toolName: string) =>
		["read_file", "write_to_file", "ask_followup_question", "attempt_completion", "use_mcp_tool"].includes(
			toolName,
		),
	),
}))

// Mock custom tool registry - must be done inline without external variable references
vi.mock("@roo-code/core", () => ({
	customToolRegistry: {
		has: vi.fn(),
		get: vi.fn(),
	},
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

import { TelemetryService } from "@roo-code/telemetry"
import { customToolRegistry } from "@roo-code/core"

describe("presentAssistantMessage - Custom Tool Recording", () => {
	let mockTask: any

	beforeEach(() => {
		// Reset all mocks
		vi.clearAllMocks()
		vi.mocked(customToolRegistry.has).mockReturnValue(false)
		vi.mocked(customToolRegistry.get).mockReturnValue(undefined)

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
			runPreToolUseHooks: vi.fn().mockResolvedValue({ decision: "allow", context: [] }),
			toolRepetitionDetector: {
				check: vi.fn().mockReturnValue({ allowExecution: true }),
			},
			providerRef: {
				deref: () => ({
					getState: vi.fn().mockResolvedValue({
						mode: "code",
						customModes: [],
						experiments: {
							customTools: true, // Enable by default
						},
					}),
				}),
			},
			say: vi.fn().mockResolvedValue(undefined),
			ask: vi.fn().mockResolvedValue({ response: "yesButtonClicked" }),
		}

		// Add pushToolResultToUserContent method after mockTask is created so it can reference mockTask
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

	describe("Custom tool usage recording", () => {
		it("should record custom tool usage as 'custom_tool' when experiment is enabled", async () => {
			const toolCallId = "tool_call_custom_123"
			mockTask.assistantMessageContent = [
				{
					type: "tool_use",
					id: toolCallId,
					name: "my_custom_tool",
					params: { value: "test" },
					partial: false,
				},
			]

			// Mock customToolRegistry to recognize this as a custom tool
			vi.mocked(customToolRegistry.has).mockReturnValue(true)
			vi.mocked(customToolRegistry.get).mockReturnValue({
				name: "my_custom_tool",
				description: "A custom tool",
				execute: vi.fn().mockResolvedValue("Custom tool result"),
			})

			await presentAssistantMessage(mockTask)

			// Should record as "custom_tool", not "my_custom_tool"
			expect(mockTask.recordToolUsage).toHaveBeenCalledWith("custom_tool")
		})
	})

	describe("preToolUse dispatch", () => {
		it("runs a static hook after repetition and before approval/execution", async () => {
			const order: string[] = []
			mockTask.assistantMessageContent = [
				{
					type: "tool_use",
					id: "static-hook",
					name: "read_file",
					params: { path: "test.txt" },
					nativeArgs: { path: "test.txt" },
					partial: false,
				},
			]
			mockTask.toolRepetitionDetector.check.mockImplementation(() => {
				order.push("repetition")
				return { allowExecution: true }
			})
			mockTask.runPreToolUseHooks.mockImplementation(async () => {
				order.push("hook")
				return { decision: "allow", context: [{ type: "text", text: "<hook_result>safe</hook_result>" }] }
			})
			vi.spyOn(readFileTool, "handle").mockImplementationOnce(async (_task, _block, callbacks) => {
				order.push("execution")
				await callbacks.askApproval("tool", "read")
				callbacks.pushToolResult("read result")
			})

			await presentAssistantMessage(mockTask)

			expect(order).toEqual(["repetition", "hook", "execution"])
			expect(mockTask.runPreToolUseHooks).toHaveBeenCalledWith("read_file")
			expect(mockTask.userMessageContent).toEqual([
				{ type: "text", text: "<hook_result>safe</hook_result>" },
				expect.objectContaining({ type: "tool_result", tool_use_id: "static-hook" }),
			])
		})

		it("blocks a custom tool after argument validation with one real tool result", async () => {
			const execute = vi.fn<CustomToolDefinition["execute"]>().mockResolvedValue("custom result")
			const parameters = z.object({ secret: z.string() })
			const parse = vi.spyOn(parameters, "parse")
			mockTask.assistantMessageContent = [
				{
					type: "tool_use",
					id: "custom-block",
					name: "my_custom_tool",
					nativeArgs: { secret: "not-forwarded" },
					params: {},
					partial: false,
				},
			]
			vi.mocked(customToolRegistry.get).mockReturnValue({
				name: "my_custom_tool",
				description: "custom",
				parameters,
				execute,
			})
			mockTask.runPreToolUseHooks.mockResolvedValue({
				decision: "block",
				context: [],
				status: "blocked",
				reason: "blocked by hook",
			})

			await presentAssistantMessage(mockTask)

			expect(parse).toHaveBeenCalledBefore(mockTask.runPreToolUseHooks)
			expect(mockTask.runPreToolUseHooks).toHaveBeenCalledWith("my_custom_tool")
			expect(mockTask.runPreToolUseHooks.mock.calls[0]).toEqual(["my_custom_tool"])
			expect(execute).not.toHaveBeenCalled()
			expect(mockTask.ask).not.toHaveBeenCalled()
			expect(
				mockTask.userMessageContent.filter((item: { type?: string }) => item.type === "tool_result"),
			).toHaveLength(1)
		})

		it("skips approval, checkpoint, and static execution when blocked", async () => {
			mockTask.assistantMessageContent = [
				{
					type: "tool_use",
					id: "static-block",
					name: "write_to_file",
					params: { path: "blocked.txt", content: "blocked" },
					nativeArgs: { path: "blocked.txt", content: "blocked" },
					partial: false,
				},
			]
			mockTask.currentStreamingDidCheckpoint = false
			mockTask.checkpointSave = vi.fn()
			mockTask.runPreToolUseHooks.mockResolvedValue({
				decision: "block",
				context: [],
				status: "blocked",
				reason: "blocked by hook",
			})
			const execute = vi.spyOn(writeToFileTool, "handle")

			await presentAssistantMessage(mockTask)

			expect(mockTask.ask).not.toHaveBeenCalled()
			expect(mockTask.checkpointSave).not.toHaveBeenCalled()
			expect(execute).not.toHaveBeenCalled()
			expect(
				mockTask.userMessageContent.filter((item: { type?: string }) => item.type === "tool_result"),
			).toHaveLength(1)
		})

		it("does not run a hook for invalid custom arguments", async () => {
			mockTask.assistantMessageContent = [
				{
					type: "tool_use",
					id: "custom-invalid",
					name: "my_custom_tool",
					nativeArgs: { invalid: true },
					params: {},
					partial: false,
				},
			]
			vi.mocked(customToolRegistry.get).mockReturnValue({
				name: "my_custom_tool",
				description: "custom",
				parameters: z.object({ expected: z.string() }),
				execute: vi.fn<CustomToolDefinition["execute"]>(),
			})

			await presentAssistantMessage(mockTask)

			expect(mockTask.runPreToolUseHooks).not.toHaveBeenCalled()
			expect(
				mockTask.userMessageContent.filter((item: { type?: string }) => item.type === "tool_result"),
			).toHaveLength(1)
		})

		it("does not run a hook when built-in mode validation rejects the call", async () => {
			mockTask.assistantMessageContent = [
				{
					type: "tool_use",
					id: "static-invalid",
					name: "read_file",
					params: { path: "secret" },
					nativeArgs: { path: "secret" },
					partial: false,
				},
			]
			vi.mocked(validateToolUse).mockImplementationOnce(() => {
				throw new Error("not allowed")
			})

			await presentAssistantMessage(mockTask)

			expect(mockTask.toolRepetitionDetector.check).not.toHaveBeenCalled()
			expect(mockTask.runPreToolUseHooks).not.toHaveBeenCalled()
		})

		it("does not run a hook when repetition blocks the call", async () => {
			mockTask.assistantMessageContent = [
				{
					type: "tool_use",
					id: "static-repeated",
					name: "read_file",
					params: { path: "repeat" },
					nativeArgs: { path: "repeat" },
					partial: false,
				},
			]
			mockTask.toolRepetitionDetector.check.mockReturnValue({
				allowExecution: false,
				askUser: { messageKey: "mistake_limit_reached", messageDetail: "Repeated {toolName}" },
			})
			mockTask.apiConfiguration = { apiProvider: "test" }
			mockTask.consecutiveMistakeLimit = 3

			await presentAssistantMessage(mockTask)

			expect(mockTask.runPreToolUseHooks).not.toHaveBeenCalled()
			expect(
				mockTask.userMessageContent.filter((item: { type?: string }) => item.type === "tool_result"),
			).toHaveLength(1)
		})
	})

	describe("Custom tool error recording", () => {
		it("should record custom tool error as 'custom_tool'", async () => {
			const toolCallId = "tool_call_custom_error_123"
			mockTask.assistantMessageContent = [
				{
					type: "tool_use",
					id: toolCallId,
					name: "failing_custom_tool",
					params: {},
					partial: false,
				},
			]

			// Mock customToolRegistry with a tool that throws an error
			vi.mocked(customToolRegistry.has).mockReturnValue(true)
			vi.mocked(customToolRegistry.get).mockReturnValue({
				name: "failing_custom_tool",
				description: "A failing custom tool",
				execute: vi.fn().mockRejectedValue(new Error("Custom tool execution failed")),
			})

			await presentAssistantMessage(mockTask)

			// Should record error as "custom_tool", not "failing_custom_tool"
			expect(mockTask.recordToolError).toHaveBeenCalledWith("custom_tool", "Custom tool execution failed")
			expect(mockTask.consecutiveMistakeCount).toBe(1)
		})
	})

	describe("Regular tool recording", () => {
		it("should record regular tool usage with actual tool name", async () => {
			const toolCallId = "tool_call_read_file_123"
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

			// read_file is not a custom tool
			vi.mocked(customToolRegistry.has).mockReturnValue(false)

			await presentAssistantMessage(mockTask)

			// Should record as "read_file", not "custom_tool"
			expect(mockTask.recordToolUsage).toHaveBeenCalledWith("read_file")
		})

		it("should record MCP tool usage as 'use_mcp_tool' (not custom_tool)", async () => {
			const toolCallId = "tool_call_mcp_123"
			mockTask.assistantMessageContent = [
				{
					type: "tool_use",
					id: toolCallId,
					name: "use_mcp_tool",
					params: {
						server_name: "test-server",
						tool_name: "test-tool",
						arguments: "{}",
					},
					nativeArgs: {
						server_name: "test-server",
						tool_name: "test-tool",
						arguments: {},
					},
					partial: false,
				},
			]

			vi.mocked(customToolRegistry.has).mockReturnValue(false)

			// Mock MCP hub for use_mcp_tool
			mockTask.providerRef = {
				deref: () => ({
					getState: vi.fn().mockResolvedValue({
						mode: "code",
						customModes: [],
						experiments: {
							customTools: true,
						},
					}),
					getMcpHub: () => ({
						findServerNameBySanitizedName: () => "test-server",
						executeToolCall: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "result" }] }),
					}),
				}),
			}

			await presentAssistantMessage(mockTask)

			// Should record as "use_mcp_tool", not "custom_tool"
			expect(mockTask.recordToolUsage).toHaveBeenCalledWith("use_mcp_tool")
		})
	})

	describe("Custom tool experiment gate", () => {
		it("should treat custom tool as unknown when experiment is disabled", async () => {
			const toolCallId = "tool_call_disabled_123"
			mockTask.assistantMessageContent = [
				{
					type: "tool_use",
					id: toolCallId,
					name: "my_custom_tool",
					params: {},
					partial: false,
				},
			]

			// Mock provider state with customTools experiment DISABLED
			mockTask.providerRef = {
				deref: () => ({
					getState: vi.fn().mockResolvedValue({
						mode: "code",
						customModes: [],
						experiments: {
							customTools: false, // Disabled
						},
					}),
				}),
			}

			// Even if registry recognizes it, experiment gate should prevent execution
			vi.mocked(customToolRegistry.has).mockReturnValue(true)
			vi.mocked(customToolRegistry.get).mockReturnValue({
				name: "my_custom_tool",
				description: "A custom tool",
				execute: vi.fn().mockResolvedValue("Should not execute"),
			})

			await presentAssistantMessage(mockTask)

			// Should be treated as unknown tool (not executed)
			expect(mockTask.say).toHaveBeenCalledWith("error", "unknownToolError")
			expect(mockTask.consecutiveMistakeCount).toBe(1)

			// Custom tool should NOT have been executed
			const getMock = vi.mocked(customToolRegistry.get)
			if (getMock.mock.results.length > 0) {
				const customTool = getMock.mock.results[0].value
				if (customTool) {
					expect(customTool.execute).not.toHaveBeenCalled()
				}
			}
		})

		it("should not call customToolRegistry.has() when experiment is disabled", async () => {
			mockTask.assistantMessageContent = [
				{
					type: "tool_use",
					id: "tool_call_123",
					name: "some_tool",
					params: {},
					partial: false,
				},
			]

			// Disable experiment
			mockTask.providerRef = {
				deref: () => ({
					getState: vi.fn().mockResolvedValue({
						mode: "code",
						customModes: [],
						experiments: {
							customTools: false,
						},
					}),
				}),
			}

			await presentAssistantMessage(mockTask)

			// When experiment is off, shouldn't even check the registry
			// (Code checks stateExperiments?.customTools before calling has())
			expect(customToolRegistry.has).not.toHaveBeenCalled()
		})
	})

	describe("Validation requirements", () => {
		it("normalizes disabledTools aliases before validateToolUse", async () => {
			const toolCallId = "tool_call_validation_alias_123"
			mockTask.assistantMessageContent = [
				{
					type: "tool_use",
					id: toolCallId,
					name: "some_unknown_tool",
					params: {},
					partial: false,
				},
			]

			mockTask.providerRef = {
				deref: () => ({
					getState: vi.fn().mockResolvedValue({
						mode: "code",
						customModes: [],
						experiments: {
							customTools: false,
						},
						disabledTools: ["search_and_replace"],
					}),
				}),
			}

			await presentAssistantMessage(mockTask)

			const validateToolUseMock = vi.mocked(validateToolUse)
			expect(validateToolUseMock).toHaveBeenCalled()
			const toolRequirements = validateToolUseMock.mock.calls[0][3]
			expect(toolRequirements).toMatchObject({
				search_and_replace: false,
				edit: false,
			})
		})
	})

	describe("Partial blocks", () => {
		it("should not record usage for partial custom tool blocks", async () => {
			mockTask.assistantMessageContent = [
				{
					type: "tool_use",
					id: "tool_call_partial_123",
					name: "my_custom_tool",
					params: { value: "test" },
					partial: true, // Still streaming
				},
			]

			vi.mocked(customToolRegistry.has).mockReturnValue(true)

			await presentAssistantMessage(mockTask)

			// Should not record usage for partial blocks
			expect(mockTask.recordToolUsage).not.toHaveBeenCalled()
		})
	})
})
