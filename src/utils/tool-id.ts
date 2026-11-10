import * as crypto from "crypto"

/**
 * OpenAI Responses API maximum length for call_id field.
 * This limit applies to both function_call and function_call_output items.
 */
export const OPENAI_CALL_ID_MAX_LENGTH = 64

/**
 * LiteLLM carries a Gemini thought signature inside the tool call id, as
 * `<call id>__thought__<Base64 signature>`. Gemini rejects the next request if the
 * signature changes, so the marker and everything after it must stay byte-for-byte intact.
 */
export const THOUGHT_SIGNATURE_MARKER = "__thought__"

/**
 * Replace every character outside the Anthropic/Bedrock tool id pattern ^[a-zA-Z0-9_-]+$
 * with underscore. Use this only at a request boundary that enforces the pattern.
 */
export function sanitizeToolIdForStrictProvider(id: string): string {
	return id.replace(/[^a-zA-Z0-9_-]/g, "_")
}

/**
 * Sanitize a tool_use ID for the conversation history. Ids that carry a thought signature
 * keep the signature unchanged; only the call id before the marker is sanitized.
 */
export function sanitizeToolUseId(id: string): string {
	const markerIndex = id.indexOf(THOUGHT_SIGNATURE_MARKER)
	if (markerIndex === -1) {
		return sanitizeToolIdForStrictProvider(id)
	}
	return sanitizeToolIdForStrictProvider(id.slice(0, markerIndex)) + id.slice(markerIndex)
}

/**
 * Truncate a call_id to fit within OpenAI's 64-character limit.
 * Uses a hash suffix to maintain uniqueness when truncation is needed.
 *
 * @param id - The original call_id
 * @param maxLength - Maximum length (defaults to OpenAI's 64-char limit)
 * @returns The truncated ID, or original if already within limits
 */
export function truncateOpenAiCallId(id: string, maxLength: number = OPENAI_CALL_ID_MAX_LENGTH): string {
	if (id.length <= maxLength) {
		return id
	}

	// Use 8-char hash suffix for uniqueness (from MD5, sufficient for collision resistance in this context)
	const hashSuffixLength = 8
	const separator = "_"
	// Reserve space for separator + hash
	const prefixMaxLength = maxLength - separator.length - hashSuffixLength

	// Create hash of the full original ID for uniqueness
	const hash = crypto.createHash("md5").update(id).digest("hex").slice(0, hashSuffixLength)

	// Take the prefix and append hash
	const prefix = id.slice(0, prefixMaxLength)
	return `${prefix}${separator}${hash}`
}

/**
 * Sanitize and truncate a tool call ID for OpenAI's Responses API.
 * This combines character sanitization with length truncation.
 *
 * @param id - The original call_id
 * @param maxLength - Maximum length (defaults to OpenAI's 64-char limit)
 * @returns The sanitized and truncated ID
 */
export function sanitizeOpenAiCallId(id: string, maxLength: number = OPENAI_CALL_ID_MAX_LENGTH): string {
	return truncateOpenAiCallId(sanitizeToolIdForStrictProvider(id), maxLength)
}

/**
 * Normalize a tool call id for LiteLLM. Ids that carry a thought signature are never
 * truncated, because Gemini must receive the signature intact. Every other id gets the
 * usual OpenAI 64-character treatment.
 */
export function sanitizeLiteLlmCallId(id: string): string {
	return id.includes(THOUGHT_SIGNATURE_MARKER) ? sanitizeToolUseId(id) : sanitizeOpenAiCallId(id)
}
