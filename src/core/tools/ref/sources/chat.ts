/**
 * Content Reference Tool — Chat Source Resolver
 *
 * Resolves content references pointing to assistant messages by index.
 * Uses negative indices: "-1" = last message, "-2" = second to last, etc.
 */

import type { ContentRef } from "../../../../shared/tools"
import type { SelectorResult } from "../selector"
import { resolveContentRef } from "../selector"
import { getEffectiveApiHistory } from "../../../condense/index"
import type { ApiMessage } from "../../../task-persistence/apiMessages"
import type { Task } from "../../../task/Task"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract flat text from an assistant ApiMessage by concatenating all textual
 * content blocks and serialising tool_use / mcp_tool_use blocks.
 */
function extractTextFromAssistantMessage(message: ApiMessage): string {
	if (!Array.isArray(message.content)) {
		// String content fallback (legacy Anthropic format)
		return typeof message.content === "string" ? message.content : ""
	}

	const parts: string[] = []
	for (const block of message.content as any[]) {
		if (block.type === "text") {
			if (block.text) parts.push(block.text)
		} else if (block.type === "tool_use") {
			parts.push(JSON.stringify(block.nativeArgs || block.params || {}))
		} else if (block.type === "mcp_tool_use") {
			parts.push(JSON.stringify(block.arguments || {}))
		}
	}
	return parts.join("\n")
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve a chat source reference by indexing into the task's assistant messages.
 *
 * Uses getEffectiveApiHistory to obtain the active conversation window, then
 * filters for assistant-only messages and indexes by negative index.
 *
 * @param ref  - ContentRef with ref.ref as a negative index string (e.g., "-1" for last message)
 * @param task - Current task instance with apiConversationHistory
 * @returns SelectorResult for the matched content fragment
 * @throws If index is invalid, out of bounds, or message is empty
 */
export async function resolveChatSource(ref: ContentRef, task: Task): Promise<SelectorResult> {
	const index = parseInt(ref.ref, 10)
	if (isNaN(index) || index >= 0) {
		throw new Error(`Invalid chat ref index: ${ref.ref}. Use negative numbers (e.g., "-1" for last).`)
	}

	// Get effective (active window) history and filter only assistant messages
	const history = getEffectiveApiHistory(task.apiConversationHistory)
	const assistantMessages = history.filter((msg) => msg.role === "assistant")

	const targetIndex = assistantMessages.length + index // -1 → last element

	if (targetIndex < 0 || targetIndex >= assistantMessages.length) {
		throw new Error(
			`Chat message index ${ref.ref} out of bounds. Available: ${assistantMessages.length} assistant messages.`,
		)
	}

	const message = assistantMessages[targetIndex]
	const sourceText = extractTextFromAssistantMessage(message)

	if (!sourceText) {
		throw new Error(`Chat message at index ${ref.ref} is empty or not text.`)
	}

	const sourceId = `chat:${ref.ref}`
	return resolveContentRef(sourceId, sourceText, ref)
}
