import type { ApiStreamChunk } from "../api/transform/stream"
import { NativeToolCallParser, type ToolCallStreamEvent } from "../core/assistant-message/NativeToolCallParser"

export async function collectStreamAndParseToolCalls(stream: AsyncIterable<ApiStreamChunk>): Promise<{
	chunks: ApiStreamChunk[]
	parserEvents: ToolCallStreamEvent[]
}> {
	const chunks: ApiStreamChunk[] = []
	const parserEvents: ToolCallStreamEvent[] = []
	const parserScope = NativeToolCallParser.createScope()

	try {
		for await (const chunk of stream) {
			if (chunk.type === "tool_call_partial") {
				parserEvents.push(
					...NativeToolCallParser.processRawChunk(
						{
							index: chunk.index,
							id: chunk.id,
							name: chunk.name,
							arguments: chunk.arguments,
						},
						parserScope,
					),
				)
			}
			chunks.push(chunk)
		}
		return { chunks, parserEvents }
	} finally {
		NativeToolCallParser.clearRawChunkState(parserScope)
	}
}
