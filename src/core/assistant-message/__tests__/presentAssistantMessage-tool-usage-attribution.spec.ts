// npx vitest src/core/assistant-message/__tests__/presentAssistantMessage-tool-usage-attribution.spec.ts

import type { Anthropic } from "@anthropic-ai/sdk"
import { describe, it, expect, beforeEach, vi } from "vitest"
import { presentAssistantMessage } from "../presentAssistantMessage"
import { validateToolUse } from "../../tools/validateToolUse"
import { getModeBySlug } from "../../../shared/modes"
import type { Task } from "../../task/Task"

vi.mock("../../task/Task")
vi.mock("../../../shared/modes", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../shared/modes")>()
	return {
		...actual,
		getModeBySlug: vi.fn(actual.getModeBySlug),
	}
})
// isValidToolName is left as the real implementation (only validateToolUse is
// mocked): it has its own independent mcp_ prefix carve-out, and a hand-rolled
// mock allowlist here would mask a regression in toTelemetryToolName's
// ordering relative to isValidToolName.
vi.mock("../../tools/validateToolUse", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../tools/validateToolUse")>()
	return {
		...actual,
		validateToolUse: vi.fn(),
	}
})

vi.mock("@roo-code/core", () => ({
	customToolRegistry: {
		has: vi.fn(() => false),
		get: vi.fn(),
	},
}))

vi.mock("@roo-code/telemetry", () => ({
	TelemetryService: {
		instance: {
			captureToolUsage: vi.fn(),
			captureConsecutiveMistakeError: vi.fn(),
			captureEvent: vi.fn(),
		},
	},
}))

import { TelemetryService } from "@roo-code/telemetry"

interface MockTask {
	taskId: string
	instanceId: string
	abort: boolean
	presentAssistantMessageLocked: boolean
	presentAssistantMessageHasPendingUpdates: boolean
	currentStreamingContentIndex: number
	assistantMessageContent: unknown[]
	userMessageContent: Anthropic.ToolResultBlockParam[]
	didCompleteReadingStream: boolean
	didRejectTool: boolean
	didAlreadyUseTool: boolean
	consecutiveMistakeCount: number
	clineMessages: unknown[]
	api: { getModel: () => { id: string; info: Record<string, unknown> } }
	recordToolUsage: ReturnType<typeof vi.fn>
	recordToolError: ReturnType<typeof vi.fn>
	toolRepetitionDetector: { check: ReturnType<typeof vi.fn> }
	providerRef: {
		deref: () => {
			getState: ReturnType<typeof vi.fn>
			getMcpHub?: () => { findServerNameBySanitizedName: (name: string) => string | undefined }
		}
	}
	say: ReturnType<typeof vi.fn>
	ask: ReturnType<typeof vi.fn>
	pushToolResultToUserContent: ReturnType<typeof vi.fn>
}

