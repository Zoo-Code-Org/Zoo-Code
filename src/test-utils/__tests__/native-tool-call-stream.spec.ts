import { collectStreamAndParseToolCalls } from "../native-tool-call-stream"
import { asyncStreamFrom } from "../stream"
import type { ApiStreamChunk } from "../../api/transform/stream"

describe("collectStreamAndParseToolCalls", () => {
	it("returns all chunks and emits a start event for an identified tool call", async () => {
		const stream = asyncStreamFrom<ApiStreamChunk>([
			{ type: "tool_call_partial", index: 0, id: "call_abc", name: "read_file" },
			{ type: "tool_call_partial", index: 0, arguments: '{"path":"foo.ts"}' },
		])

		const { chunks, parserEvents } = await collectStreamAndParseToolCalls(stream)

		expect(chunks).toHaveLength(2)
		expect(parserEvents).toEqual([
			{ type: "tool_call_start", id: "call_abc", name: "read_file" },
			{ type: "tool_call_delta", id: "call_abc", delta: '{"path":"foo.ts"}' },
		])
	})

	it("ignores non-tool_call_partial chunks", async () => {
		const stream = asyncStreamFrom<ApiStreamChunk>([
			{ type: "text", text: "hello" },
			{ type: "usage", inputTokens: 10, outputTokens: 5 },
		])

		const { chunks, parserEvents } = await collectStreamAndParseToolCalls(stream)

		expect(chunks).toHaveLength(2)
		expect(parserEvents).toHaveLength(0)
	})

	it("emits a separate delta event for each argument fragment", async () => {
		// Argument JSON often arrives in multiple chunks; each should produce its own delta.
		const stream = asyncStreamFrom<ApiStreamChunk>([
			{ type: "tool_call_partial", index: 0, id: "call_buf", name: "write_file" },
			{ type: "tool_call_partial", index: 0, arguments: '{"path":' },
			{ type: "tool_call_partial", index: 0, arguments: '"bar.ts"}' },
		])

		const { parserEvents } = await collectStreamAndParseToolCalls(stream)

		expect(parserEvents).toEqual([
			{ type: "tool_call_start", id: "call_buf", name: "write_file" },
			{ type: "tool_call_delta", id: "call_buf", delta: '{"path":' },
			{ type: "tool_call_delta", id: "call_buf", delta: '"bar.ts"}' },
		])
	})

	it("tracks two parallel tool calls under separate indices", async () => {
		const stream = asyncStreamFrom<ApiStreamChunk>([
			{ type: "tool_call_partial", index: 0, id: "call_0", name: "read_file" },
			{ type: "tool_call_partial", index: 1, id: "call_1", name: "write_file" },
			{ type: "tool_call_partial", index: 0, arguments: '"a"' },
			{ type: "tool_call_partial", index: 1, arguments: '"b"' },
		])

		const { parserEvents } = await collectStreamAndParseToolCalls(stream)

		expect(parserEvents).toEqual([
			{ type: "tool_call_start", id: "call_0", name: "read_file" },
			{ type: "tool_call_start", id: "call_1", name: "write_file" },
			{ type: "tool_call_delta", id: "call_0", delta: '"a"' },
			{ type: "tool_call_delta", id: "call_1", delta: '"b"' },
		])
	})

	it("cleans up scope state and re-throws when the stream errors mid-way", async () => {
		async function* failingStream(): AsyncGenerator<ApiStreamChunk> {
			yield { type: "tool_call_partial", index: 0, id: "call_fail", name: "read_file" }
			throw new Error("mid-stream failure")
		}

		await expect(collectStreamAndParseToolCalls(failingStream())).rejects.toThrow("mid-stream failure")

		// A second call on a fresh stream must work normally — no stale scope from the failed call.
		const { parserEvents } = await collectStreamAndParseToolCalls(
			asyncStreamFrom<ApiStreamChunk>([
				{ type: "tool_call_partial", index: 0, id: "call_ok", name: "write_file" },
			]),
		)
		expect(parserEvents).toEqual([{ type: "tool_call_start", id: "call_ok", name: "write_file" }])
	})
})
