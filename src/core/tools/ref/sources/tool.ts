/**
 * Content Reference Tool — Tool Source Resolver
 *
 * Resolves content references pointing to tool_result blocks in the
 * conversation history. Matches by tool name across tool_use/tool_result pairs.
 */

import type { ContentRef } from "../../../../shared/tools"
import type { SelectorResult } from "../selector"
import { resolveContentRef } from "../selector"
import type { Task } from "../../../task/Task"

/**
 * Resolve a tool source reference by finding the last tool_result for a given tool.
 *
 * Traverses userMessageContent backwards to find the latest tool_result,
 * then verifies the tool name by matching tool_use_id against assistantMessageContent.
 *
 * @param ref  - ContentRef with ref.ref as the tool name (e.g., "read_file")
 * @param task - Current task instance with user and assistant message content
 * @returns SelectorResult with the tool result content
 * @throws If no matching tool result is found
 */
export async function resolveToolSource(ref: ContentRef, task: Task): Promise<SelectorResult> {
	// Find the last tool_result for the specified tool
	const toolName = ref.ref
	const messages = task.userMessageContent

	// Traverse backwards to find latest result for this tool
	for (let i = messages.length - 1; i >= 0; i--) {
		const block = messages[i]

		if (isToolResultBlock(block)) {
			const toolUseId = block.tool_use_id

			// Find the corresponding tool_use in assistant message to match tool name
			const assistantMessages = task.assistantMessageContent
			for (const msg of assistantMessages) {
				if (
					(msg.type === "tool_use" || msg.type === "mcp_tool_use") &&
					(msg as any).id === toolUseId &&
					(msg as any).name === toolName
				) {
					// Found matching tool result
					const content = extractTextContent(block)
					const sourceId = `tool:${toolName}:${toolUseId}`
					return resolveContentRef(sourceId, content, ref)
				}
			}
		}
	}

	throw new Error(`No tool result found for tool: ${toolName}`)
}

/**
 * Type guard to check if a user message block is a ToolResultBlockParam.
 */
function isToolResultBlock(block: any): block is { type: "tool_result"; tool_use_id: string; content: any } {
	return block && block.type === "tool_result" && typeof block.tool_use_id === "string"
}

/**
 * Extract text content from a tool_result block.
 *
 * Handles both string content and structured content arrays.
 */
function extractTextContent(block: { content: any }): string {
	if (typeof block.content === "string") {
		return block.content
	}
	if (Array.isArray(block.content)) {
		return block.content
			.filter((c: any) => c.type === "text")
			.map((c: any) => c.text)
			.join("\n")
	}
	return JSON.stringify(block.content || "")
}
