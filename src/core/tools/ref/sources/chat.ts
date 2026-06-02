/**
 * Content Reference Tool — Chat Source Resolver
 *
 * Resolves content references pointing to assistant messages by index.
 * Uses negative indices: "-1" = last message, "-2" = second to last, etc.
 */

import type { ContentRef } from "../../../../shared/tools"
import type { SelectorResult } from "../selector"
import { resolveContentRef } from "../selector"
import type { Task } from "../../../task/Task"

/**
 * Resolve a chat source reference by indexing into the task's assistant messages.
 *
 * @param ref  - ContentRef with ref.ref as a negative index string (e.g., "-1" for last message)
 * @param task - Current task instance with assistantMessageContent
 * @returns SelectorResult for the matched content fragment
 * @throws If index is invalid, out of bounds, or message is empty
 */
export async function resolveChatSource(ref: ContentRef, task: Task): Promise<SelectorResult> {
	// ref.ref = index like "-1" (last), "-2" (second to last)
	const index = parseInt(ref.ref, 10)
	if (isNaN(index) || index >= 0) {
		throw new Error(`Invalid chat ref index: ${ref.ref}. Use negative numbers (e.g., "-1" for last).`)
	}

	const messages = task.assistantMessageContent
	const targetIndex = messages.length + index // -1 → last element

	if (targetIndex < 0 || targetIndex >= messages.length) {
		throw new Error(`Chat message index ${ref.ref} out of bounds. Available: ${messages.length} messages.`)
	}

	const message = messages[targetIndex]
	let sourceText = ""

	if (message.type === "text") {
		// TextContent has .content field
		sourceText = message.content || ""
	} else if (message.type === "tool_use") {
		// ToolUse — stringify params or nativeArgs as a fallback
		sourceText = JSON.stringify((message as any).nativeArgs || (message as any).params || {})
	} else if (message.type === "mcp_tool_use") {
		// McpToolUse — stringify arguments
		sourceText = JSON.stringify((message as any).arguments || {})
	}

	if (!sourceText) {
		throw new Error(`Chat message at index ${ref.ref} is empty or not text.`)
	}

	const sourceId = `chat:${ref.ref}`
	return resolveContentRef(sourceId, sourceText, ref)
}
