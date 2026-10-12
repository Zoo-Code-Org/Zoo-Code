// npx vitest src/core/assistant-message/__tests__/presentAssistantMessage-custom-tool.spec.ts

import { describe, it, expect, beforeEach, vi } from "vitest"
import { presentAssistantMessage } from "../presentAssistantMessage"
import { validateToolUse } from "../../tools/validateToolUse"

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

// Mock the tool handlers so the tests only exercise validation (toolRequirements)
// and never the real tool execution logic.
vi.mock("../../tools/AttemptCompletionTool", () => ({
	attemptCompletionTool: { handle: vi.fn().mockResolvedValue(undefined) },
}))
vi.mock("../../tools/AskFollowupQuestionTool", () => ({
	askFollowupQuestionTool: { handle: vi.fn().mockResolvedValue(undefined) },
}))

// presentAssistantMessage records tool usage through TelemetryService.instance.
vi.mock("@roo-code/telemetry", () => ({
	TelemetryService: {
		instance: {
			captureToolUsage: vi.fn(),
			captureConsecutiveMistakeError: vi.fn(),
			captureEvent: vi.fn(),
		},
	},
}))

import { customToolRegistry } from "@roo-code/core"

describe("presentAssistantMessage - Custom Tool Recording", () => {
	let mockTask: any

	beforeEach(() => {
		// Reset all mocks
		vi.clearAllMocks()

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
			getTaskMode: vi.fn().mockResolvedValue("code"),
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
						experiments: {
							customTools: true, // Enable by default
						},
					}),
				}),
			},
			say: vi.fn().mockResolvedValue(undefined),
			ask: vi.fn().mockResolvedValue({ response: "yesButtonClicked" }),
			finalizePartialToolAsk: vi.fn().mockResolvedValue(undefined),
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

		it("passes the task-local mode to custom tool execution", async () => {
			mockTask.getTaskMode.mockResolvedValue("code")
			mockTask.providerRef.deref = () => ({
				getState: vi.fn().mockResolvedValue({
					mode: "orchestrator",
					customModes: [],
					experiments: { customTools: true },
				}),
			})
			mockTask.assistantMessageContent = [
				{
					type: "tool_use",
					id: "tool_call_task_mode",
					name: "my_custom_tool",
					params: {},
					partial: false,
				},
			]
			const execute = vi.fn().mockResolvedValue("Custom tool result")
			vi.mocked(customToolRegistry.has).mockReturnValue(true)
			vi.mocked(customToolRegistry.get).mockReturnValue({
				name: "my_custom_tool",
				description: "A custom tool",
				execute,
			})

			await presentAssistantMessage(mockTask)

			expect(execute).toHaveBeenCalledWith(undefined, { mode: "code", task: mockTask })
		})
	})

	describe("Custom tool mode delegation regression", () => {
		// Regression for issue #1623.
		// Before the fix, customTool.execute received the shared provider mode
		// instead of the task-local mode. A child delegated to "architect" would
		// have its custom tool called with "orchestrator".
		it("passes the task-local mode to customTool.execute, not the provider mode", async () => {
			// Provider says "orchestrator"; task was delegated to "architect".
			mockTask.providerRef = {
				deref: () => ({
					getState: vi.fn().mockResolvedValue({
						mode: "orchestrator",
						customModes: [],
						experiments: { customTools: true },
					}),
				}),
			}
			mockTask.getTaskMode = vi.fn().mockResolvedValue("architect")

			const executeMock = vi.fn().mockResolvedValue("result")
			vi.mocked(customToolRegistry.has).mockReturnValue(true)
			vi.mocked(customToolRegistry.get).mockReturnValue({
				name: "my_custom_tool",
				description: "A custom tool",
				execute: executeMock,
			})

			mockTask.assistantMessageContent = [
				{
					type: "tool_use",
					id: "call_delegation",
					name: "my_custom_tool",
					params: { value: "test" },
					partial: false,
				},
			]

			await presentAssistantMessage(mockTask)

			expect(executeMock).toHaveBeenCalledOnce()
			const context = executeMock.mock.calls[0][1]
			expect(context.mode).toBe("architect")
			expect(context.task).toBe(mockTask)
		})
	})

	describe("Presentation lock ownership", () => {
		it("drains an update queued during the helper-to-wrapper handoff", async () => {
			mockTask.assistantMessageContent = [{ type: "text", content: "initial", partial: true }]
			let queuedCall: Promise<void> | undefined
			let lockedDuringHandoff = false
			mockTask.say.mockImplementationOnce(async () => {
				// The first microtask precedes the helper's await continuation.
				// The second follows that continuation but precedes the wrapper's.
				queueMicrotask(() => {
					queueMicrotask(() => {
						lockedDuringHandoff = mockTask.presentAssistantMessageLocked
						mockTask.assistantMessageContent[0] = { type: "text", content: "final", partial: false }
						mockTask.didCompleteReadingStream = true
						queuedCall = presentAssistantMessage(mockTask)
					})
				})
			})

			await presentAssistantMessage(mockTask)
			await queuedCall

			expect(lockedDuringHandoff).toBe(true)
			expect(mockTask.say.mock.calls).toEqual([
				["text", "initial", undefined, true],
				["text", "final", undefined, false],
			])
			expect(mockTask.currentStreamingContentIndex).toBe(1)
			expect(mockTask.userMessageContentReady).toBe(true)
			expect(mockTask.presentAssistantMessageHasPendingUpdates).toBe(false)
			expect(mockTask.presentAssistantMessageLocked).toBe(false)
		})

		it("stops draining an update queued during the handoff once the task aborts", async () => {
			mockTask.assistantMessageContent = [{ type: "text", content: "initial", partial: true }]
			let queuedCall: Promise<void> | undefined
			let pendingDuringHandoff = false
			let aborted = false
			let abortChecksAfterAbort = 0
			Object.defineProperty(mockTask, "abort", {
				configurable: true,
				get: () => {
					// Fail fast instead of hanging if a drain keeps retrying an
					// aborted pass whose pending update can never be consumed.
					if (aborted && ++abortChecksAfterAbort > 10) {
						throw new Error("presenter kept draining after abort")
					}
					return aborted
				},
			})
			mockTask.say.mockImplementationOnce(async () => {
				queueMicrotask(() => {
					queueMicrotask(() => {
						mockTask.assistantMessageContent[0] = { type: "text", content: "final", partial: false }
						mockTask.didCompleteReadingStream = true
						queuedCall = presentAssistantMessage(mockTask)
						pendingDuringHandoff = mockTask.presentAssistantMessageHasPendingUpdates
						aborted = true
					})
				})
			})

			await presentAssistantMessage(mockTask)
			await queuedCall

			expect(pendingDuringHandoff).toBe(true)
			expect(mockTask.say).toHaveBeenCalledExactlyOnceWith("text", "initial", undefined, true)
			expect(mockTask.currentStreamingContentIndex).toBe(0)
			expect(mockTask.presentAssistantMessageLocked).toBe(false)
		})

		it("holds one lock across consecutive blocks and queues overlapping calls", async () => {
			mockTask.assistantMessageContent = [
				{ type: "text", content: "first", partial: false },
				{ type: "text", content: "second", partial: false },
			]
			mockTask.didCompleteReadingStream = true
			const lockChanges: boolean[] = []
			let locked = false
			Object.defineProperty(mockTask, "presentAssistantMessageLocked", {
				configurable: true,
				get: () => locked,
				set: (value: boolean) => {
					locked = value
					lockChanges.push(value)
				},
			})
			mockTask.say.mockImplementation(async (_type: string, content: string) => {
				expect(mockTask.presentAssistantMessageLocked).toBe(true)
				if (content === "second") {
					await presentAssistantMessage(mockTask)
					expect(mockTask.presentAssistantMessageHasPendingUpdates).toBe(true)
				}
			})

			await presentAssistantMessage(mockTask)

			expect(mockTask.say.mock.calls).toEqual([
				["text", "first", undefined, false],
				["text", "second", undefined, false],
			])
			expect(mockTask.currentStreamingContentIndex).toBe(2)
			expect(mockTask.userMessageContentReady).toBe(true)
			expect(mockTask.presentAssistantMessageHasPendingUpdates).toBe(false)
			expect(lockChanges).toEqual([true, false])
		})

		it("consumes a pending update for a partial block without repeating it indefinitely", async () => {
			mockTask.assistantMessageContent = [{ type: "text", content: "initial", partial: true }]
			mockTask.say
				.mockImplementationOnce(async () => {
					mockTask.assistantMessageContent[0] = { type: "text", content: "updated", partial: true }
					await presentAssistantMessage(mockTask)
					expect(mockTask.presentAssistantMessageHasPendingUpdates).toBe(true)
				})
				.mockImplementationOnce(async () => {
					expect(mockTask.presentAssistantMessageLocked).toBe(true)
					expect(mockTask.presentAssistantMessageHasPendingUpdates).toBe(false)
				})

			await presentAssistantMessage(mockTask)

			expect(mockTask.say.mock.calls).toEqual([
				["text", "initial", undefined, true],
				["text", "updated", undefined, true],
			])
			expect(mockTask.currentStreamingContentIndex).toBe(0)
			expect(mockTask.presentAssistantMessageHasPendingUpdates).toBe(false)
			expect(mockTask.presentAssistantMessageLocked).toBe(false)
		})

		it("stops internal continuation when the task aborts between blocks", async () => {
			mockTask.assistantMessageContent = [
				{ type: "text", content: "first", partial: false },
				{ type: "text", content: "second", partial: false },
			]
			mockTask.say.mockImplementationOnce(async () => {
				mockTask.abort = true
			})

			await presentAssistantMessage(mockTask)

			expect(mockTask.say).toHaveBeenCalledExactlyOnceWith("text", "first", undefined, false)
			expect(mockTask.currentStreamingContentIndex).toBe(1)
			expect(mockTask.presentAssistantMessageLocked).toBe(false)
		})

		it("releases the presentation lock when a later block throws", async () => {
			mockTask.assistantMessageContent = [
				{ type: "text", content: "first", partial: false },
				{ type: "text", content: "second", partial: false },
			]
			mockTask.say.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("second block failed"))

			await expect(presentAssistantMessage(mockTask)).rejects.toThrow("second block failed")

			expect(mockTask.say).toHaveBeenCalledTimes(2)
			expect(mockTask.currentStreamingContentIndex).toBe(1)
			expect(mockTask.presentAssistantMessageLocked).toBe(false)
		})
	})

	describe("Custom tool error recording", () => {
		it("releases the presentation lock when dispatch throws", async () => {
			mockTask.assistantMessageContent = [
				{
					type: "tool_use",
					id: "tool_call_dispatch_failure",
					name: "read_file",
					params: {},
					partial: false,
				},
			]
			mockTask.providerRef.deref = () => ({
				getState: vi.fn().mockRejectedValue(new Error("provider state failed")),
			})

			await expect(presentAssistantMessage(mockTask)).rejects.toThrow("provider state failed")
			expect(mockTask.presentAssistantMessageLocked).toBe(false)
		})

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

		it("marks a disabled attempt_completion as blocked and answers it with an error tool_result", async () => {
			// An explicit disabledTools entry outranks the always-available class,
			// so a disabled attempt_completion reaches the validator like any
			// other tool; its rejection must surface as the standard validation-
			// error tool_result instead of completing the task.
			mockTask.assistantMessageContent = [
				{
					type: "tool_use",
					id: "tool_call_protocol_123",
					name: "attempt_completion",
					params: {},
					nativeArgs: {},
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
						disabledTools: ["attempt_completion"],
					}),
				}),
			}

			// Mirror the real validator's rejection for a requirement that maps
			// to false (validateToolUse.spec pins the predicate itself).
			vi.mocked(validateToolUse).mockImplementationOnce(() => {
				throw new Error('Tool "attempt_completion" is not allowed in code mode.')
			})

			await presentAssistantMessage(mockTask)

			const validateToolUseMock = vi.mocked(validateToolUse)
			expect(validateToolUseMock).toHaveBeenCalled()
			const toolRequirements = validateToolUseMock.mock.calls[0][3]
			expect(toolRequirements).toMatchObject({ attempt_completion: false })

			const errorToolResults = mockTask.userMessageContent.filter((block: unknown) => {
				const b = block as { type?: string; is_error?: boolean }
				return b.type === "tool_result" && b.is_error
			})
			expect(errorToolResults).toHaveLength(1)
			expect(mockTask.consecutiveMistakeCount).toBe(1)

			// The completion handler must not run for the rejected call.
			const { attemptCompletionTool } = await import("../../tools/AttemptCompletionTool")
			expect(attemptCompletionTool.handle).not.toHaveBeenCalled()
		})

		it("treats a model-excluded attempt_completion as blocked and answers it with an error tool_result", async () => {
			// A model excludedTools entry suppresses the protocol tool in the
			// effective policy, so the execution gate must see the same
			// restriction with disabledTools unset.
			mockTask.assistantMessageContent = [
				{
					type: "tool_use",
					id: "tool_call_protocol_excluded_123",
					name: "attempt_completion",
					params: {},
					nativeArgs: {},
					partial: false,
				},
			]

			mockTask.api.getModel = () => ({ id: "test-model", info: { excludedTools: ["attempt_completion"] } })

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

			// Mirror the real validator's rejection for a requirement that maps
			// to false (validateToolUse.spec pins the predicate itself).
			vi.mocked(validateToolUse).mockImplementationOnce(() => {
				throw new Error('Tool "attempt_completion" is not allowed in code mode.')
			})

			await presentAssistantMessage(mockTask)

			const validateToolUseMock = vi.mocked(validateToolUse)
			expect(validateToolUseMock).toHaveBeenCalled()
			const toolRequirements = validateToolUseMock.mock.calls[0][3]
			expect(toolRequirements).toMatchObject({ attempt_completion: false })

			const errorToolResults = mockTask.userMessageContent.filter((block: unknown) => {
				const b = block as { type?: string; is_error?: boolean }
				return b.type === "tool_result" && b.is_error
			})
			expect(errorToolResults).toHaveLength(1)
			expect(mockTask.consecutiveMistakeCount).toBe(1)

			// The completion handler must not run for the rejected call.
			const { attemptCompletionTool } = await import("../../tools/AttemptCompletionTool")
			expect(attemptCompletionTool.handle).not.toHaveBeenCalled()

			// Absent model metadata must not derail the requirements build: the
			// protocol-tool leg simply sees no exclusions, and the call validates
			// normally instead of erroring out.
			mockTask.api.getModel = () => undefined
			mockTask.currentStreamingContentIndex = 0
			mockTask.userMessageContent = []
			mockTask.consecutiveMistakeCount = 0
			mockTask.didAlreadyUseTool = false
			mockTask.didCompleteReadingStream = false

			await presentAssistantMessage(mockTask)

			expect(validateToolUseMock).toHaveBeenCalledTimes(2)
			expect(validateToolUseMock.mock.calls[1][3]).toEqual({})
			expect(mockTask.consecutiveMistakeCount).toBe(0)
			const phase2Errors = mockTask.userMessageContent.filter((block: { type?: string; is_error?: boolean }) => {
				return block.type === "tool_result" && block.is_error
			})
			expect(phase2Errors).toHaveLength(0)
		})

		it("still marks ordinary tools (ask_followup_question) as blocked", async () => {
			mockTask.assistantMessageContent = [
				{
					type: "tool_use",
					id: "tool_call_ordinary_123",
					name: "ask_followup_question",
					params: { question: "Which option?" },
					nativeArgs: { question: "Which option?" },
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
						disabledTools: ["ask_followup_question"],
					}),
				}),
			}

			await presentAssistantMessage(mockTask)

			const validateToolUseMock = vi.mocked(validateToolUse)
			expect(validateToolUseMock).toHaveBeenCalled()
			const toolRequirements = validateToolUseMock.mock.calls[0][3]
			expect(toolRequirements).toMatchObject({
				ask_followup_question: false,
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
