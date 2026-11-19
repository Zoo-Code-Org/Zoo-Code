import type OpenAI from "openai"

/** Reads only the fields needed to replay an opaque Responses reasoning item. */
export function readResponsesReasoningItem(value: unknown): OpenAI.Responses.ResponseReasoningItem | undefined {
	if (!value || typeof value !== "object") return undefined
	const item = value as Record<string, unknown>
	if (
		item.type !== "reasoning" ||
		typeof item.id !== "string" ||
		!item.id ||
		typeof item.encrypted_content !== "string" ||
		!item.encrypted_content
	)
		return undefined
	const summary = item.summary ?? []
	if (!Array.isArray(summary)) return undefined
	const summaries: OpenAI.Responses.ResponseReasoningItem.Summary[] = []
	for (const part of summary) {
		if (!part || typeof part !== "object" || part.type !== "summary_text" || typeof part.text !== "string")
			return undefined
		summaries.push({ type: "summary_text", text: part.text })
	}
	return { type: "reasoning", id: item.id, encrypted_content: item.encrypted_content, summary: summaries }
}
