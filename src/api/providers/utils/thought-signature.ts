import { createHash } from "crypto"

import type { Anthropic } from "@anthropic-ai/sdk"
import type OpenAI from "openai"

import { type ExtendedContentBlockParam, isThoughtSignatureContentBlock } from "../../transform/gemini-format"

/** LiteLLM embeds a Gemini thought signature in the tool call id after this marker. */
export const LITELLM_THOUGHT_SIGNATURE_ID_MARKER = "__thought__"

/**
 * Name the backend that minted a signature, so it is sent back only to that backend. The hash
 * keeps the endpoint URL out of the task history and the diagnostics export.
 */
export function thoughtSignatureOrigin(baseUrl: string, modelId: string): string {
	const endpoint = baseUrl.replace(/\/+$/, "")
	return createHash("sha256").update(`${endpoint}|${modelId}`).digest("hex").slice(0, 16)
}

function signatureOf(toolCall: unknown): string | undefined {
	const fields = (toolCall as { provider_specific_fields?: { thought_signature?: unknown } } | undefined)
		?.provider_specific_fields
	return typeof fields?.thought_signature === "string" && fields.thought_signature.length > 0
		? fields.thought_signature
		: undefined
}

/** Keep the first explicit signature, or the first ID fallback, across response chunks. */
export class ThoughtSignatureReader {
	private explicit: string | undefined
	private encoded: string | undefined

	get signature(): string | undefined {
		return this.explicit ?? this.encoded
	}

	update(toolCalls: readonly unknown[] | null | undefined): void {
		if (this.explicit !== undefined) return
		for (const call of toolCalls ?? []) {
			this.explicit = signatureOf(call)
			if (this.explicit !== undefined) return
			// Keep looking for an explicit field after an ID fallback, including in later chunks.
			if (this.encoded !== undefined) continue
			if (typeof call !== "object" || call === null || !("id" in call) || typeof call.id !== "string") continue
			const marker = call.id.indexOf(LITELLM_THOUGHT_SIGNATURE_ID_MARKER)
			if (marker < 0) continue
			const signature = call.id.slice(marker + LITELLM_THOUGHT_SIGNATURE_ID_MARKER.length)
			if (signature) this.encoded = signature
		}
	}
}

function collectToolCallReplay(
	history: Anthropic.Messages.MessageParam[],
	origin: string,
	normalizeToolCallId: (id: string) => string,
): Map<string, { id: string; signature?: string }> {
	const calls = new Map<string, { id: string; signature?: string }>()
	for (const message of history) {
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue
		let signature: string | undefined
		const toolUseIds: string[] = []
		const blocks: readonly ExtendedContentBlockParam[] = message.content
		for (const block of blocks) {
			if (isThoughtSignatureContentBlock(block)) {
				signature = block.origin === origin ? block.thoughtSignature : undefined
			} else if (block.type === "tool_use") {
				toolUseIds.push(block.id)
			}
		}
		for (const [index, id] of toolUseIds.entries()) {
			const marker = id.indexOf(LITELLM_THOUGHT_SIGNATURE_ID_MARKER)
			// Remove foreign signature bytes before normalization can truncate or hash the ID.
			// Keep calls with the same prefix distinct after removing their signature suffixes.
			const outgoingId =
				!signature && marker >= 0
					? `${id.slice(0, marker) || "call"}_${createHash("sha256").update(id).digest("hex").slice(0, 16)}`
					: id
			calls.set(normalizeToolCallId(id), {
				id: normalizeToolCallId(outgoingId),
				...(index === 0 && signature ? { signature } : {}),
			})
		}
	}
	return calls
}

interface ApplyThoughtSignaturesOptions {
	/** Only signatures stored with this origin are sent back. */
	origin: string
	/** The same id normalizer the caller used to build the OpenAI messages. */
	normalizeToolCallId?: (id: string) => string
	/** Signature for a tool call without a stored one, for example the Gemini bypass token. */
	fallback?: (toolCallId: string) => string | undefined
}

/**
 * Write `provider_specific_fields.thought_signature` on assistant tool calls, where LiteLLM
 * reads it before the id. A stored signature goes on the first tool call of its message,
 * because Gemini signs only the first call of a parallel set.
 */
export function applyThoughtSignatures(
	history: Anthropic.Messages.MessageParam[],
	openAiMessages: OpenAI.Chat.ChatCompletionMessageParam[],
	{ origin, normalizeToolCallId = (id) => id, fallback }: ApplyThoughtSignaturesOptions,
): OpenAI.Chat.ChatCompletionMessageParam[] {
	const replayByToolCallId = collectToolCallReplay(history, origin, normalizeToolCallId)

	return openAiMessages.map((message) => {
		if (message.role === "tool") {
			const id = replayByToolCallId.get(message.tool_call_id)?.id ?? message.tool_call_id
			return id === message.tool_call_id ? message : { ...message, tool_call_id: id }
		}
		if (message.role !== "assistant" || !message.tool_calls?.length) {
			return message
		}
		let signed = false
		const toolCalls = message.tool_calls.map((toolCall) => {
			const stored = replayByToolCallId.get(toolCall.id)
			const signature = stored?.signature ?? fallback?.(toolCall.id)
			const id = stored?.id ?? toolCall.id
			signed ||= Boolean(signature)
			if (signature) {
				return { ...toolCall, id, provider_specific_fields: { thought_signature: signature } }
			}
			return id === toolCall.id ? toolCall : { ...toolCall, id }
		})
		const result: OpenAI.Chat.ChatCompletionAssistantMessageParam & { reasoning_content?: string } = {
			...message,
			tool_calls: toolCalls,
		}
		// LiteLLM can turn this text into an unsigned Gemini thought part.
		if (signed) delete result.reasoning_content
		return result
	})
}
