import { Anthropic } from "@anthropic-ai/sdk"

import type { ApiMessage } from "../task-persistence"

type Block = Anthropic.Messages.ContentBlockParam
type ToolResultBlock = Anthropic.Messages.ToolResultBlockParam

const INTERRUPTED_RESULT = "Tool execution was interrupted before completion."

function toBlocks(content: ApiMessage["content"]): Block[] {
	if (Array.isArray(content)) return content as Block[]
	if (content === undefined || content === null || content === "") return []
	return [{ type: "text", text: String(content) }]
}

function toolUseIdsOf(message: ApiMessage): string[] {
	if (message.role !== "assistant" || !Array.isArray(message.content)) return []
	return (message.content as Block[]).flatMap((block) => (block.type === "tool_use" ? [block.id] : []))
}

/**
 * Shapes outgoing history so tool results satisfy Anthropic's adjacency rule: every
 * `tool_use` in an assistant message is answered by a `tool_result` in the very next
 * user message, `tool_result` blocks come first, and no `tool_result` refers to a
 * `tool_use` outside the immediately preceding assistant message.
 *
 * - Results are moved ahead of other content, in `tool_use` order (duplicates dropped).
 * - Results without a matching `tool_use` are dropped.
 * - Interrupted calls get a synthetic error result.
 *
 * Used for API request shaping only; stored history is not mutated. A trailing assistant
 * message is left alone because its results have not been produced yet.
 */
export function normalizeToolResultPairing(messages: ApiMessage[]): ApiMessage[] {
	const out: ApiMessage[] = []

	for (let i = 0; i < messages.length; i++) {
		const message = messages[i]

		if (message.role === "assistant") {
			out.push(message)
			const toolUseIds = toolUseIdsOf(message)
			if (toolUseIds.length === 0 || i === messages.length - 1) continue

			const next = messages[i + 1]
			const nextBlocks = next.role === "user" ? toBlocks(next.content) : []
			const resultsById = new Map<string, ToolResultBlock>()
			for (const block of nextBlocks) {
				if (block.type === "tool_result" && !resultsById.has(block.tool_use_id)) {
					resultsById.set(block.tool_use_id, block)
				}
			}

			const results: ToolResultBlock[] = toolUseIds.map(
				(id) => resultsById.get(id) ?? { type: "tool_result", tool_use_id: id, content: INTERRUPTED_RESULT },
			)

			if (next.role === "user") {
				const rest = nextBlocks.filter((block) => block.type !== "tool_result")
				out.push({ ...next, content: [...results, ...rest] })
				i++
			} else {
				// Another assistant message follows: answer the calls with a user turn of their own.
				out.push({ role: "user", content: results })
			}
			continue
		}

		// A user message not directly after a tool_use turn cannot carry tool results.
		if (!Array.isArray(message.content) || !message.content.some((block) => block.type === "tool_result")) {
			out.push(message)
			continue
		}
		const kept = (message.content as Block[]).filter((block) => block.type !== "tool_result")
		if (kept.length > 0) out.push({ ...message, content: kept })
	}

	return out
}
