import { NativeToolCallParser } from "../NativeToolCallParser"

describe("NativeToolCallParser - Additional Coverage", () => {
	beforeEach(() => {
		NativeToolCallParser.clearAllStreamingToolCalls()
		NativeToolCallParser.clearRawChunkState()
	})

	describe("hasActiveStreamingToolCalls", () => {
		it("should return false when no streaming tool calls are active", () => {
			NativeToolCallParser.clearAllStreamingToolCalls()
			expect(NativeToolCallParser.hasActiveStreamingToolCalls()).toBe(false)
		})

		it("should return true when there is an active streaming tool call", () => {
			NativeToolCallParser.clearAllStreamingToolCalls()
			NativeToolCallParser.startStreamingToolCall("toolu_123", "read_file")
			expect(NativeToolCallParser.hasActiveStreamingToolCalls()).toBe(true)

			// Finalize to clear state (needs compound key)
			NativeToolCallParser.finalizeStreamingToolCall(
				NativeToolCallParser.makeStreamingKey("toolu_123", "read_file"),
			)
			expect(NativeToolCallParser.hasActiveStreamingToolCalls()).toBe(false)
		})
	})

	describe("getStreamingToolName", () => {
		it("should return undefined for a non-existent tool call id", () => {
			NativeToolCallParser.clearAllStreamingToolCalls()
			expect(NativeToolCallParser.getStreamingToolName("toolu_nonexistent")).toBeUndefined()
		})

		it("should return the name of an active streaming tool call", () => {
			NativeToolCallParser.clearAllStreamingToolCalls()
			const testId = "toolu_stream_name_123"
			const testName = "write_to_file"
			NativeToolCallParser.startStreamingToolCall(testId, testName)

			expect(
				NativeToolCallParser.getStreamingToolName(NativeToolCallParser.makeStreamingKey(testId, testName)),
			).toBe("write_to_file")

			// Cleanup
			NativeToolCallParser.finalizeStreamingToolCall(NativeToolCallParser.makeStreamingKey(testId, testName))
		})

		it("should return undefined after the tool call is finalized", () => {
			NativeToolCallParser.clearAllStreamingToolCalls()
			const testId = "toolu_stream_name_456"
			NativeToolCallParser.startStreamingToolCall(testId, "codebase_search")
			NativeToolCallParser.finalizeStreamingToolCall(testId)

			expect(NativeToolCallParser.getStreamingToolName(testId)).toBeUndefined()
		})

		it("should return the name for MCP tools", () => {
			NativeToolCallParser.clearAllStreamingToolCalls()
			const testId = "toolu_mcp_name_789"
			const mcpToolName = "mcp--my-server--my-tool"
			NativeToolCallParser.startStreamingToolCall(testId, mcpToolName)

			expect(
				NativeToolCallParser.getStreamingToolName(NativeToolCallParser.makeStreamingKey(testId, mcpToolName)),
			).toBe(mcpToolName)

			// Cleanup
			NativeToolCallParser.finalizeStreamingToolCall(NativeToolCallParser.makeStreamingKey(testId, mcpToolName))
		})
	})

	describe("processStreamingChunk with MCP tools", () => {
		it("should return null for MCP tools during streaming (wait for final)", () => {
			const id = "toolu_mcp_stream_123"
			NativeToolCallParser.startStreamingToolCall(id, "mcp--my-server--get_config")

			// For MCP tools, processStreamingChunk should return null
			const result = NativeToolCallParser.processStreamingChunk(id, '{"key":"value"}')
			expect(result).toBeNull()
		})

		it("should return final McpToolUse for MCP tools on finalize", () => {
			const id = "toolu_mcp_finalize_123"
			const name = "mcp--my-server--get_config"
			NativeToolCallParser.startStreamingToolCall(id, name)

			// Add arguments via processStreamingChunk (doesn't return partial for MCP)
			NativeToolCallParser.processStreamingChunk(
				NativeToolCallParser.makeStreamingKey(id, name),
				'{"key":"value"}',
			)

			const result = NativeToolCallParser.finalizeStreamingToolCall(
				NativeToolCallParser.makeStreamingKey(id, name),
			)
			expect(result).not.toBeNull()
			// MCP tools return "mcp_tool_use" type, not "tool_use"
			expect(result?.type).toMatch(/^(tool_use|mcp_tool_use)$/)
		})
	})

	describe("finalizeRawChunks edge cases", () => {
		it("should return empty array when no raw chunks are tracked", () => {
			NativeToolCallParser.clearRawChunkState()
			const events = NativeToolCallParser.finalizeRawChunks()
			expect(events).toHaveLength(0)
		})

		it("should emit an end event for a tool call that already started (name provided upfront)", () => {
			NativeToolCallParser.clearRawChunkState()
			NativeToolCallParser.processRawChunk({
				index: 1,
				id: "toolu_partial",
				name: "read_file",
				arguments: undefined,
			})
			const events = NativeToolCallParser.finalizeRawChunks()
			expect(events).toEqual([{ type: "tool_call_end", id: "toolu_partial", name: "read_file" }])
		})
	})

	describe("clearRawChunkState", () => {
		it("should clear all raw chunk tracking state", () => {
			// Add some raw chunks first
			NativeToolCallParser.processRawChunk({
				index: 1,
				id: "toolu_clear_test",
				name: "read_file",
				arguments: '{"path":"test.ts"}',
			})

			// Clear state
			NativeToolCallParser.clearRawChunkState()

			// Finalize should return empty array
			const events = NativeToolCallParser.finalizeRawChunks()
			expect(events).toHaveLength(0)
		})
	})

	describe("clearAllStreamingToolCalls", () => {
		it("should clear all streaming tool call state", () => {
			NativeToolCallParser.startStreamingToolCall("toolu_clear_stream_1", "read_file")
			NativeToolCallParser.startStreamingToolCall("toolu_clear_stream_2", "write_to_file")

			expect(NativeToolCallParser.hasActiveStreamingToolCalls()).toBe(true)

			// Clear all
			NativeToolCallParser.clearAllStreamingToolCalls()

			expect(NativeToolCallParser.hasActiveStreamingToolCalls()).toBe(false)
			expect(NativeToolCallParser.getStreamingToolName("toolu_clear_stream_1")).toBeUndefined()
			expect(NativeToolCallParser.getStreamingToolName("toolu_clear_stream_2")).toBeUndefined()
		})
	})
})
