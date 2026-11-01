// npx vitest run core/task/__tests__/ToolExecutionContext.spec.ts

import { DispatchState } from "../dispatchState"
import type { Anthropic } from "@anthropic-ai/sdk"
import { describe, it, expect, beforeEach, vi } from "vitest"
import { presentAssistantMessage } from "../../assistant-message/presentAssistantMessage"
import { validateToolUse } from "../../tools/validateToolUse"
import type { Task, ToolExecutionContext } from "../Task"
import type { RequestPolicySnapshot } from "../../prompts/tools/effective-tool-policy"

vi.mock("../Task")
vi.mock("../../tools/validateToolUse", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../tools/validateToolUse")>()
	return { ...actual, validateToolUse: vi.fn() }
})

vi.mock("@roo-code/core", () => ({
	customToolRegistry: { has: vi.fn(() => false), get: vi.fn() },
}))

vi.mock("@roo-code/telemetry", () => ({
	TelemetryService: {
		instance: {
			captureToolUsage: vi.fn(),
			captureConsecutiveMistakeError: vi.fn(),
			captureException: vi.fn(),
			captureEvent: vi.fn(),
		},
	},
}))

const { listFilesHandle } = vi.hoisted(() => ({ listFilesHandle: vi.fn() }))

vi.mock("../../tools/ListFilesTool", () => ({
	listFilesTool: { handle: listFilesHandle },
}))

type ApprovalCallbacks = {
	askApproval: (type: string, message?: string) => Promise<boolean>
	toolCallId: string
}

function buildMockTask() {
	const mockTask = {
		taskId: "test-task-id",
		instanceId: "test-instance",
		abort: false,
		dispatchState: DispatchState.IDLE,
		pendingWork: null,
		currentStreamingContentIndex: 0,
		assistantMessageContent: [] as unknown[],
		userMessageContent: [] as Anthropic.ToolResultBlockParam[],
		didCompleteReadingStream: true,
		didRejectTool: false,
		didAlreadyUseTool: false,
		activeToolContexts: new Map<string, ToolExecutionContext>(),
		consecutiveMistakeCount: 0,
		clineMessages: [],
		api: { getModel: () => ({ id: "test-model", info: {} }) },
		apiConfiguration: { apiProvider: "test" },
		recordToolUsage: vi.fn(),
		recordToolError: vi.fn(),
		toolRepetitionDetector: { check: vi.fn().mockReturnValue({ allowExecution: true }) },
		providerRef: {
			deref: () => ({ getState: vi.fn().mockResolvedValue({ mode: "code", customModes: [] }) }),
		},
		say: vi.fn().mockResolvedValue(undefined),
		ask: vi.fn().mockResolvedValue({ response: "yesButtonClicked" }),
		getTaskMode: vi.fn().mockResolvedValue("code"),
		pushToolResultToUserContent: vi.fn(),
	}

	mockTask.pushToolResultToUserContent.mockImplementation((toolResult: Anthropic.ToolResultBlockParam) => {
		mockTask.userMessageContent.push(toolResult)
		return true
	})

	return mockTask
}

const listFilesBlock = (id: string) => ({
	type: "tool_use",
	id,
	name: "list_files",
	params: { path: "src" },
	nativeArgs: { path: "src" },
	partial: false,
})

const baseSnapshot: RequestPolicySnapshot = {
	disabledTools: [],
	customModes: [],
}

const asTask = (task: ReturnType<typeof buildMockTask>): Task => task as unknown as Task

describe("ToolExecutionContext", () => {
	let mockTask: ReturnType<typeof buildMockTask>
	let contextsSeenDuringExecution: Map<string, ToolExecutionContext | undefined>

	beforeEach(() => {
		vi.clearAllMocks()
		vi.mocked(validateToolUse).mockImplementation(() => undefined)
		mockTask = buildMockTask()
		contextsSeenDuringExecution = new Map()

		listFilesHandle.mockImplementation(
			async (task: Task, _block: unknown, { askApproval, toolCallId }: ApprovalCallbacks) => {
				contextsSeenDuringExecution.set(toolCallId, task.activeToolContexts.get(toolCallId))
				await askApproval("tool", JSON.stringify({ tool: "listFilesTopLevel", path: "src" }))
			},
		)
	})

	it("creates a context keyed by the tool call id that stays readable after the tool pushes its result", async () => {
		mockTask.assistantMessageContent = [listFilesBlock("call_a")]
		listFilesHandle.mockImplementationOnce(
			async (
				task: Task,
				_block: unknown,
				{
					askApproval,
					toolCallId,
					pushToolResult,
				}: ApprovalCallbacks & { pushToolResult: (c: string) => void },
			) => {
				contextsSeenDuringExecution.set(toolCallId, task.activeToolContexts.get(toolCallId))
				await askApproval("tool", "{}")
				pushToolResult("done")
			},
		)

		await presentAssistantMessage(asTask(mockTask), baseSnapshot)

		expect(contextsSeenDuringExecution.get("call_a")).toBe(mockTask.activeToolContexts.get("call_a"))
		expect(mockTask.activeToolContexts.get("call_a")).toEqual({
			toolCallId: "call_a",
			didReject: false,
		})
		expect(mockTask.didRejectTool).toBe(false)
	})

	it("reuses the context when a partial tool call is followed by its complete block", async () => {
		mockTask.assistantMessageContent = [{ ...listFilesBlock("call_a"), partial: true }]
		await presentAssistantMessage(asTask(mockTask), baseSnapshot)
		const first = mockTask.activeToolContexts.get("call_a")

		mockTask.assistantMessageContent = [listFilesBlock("call_a")]
		await presentAssistantMessage(asTask(mockTask), baseSnapshot)

		expect(first).toBeDefined()
		expect(mockTask.activeToolContexts.get("call_a")).toBe(first)
	})

	it("sets didReject on the rejected tool's context only, and the serial flag keeps skipping the sibling", async () => {
		mockTask.assistantMessageContent = [listFilesBlock("call_a"), listFilesBlock("call_b")]
		mockTask.activeToolContexts.set("call_a", { toolCallId: "call_a", didReject: false })
		mockTask.activeToolContexts.set("call_b", { toolCallId: "call_b", didReject: false })
		mockTask.ask.mockResolvedValueOnce({ response: "noButtonClicked" })

		await presentAssistantMessage(asTask(mockTask), baseSnapshot)
		mockTask.dispatchState = DispatchState.IDLE
		mockTask.currentStreamingContentIndex = 1
		await presentAssistantMessage(asTask(mockTask), baseSnapshot)

		expect(mockTask.didRejectTool).toBe(true)
		expect(listFilesHandle).toHaveBeenCalledTimes(1)
		expect(mockTask.activeToolContexts.get("call_a")?.didReject).toBe(true)
		expect(mockTask.activeToolContexts.get("call_b")?.didReject).toBe(false)
	})

	it("keeps the serial didRejectTool flag in sync with a rejection", async () => {
		mockTask.assistantMessageContent = [listFilesBlock("call_a")]
		mockTask.ask.mockResolvedValue({ response: "noButtonClicked" })

		await presentAssistantMessage(asTask(mockTask), baseSnapshot)

		expect(mockTask.didRejectTool).toBe(true)
		expect(mockTask.activeToolContexts.get("call_a")?.didReject).toBe(true)
	})
})
