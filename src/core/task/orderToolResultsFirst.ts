import type { ApiMessage } from "../task-persistence"

/**
 * Moves `tool_result` blocks to the front of each user message, keeping the relative order of
 * the results and of the remaining blocks.
 *
 * Anthropic requires the results for the previous turn's `tool_use` blocks to lead the next user
 * message. History saved with image blocks between results (#1307, #1774), or produced by merging
 * consecutive user messages, is otherwise rejected with a 400 on every retry.
 *
 * Used for *API request shaping only* (do not use for storage). Messages already in order are
 * returned unchanged.
 */
export function orderToolResultsFirst(messages: ApiMessage[]): ApiMessage[] {
	return messages.map((message) => {
		if (message.role !== "user" || !Array.isArray(message.content)) {
			return message
		}
		const firstOther = message.content.findIndex((block) => block.type !== "tool_result")
		const hasLaterResult =
			firstOther !== -1 && message.content.slice(firstOther).some((block) => block.type === "tool_result")
		if (!hasLaterResult) {
			return message
		}
		return {
			...message,
			content: [
				...message.content.filter((block) => block.type === "tool_result"),
				...message.content.filter((block) => block.type !== "tool_result"),
			],
		}
	})
}
