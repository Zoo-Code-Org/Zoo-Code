// npx vitest run core/task/__tests__/finalizeStreamingToolCallById.spec.ts

import { Task } from "../Task"
import { NativeToolCallParser } from "../../assistant-message/NativeToolCallParser"
import type { ToolUse } from "../../../shared/tools"

type FinalizeStub = {
	assistantMessageContent: ToolUse[]
	streamingToolCallIndices: Map<string, number>
	userMessageContentReady: boolean
	presentAssistantMessageSafe: ReturnType<typeof vi.fn>
}

type FinalizeMethod = (this: FinalizeStub, id: string, scope: object) => void

/**
 * Invoke the private finalizeStreamingToolCallById against a minimal `this` stub.
 *
 * Instantiating a full Task requires a provider, context, and async setup that are
 * irrelevant to this helper. The method only touches assistantMessageContent,
 * streamingToolCallIndices, and userMessageContentReady, so a stub carrying those
 * fields exercises the real source lines without the constructor.
 */
function callFinalize(stub: FinalizeStub, id: string, scope: object): void {
	const finalize = (Task.prototype as unknown as { finalizeStreamingToolCallById: FinalizeMethod })
		.finalizeStreamingToolCallById
	finalize.call(stub, id, scope)
}

describe("Task.finalizeStreamingToolCallById", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("replaces the partial block with the finalized tool use and presents it", () => {
		const scope = NativeToolCallParser.createScope()
		const finalToolUse: ToolUse = { type: "tool_use", name: "read_file", params: {}, partial: false }
		const finalizeSpy = vi.spyOn(NativeToolCallParser, "finalizeStreamingToolCall").mockReturnValue(finalToolUse)

		const stub = {
			assistantMessageContent: [{ type: "tool_use", id: "call_abc", name: "read_file", partial: true }],
			streamingToolCallIndices: new Map<string, number>([["call_abc", 0]]),
			userMessageContentReady: true,
			presentAssistantMessageSafe: vi.fn(),
		}

		callFinalize(stub, "call_abc", scope)

		expect(finalizeSpy).toHaveBeenCalledWith("call_abc", scope)
		expect(stub.assistantMessageContent[0]).toBe(finalToolUse)
		expect(stub.assistantMessageContent[0].id).toBe("call_abc")
		expect(stub.streamingToolCallIndices.has("call_abc")).toBe(false)
		expect(stub.userMessageContentReady).toBe(false)
		expect(stub.presentAssistantMessageSafe).toHaveBeenCalledTimes(1)
	})

	it("marks the existing block non-partial when finalize returns null (malformed JSON)", () => {
		const scope = NativeToolCallParser.createScope()
		vi.spyOn(NativeToolCallParser, "finalizeStreamingToolCall").mockReturnValue(null)

		const existingBlock: ToolUse = {
			type: "tool_use",
			id: "call_bad",
			name: "write_to_file",
			params: {},
			partial: true,
		}
		const stub = {
			assistantMessageContent: [existingBlock],
			streamingToolCallIndices: new Map<string, number>([["call_bad", 0]]),
			userMessageContentReady: true,
			presentAssistantMessageSafe: vi.fn(),
		}

		callFinalize(stub, "call_bad", scope)

		expect(existingBlock.partial).toBe(false)
		expect(existingBlock.id).toBe("call_bad")
		expect(stub.streamingToolCallIndices.has("call_bad")).toBe(false)
		expect(stub.userMessageContentReady).toBe(false)
		expect(stub.presentAssistantMessageSafe).toHaveBeenCalledTimes(1)
	})

	it("is a no-op when the id is not tracked", () => {
		const scope = NativeToolCallParser.createScope()
		vi.spyOn(NativeToolCallParser, "finalizeStreamingToolCall").mockReturnValue(null)

		const stub = {
			assistantMessageContent: [] as ToolUse[],
			streamingToolCallIndices: new Map<string, number>(),
			userMessageContentReady: true,
			presentAssistantMessageSafe: vi.fn(),
		}

		callFinalize(stub, "call_unknown", scope)

		expect(stub.assistantMessageContent).toHaveLength(0)
		expect(stub.userMessageContentReady).toBe(true)
		expect(stub.presentAssistantMessageSafe).not.toHaveBeenCalled()
	})

	it("is idempotent: a second call for the same id does nothing", () => {
		const scope = NativeToolCallParser.createScope()
		const finalToolUse: ToolUse = { type: "tool_use", name: "read_file", params: {}, partial: false }
		vi.spyOn(NativeToolCallParser, "finalizeStreamingToolCall")
			.mockReturnValueOnce(finalToolUse)
			.mockReturnValue(null)

		const stub = {
			assistantMessageContent: [{ type: "tool_use", id: "call_once", name: "read_file", partial: true }],
			streamingToolCallIndices: new Map<string, number>([["call_once", 0]]),
			userMessageContentReady: true,
			presentAssistantMessageSafe: vi.fn(),
		}

		callFinalize(stub, "call_once", scope)
		callFinalize(stub, "call_once", scope) // id no longer tracked -> no-op

		expect(stub.presentAssistantMessageSafe).toHaveBeenCalledTimes(1)
	})
})
