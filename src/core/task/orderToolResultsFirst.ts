import type { Anthropic } from "@anthropic-ai/sdk"

import type { ApiMessage } from "../task-persistence"

type Block = Anthropic.Messages.ContentBlockParam
type ToolResultBlock = Anthropic.Messages.ToolResultBlockParam

function toContentArray(content: ToolResultBlock["content"]): Exclude<ToolResultBlock["content"], string | undefined> {
	if (typeof content === "string") return [{ type: "text", text: content }]
	return content ?? []
}

/**
 * Moves `tool_result` blocks to the front of each user message, keeping the relative order of
 * the results and of the remaining blocks. An image that directly follows a result (as when
 * `read_file` returns an image) is nested into that result's `content`, where Anthropic expects it.
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

		const results: ToolResultBlock[] = []
		const rest: Block[] = []
		// Index of the result an immediately following image belongs to; reset by any other block.
		let owner = -1
		for (const block of message.content) {
			if (block.type === "tool_result") {
				results.push(block)
				owner = results.length - 1
			} else if (block.type === "image" && owner !== -1) {
				const current = results[owner]
				results[owner] = { ...current, content: [...toContentArray(current.content), block] }
			} else {
				owner = -1
				rest.push(block)
			}
		}

		return { ...message, content: [...results, ...rest] }
	})
}