describe("presentAssistantMessage - tool usage attribution", () => {
	let mockTask: MockTask

	beforeEach(() => {
		vi.clearAllMocks()
		vi.mocked(validateToolUse).mockImplementation(() => undefined)

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
			pushToolResultToUserContent: vi.fn(),
		}

		mockTask.pushToolResultToUserContent = vi
			.fn()
			.mockImplementation((toolResult: Anthropic.ToolResultBlockParam) => {
				const existingResult = mockTask.userMessageContent.find(
					(block) => block.type === "tool_result" && block.tool_use_id === toolResult.tool_use_id,
				)
				if (existingResult) {
					return false
				}
				mockTask.userMessageContent.push(toolResult)
				return true
			})
	})

	it("records exactly one attempt for a normal static tool", async () => {
		mockTask.assistantMessageContent = [
			{
				type: "tool_use",
				id: "call_1",
				name: "read_file",
				params: { path: "test.txt" },
				nativeArgs: { path: "test.txt" },
				partial: false,
			},
		]

		await presentAssistantMessage(mockTask as unknown as Task)

		expect(mockTask.recordToolUsage).toHaveBeenCalledTimes(1)
		expect(mockTask.recordToolUsage).toHaveBeenCalledWith("read_file")
		expect(TelemetryService.instance.captureToolUsage).toHaveBeenCalledTimes(1)
		expect(TelemetryService.instance.captureToolUsage).toHaveBeenCalledWith(mockTask.taskId, "read_file")
	})

	it("records a valid dynamic mcp_ tool name as use_mcp_tool", async () => {
		mockTask.assistantMessageContent = [
			{
				type: "tool_use",
				id: "call_mcp",
				name: "mcp_my_server_do_thing",
				params: {},
				nativeArgs: {},
				partial: false,
			},
		]

		await presentAssistantMessage(mockTask as unknown as Task)

		expect(mockTask.recordToolUsage).toHaveBeenCalledWith("use_mcp_tool")
		expect(TelemetryService.instance.captureToolUsage).toHaveBeenCalledWith(mockTask.taskId, "use_mcp_tool")
	})

	it("records a malformed mcp_ tool name as use_mcp_tool, not the raw name", async () => {
		mockTask.assistantMessageContent = [
			{
				type: "tool_use",
				id: "call_mcp_bad",
				name: "mcp_",
				params: {},
				nativeArgs: {},
				partial: false,
			},
		]

		await presentAssistantMessage(mockTask as unknown as Task)

		expect(mockTask.recordToolUsage).toHaveBeenCalledWith("use_mcp_tool")
		expect(mockTask.recordToolUsage).not.toHaveBeenCalledWith("mcp_")
	})

	it("records a safe failure key without leaking the raw tool name when validation fails", async () => {
		vi.mocked(validateToolUse).mockImplementation(() => {
			throw new Error('Tool "read_file" is not allowed in this mode.')
		})

		mockTask.assistantMessageContent = [
			{
				type: "tool_use",
				id: "call_bad_mode",
				name: "read_file",
				params: { path: "test.txt" },
				nativeArgs: { path: "test.txt" },
				partial: false,
			},
		]

		await presentAssistantMessage(mockTask as unknown as Task)

		// A known static tool that fails validation still maps to its own name
		// (it's a real, recognized tool - just disallowed here), never left raw/unmapped.
		expect(mockTask.recordToolError).toHaveBeenCalledWith("read_file", expect.any(String))
		// No success attempt should be recorded for a validation failure.
		expect(mockTask.recordToolUsage).not.toHaveBeenCalled()
	})

	it("records invalid_tool_call, not the raw name, when an arbitrary unknown tool fails validation", async () => {
		vi.mocked(validateToolUse).mockImplementation(() => {
			throw new Error('Unknown tool "totally_made_up_tool". This tool does not exist.')
		})

		mockTask.assistantMessageContent = [
			{
				type: "tool_use",
				id: "call_unknown",
				name: "totally_made_up_tool",
				params: {},
				nativeArgs: {},
				partial: false,
			},
		]

		await presentAssistantMessage(mockTask as unknown as Task)

		expect(mockTask.recordToolError).toHaveBeenCalledWith("invalid_tool_call", expect.any(String))
		expect(mockTask.recordToolError).not.toHaveBeenCalledWith("totally_made_up_tool", expect.anything())
		expect(mockTask.recordToolUsage).not.toHaveBeenCalled()
	})

	describe("native mcp_tool_use block", () => {
		it("records exactly one attempt once the MCP tool's own validation passes", async () => {
			mockTask.providerRef = {
				deref: () => ({
					getState: vi.fn().mockResolvedValue({
						mode: "code",
						customModes: [],
					}),
					getMcpHub: () => ({
						findServerNameBySanitizedName: () => "my_server",
						getAllServers: () => [
							{
								name: "my_server",
								tools: [{ name: "do_thing", enabledForPrompt: true }],
							},
						],
					}),
				}),
			}

			mockTask.assistantMessageContent = [
				{
					type: "mcp_tool_use",
					id: "call_native_mcp",
					name: "mcp_my_server_do_thing",
					serverName: "my_server",
					toolName: "do_thing",
					arguments: {},
					partial: false,
				},
			]

			await presentAssistantMessage(mockTask as unknown as Task)

			expect(mockTask.recordToolUsage).toHaveBeenCalledTimes(1)
			expect(mockTask.recordToolUsage).toHaveBeenCalledWith("use_mcp_tool")
			expect(TelemetryService.instance.captureToolUsage).toHaveBeenCalledTimes(1)
			expect(TelemetryService.instance.captureToolUsage).toHaveBeenCalledWith(mockTask.taskId, "use_mcp_tool")
		})

		it("records no attempt when the MCP server is not on the mode's allow-list", async () => {
			vi.mocked(getModeBySlug).mockReturnValueOnce({
				slug: "code",
				name: "Code",
				roleDefinition: "",
				groups: [],
				allowedMcpServers: ["some-other-server"],
			})

			mockTask.providerRef = {
				deref: () => ({
					getState: vi.fn().mockResolvedValue({
						mode: "code",
						customModes: [],
					}),
					getMcpHub: () => ({
						findServerNameBySanitizedName: () => "my_server",
					}),
				}),
			}

			mockTask.assistantMessageContent = [
				{
					type: "mcp_tool_use",
					id: "call_native_mcp_disallowed",
					name: "mcp_my_server_do_thing",
					serverName: "my_server",
					toolName: "do_thing",
					arguments: {},
					partial: false,
				},
			]

			await presentAssistantMessage(mockTask as unknown as Task)

			// The server is disallowed, so the call never reaches onValidated:
			// no success attempt is recorded for a call that was never permitted to execute.
			expect(mockTask.recordToolUsage).not.toHaveBeenCalled()
			expect(TelemetryService.instance.captureToolUsage).not.toHaveBeenCalled()
		})
	})
})
