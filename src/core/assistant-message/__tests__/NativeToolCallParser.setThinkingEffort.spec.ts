// npx vitest run src/core/assistant-message/__tests__/NativeToolCallParser.setThinkingEffort.spec.ts
//
// DTE series 3/5 — set_thinking_effort parsing in NativeToolCallParser:
// complete, partial-streaming, and finalize paths.

import { NativeToolCallParser } from "../NativeToolCallParser"

describe("NativeToolCallParser — set_thinking_effort", () => {
	beforeEach(() => {
		NativeToolCallParser.clearAllStreamingToolCalls()
		NativeToolCallParser.clearRawChunkState()
	})

	describe("parseToolCall (complete)", () => {
		it("parses effort and reason into nativeArgs", () => {
			const toolCall = {
				id: "toolu_dte_1",
				name: "set_thinking_effort" as const,
				arguments: JSON.stringify({
					effort: "high",
					reason: "Deep multi-file refactor ahead",
				}),
			}

			const result = NativeToolCallParser.parseToolCall(toolCall)

			expect(result).not.toBeNull()
			if (result?.type === "tool_use") {
				expect(result.name).toBe("set_thinking_effort")
				expect(result.nativeArgs).toEqual({
					effort: "high",
					reason: "Deep multi-file refactor ahead",
				})
				expect(result.params).toEqual({
					effort: "high",
					reason: "Deep multi-file refactor ahead",
				})
			}
		})

		it("returns null when the required reason is missing", () => {
			const toolCall = {
				id: "toolu_dte_2",
				name: "set_thinking_effort" as const,
				arguments: JSON.stringify({ effort: "high" }),
			}

			const result = NativeToolCallParser.parseToolCall(toolCall)
			expect(result).toBeNull()
		})
	})

	describe("processStreamingChunk (partial)", () => {
		it("emits a partial ToolUse carrying the streamed effort", () => {
			const id = "toolu_dte_stream_1"
			NativeToolCallParser.startStreamingToolCall(id, "set_thinking_effort")

			const result = NativeToolCallParser.processStreamingChunk(
				id,
				JSON.stringify({ effort: "high", reason: "escalating" }),
			)

			expect(result).not.toBeNull()
			const nativeArgs = result?.nativeArgs as { effort?: string; reason?: string } | undefined
			expect(nativeArgs).toBeDefined()
			expect(nativeArgs?.effort).toBe("high")
			expect(nativeArgs?.reason).toBe("escalating")
		})
	})

	describe("finalizeStreamingToolCall", () => {
		it("parses complete args on finalize", () => {
			const id = "toolu_dte_final_1"
			NativeToolCallParser.startStreamingToolCall(id, "set_thinking_effort")

			NativeToolCallParser.processStreamingChunk(id, JSON.stringify({ effort: "low", reason: "mechanical step" }))

			const result = NativeToolCallParser.finalizeStreamingToolCall(id)

			expect(result).not.toBeNull()
			if (result?.type === "tool_use") {
				expect(result.nativeArgs).toEqual({
					effort: "low",
					reason: "mechanical step",
				})
			}
		})
	})
})
