import { Anthropic } from "@anthropic-ai/sdk"

import type { ApiMessage } from "../task-persistence"
import { MAX_TOOL_NAME_LENGTH, buildMcpToolName, parseMcpToolName } from "../../utils/mcp-name"

/**
 * Rewrites MCP `tool_use` names longer than the provider limit to the name that was declared
 * to the model. Providers such as Bedrock Converse and Azure OpenAI reject over-long names in
 * history, so a task that already recorded one would otherwise fail on every retry.
 *
 * Used for API request shaping only; stored history is not mutated.
 */
export function capMcpToolUseNames(messages: ApiMessage[]): ApiMessage[] {
	return messages.map((message) => {
		if (message.role !== "assistant" || !Array.isArray(message.content)) return message

		const needsRename = message.content.some(
			(block) => block.type === "tool_use" && block.name.length > MAX_TOOL_NAME_LENGTH,
		)
		if (!needsRename) return message

		return {
			...message,
			content: message.content.map((block): Anthropic.Messages.ContentBlockParam => {
				if (block.type !== "tool_use" || block.name.length <= MAX_TOOL_NAME_LENGTH) return block

				const parsed = parseMcpToolName(block.name)
				return parsed ? { ...block, name: buildMcpToolName(parsed.serverName, parsed.toolName) } : block
			}),
		}
	})
}
