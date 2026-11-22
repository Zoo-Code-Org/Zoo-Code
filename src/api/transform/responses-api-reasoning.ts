import { providerIdentifiers } from "@roo-code/types"
import { createHash } from "node:crypto"
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

export type ScopedResponsesReasoningItem = OpenAI.Responses.ResponseReasoningItem & {
	format: "openai-responses-v1"
	provider: "openai"
	endpoint: string
}

/** Identifies the effective SDK endpoint without storing URL credentials or query secrets. */
export function responsesReasoningScope(baseURL: string): string {
	return createHash("sha256").update(baseURL.replace(/\/+$/, "")).digest("hex")
}

/** Tagged history is private to its originating provider and effective endpoint. */
export function readReplayableResponsesReasoning(
	value: unknown,
	endpoint?: string,
): OpenAI.Responses.ResponseReasoningItem | undefined {
	if (!value || typeof value !== "object") return undefined
	const item = value as Record<string, unknown>
	if (endpoint !== undefined || item.format === "openai-responses-v1") {
		if (
			endpoint === undefined ||
			item.format !== "openai-responses-v1" ||
			item.provider !== providerIdentifiers.openai ||
			item.endpoint !== endpoint
		)
			return undefined
	}
	return readResponsesReasoningItem(value)
}
