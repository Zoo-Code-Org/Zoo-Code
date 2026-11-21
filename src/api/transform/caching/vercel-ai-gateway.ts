import OpenAI from "openai"

import type { PromptCacheTtl } from "@roo-code/types"

import { cacheControl } from "./ttl"

export function addCacheBreakpoints(
	systemPrompt: string,
	messages: OpenAI.Chat.ChatCompletionMessageParam[],
	ttl?: PromptCacheTtl,
) {
	const control = cacheControl(ttl)

	// Apply cache_control to system message at the message level
	messages[0] = {
		role: "system",
		content: systemPrompt,
		// @ts-ignore-next-line
		cache_control: control,
	}

	// Add cache_control to the last two user messages for conversation context caching
	const lastTwoUserMessages = messages.filter((msg) => msg.role === "user").slice(-2)

	lastTwoUserMessages.forEach((msg) => {
		if (typeof msg.content === "string" && msg.content.length > 0) {
			msg.content = [{ type: "text", text: msg.content }]
		}

		if (Array.isArray(msg.content)) {
			// Find the last text part in the message content
			const lastTextPart = msg.content.filter((part) => part.type === "text").pop()

			if (lastTextPart && lastTextPart.text && lastTextPart.text.length > 0) {
				// @ts-ignore-next-line
				lastTextPart["cache_control"] = control
			}
		}
	})
}
