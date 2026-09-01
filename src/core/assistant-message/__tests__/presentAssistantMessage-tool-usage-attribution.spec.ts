// npx vitest src/core/assistant-message/__tests__/presentAssistantMessage-tool-usage-attribution.spec.ts

import type { Anthropic } from "@anthropic-ai/sdk"
import { parametersSchema as z } from "@roo-code/types"
import { describe, it, expect, beforeEach, vi } from "vitest"
import { presentAssistantMessage } from "../presentAssistantMessage"
import { validateToolUse } from "../../tools/validateToolUse"
import { useMcpToolTool } from "../../tools/UseMcpToolTool"
import { defaultModeSlug, getModeBySlug } from "../../../shared/modes"
import type { CurrentRequestToolPolicy, Task } from "../../task/Task"

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

import { customToolRegistry } from "@roo-code/core"
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
			getMcpHub?: () => { findServerNameBySanitizedName: (name: string) => string | undefined } | undefined
		}
	}
	say: ReturnType<typeof vi.fn>
	ask: ReturnType<typeof vi.fn>
	pushToolResultToUserContent: ReturnType<typeof vi.fn>
	getTaskMode?: () => Promise<string>
	getCurrentRequestToolPolicy?: () => CurrentRequestToolPolicy
}

function presentMockTask(task: MockTask) {
	// This focused structural mock implements only the Task members reached by these tests.
	return presentAssistantMessage(task as unknown as Task)
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
					getMcpHub: () => undefined,
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

	it("passes model-excluded tools to fallback execution validation", async () => {
		mockTask.api.getModel = () => ({
			id: "test-model",
			info: { excludedTools: ["read_file"] },
		})
		mockTask.assistantMessageContent = [
			{
				type: "tool_use",
				id: "call_excluded",
				name: "read_file",
				params: { path: "test.txt" },
				nativeArgs: { path: "test.txt" },
				partial: false,
			},
		]

		await presentMockTask(mockTask)

		expect(vi.mocked(validateToolUse).mock.calls[0][3]).toMatchObject({ read_file: false })
	})

	it("uses task mode before live state when no request policy exists", async () => {
		mockTask.getTaskMode = vi.fn().mockResolvedValue("architect")
		mockTask.providerRef = {
			deref: () => ({
				getState: vi.fn().mockResolvedValue({ mode: "code", customModes: [] }),
			}),
		}
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

		await presentMockTask(mockTask)

		expect(vi.mocked(validateToolUse).mock.calls[0][1]).toBe("architect")
	})

	it("defaults fallback validation and resolves model-included tool aliases", async () => {
		mockTask.api.getModel = () => ({
			id: "test-model",
			info: { includedTools: ["search_and_replace"] },
		})
		mockTask.providerRef = {
			deref: () => ({
				getState: vi.fn().mockResolvedValue({}),
			}),
		}
		mockTask.assistantMessageContent = [
			{
				type: "tool_use",
				id: "call_default_policy",
				name: "read_file",
				params: { path: "test.txt" },
				nativeArgs: { path: "test.txt" },
				partial: false,
			},
		]

		await presentMockTask(mockTask)

		const validationCall = vi.mocked(validateToolUse).mock.calls[0]
		expect(validationCall[1]).toBe(defaultModeSlug)
		expect(validationCall[2]).toEqual([])
		expect(validationCall[6]).toEqual(["edit"])
	})

	it("uses the request policy without reading the live focused mode", async () => {
		mockTask.getCurrentRequestToolPolicy = () => ({
			effectiveToolNames: new Set(["read_file", "attempt_completion"]),
			mode: "architect",
			customModes: [],
			experiments: {},
		})
		mockTask.providerRef = {
			deref: () => ({
				getState: vi.fn().mockRejectedValue(new Error("live state should not be read")),
			}),
		}
		mockTask.assistantMessageContent = [
			{
				type: "tool_use",
				id: "call_request_policy",
				name: "execute_command",
				params: { command: "echo should-not-run" },
				nativeArgs: { command: "echo should-not-run" },
				partial: false,
			},
		]

		await presentMockTask(mockTask)

		expect(mockTask.recordToolUsage).not.toHaveBeenCalled()
		expect(mockTask.recordToolError).toHaveBeenCalledWith("execute_command", expect.any(String))
		expect(mockTask.userMessageContent).toHaveLength(1)
	})

	it("uses the request policy experiment and mode for custom tool execution", async () => {
		const parameters = z.object({ value: z.string() })
		const parseSpy = vi.spyOn(parameters, "parse")
		const execute = vi.fn().mockResolvedValue("request-scoped custom result")
		const getState = vi.fn().mockRejectedValue(new Error("live state should not be read"))

		vi.mocked(customToolRegistry.has).mockImplementation((name) => name === "request_scoped_tool")
		vi.mocked(customToolRegistry.get).mockImplementation((name) =>
			name === "request_scoped_tool"
				? {
						name,
						description: "A request-scoped custom tool",
						parameters,
						execute,
					}
				: undefined,
		)
		mockTask.getCurrentRequestToolPolicy = () => ({
			effectiveToolNames: new Set(["request_scoped_tool"]),
			mode: "architect",
			customModes: [],
			experiments: { customTools: true },
		})
		mockTask.providerRef = {
			deref: () => ({
				getState,
			}),
		}
		mockTask.assistantMessageContent = [
			{
				type: "tool_use",
				id: "call_request_scoped_custom_tool",
				name: "request_scoped_tool",
				params: { value: "from-request" },
				nativeArgs: { value: "from-request" },
				partial: false,
			},
		]

		await presentMockTask(mockTask)

		expect(getState).not.toHaveBeenCalled()
		expect(customToolRegistry.get).toHaveBeenCalledWith("request_scoped_tool")
		expect(parseSpy).toHaveBeenCalledWith({ value: "from-request" })
		expect(execute).toHaveBeenCalledWith(
			{ value: "from-request" },
			expect.objectContaining({ mode: "architect", task: mockTask }),
		)
		expect(mockTask.userMessageContent).toEqual([
			expect.objectContaining({
				tool_use_id: "call_request_scoped_custom_tool",
				content: "request-scoped custom result",
			}),
		])
	})

	it("allows the standard MCP wrapper when the request policy exposes a dynamic MCP tool", async () => {
		const handleSpy = vi.spyOn(useMcpToolTool, "handle").mockResolvedValue(undefined)
		mockTask.getCurrentRequestToolPolicy = () => ({
			effectiveToolNames: new Set(["mcp--filesystem--read_file", "attempt_completion"]),
			mode: "code",
			customModes: [],
			experiments: {},
		})
		mockTask.assistantMessageContent = [
			{
				type: "tool_use",
				id: "call_standard_mcp_wrapper",
				name: "use_mcp_tool",
				params: {
					server_name: "nonexistent-server",
					tool_name: "read_file",
					arguments: { path: "test.txt" },
				},
				nativeArgs: {
					server_name: "nonexistent-server",
					tool_name: "read_file",
					arguments: { path: "test.txt" },
				},
				partial: false,
			},
		]

		await presentMockTask(mockTask)

		expect(handleSpy).toHaveBeenCalledOnce()
		expect(mockTask.recordToolUsage).toHaveBeenCalledWith("use_mcp_tool")
		handleSpy.mockRestore()
	})

	it("blocks the standard MCP wrapper when the request policy exposes no MCP tools", async () => {
		const handleSpy = vi.spyOn(useMcpToolTool, "handle").mockResolvedValue(undefined)
		mockTask.getCurrentRequestToolPolicy = () => ({
			effectiveToolNames: new Set(["read_file", "attempt_completion"]),
			mode: "code",
			customModes: [],
			experiments: {},
		})
		mockTask.assistantMessageContent = [
			{
				type: "tool_use",
				id: "call_unavailable_standard_mcp_wrapper",
				name: "use_mcp_tool",
				params: {
					server_name: "filesystem",
					tool_name: "read_file",
					arguments: { path: "test.txt" },
				},
				nativeArgs: {
					server_name: "filesystem",
					tool_name: "read_file",
					arguments: { path: "test.txt" },
				},
				partial: false,
			},
		]

		await presentMockTask(mockTask)

		expect(handleSpy).not.toHaveBeenCalled()
		expect(mockTask.recordToolError).toHaveBeenCalledWith("use_mcp_tool", expect.any(String))
		handleSpy.mockRestore()
	})

	it("validates available tools with the request mode and effective included set", async () => {
		const effectiveToolNames = new Set(["read_file", "apply_patch", "attempt_completion"])
		mockTask.getCurrentRequestToolPolicy = () => ({
			effectiveToolNames,
			mode: "architect",
			customModes: [],
			experiments: {},
		})
		mockTask.assistantMessageContent = [
			{
				type: "tool_use",
				id: "call_allowed",
				name: "read_file",
				params: { path: "test.txt" },
				nativeArgs: { path: "test.txt" },
				partial: false,
			},
		]

		await presentMockTask(mockTask)

		const validationCall = vi.mocked(validateToolUse).mock.calls[0]
		expect(validationCall[1]).toBe("architect")
		expect(validationCall[6]).toEqual(Array.from(effectiveToolNames))
	})

	it("passes global MCP disablement to fallback execution validation", async () => {
		mockTask.providerRef = {
			deref: () => ({
				getState: vi.fn().mockResolvedValue({ mode: "code", customModes: [], mcpEnabled: false }),
				getMcpHub: () => undefined,
			}),
		}
		mockTask.assistantMessageContent = [
			{
				type: "tool_use",
				id: "call_mcp_disabled",
				name: "access_mcp_resource",
				params: { server_name: "test", uri: "resource://test" },
				nativeArgs: { server_name: "test", uri: "resource://test" },
				partial: false,
			},
		]

		await presentMockTask(mockTask)

		expect(vi.mocked(validateToolUse).mock.calls[0][3]).toMatchObject({
			use_mcp_tool: false,
			access_mcp_resource: false,
		})
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

	it.each([
		["custom-mode", "Custom Mode"],
		["missing-mode", "missing-mode"],
	])("describes skipped new_task calls using the resolved mode name for %s", async (mode, expectedName) => {
		mockTask.didRejectTool = true
		mockTask.providerRef = {
			deref: () => ({
				getState: vi.fn().mockResolvedValue({
					mode: "code",
					customModes: [
						{
							slug: "custom-mode",
							name: "Custom Mode",
							roleDefinition: "Custom role",
							groups: ["read"],
						},
					],
				}),
			}),
		}
		mockTask.assistantMessageContent = [
			{
				type: "tool_use",
				id: `call_new_task_${mode}`,
				name: "new_task",
				params: { mode, message: "Delegate work" },
				nativeArgs: { mode, message: "Delegate work" },
				partial: false,
			},
		]

		await presentMockTask(mockTask)

		expect(mockTask.pushToolResultToUserContent).toHaveBeenCalledWith(
			expect.objectContaining({ content: expect.stringContaining(`[new_task in ${expectedName} mode`) }),
		)
	})

	describe("native mcp_tool_use block", () => {
		it("passes partial MCP blocks through without final validation", async () => {
			const handleSpy = vi.spyOn(useMcpToolTool, "handle").mockResolvedValue(undefined)
			mockTask.assistantMessageContent = [
				{
					type: "mcp_tool_use",
					id: "call_native_mcp_partial",
					name: "mcp--test-server--search",
					serverName: "test-server",
					toolName: "search",
					arguments: {},
					partial: true,
				},
			]

			await presentMockTask(mockTask)

			expect(handleSpy).toHaveBeenCalledTimes(1)
			expect(validateToolUse).not.toHaveBeenCalled()
			handleSpy.mockRestore()
		})

		it("applies fallback disablement before executing an MCP block", async () => {
			const handleSpy = vi.spyOn(useMcpToolTool, "handle").mockResolvedValue(undefined)
			mockTask.api.getModel = () => ({
				id: "test-model",
				info: { excludedTools: ["mcp--blocked-server--blocked-tool"] },
			})
			mockTask.providerRef = {
				deref: () => ({
					getState: vi.fn().mockResolvedValue({
						disabledTools: ["read_file"],
						mcpEnabled: false,
					}),
					getMcpHub: () => undefined,
				}),
			}
			mockTask.assistantMessageContent = [
				{
					type: "mcp_tool_use",
					id: "call_native_mcp_fallback_blocked",
					name: "mcp--blocked-server--blocked-tool",
					serverName: "blocked-server",
					toolName: "blocked-tool",
					arguments: {},
					partial: false,
				},
			]

			await presentMockTask(mockTask)

			expect(handleSpy).not.toHaveBeenCalled()
			expect(mockTask.recordToolError).toHaveBeenCalledWith("use_mcp_tool", expect.any(String))
			handleSpy.mockRestore()
		})

		it("uses the task mode for fallback MCP validation", async () => {
			const handleSpy = vi.spyOn(useMcpToolTool, "handle").mockResolvedValue(undefined)
			mockTask.getTaskMode = vi.fn().mockResolvedValue("architect")
			mockTask.providerRef = {
				deref: () => ({
					getState: vi.fn().mockResolvedValue({}),
					getMcpHub: () => undefined,
				}),
			}
			mockTask.assistantMessageContent = [
				{
					type: "mcp_tool_use",
					id: "call_native_mcp_task_mode",
					name: "mcp--test-server--search",
					serverName: "test-server",
					toolName: "search",
					arguments: {},
					partial: false,
				},
			]

			await presentMockTask(mockTask)

			expect(vi.mocked(validateToolUse).mock.calls[0][1]).toBe("architect")
			expect(vi.mocked(validateToolUse).mock.calls[0][2]).toEqual([])
			expect(handleSpy).toHaveBeenCalledTimes(1)
			handleSpy.mockRestore()
		})

		it("uses the default mode for fallback MCP validation", async () => {
			const handleSpy = vi.spyOn(useMcpToolTool, "handle").mockResolvedValue(undefined)
			mockTask.providerRef = {
				deref: () => ({
					getState: vi.fn().mockResolvedValue({}),
					getMcpHub: () => undefined,
				}),
			}
			mockTask.assistantMessageContent = [
				{
					type: "mcp_tool_use",
					id: "call_native_mcp_default_mode",
					name: "mcp--test-server--search",
					serverName: "test-server",
					toolName: "search",
					arguments: {},
					partial: false,
				},
			]

			await presentMockTask(mockTask)

			expect(vi.mocked(validateToolUse).mock.calls[0][1]).toBe(defaultModeSlug)
			expect(handleSpy).toHaveBeenCalledTimes(1)
			handleSpy.mockRestore()
		})

		it("blocks an MCP tool absent from the request policy", async () => {
			const handleSpy = vi.spyOn(useMcpToolTool, "handle").mockResolvedValue(undefined)
			mockTask.getCurrentRequestToolPolicy = () => ({
				effectiveToolNames: new Set(["mcp--allowed-server--allowed-tool"]),
				mode: "code",
				customModes: [],
				experiments: {},
			})
			mockTask.assistantMessageContent = [
				{
					type: "mcp_tool_use",
					id: "call_native_mcp_blocked",
					name: "mcp--blocked-server--blocked-tool",
					serverName: "blocked-server",
					toolName: "blocked-tool",
					arguments: {},
					partial: false,
				},
			]

			await presentMockTask(mockTask)

			expect(handleSpy).not.toHaveBeenCalled()
			expect(mockTask.recordToolUsage).not.toHaveBeenCalled()
			expect(mockTask.userMessageContent).toHaveLength(1)
			handleSpy.mockRestore()
		})

		it("matches provider-normalized MCP names against the request policy", async () => {
			const handleSpy = vi.spyOn(useMcpToolTool, "handle").mockResolvedValue(undefined)
			mockTask.getCurrentRequestToolPolicy = () => ({
				effectiveToolNames: new Set(["mcp--my-server--do-thing"]),
				mode: "code",
				customModes: [],
				experiments: {},
			})
			mockTask.assistantMessageContent = [
				{
					type: "mcp_tool_use",
					id: "call_native_mcp_normalized",
					name: "mcp__my_server__do_thing",
					serverName: "my_server",
					toolName: "do_thing",
					arguments: {},
					partial: false,
				},
			]

			await presentMockTask(mockTask)

			expect(handleSpy).toHaveBeenCalledTimes(1)
			handleSpy.mockRestore()
		})

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
