/**
 * Content Reference Tool — Chat Source Resolver
 *
 * Resolves content references pointing to assistant messages by index.
 * Uses negative indices: "-1" = last message, "-2" = second to last, etc.
 *
 * Для тестирования можно передать history явно вторым параметром.
 * Если history не передан — используется task.apiConversationHistory.
 */

import type { ContentRef } from "../../../../shared/tools"
import type { SelectorResult } from "../selector"
import { resolveContentRef } from "../selector"
import { getEffectiveApiHistory } from "../../../condense/index"
import type { ApiMessage } from "../../../task-persistence/apiMessages"
import type { Task } from "../../../task/Task"
import { info, successCrt, error } from "../superDebug"

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
 * @param ref     - ContentRef with ref.ref as a negative index string (e.g., "-1" for last message)
 * @param task    - Current task instance with apiConversationHistory
 * @param history - (optional) Override history array for testing. If provided, used instead of task.apiConversationHistory
 * @returns SelectorResult for the matched content fragment
 * @throws If index is invalid, out of bounds, message is empty, or history is empty/undefined
 */
export async function resolveChatSource(ref: ContentRef, task: Task, history?: ApiMessage[]): Promise<SelectorResult> {
	const index = parseInt(ref.ref, 10)
	if (isNaN(index) || index >= 0) {
		error("CHAT_SOURCE", `Invalid chat ref index: ${ref.ref}`, { ref })
		throw new Error(`Invalid chat ref index: ${ref.ref}. Use negative numbers (e.g., "-1" for last).`)
	}

	info("CHAT_SOURCE", `resolveChatSource: index="${ref.ref}"`)

	// Используем переданный history или берём из task
	const rawHistory = history ?? task.apiConversationHistory

	if (!rawHistory || !Array.isArray(rawHistory) || rawHistory.length === 0) {
		throw new Error(
			`Chat message index ${ref.ref} cannot be resolved: conversation history is empty or not available. ` +
				`Ensure the task has assistant messages before using source=chat.`,
		)
	}

	// Get effective (active window) history and filter only assistant messages
	const effectiveHistory = getEffectiveApiHistory(rawHistory)
	const assistantMessages = effectiveHistory.filter((msg: ApiMessage) => msg.role === "assistant")

	if (assistantMessages.length === 0) {
		throw new Error(
			`Chat message index ${ref.ref} cannot be resolved: no assistant messages found in history ` +
				`(${rawHistory.length} total messages, ${effectiveHistory.length} effective).`,
		)
	}

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
	info(
		"CHAT_SOURCE",
		`Found assistant message: targetIndex=${targetIndex}/${assistantMessages.length}, sourceTextLength=${sourceText.length}`,
	)

	// Если у ref нет ни одного способа сужения (selector, focus, startAnchor, startLine) —
	// возвращаем полный текст сообщения, а не передаём пустой ref в resolveContentRef
	if (!ref.selector && !ref.focus && !ref.startAnchor && ref.startLine == null) {
		const result: SelectorResult = {
			sourceId,
			content: sourceText,
			startOffset: 0,
			endOffset: sourceText.length,
			line: 0,
			confidence: 1.0,
			method: "exact",
		}
		successCrt("CHAT_SOURCE", `resolved full chat message at index ${ref.ref} (targetIndex=${targetIndex})`, {
			sourceId: result.sourceId,
			confidence: result.confidence,
			contentLength: result.content.length,
		})
		return result
	}

	const result = await resolveContentRef(sourceId, sourceText, ref)
	successCrt("CHAT_SOURCE", `resolved chat message at index ${ref.ref} (targetIndex=${targetIndex})`, {
		sourceId: result.sourceId,
		confidence: result.confidence,
		contentLength: result.content.length,
	})
	return result
}
