/**
 * Extracts reasoning text from a streaming delta object.
 *
 * Prefers `reasoning_content` (DeepSeek-R1 / QwQ style) and falls back to
 * `reasoning` (OpenRouter style). Whitespace-only payloads (e.g. a lone " "
 * or "\n\n" between paragraphs) are preserved so streamed reasoning keeps
 * word and paragraph boundaries once chunks are concatenated downstream.
 *
 * The fallback only fires when the current field is missing, non-string,
 * or an empty string — a delta with `reasoning_content: null` and a
 * populated `reasoning` still resolves to the populated field.
 */
export function extractReasoningFromDelta(delta: unknown): string | undefined {
	if (!delta) return undefined

	const d = delta as { reasoning_content?: unknown; reasoning?: unknown }

	if (typeof d.reasoning_content === "string" && d.reasoning_content.length > 0) {
		return d.reasoning_content
	}
	if (typeof d.reasoning === "string" && d.reasoning.length > 0) {
		return d.reasoning
	}
	return undefined
}
