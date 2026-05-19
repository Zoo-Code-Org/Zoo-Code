import { Anthropic } from "@anthropic-ai/sdk"

import { type ProviderSettings, getApiProtocol, getModelId, isRetiredProvider } from "@roo-code/types"

import type { ApiHandler } from "../../api"
import { getEffectiveApiHistory } from "../condense"
import type { ApiMessage } from "../task-persistence"
import { validateAndFixToolResultIds } from "./validateToolResultIds"

type ApiHistoryHandler = ApiHandler & {
	getResponseId?: () => string | undefined
	getEncryptedContent?: () => { encrypted_content: string; id?: string } | undefined
	getThoughtSignature?: () => string | undefined
	getReasoningDetails?: () => any[] | undefined
}

interface PrepareApiConversationMessageOptions {
	message: Anthropic.MessageParam
	reasoning?: string
	api: ApiHandler
	apiConfiguration: ProviderSettings
	apiConversationHistory: ApiMessage[]
}

export function prepareApiConversationMessage({
	message,
	reasoning,
	api,
	apiConfiguration,
	apiConversationHistory,
}: PrepareApiConversationMessageOptions): ApiMessage {
	if (message.role === "assistant") {
		return prepareAssistantMessage(message, reasoning, api as ApiHistoryHandler, apiConfiguration)
	}

	return prepareUserMessage(message, apiConversationHistory)
}

function prepareAssistantMessage(
	message: Anthropic.MessageParam,
	reasoning: string | undefined,
	handler: ApiHistoryHandler,
	apiConfiguration: ProviderSettings,
): ApiMessage {
	const responseId = handler.getResponseId?.()
	const reasoningData = handler.getEncryptedContent?.()
	const thoughtSignature = handler.getThoughtSignature?.()
	const reasoningDetails = handler.getReasoningDetails?.()

	const modelId = getModelId(apiConfiguration)
	const apiProvider = apiConfiguration.apiProvider
	const apiProtocol = getApiProtocol(
		apiProvider && !isRetiredProvider(apiProvider) ? apiProvider : undefined,
		modelId,
	)
	const isAnthropicProtocol = apiProtocol === "anthropic"

	const messageWithTs: any = {
		...message,
		...(responseId ? { id: responseId } : {}),
		ts: Date.now(),
	}

	if (reasoningDetails) {
		messageWithTs.reasoning_details = reasoningDetails
	}

	if (isAnthropicProtocol && reasoning && thoughtSignature && !reasoningDetails) {
		const thinkingBlock = {
			type: "thinking",
			thinking: reasoning,
			signature: thoughtSignature,
		}

		prependContentBlock(messageWithTs, thinkingBlock)
	} else if (reasoning && !reasoningDetails) {
		// The original Task.ts also duck-typed getSummary?.(), but no provider implements it.
		// Keep the explicit empty summary to preserve the existing reasoning-block wire shape.
		const reasoningBlock = {
			type: "reasoning",
			text: reasoning,
			summary: [] as any[],
		}

		prependContentBlock(messageWithTs, reasoningBlock)
	} else if (reasoningData?.encrypted_content) {
		const reasoningBlock = {
			type: "reasoning",
			summary: [] as any[],
			encrypted_content: reasoningData.encrypted_content,
			...(reasoningData.id ? { id: reasoningData.id } : {}),
		}

		prependContentBlock(messageWithTs, reasoningBlock)
	}

	if (thoughtSignature && !isAnthropicProtocol) {
		const thoughtSignatureBlock = {
			type: "thoughtSignature",
			thoughtSignature,
		}

		appendContentBlock(messageWithTs, thoughtSignatureBlock)
	}

	return messageWithTs
}

function prepareUserMessage(message: Anthropic.MessageParam, apiConversationHistory: ApiMessage[]): ApiMessage {
	const effectiveHistoryForValidation = getEffectiveApiHistory(apiConversationHistory)
	const lastEffective = effectiveHistoryForValidation[effectiveHistoryForValidation.length - 1]
	const historyForValidation = lastEffective?.role === "assistant" ? effectiveHistoryForValidation : []

	let messageToAdd = message
	if (lastEffective?.role !== "assistant" && Array.isArray(message.content)) {
		messageToAdd = {
			...message,
			content: message.content.map((block) =>
				block.type === "tool_result"
					? {
							type: "text" as const,
							text: `Tool result:\n${typeof block.content === "string" ? block.content : JSON.stringify(block.content)}`,
						}
					: block,
			),
		}
	}

	const validatedMessage = validateAndFixToolResultIds(messageToAdd, historyForValidation)
	return { ...validatedMessage, ts: Date.now() }
}

function prependContentBlock(message: any, block: any): void {
	if (typeof message.content === "string") {
		message.content = [block, { type: "text", text: message.content } satisfies Anthropic.Messages.TextBlockParam]
	} else if (Array.isArray(message.content)) {
		message.content = [block, ...message.content]
	} else if (!message.content) {
		message.content = [block]
	}
}

function appendContentBlock(message: any, block: any): void {
	if (typeof message.content === "string") {
		message.content = [{ type: "text", text: message.content } satisfies Anthropic.Messages.TextBlockParam, block]
	} else if (Array.isArray(message.content)) {
		message.content = [...message.content, block]
	} else if (!message.content) {
		message.content = [block]
	}
}
