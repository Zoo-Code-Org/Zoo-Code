// npx vitest run core/assistant-message/__tests__/presentAssistantMessage-validation-rejection.spec.ts

import { describe, it, expect, beforeEach, vi } from "vitest"

import { providerIdentifiers } from "@roo-code/types/provider-identifiers"

import { presentAssistantMessage } from "../presentAssistantMessage"
import type { RequestPolicySnapshot } from "../../prompts/tools/effective-tool-policy"
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

// The presenter validates against this frozen request snapshot; the mocked
// validateToolUse never reads policy fields, and the provider-state double in
// the task mock stays inert.
const baseSnapshot: RequestPolicySnapshot = {
	disabledTools: [],
	customModes: [],
	experiments: {},
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
			toolRepetitionDetector: { check: vi.fn().mockReturnValue({ action: "allow" }) },
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

		await presentAssistantMessage(mockTask as unknown as Task, baseSnapshot)

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
			action: "hard_block",
			askUser: { messageKey: "mistake_limit_reached", messageDetail: "repeated" },
		})
		mockTask.assistantMessageContent = writeBlock()

		await presentAssistantMessage(mockTask as unknown as Task, baseSnapshot)

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

	it("releases the streamed state when the repetition guard soft-blocks the completed block", async () => {
		// The tiered detector refuses a repeated call with a soft block - an error back to the
		// model, no user involved - and breaks before handle() just like the hard block. The
		// stream this call had already started owns nobody but this branch, so the release
		// must run on the soft exit too, not only on the hard one.
		mockValidate.mockReturnValue(undefined)
		mockTask.toolRepetitionDetector.check = vi.fn().mockReturnValue({
			action: "soft_block",
			message: "You are repeating the same tool call. Explain why you are repeating it.",
		})
		mockTask.assistantMessageContent = writeBlock()

		await presentAssistantMessage(mockTask as unknown as Task, baseSnapshot)

		expect(mockRelease).toHaveBeenCalledTimes(1)
		expect(mockHandle).not.toHaveBeenCalled()
		const toolResult = mockTask.userMessageContent.find((item) => item.type === "tool_result")
		if (!toolResult) {
			throw new Error("expected a tool_result for the soft-blocked call")
		}
		expect(toolResult.content).toContain("repeating the same tool call")
	})

	it("releases the streamed state when the completed block carries no native arguments", async () => {
		// A third way to break out of the loop before handle(): the parser never finished the
		// call. Streaming is not gated by it either, so the same state and preview can exist.
		mockValidate.mockReturnValue(undefined)
		mockTask.assistantMessageContent = [
			{
				type: "tool_use",
				id: "call-write-2",
				name: "write_to_file",
				params: { path: "a.ts" },
				partial: false,
			},
		]

		await presentAssistantMessage(mockTask as unknown as Task, baseSnapshot)

		expect(mockRelease).toHaveBeenCalledTimes(1)
		expect(mockRelease).toHaveBeenCalledWith(mockTask)
		expect(mockHandle).not.toHaveBeenCalled()
		const toolResult = mockTask.userMessageContent.find((item) => item.type === "tool_result")
		if (!toolResult) {
			throw new Error("expected a tool_result for the rejected call")
		}
		expect(toolResult.content).toContain("missing nativeArgs")
	})

	it("does not release the write_to_file stream for a different tool hard-blocked by the repetition guard", async () => {
		// The release is scoped by tool name in every branch. A repeated read_file must not
		// reach through to write_to_file's state. The check result must carry the detector's
		// real action field: with a shape the guard does not read, the block would fall
		// through to the tool switch and the assertion would pass without ever entering the
		// branch whose name guard it claims to control.
		mockValidate.mockReturnValue(undefined)
		mockTask.toolRepetitionDetector.check = vi.fn().mockReturnValue({
			action: "hard_block",
			askUser: { messageKey: "mistake_limit_reached", messageDetail: "repeated" },
		})
		mockTask.assistantMessageContent = [
			{
				type: "tool_use",
				id: "call-read-2",
				name: "read_file",
				params: { path: "a.ts" },
				nativeArgs: { path: "a.ts" },
				partial: false,
			},
		]

		await presentAssistantMessage(mockTask as unknown as Task, baseSnapshot)

		// The branch ran: the model received the hard-block refusal...
		const toolResult = mockTask.userMessageContent.find((item) => item.type === "tool_result")
		if (!toolResult) {
			throw new Error("expected a tool_result for the hard-blocked call")
		}
		expect(toolResult.content).toContain("repetition limit reached")
		// ...and the name guard kept write_to_file's release out of it.
		expect(mockRelease).not.toHaveBeenCalled()
		expect(mockHandle).not.toHaveBeenCalled()
	})

	it("does not release the write_to_file stream for a different tool soft-blocked by the repetition guard", async () => {
		// Same name guard, the other refusal tier: the soft block also breaks before handle()
		// and also releases only for write_to_file.
		mockValidate.mockReturnValue(undefined)
		mockTask.toolRepetitionDetector.check = vi.fn().mockReturnValue({
			action: "soft_block",
			message: "You are repeating the same tool call. Explain why you are repeating it.",
		})
		mockTask.assistantMessageContent = [
			{
				type: "tool_use",
				id: "call-read-4",
				name: "read_file",
				params: { path: "a.ts" },
				nativeArgs: { path: "a.ts" },
				partial: false,
			},
		]

		await presentAssistantMessage(mockTask as unknown as Task, baseSnapshot)

		const toolResult = mockTask.userMessageContent.find((item) => item.type === "tool_result")
		if (!toolResult) {
			throw new Error("expected a tool_result for the soft-blocked call")
		}
		expect(toolResult.content).toContain("repeating the same tool call")
		expect(mockRelease).not.toHaveBeenCalled()
		expect(mockHandle).not.toHaveBeenCalled()
	})

	it("does not release the write_to_file stream for a different tool with no native arguments", async () => {
		// The name check guards this branch too. Without a negative control here, a mutant
		// that releases for every tool in this branch survives.
		mockValidate.mockReturnValue(undefined)
		mockTask.assistantMessageContent = [
			{
				type: "tool_use",
				id: "call-read-3",
				name: "read_file",
				params: { path: "a.ts" },
				partial: false,
			},
		]

		await presentAssistantMessage(mockTask as unknown as Task, baseSnapshot)

		// The branch ran: the model received the parse refusal for the read_file call...
		const toolResult = mockTask.userMessageContent.find((item) => item.type === "tool_result")
		if (!toolResult) {
			throw new Error("expected a tool_result for the un-parsable call")
		}
		expect(toolResult.tool_use_id).toBe("call-read-3")
		expect(toolResult.content).toContain("missing nativeArgs")
		// ...and the name guard kept write_to_file's release out of it.
		expect(mockRelease).not.toHaveBeenCalled()
		expect(mockHandle).not.toHaveBeenCalled()
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

		await presentAssistantMessage(mockTask as unknown as Task, baseSnapshot)

		// The validation refusal is what the model received...
		const toolResult = mockTask.userMessageContent.find((item) => item.type === "tool_result")
		if (!toolResult) {
			throw new Error("expected a tool_result for the rejected call")
		}
		expect(toolResult.tool_use_id).toBe("call-read-1")
		expect(toolResult.content).toContain("not allowed in this mode")
		// ...and write_to_file's release stayed out of it.
		expect(mockRelease).not.toHaveBeenCalled()
	})

	it("releases the streamed state before awaiting the hard-block guidance prompt", async () => {
		// The prompt can stay open indefinitely, and an ask() that rejects (the abort lands
		// while it is open) skips any release placed after it. The refused write's stream
		// state, abort listener, and unapproved preview must not be held hostage to an
		// answer that may never come: the release runs before the prompt opens.
		mockValidate.mockReturnValue(undefined)
		mockTask.toolRepetitionDetector.check = vi.fn().mockReturnValue({
			action: "hard_block",
			askUser: { messageKey: "mistake_limit_reached", messageDetail: "repeated" },
		})
		// Keep the release pending: invocation order alone would still pass if the prompt
		// opened while the cleanup was mid-flight. The prompt must not open until the
		// release COMPLETES.
		let resolveRelease!: () => void
		mockRelease.mockImplementation(() => new Promise<void>((resolve) => (resolveRelease = resolve)))
		mockTask.ask = vi.fn().mockRejectedValue(new Error("prompt failed"))
		mockTask.assistantMessageContent = writeBlock()

		const presentation = presentAssistantMessage(mockTask as unknown as Task, baseSnapshot)
		await vi.waitFor(() => expect(mockRelease).toHaveBeenCalledTimes(1))
		// The release is still pending: the prompt must not have opened.
		expect(mockTask.ask).not.toHaveBeenCalled()
		resolveRelease()
		await expect(presentation).rejects.toThrow("prompt failed")
		expect(mockTask.ask).toHaveBeenCalledTimes(1)
	})
})
