// npx vitest src/core/assistant-message/__tests__/presentAssistantMessage-custom-tool.spec.ts

import { describe, it, expect, beforeEach, vi } from "vitest"
import { presentAssistantMessage } from "../presentAssistantMessage"
import { validateToolUse } from "../../tools/validateToolUse"
import type { RequestPolicySnapshot } from "../../prompts/tools/effective-tool-policy"

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

// The snapshot the presenter consumes; the getState doubles below deliberately
// disagree with it so any surviving live-read re-entry is caught by assertions.
const baseSnapshot: RequestPolicySnapshot = {
	disabledTools: [],
	customModes: [],
	experiments: { customTools: true },
}

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
				check: vi.fn().mockReturnValue({ allowExecution: true }),
			},
			providerRef: {
				deref: () => ({
					getState: vi.fn().mockResolvedValue({
						mode: "code",
						customModes: [],
						// Poisoned: reads opposite to baseSnapshot, so a live
						// read here changes validation behavior and fails tests.
						experiments: {
							customTools: false,
						},
						disabledTools: ["read_file"],
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

			await presentAssistantMessage(mockTask, baseSnapshot)

			// Should record as "custom_tool", not "my_custom_tool"
			expect(mockTask.recordToolUsage).toHaveBeenCalledWith("custom_tool")
		})

		it("passes the task-local mode to custom tool execution", async () => {
			mockTask.getTaskMode.mockResolvedValue("code")
			mockTask.providerRef.deref = () => ({
				getState: vi.fn().mockResolvedValue({
					mode: "orchestrator",
					customModes: [],
					experiments: { customTools: false },
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

			await presentAssistantMessage(mockTask, baseSnapshot)

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
						// Poisoned: a live read would disable the custom-tool gate.
						experiments: { customTools: false },
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

			await presentAssistantMessage(mockTask, baseSnapshot)

			expect(executeMock).toHaveBeenCalledOnce()
			const context = executeMock.mock.calls[0][1]
			expect(context.mode).toBe("architect")
			expect(context.task).toBe(mockTask)
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

			await presentAssistantMessage(mockTask, baseSnapshot)

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

			await presentAssistantMessage(mockTask, baseSnapshot)

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
							customTools: false,
						},
						disabledTools: ["use_mcp_tool"],
					}),
					getMcpHub: () => ({
						findServerNameBySanitizedName: () => "test-server",
						executeToolCall: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "result" }] }),
					}),
				}),
			}

			await presentAssistantMessage(mockTask, baseSnapshot)

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

			// The snapshot carries the disabled experiment; the provider double is
			// poisoned with the enabled value so a live read would flip the gate.
			mockTask.providerRef = {
				deref: () => ({
					getState: vi.fn().mockResolvedValue({
						mode: "code",
						customModes: [],
						experiments: {
							customTools: true,
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

			await presentAssistantMessage(mockTask, { ...baseSnapshot, experiments: { customTools: false } })

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
							customTools: true,
						},
					}),
				}),
			}

			await presentAssistantMessage(mockTask, { ...baseSnapshot, experiments: { customTools: false } })

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
						// Poisoned: a live read would build requirements for
						// read_file instead of the snapshot's search_and_replace.
						disabledTools: ["read_file"],
					}),
				}),
			}

			await presentAssistantMessage(mockTask, { ...baseSnapshot, disabledTools: ["search_and_replace"] })

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
						// Poisoned: empty live list would leave requirements empty.
						disabledTools: [],
					}),
				}),
			}

			// Mirror the real validator's rejection for a requirement that maps
			// to false (validateToolUse.spec pins the predicate itself).
			vi.mocked(validateToolUse).mockImplementationOnce(() => {
				throw new Error('Tool "attempt_completion" is not allowed in code mode.')
			})

			await presentAssistantMessage(mockTask, { ...baseSnapshot, disabledTools: ["attempt_completion"] })

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

			// The snapshot carries the model exclusion; the live model read is
			// poisoned with no exclusions so a live read would empty requirements.
			mockTask.api.getModel = () => ({ id: "test-model", info: {} })

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

			await presentAssistantMessage(mockTask, {
				...baseSnapshot,
				modelInfo: {
					contextWindow: 200000,
					supportsPromptCache: false,
					excludedTools: ["attempt_completion"],
				},
			})

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

			await presentAssistantMessage(mockTask, baseSnapshot)

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
						// Poisoned: a live read would build requirements for
						// read_file instead of the snapshot's ask_followup_question.
						disabledTools: ["read_file"],
					}),
				}),
			}

			await presentAssistantMessage(mockTask, { ...baseSnapshot, disabledTools: ["ask_followup_question"] })

			const validateToolUseMock = vi.mocked(validateToolUse)
			expect(validateToolUseMock).toHaveBeenCalled()
			const toolRequirements = validateToolUseMock.mock.calls[0][3]
			expect(toolRequirements).toMatchObject({
				ask_followup_question: false,
			})
		})

		it("does not newly reject an advertised tool when the live settings disable it after the prompt was built", async () => {
			// The prompt was built from the passed snapshot, which advertises
			// attempt_completion; the provider double carries a settings edit that
			// landed after that capture. Validation must never consult the live
			// list, so the tool stays executable: a live-read re-entry would build
			// "attempt_completion: false" requirements and the mirrored gate below
			// would reject instead of dispatching.
			mockTask.assistantMessageContent = [
				{
					type: "tool_use",
					id: "tool_call_snapshot_disable_123",
					name: "attempt_completion",
					params: { result: "done" },
					nativeArgs: { result: "done" },
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
						// Disagrees with the snapshot: attempt_completion was
						// disabled only after the prompt was built.
						disabledTools: ["attempt_completion"],
					}),
				}),
			}

			// attempt_completion is not a custom tool (registry lookups leak
			// between tests, so pin the answer here as elsewhere in this file).
			vi.mocked(customToolRegistry.has).mockReturnValue(false)

			// Mirror validateToolUse's requirements gate — an entry mapped to
			// false rejects with the real validator's not-allowed message (pinned
			// by validateToolUse.spec) — so a live read surfaces as an execution
			// outcome, not only as a differing call argument.
			vi.mocked(validateToolUse).mockImplementationOnce((toolName, mode, _customModes, toolRequirements) => {
				if (toolRequirements?.[toolName] === false) {
					throw new Error(`Tool "${toolName}" is not allowed in ${mode} mode.`)
				}
			})

			await presentAssistantMessage(mockTask, baseSnapshot)

			const validateToolUseMock = vi.mocked(validateToolUse)
			expect(validateToolUseMock).toHaveBeenCalled()
			// Empty requirements: built from the snapshot's empty disabledTools,
			// not from the mutated live list.
			expect(validateToolUseMock.mock.calls[0][3]).toEqual({})
			expect(mockTask.recordToolUsage).toHaveBeenCalledWith("attempt_completion")
			const { attemptCompletionTool } = await import("../../tools/AttemptCompletionTool")
			expect(attemptCompletionTool.handle).toHaveBeenCalledOnce()
			const errorToolResults = mockTask.userMessageContent.filter((block: unknown) => {
				const b = block as { type?: string; is_error?: boolean }
				return b.type === "tool_result" && b.is_error
			})
			expect(errorToolResults).toHaveLength(0)
		})

		it("still rejects a tool the prompt omitted when the live settings re-enable it after the prompt was built", async () => {
			// The snapshot's disabledTools kept read_file out of the prompt. The
			// provider double reflects a settings edit that re-enables the tool
			// after that capture; validation must stay on the frozen policy and
			// reject the call instead of executing the un-advertised tool.
			mockTask.assistantMessageContent = [
				{
					type: "tool_use",
					id: "tool_call_snapshot_reenable_123",
					name: "read_file",
					params: { path: "test.txt" },
					nativeArgs: { path: "test.txt" },
					partial: false,
				},
			]

			// read_file is not a custom tool (registry lookups leak between
			// tests, so pin the answer here as elsewhere in this file).
			vi.mocked(customToolRegistry.has).mockReturnValue(false)
			vi.mocked(customToolRegistry.get).mockReturnValue(undefined)

			mockTask.providerRef = {
				deref: () => ({
					getState: vi.fn().mockResolvedValue({
						mode: "code",
						customModes: [],
						experiments: {
							customTools: false,
						},
						// Disagrees with the snapshot: the disabling entry was
						// removed only after the prompt was built.
						disabledTools: [],
					}),
				}),
			}

			// Mirror validateToolUse's requirements gate (as above) so the
			// snapshot-fed rejection is observable end to end.
			vi.mocked(validateToolUse).mockImplementationOnce((toolName, mode, _customModes, toolRequirements) => {
				if (toolRequirements?.[toolName] === false) {
					throw new Error(`Tool "${toolName}" is not allowed in ${mode} mode.`)
				}
			})

			await presentAssistantMessage(mockTask, { ...baseSnapshot, disabledTools: ["read_file"] })

			const validateToolUseMock = vi.mocked(validateToolUse)
			expect(validateToolUseMock).toHaveBeenCalled()
			// Strictly the snapshot's restriction; an emptied live list would
			// have produced {} here.
			expect(validateToolUseMock.mock.calls[0][3]).toEqual({ read_file: false })

			const errorToolResults = mockTask.userMessageContent.filter((block: unknown) => {
				const b = block as { type?: string; is_error?: boolean }
				return b.type === "tool_result" && b.is_error
			})
			expect(errorToolResults).toHaveLength(1)
			// Rejected at validation: the tool itself never ran.
			expect(mockTask.recordToolUsage).not.toHaveBeenCalled()
			expect(mockTask.consecutiveMistakeCount).toBe(1)
		})

		it("validates against the snapshot's modelInfo.includedTools when the live model metadata disagrees", async () => {
			// The presenter derives the validator's includedTools argument from
			// policySnapshot.modelInfo, alias-resolving each entry. A live read of
			// the model metadata would pick up the poisoned getModel() double below
			// and forward a different list; the mirrored includedTools gate makes
			// that difference observable as an execution outcome, not only as a
			// differing call argument.
			mockTask.assistantMessageContent = [
				{
					type: "tool_use",
					id: "tool_call_snapshot_included_123",
					name: "attempt_completion",
					params: {},
					nativeArgs: {},
					partial: false,
				},
			]

			// attempt_completion is not a custom tool (registry lookups leak
			// between tests, so pin the answer here as elsewhere in this file).
			vi.mocked(customToolRegistry.has).mockReturnValue(false)

			// Poisoned: the live model metadata's inclusion list omits the tool the
			// snapshot advertises, so a live read would forward ["apply_patch"].
			mockTask.api.getModel = () => ({ id: "test-model", info: { includedTools: ["apply_patch"] } })

			// Mirror the file's validateToolUse-gate idiom: a provided includedTools
			// list that does not contain the tool rejects with the real validator's
			// not-allowed message, turning a diverging list into an execution outcome.
			vi.mocked(validateToolUse).mockImplementationOnce(
				(toolName, mode, _customModes, _requirements, _params, _experiments, includedTools) => {
					if (includedTools && !includedTools.includes(toolName)) {
						throw new Error(`Tool "${toolName}" is not allowed in ${mode} mode.`)
					}
				},
			)

			await presentAssistantMessage(mockTask, {
				...baseSnapshot,
				modelInfo: {
					contextWindow: 200000,
					supportsPromptCache: false,
					includedTools: ["search_and_replace", "attempt_completion"],
				},
			})

			const validateToolUseMock = vi.mocked(validateToolUse)
			expect(validateToolUseMock).toHaveBeenCalled()
			// Snapshot-derived and alias-resolved: "search_and_replace" arrived as
			// its canonical "edit", and the live metadata's list never entered the
			// call (a live read would give ["apply_patch"] here).
			expect(validateToolUseMock.mock.calls[0][6]).toEqual(["edit", "attempt_completion"])

			// Execution followed the snapshot's list: the tool validated, was
			// recorded, and dispatched instead of drawing a rejection tool_result.
			expect(mockTask.recordToolUsage).toHaveBeenCalledWith("attempt_completion")
			const { attemptCompletionTool } = await import("../../tools/AttemptCompletionTool")
			expect(attemptCompletionTool.handle).toHaveBeenCalledOnce()
			const allowedErrors = mockTask.userMessageContent.filter((block: unknown) => {
				const b = block as { type?: string; is_error?: boolean }
				return b.type === "tool_result" && b.is_error
			})
			expect(allowedErrors).toHaveLength(0)
		})

		it("fails fast with a missing-snapshot error instead of re-reading live settings", async () => {
			// The required chain parameter makes an omitted snapshot a compile
			// error; this widened function type reproduces a caller that supplies
			// none at runtime anyway. The `as` below is the minimal typed widening
			// — no untyped escape, no double assertion — needed to pass undefined
			// where the required parameter type forbids it.
			const presentWithoutSnapshot = presentAssistantMessage as (
				cline: Parameters<typeof presentAssistantMessage>[0],
				policySnapshot?: RequestPolicySnapshot,
			) => ReturnType<typeof presentAssistantMessage>

			mockTask.assistantMessageContent = [
				{
					type: "tool_use",
					id: "tool_call_no_snapshot_123",
					name: "read_file",
					params: { path: "test.txt" },
					partial: false,
				},
			]

			const getState = vi.fn().mockResolvedValue({
				mode: "code",
				customModes: [],
				experiments: { customTools: false },
				disabledTools: [],
			})
			mockTask.providerRef = { deref: () => ({ getState }) }

			let rejection: unknown
			await presentWithoutSnapshot(mockTask, undefined).catch((error: unknown) => {
				rejection = error
			})

			// The fire-and-forget wrapper suppresses only rejections whose
			// message ends in "aborted"; the guard's message deliberately does
			// not, so the wrapper surfaces this as a real failure rather than
			// silently treating the run as aborted.
			if (!(rejection instanceof Error)) {
				throw new Error(`expected a thrown Error, got ${String(rejection)}`)
			}
			expect(rejection.message).toMatch(/missing request policy snapshot/)
			expect(rejection.message.endsWith("aborted")).toBe(false)
			// No fallback re-read: the live settings source is never consulted.
			expect(getState).not.toHaveBeenCalled()
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

			await presentAssistantMessage(mockTask, baseSnapshot)

			// Should not record usage for partial blocks
			expect(mockTask.recordToolUsage).not.toHaveBeenCalled()
		})
	})
})
