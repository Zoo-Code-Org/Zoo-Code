// npx vitest run core/task/__tests__/finalizeStreamingToolCallById.spec.ts

import { Task } from "../Task"
import { presentAssistantMessage } from "../../assistant-message"
import { NativeToolCallParser } from "../../assistant-message/NativeToolCallParser"
import type { ToolUse } from "../../../shared/tools"

// presentAssistantMessage is invoked by finalizeStreamingToolCallById to flush the
// finalized tool use; mocking it isolates the helper from the full presentation pipeline.
vi.mock("../../assistant-message", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, any>
	return {
		...actual,
		presentAssistantMessage: vi.fn(),
	}
})

const mockedPresent = vi.mocked(presentAssistantMessage)

/**
 * Invoke the private finalizeStreamingToolCallById against a minimal `this` stub.
 *
 * Instantiating a full Task requires a provider, context, and async setup that are
 * irrelevant to this helper. The method only touches assistantMessageContent,
 * streamingToolCallIndices, and userMessageContentReady, so a stub carrying those
 * fields exercises the real source lines without the constructor.
 */
function callFinalize(
	stub: {
		assistantMessageContent: any[]
		streamingToolCallIndices: Map<string, number>
		userMessageContentReady: boolean
	},
	id: string,
): void {
	;(Task.prototype as any).finalizeStreamingToolCallById.call(stub, id)
}

describe("Task.finalizeStreamingToolCallById", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("replaces the partial block with the finalized tool use and presents it", () => {
		const finalToolUse = { type: "tool_use", name: "read_file", partial: false } as unknown as ToolUse
		const finalizeSpy = vi
			.spyOn(NativeToolCallParser, "finalizeStreamingToolCall")
			.mockReturnValue(finalToolUse)

		const stub = {
			assistantMessageContent: [{ type: "tool_use", id: "call_abc", name: "read_file", partial: true }],
			streamingToolCallIndices: new Map<string, number>([["call_abc", 0]]),
			userMessageContentReady: true,
		}

		callFinalize(stub, "call_abc")

		expect(finalizeSpy).toHaveBeenCalledWith("call_abc")
		expect(stub.assistantMessageContent[0]).toBe(finalToolUse)
		expect((stub.assistantMessageContent[0] as any).id).toBe("call_abc")
		expect(stub.streamingToolCallIndices.has("call_abc")).toBe(false)
		expect(stub.userMessageContentReady).toBe(false)
		expect(mockedPresent).toHaveBeenCalledTimes(1)
	})

	it("marks the existing block non-partial when finalize returns null (malformed JSON)", () => {
		vi.spyOn(NativeToolCallParser, "finalizeStreamingToolCall").mockReturnValue(null)

		const existingBlock = { type: "tool_use", id: "call_bad", name: "write_to_file", partial: true }
		const stub = {
			assistantMessageContent: [existingBlock],
			streamingToolCallIndices: new Map<string, number>([["call_bad", 0]]),
			userMessageContentReady: true,
		}

		callFinalize(stub, "call_bad")

		expect(existingBlock.partial).toBe(false)
		expect((existingBlock as any).id).toBe("call_bad")
		expect(stub.streamingToolCallIndices.has("call_bad")).toBe(false)
		expect(stub.userMessageContentReady).toBe(false)
		expect(mockedPresent).toHaveBeenCalledTimes(1)
	})

	it("is a no-op when the id is not tracked", () => {
		vi.spyOn(NativeToolCallParser, "finalizeStreamingToolCall").mockReturnValue(null)

		const stub = {
			assistantMessageContent: [] as any[],
			streamingToolCallIndices: new Map<string, number>(),
			userMessageContentReady: true,
		}

		callFinalize(stub, "call_unknown")

		expect(stub.assistantMessageContent).toHaveLength(0)
		expect(stub.userMessageContentReady).toBe(true)
		expect(mockedPresent).not.toHaveBeenCalled()
	})

	it("is idempotent: a second call for the same id does nothing", () => {
		const finalToolUse = { type: "tool_use", name: "read_file", partial: false } as unknown as ToolUse
		vi.spyOn(NativeToolCallParser, "finalizeStreamingToolCall")
			.mockReturnValueOnce(finalToolUse)
			.mockReturnValue(null)

		const stub = {
			assistantMessageContent: [{ type: "tool_use", id: "call_once", name: "read_file", partial: true }],
			streamingToolCallIndices: new Map<string, number>([["call_once", 0]]),
			userMessageContentReady: true,
		}

		callFinalize(stub, "call_once")
		callFinalize(stub, "call_once") // id no longer tracked -> no-op

		expect(mockedPresent).toHaveBeenCalledTimes(1)
	})
})
