import { Anthropic } from "@anthropic-ai/sdk"
import OpenAI from "openai"

import {
	internationalZAiDefaultModelId,
	mainlandZAiDefaultModelId,
	type ModelInfo,
	ZAI_DEFAULT_TEMPERATURE,
	zaiApiLineConfigs,
	getZAiModels,
} from "@roo-code/types"

import { type ApiHandlerOptions, getModelMaxOutputTokens } from "../../shared/api"
import { convertToZAiFormat } from "../transform/zai-format"

import type { ApiHandlerCreateMessageMetadata, CompletePromptOptions } from "../index"
import { BaseOpenAiCompatibleProvider } from "./base-openai-compatible-provider"
import { NOT_PROVIDED } from "./constants"
import { handleOpenAIError } from "./utils/error-handler"

// Custom interface for Z.ai params to support thinking mode and reasoning effort tiers.
// Z.ai accepts the standard `reasoning_effort` ladder (none/minimal/low/medium/high/xhigh/max)
// alongside the GLM-specific `thinking` toggle. Omit the OpenAI-typed `reasoning_effort` so we
// can widen it to include provider-specific values such as "max".
type ZAiChatCompletionParams = Omit<OpenAI.Chat.ChatCompletionCreateParams, "reasoning_effort"> & {
	thinking?: { type: "enabled" | "disabled"; clear_thinking?: boolean }
	reasoning_effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
}

const isGlm53Model = (model: string) => model === "glm-5.3" || model === "glm-5.3-flash"

export class ZAiHandler extends BaseOpenAiCompatibleProvider<string> {
	constructor(options: ApiHandlerOptions) {
		const apiLine = options.zaiApiLine ?? "international_coding"
		const isChina = zaiApiLineConfigs[apiLine].isChina
		const models = getZAiModels(apiLine)
		const defaultModelId = (isChina ? mainlandZAiDefaultModelId : internationalZAiDefaultModelId) as string

		super({
			...options,
			providerName: "Z.ai",
			baseURL: zaiApiLineConfigs[apiLine].baseUrl,
			apiKey: options.zaiApiKey ?? NOT_PROVIDED,
			defaultProviderModelId: defaultModelId,
			providerModels: models,
			defaultTemperature: ZAI_DEFAULT_TEMPERATURE,
		})
	}

	/**
	 * Override createStream to handle GLM thinking-capable models.
	 * These models have thinking enabled by default in the API, so we need to
	 * explicitly send { type: "disabled" } when the user turns off reasoning.
	 */
	protected override createStream(
		systemPrompt: string,
		messages: Anthropic.Messages.MessageParam[],
		metadata?: ApiHandlerCreateMessageMetadata,
		requestOptions?: OpenAI.RequestOptions,
	) {
		const { id: modelId, info } = this.getModel()

		// Check if this is a model with thinking support (e.g. GLM-4.7, GLM-5)
		const isThinkingModel = Array.isArray(info.supportsReasoningEffort)

		if (isThinkingModel) {
			// Create the stream with our custom thinking parameter
			return this.createStreamWithThinking(systemPrompt, messages, metadata)
		}

		// For non-thinking models, use the default behavior
		return super.createStream(systemPrompt, messages, metadata, requestOptions)
	}

	/**
	 * Creates a stream with explicit thinking control for GLM thinking-capable models.
	 */
	private createStreamWithThinking(
		systemPrompt: string,
		messages: Anthropic.Messages.MessageParam[],
		metadata?: ApiHandlerCreateMessageMetadata,
	) {
		const { id: model, info } = this.getModel()
		const { reasoningEffort, useReasoning } = this.getReasoningSettings(info)

		const max_tokens =
			this.options.modelMaxTokens ||
			(getModelMaxOutputTokens({
				modelId: model,
				model: info,
				settings: this.options,
				format: "openai",
			}) ??
				undefined)

		const temperature = this.options.modelTemperature ?? info.defaultTemperature ?? this.defaultTemperature

		// Use Z.ai format to preserve reasoning_content and merge post-tool text into tool messages
		const convertedMessages = convertToZAiFormat(messages, { mergeToolResultText: true })

		const params: ZAiChatCompletionParams = {
			model,
			max_tokens,
			temperature,
			messages: [{ role: "system", content: systemPrompt }, ...convertedMessages],
			stream: true,
			stream_options: { include_usage: true },
			// Models with required reasoning stay enabled even when an old setting requests disable.
			thinking: useReasoning
				? { type: "enabled", ...(isGlm53Model(model) && { clear_thinking: false }) }
				: { type: "disabled" },
			reasoning_effort: reasoningEffort,
			tools: this.convertToolsForOpenAI(metadata?.tools),
			tool_choice: metadata?.tool_choice,
			parallel_tool_calls: metadata?.parallelToolCalls ?? true,
		}

		try {
			return this.client.chat.completions.create(
				params as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming,
			)
		} catch (error) {
			throw handleOpenAIError(error, this.providerName)
		}
	}

	private getReasoningSettings(info: ModelInfo) {
		// Fall back to the model default when the resolved effort isn't supported by the model.
		const supported = info.supportsReasoningEffort
		const raw =
			this.options.enableReasoningEffort === false
				? undefined
				: (this.options.reasoningEffort ?? info.reasoningEffort)
		const requiresReasoning = info.requiredReasoningEffort === true
		const effort =
			requiresReasoning && (!raw || raw === "disable")
				? info.reasoningEffort
				: raw && Array.isArray(supported) && !supported.includes(raw)
					? info.reasoningEffort
					: raw
		const reasoningEffort = effort && effort !== "disable" ? effort : undefined

		return { reasoningEffort, useReasoning: requiresReasoning || reasoningEffort !== undefined }
	}

	override async completePrompt(prompt: string, options?: CompletePromptOptions): Promise<string> {
		const { id: model, info } = this.getModel()
		if (!isGlm53Model(model)) {
			return super.completePrompt(prompt, options)
		}

		const { reasoningEffort } = this.getReasoningSettings(info)
		const params: ZAiChatCompletionParams = {
			model,
			messages: [{ role: "user", content: prompt }],
			temperature: this.options.modelTemperature ?? info.defaultTemperature ?? this.defaultTemperature,
			thinking: { type: "enabled", clear_thinking: false },
			reasoning_effort: reasoningEffort,
		}

		try {
			const response = await this.client.chat.completions.create(
				params as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
			)
			return response.choices?.[0]?.message.content || ""
		} catch (error) {
			throw handleOpenAIError(error, this.providerName)
		}
	}
}
