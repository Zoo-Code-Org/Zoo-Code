import type { ApiMessage } from "../task-persistence"

/**
 * Moves `tool_result` blocks to the front of each user message, keeping the relative order of
 * the results and of the remaining blocks (images, text). This is the same partition
 * `Task.pushToolResultToUserContent` applies to live turns (#1307), so repaired history has the
 * shape every provider converter already handles: images stay top-level blocks after the results,
 * where image-capable converters forward them and `maybeRemoveImageBlocks` can strip them.
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

		const results = message.content.filter((block) => block.type === "tool_result")
		const rest = message.content.filter((block) => block.type !== "tool_result")
		return { ...message, content: [...results, ...rest] }
	})
}
