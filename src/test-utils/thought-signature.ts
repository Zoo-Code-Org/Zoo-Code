import type { Anthropic } from "@anthropic-ai/sdk"
import type OpenAI from "openai"
import type { Mock } from "vitest"

import type { ExtendedContentBlockParam } from "../api/transform/gemini-format"

export const TEST_THOUGHT_SIGNATURE = "AY89a18ErUKBAfkTYnDbzq6mGnRG5QS8VFogncpDzYVXzC0i+aDwY5o/0123456789abcdef=="

/** A LiteLLM `__thought__` id after the history sanitizer changed `+`, `/` and `=` to `_`. */
export const SANITIZED_LITELLM_TOOL_CALL_ID =
	"call_1__thought__AY89a18ErUKBAfkTYnDbzq6mGnRG5QS8VFogncpDzYVXzC0i_aDwY5o_0"

export function signedAssistantMessage(
	toolUseIds: string[],
	{ signature = TEST_THOUGHT_SIGNATURE, origin }: { signature?: string; origin?: string } = {},
): Anthropic.Messages.MessageParam {
	const content: ExtendedContentBlockParam[] = [
		...toolUseIds.map((id) => ({ type: "tool_use" as const, id, name: "read_file", input: {} })),
		{ type: "thoughtSignature", thoughtSignature: signature, ...(origin ? { origin } : {}) },
	]
	// The history stores the non-Anthropic thoughtSignature block next to the tool_use blocks.
	return { role: "assistant", content: content as Anthropic.Messages.ContentBlockParam[] }
}

export function toolResultsMessage(toolUseIds: string[]): Anthropic.Messages.MessageParam {
	return {
		role: "user",
		content: toolUseIds.map((id) => ({ type: "tool_result", tool_use_id: id, content: "ok" })),
	}
}

export function sentToolCalls(create: Mock): OpenAI.Chat.ChatCompletionMessageToolCall[] | undefined {
	const sent: OpenAI.Chat.ChatCompletionMessageParam[] = create.mock.calls.at(-1)?.[0].messages
	const assistant = sent.find((msg) => msg.role === "assistant" && msg.tool_calls?.length)
	return assistant?.role === "assistant" ? assistant.tool_calls : undefined
}
