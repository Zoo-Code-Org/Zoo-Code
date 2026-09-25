// npx vitest src/core/assistant-message/__tests__/presentAssistantMessage-tool-usage-attribution.spec.ts

import type { Anthropic } from "@anthropic-ai/sdk"
import { describe, it, expect, beforeEach, vi, type Mock } from "vitest"
import { presentAssistantMessage } from "../presentAssistantMessage"
import { validateToolUse } from "../../tools/validateToolUse"
import { getModeBySlug } from "../../../shared/modes"
import type { Task } from "../../task/Task"
import type { RequestPolicySnapshot } from "../../prompts/tools/effective-tool-policy"

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

// The snapshot the presenter consumes; the getState doubles below deliberately
// disagree with it so any surviving live-read re-entry is caught by assertions.
const baseSnapshot: RequestPolicySnapshot = {
	disabledTools: [],
	customModes: [],
}

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
	getTaskMode: Mock<() => Promise<string>>
	api: { getModel: () => { id: string; info: Record<string, unknown> } }
	recordToolUsage: ReturnType<typeof vi.fn>
	recordToolError: ReturnType<typeof vi.fn>
	toolRepetitionDetector: { check: ReturnType<typeof vi.fn> }
	providerRef: {
		deref: () =>
			| {
					getState: ReturnType<typeof vi.fn>
					getMcpHub?: () => { findServerNameBySanitizedName: (name: string) => string | undefined }
			  }
			| undefined
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
						// Poisoned: disagrees with baseSnapshot, so a live
						// read here changes validation args and fails tests.
						customModes: [{ slug: "poison", name: "Poison", roleDefinition: "", groups: [] }],
						disabledTools: ["write_to_file"],
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

		await presentAssistantMessage(mockTask as unknown as Task, baseSnapshot)

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

		await presentAssistantMessage(mockTask as unknown as Task, baseSnapshot)

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

		await presentAssistantMessage(mockTask as unknown as Task, baseSnapshot)

		expect(mockTask.recordToolUsage).toHaveBeenCalledWith("use_mcp_tool")
		expect(mockTask.recordToolUsage).not.toHaveBeenCalledWith("mcp_")
	})

	it("validates tools against the task-local mode when provider state differs", async () => {
		mockTask.getTaskMode.mockResolvedValue("code")
		mockTask.providerRef.deref = () => ({
			getState: vi.fn().mockResolvedValue({
				mode: "orchestrator",
				// Poisoned: a live read would put non-empty customModes and a
				// read_file restriction into the validator call.
				customModes: [{ slug: "delegated", name: "Delegated", roleDefinition: "", groups: [] }],
				disabledTools: ["read_file"],
			}),
		})
		mockTask.assistantMessageContent = [
			{
				type: "tool_use",
				id: "call_task_mode",
				name: "read_file",
				params: { path: "test.txt" },
				nativeArgs: { path: "test.txt" },
				partial: false,
			},
		]

		await presentAssistantMessage(mockTask as unknown as Task, baseSnapshot)

		expect(validateToolUse).toHaveBeenCalledWith(
			"read_file",
			"code",
			[],
			{},
			{ path: "test.txt" },
			undefined,
			undefined,
		)
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

		await presentAssistantMessage(mockTask as unknown as Task, baseSnapshot)

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

		await presentAssistantMessage(mockTask as unknown as Task, baseSnapshot)

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
						disabledTools: ["use_mcp_tool"],
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

			await presentAssistantMessage(mockTask as unknown as Task, baseSnapshot)

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
						disabledTools: ["use_mcp_tool"],
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

			await presentAssistantMessage(mockTask as unknown as Task, baseSnapshot)

			// The server is disallowed, so the call never reaches onValidated:
			// no success attempt is recorded for a call that was never permitted to execute.
			expect(mockTask.recordToolUsage).not.toHaveBeenCalled()
			expect(TelemetryService.instance.captureToolUsage).not.toHaveBeenCalled()
		})
	})

	describe("undefined provider state", () => {
		// The presenter reads only the request snapshot, never live provider state,
		// so an unavailable provider must not affect validation: the task-local
		// mode and the snapshot's own fields govern the validator call.
		it("falls back to empty state when provider is unavailable", async () => {
			mockTask.providerRef = { deref: () => undefined }
			mockTask.assistantMessageContent = [
				{
					type: "tool_use",
					id: "call_no_state",
					name: "read_file",
					params: { path: "test.ts" },
					nativeArgs: { path: "test.ts" },
					partial: false,
				},
			]

			await presentAssistantMessage(mockTask as unknown as Task, baseSnapshot)

			// validateToolUse must still be called with the task-local mode.
			const calls = vi.mocked(validateToolUse).mock.calls
			expect(calls.length).toBeGreaterThan(0)
			expect(calls[0][1]).toBe("code")
			// customModes comes from the snapshot's own customModes field ([] here), not from provider state.
			expect(calls[0][2]).toEqual([])
		})
	})

	describe("mode delegation regression", () => {
		// Regression for issue #1623.
		// Before the fix, validateToolUse received the shared provider mode instead
		// of the task-local mode, so a child delegated to "architect" mode would have
		// its tools validated against "orchestrator".
		it("passes the task-local mode to validateToolUse, not the provider mode", async () => {
			// Provider says "orchestrator"; task was delegated to "architect".
			mockTask.providerRef = {
				deref: () => ({
					getState: vi.fn().mockResolvedValue({
						mode: "orchestrator",
						// Poisoned: a live read would pass these customModes
						// to validateToolUse instead of the snapshot's [].
						customModes: [{ slug: "delegated", name: "Delegated", roleDefinition: "", groups: [] }],
					}),
				}),
			}
			mockTask.getTaskMode = vi.fn().mockResolvedValue("architect")

			mockTask.assistantMessageContent = [
				{
					type: "tool_use",
					id: "call_delegation",
					name: "read_file",
					params: { path: "test.ts" },
					nativeArgs: { path: "test.ts" },
					partial: false,
				},
			]

			await presentAssistantMessage(mockTask as unknown as Task, baseSnapshot)

			// The key assertion: task-local mode "architect" was passed, not "orchestrator".
			const calls = vi.mocked(validateToolUse).mock.calls
			expect(calls.length).toBeGreaterThan(0)
			expect(calls[0][0]).toBe("read_file")
			expect(calls[0][1]).toBe("architect")
		})
	})
})
