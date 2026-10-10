// npx vitest run core/assistant-message/__tests__/presentAssistantMessage-validation-rejection.spec.ts

import { describe, it, expect, beforeEach, vi } from "vitest"

import { providerIdentifiers } from "@roo-code/types/provider-identifiers"

import { presentAssistantMessage } from "../presentAssistantMessage"
import type { Task } from "../../task/Task"

const mockRelease = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
const mockHandle = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
const mockValidate = vi.hoisted(() => vi.fn())

vi.mock("../../task/Task")
vi.mock("../../tools/validateToolUse", () => ({
	validateToolUse: mockValidate,
	isValidToolName: vi.fn(() => true),
}))
vi.mock("../../tools/NewTaskTool", () => ({ newTaskTool: { handle: vi.fn() } }))
vi.mock("../../tools/WriteToFileTool", () => ({
	writeToFileTool: { handle: mockHandle, releaseStreamAfterValidationRejection: mockRelease },
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

interface ToolResultBlock {
	type: string
	tool_use_id?: string
	content?: string
	is_error?: boolean
}

/**
 * Structural double for the presenter's Task surface. The presenter reads far more of Task
 * than the two rejection branches touch, so the double carries only what this file drives;
 * it is handed over through unknown (the repo's pattern for presenter-level doubles, see
 * presentAssistantMessage-tool-usage-attribution.spec.ts) rather than any.
 */
interface PresenterTask {
	taskId: string
	instanceId: string
	abort: boolean
	presentAssistantMessageLocked: boolean
	presentAssistantMessageHasPendingUpdates: boolean
	currentStreamingContentIndex: number
	assistantMessageContent: Record<string, unknown>[]
	userMessageContent: ToolResultBlock[]
	didCompleteReadingStream: boolean
	didRejectTool: boolean
	didAlreadyUseTool: boolean
	consecutiveMistakeCount: number
	consecutiveMistakeLimit: number
	apiConfiguration: { apiProvider: string }
	clineMessages: unknown[]
	getTaskMode: ReturnType<typeof vi.fn>
	api: { getModel: () => { id: string; info: Record<string, unknown> } }
	recordToolUsage: ReturnType<typeof vi.fn>
	recordToolError: ReturnType<typeof vi.fn>
	toolRepetitionDetector: { check: ReturnType<typeof vi.fn> }
	providerRef: { deref: () => { getState: ReturnType<typeof vi.fn> } }
	say: ReturnType<typeof vi.fn>
	ask: ReturnType<typeof vi.fn>
	pushToolResultToUserContent: ReturnType<typeof vi.fn>
}

describe("presentAssistantMessage - a rejected write_to_file releases its stream", () => {
	let mockTask: PresenterTask

	beforeEach(() => {
		vi.clearAllMocks()
		mockRelease.mockResolvedValue(undefined)
		mockHandle.mockResolvedValue(undefined)
		mockValidate.mockImplementation(() => {
			throw new Error("write_to_file is not allowed in this mode")
		})
		mockTask = {
			taskId: "validation-task",
			instanceId: "inst-1",
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
			consecutiveMistakeLimit: 3,
			apiConfiguration: { apiProvider: providerIdentifiers.anthropic },
			clineMessages: [],
			getTaskMode: vi.fn().mockResolvedValue("code"),
			api: { getModel: () => ({ id: "test-model", info: {} }) },
			recordToolUsage: vi.fn(),
			recordToolError: vi.fn(),
			toolRepetitionDetector: { check: vi.fn().mockReturnValue({ allowExecution: true }) },
			providerRef: { deref: () => ({ getState: vi.fn().mockResolvedValue({ mode: "code", customModes: [] }) }) },
			say: vi.fn().mockResolvedValue(undefined),
			ask: vi.fn().mockResolvedValue({ response: "yesButtonClicked" }),

			pushToolResultToUserContent: vi.fn().mockImplementation((toolResult) => {
				mockTask.userMessageContent.push(toolResult)
				return true
			}),
		}
	})

	const writeBlock = () => [
		{
			type: "tool_use",
			id: "call-write-1",
			name: "write_to_file",
			params: { path: "a.ts", content: "partial from the stream" },
			// The presenter breaks earlier for a known tool whose nativeArgs never arrived, so the
			// block has to carry them to reach the validation step.
			nativeArgs: { path: "a.ts", content: "partial from the stream" },
			partial: false,
		},
	]

	it("releases the streamed state when validation rejects the completed block", async () => {
		// A partial delta is never validated, so streaming can already have registered this
		// task's write_to_file state and opened a preview by the time the completed block is
		// rejected. The loop breaks before writeToFileTool.handle() runs, so nothing else
		// releases them and the task carries a stale stream into its next write.
		mockTask.assistantMessageContent = writeBlock()

		await presentAssistantMessage(mockTask as unknown as Task)

		expect(mockRelease).toHaveBeenCalledTimes(1)
		expect(mockRelease).toHaveBeenCalledWith(mockTask)
		expect(mockHandle).not.toHaveBeenCalled()
		// The validation error stays the tool result the model sees.
		const toolResult = mockTask.userMessageContent.find((item) => item.type === "tool_result")
		if (!toolResult) {
			throw new Error("expected a tool_result for the rejected call")
		}
		expect(toolResult.is_error).toBe(true)
		expect(toolResult.content).toContain("not allowed in this mode")
	})

	it("releases the streamed state when the repetition guard refuses the completed block", async () => {
		// Same family: the block is refused before handle() runs, so the stream owns nobody
		// but this branch.
		mockValidate.mockReturnValue(undefined)
		mockTask.toolRepetitionDetector.check = vi.fn().mockReturnValue({
			allowExecution: false,
			askUser: { messageKey: "mistake_limit_reached", messageDetail: "repeated" },
		})
		mockTask.assistantMessageContent = writeBlock()

		await presentAssistantMessage(mockTask as unknown as Task)

		expect(mockRelease).toHaveBeenCalledTimes(1)
		expect(mockHandle).not.toHaveBeenCalled()
		// pushToolResult is the presenter's own closure; what the model receives is the
		// tool_result in the user content, which is what must still carry the refusal.
		const toolResult = mockTask.userMessageContent.find((item) => item.type === "tool_result")
		if (!toolResult) {
			throw new Error("expected a tool_result for the rejected call")
		}
		expect(toolResult.content).toContain("repetition limit reached")
	})

	it("leaves the stream alone when a rejected tool never streamed", async () => {
		// The release is write_to_file scoped: a rejected read_file must not touch it.
		mockTask.assistantMessageContent = [
			{
				type: "tool_use",
				id: "call-read-1",
				name: "read_file",
				params: { path: "a.ts" },
				nativeArgs: { path: "a.ts" },
				partial: false,
			},
		]

		await presentAssistantMessage(mockTask as unknown as Task)

		expect(mockRelease).not.toHaveBeenCalled()
	})
})
