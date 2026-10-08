// npx vitest src/core/assistant-message/__tests__/presentAssistantMessage-missing-native-args.spec.ts

import { describe, it, expect, beforeEach, vi } from "vitest"
import { presentAssistantMessage } from "../presentAssistantMessage"
import { isValidToolName, validateToolUse } from "../../tools/validateToolUse"

const mockTeardown = vi.hoisted(() => vi.fn())
const mockWriteHandle = vi.hoisted(() => vi.fn())

vi.mock("../../task/Task")
vi.mock("../../tools/validateToolUse", () => ({
	validateToolUse: vi.fn(),
	isValidToolName: vi.fn(() => true),
}))
vi.mock("../../tools/WriteToFileTool", () => ({
	writeToFileTool: { handle: mockWriteHandle, teardownAbandonedStream: mockTeardown },
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

type ToolResultBlock = { type: string; tool_use_id: string; content: string; is_error: boolean }

describe("presentAssistantMessage - finalized block without nativeArgs", () => {
	// The presenter reads only a subset of Task. A Record keeps the double honest without
	// an `any`; the single cast at the call site is the documented boundary.
	let mockTask: Record<string, unknown>
	let userMessageContent: ToolResultBlock[]

	beforeEach(() => {
		mockTeardown.mockReset()
		mockWriteHandle.mockReset()
		userMessageContent = []
		mockTask = {
			taskId: "test-task-id",
			instanceId: "test-instance",
			abort: false,
			presentAssistantMessageLocked: false,
			presentAssistantMessageHasPendingUpdates: false,
			currentStreamingContentIndex: 0,
			assistantMessageContent: [
				{
					type: "tool_use",
					name: "write_to_file",
					params: {},
					partial: false,
					// Streaming JSON never parsed: Task completes the block with no nativeArgs.
					id: "toolu_1",
					nativeArgs: undefined,
				},
			],
			userMessageContent,
			didCompleteReadingStream: false,
			didRejectTool: false,
			didAlreadyUseTool: false,
			consecutiveMistakeCount: 0,
			consecutiveMistakeLimit: 3,
			apiConfiguration: { apiProvider: "test-provider" },
			clineMessages: [],
			getTaskMode: vi.fn().mockResolvedValue("code"),
			api: { getModel: () => ({ id: "test-model", info: {} }) },
			recordToolUsage: vi.fn(),
			recordToolError: vi.fn(),
			toolRepetitionDetector: { check: vi.fn().mockReturnValue({ allowExecution: true }) },
			providerRef: {
				deref: () => ({ getState: vi.fn().mockResolvedValue({ mode: "code", customModes: [] }) }),
			},
			say: vi.fn().mockResolvedValue(undefined),
			ask: vi.fn().mockResolvedValue({ response: "yesButtonClicked" }),
			pushToolResultToUserContent: vi.fn((toolResult: ToolResultBlock) => {
				userMessageContent.push(toolResult)
				return true
			}),
		}
	})

	it("tears the write_to_file stream state down instead of dispatching the tool", async () => {
		await presentAssistantMessage(mockTask as unknown as Parameters<typeof presentAssistantMessage>[0])

		// The malformed call must not be executed, and exactly one error tool_result is
		// emitted for the provider.
		expect(isValidToolName).toHaveBeenCalled()
		expect(mockWriteHandle).not.toHaveBeenCalled()
		expect(mockTask.pushToolResultToUserContent).toHaveBeenCalledTimes(1)
		expect(userMessageContent).toEqual([
			expect.objectContaining({
				type: "tool_result",
				tool_use_id: "toolu_1",
				is_error: true,
				content: expect.stringContaining("missing nativeArgs"),
			}),
		])
		// The guard bypasses handle(), so the per-task stream state has to be released here:
		// otherwise the entry, its TaskAborted listener and any streamed diff view leak into
		// the next API request of the same task.
		expect(mockTeardown).toHaveBeenCalledTimes(1)
		expect(mockTeardown).toHaveBeenCalledWith(mockTask)
	})

	it("tears the stream state down when tool validation rejects the call", async () => {
		// A mode file restriction (or any validateToolUse failure) lands here. The block
		// streamed partial deltas - handlePartial ran - and this exit bypasses handle(), so
		// without the teardown the per-task stream state, its TaskAborted listener and any
		// streamed diff view leak into the next API request.
		mockTask.assistantMessageContent = [
			{
				type: "tool_use",
				name: "write_to_file",
				params: { path: "restricted.ts", content: "partial model output" },
				partial: false,
				id: "toolu_2",
				nativeArgs: { path: "restricted.ts", content: "partial model output" },
			},
		]
		vi.mocked(validateToolUse).mockImplementationOnce(() => {
			throw new Error("write_to_file is not allowed to write restricted.ts in this mode")
		})

		await presentAssistantMessage(mockTask as unknown as Parameters<typeof presentAssistantMessage>[0])

		expect(mockWriteHandle).not.toHaveBeenCalled()
		expect(userMessageContent).toEqual([
			expect.objectContaining({
				type: "tool_result",
				tool_use_id: "toolu_2",
				is_error: true,
				content: expect.stringContaining("restricted.ts"),
			}),
		])
		expect(mockTeardown).toHaveBeenCalledTimes(1)
		expect(mockTeardown).toHaveBeenCalledWith(mockTask)
	})

	it("tears the stream state down when the tool repetition limit stops the call", async () => {
		mockTask.assistantMessageContent = [
			{
				type: "tool_use",
				name: "write_to_file",
				params: { path: "same.ts", content: "same content" },
				partial: false,
				id: "toolu_3",
				nativeArgs: { path: "same.ts", content: "same content" },
			},
		]
		vi.mocked(mockTask.toolRepetitionDetector as unknown as { check: unknown }).check = vi
			.fn()
			.mockReturnValue({
				allowExecution: false,
				askUser: { messageKey: "tool_repetition", messageDetail: "write_to_file" },
			})

		await presentAssistantMessage(mockTask as unknown as Parameters<typeof presentAssistantMessage>[0])

		expect(mockWriteHandle).not.toHaveBeenCalled()
		// The repetition exit reports through the local pushToolResult, which wraps the
		// message in the tool-error envelope rather than the provider is_error flag.
		expect(userMessageContent).toEqual([
			expect.objectContaining({
				type: "tool_result",
				tool_use_id: "toolu_3",
				content: expect.stringContaining("repetition limit reached"),
			}),
		])
		expect(mockTeardown).toHaveBeenCalledTimes(1)
		expect(mockTeardown).toHaveBeenCalledWith(mockTask)
	})
})
