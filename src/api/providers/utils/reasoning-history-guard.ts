/**
 * Detects whether a converted OpenAI-format message history contains any
 * assistant message with `tool_calls` but no non-empty `reasoning_content`.
 * Used as a guard before enabling strict provider "thinking" modes that
 * require reasoning_content to accompany every tool-call turn.
 *
 * This function operates on messages *after* conversion to the provider's
 * OpenAI-compatible format (e.g. `convertToR1Format`, `convertToZAiFormat`),
 * because it is only in the converted format that `reasoning_content`
 * presence can be reliably determined.
 *
 * @param messages - Array of converted messages in OpenAI-compatible format
 * @returns `true` if any assistant message has tool_calls but lacks
 *          non-empty reasoning_content
 */
export function historyHasToolCallsWithoutReasoning(
	messages: Array<{ role?: string; tool_calls?: unknown[]; reasoning_content?: unknown }>,
): boolean {
	return messages.some(
		(m) =>
			m.role === "assistant" &&
			Array.isArray(m.tool_calls) &&
			m.tool_calls.length > 0 &&
			(typeof m.reasoning_content !== "string" || m.reasoning_content.length === 0),
	)
}
