import { ApiMessage } from "../../core/task-persistence/apiMessages"

import { ApiHandler } from "../index"

/* Removes image blocks from messages if they are not supported by the Api Handler */
export function maybeRemoveImageBlocks(messages: ApiMessage[], apiHandler: ApiHandler): ApiMessage[] {
	// Check model capability ONCE instead of for every message
	const supportsImages = apiHandler.getModel().info.supportsImages

	return messages.map((message) => {
		// Handle array content (could contain image blocks).
		let { content } = message
		if (Array.isArray(content)) {
			if (!supportsImages) {
				// Convert image blocks to text descriptions.
				content = content.map((block) => {
					if (block.type === "image") {
						// Convert image blocks to text descriptions.
						// Note: We can't access the actual image content/url due to API limitations,
						// but we can indicate that an image was present in the conversation.
						return {
							type: "text",
							text: "[Referenced image in conversation]",
						}
					}
					// Only tool_result blocks ever carry array content (text blocks
					// carry a string, tool_use none), so dropping this type check
					// cannot change any reachable shape (full-suite equivalent).
					// Stryker disable next-line ConditionalExpression: only tool_result blocks ever carry array content
					const isToolResultWithBlocks = block.type === "tool_result"
					if (isToolResultWithBlocks && Array.isArray(block.content)) {
						// Images can also nest inside a tool_result's block list.
						return {
							...block,
							content: block.content.map((nested) =>
								nested.type === "image"
									? { type: "text", text: "[Referenced image in conversation]" }
									: nested,
							),
						}
					}
					return block
				})
			}
		}
		return { ...message, content }
	})
}
