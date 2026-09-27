import { Anthropic } from "@anthropic-ai/sdk"
import OpenAI from "openai"

import { type FriendliModelId, friendliDefaultModelId, friendliModels } from "@roo-code/types"

import type { ApiHandlerOptions } from "../../shared/api"
import { shouldUseReasoningEffort, getModelMaxOutputTokens } from "../../shared/api"

import { convertToOpenAiMessages } from "../transform/openai-format"
import { getModelParams } from "../transform/model-params"

import { BaseOpenAiCompatibleProvider } from "./base-openai-compatible-provider"
import { handleOpenAIError } from "./utils/error-handler"
import type { ApiHandlerCreateMessageMetadata, CompletePromptOptions } from "../index"

/**
 * Friendli extends the OpenAI Chat Completions API with these non-standard fields:
 * - reasoning_effort: enum (minimal, low, medium, high, xhigh, max) — reasoning depth
 * - chat_template_kwargs: { enable_thinking: boolean } — toggles thinking for controllable models
 * - parse_reasoning / include_reasoning: when true, Friendli streams reasoning via
 *   delta.reasoning_content (which extractReasoningFromDelta already handles)
 * - reasoning_budget: integer token budget (not currently surfaced in settings UI)
 *
 * The reasoning fields are shared across streaming and non-streaming requests; the base
 * `ChatCompletionCreateParams` (non-streaming) variant is used for `completePrompt` while the
 * `ChatCompletionCreateParamsStreaming` variant is used for `createStream`.
 */
type FriendliReasoningParams = {
	chat_template_kwargs?: { enable_thinking: boolean }
	parse_reasoning?: boolean
	include_reasoning?: boolean
	// Friendli's reasoning_effort supports a broader enum than OpenAI's type allows
	reasoning_effort?:
		| OpenAI.Chat.Completions.ChatCompletionCreateParams["reasoning_effort"]
		| "minimal"
		| "xhigh"
		| "max"
}

type FriendliChatCompletionParams = Omit<
	OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming,
	"reasoning_effort"
> &
	FriendliReasoningParams

type FriendliChatCompletionNonStreamingParams = Omit<
	OpenAI.Chat.Completions.ChatCompletionCreateParams,
	"reasoning_effort"
> &
	FriendliReasoningParams

/**
 * Handler for the Friendli Model APIs (OpenAI-compatible).
 * Routes chat completions to `https://api.friendli.ai/serverless/v1`.
 *
 * Overrides `createStream` and `completePrompt` to inject Friendli-specific
 * reasoning parameters that the base class doesn't know about.
 */
export class FriendliHandler extends BaseOpenAiCompatibleProvider<FriendliModelId> {
	/**
	 * @param options  Provider settings; `friendliApiKey` is required.
	 */
	constructor(options: ApiHandlerOptions) {
		super({
			...options,
			providerName: "Friendli",
			baseURL: "https://api.friendli.ai/serverless/v1",
			apiKey: options.friendliApiKey,
			defaultProviderModelId: friendliDefaultModelId,
			providerModels: friendliModels,
			defaultTemperature: 0.6,
		})
	}

	override getModel() {
		const id =
			this.options.apiModelId && this.options.apiModelId in this.providerModels
				? (this.options.apiModelId as FriendliModelId)
				: this.defaultProviderModelId

		const info = this.providerModels[id]
		const params = getModelParams({
			format: "openai",
			modelId: id,
			model: info,
			settings: this.options,
			defaultTemperature: 0.6,
		})

		return { id, info, ...params }
	}

	/**
	 * Build Friendli-specific reasoning params to merge into the OpenAI request.
	 *
	 * Rules:
	 * - Controllable reasoning models (GLM-5.x): always send `chat_template_kwargs`.
	 *   User enabled → { enable_thinking: true } + reasoning_effort + parse_reasoning.
	 *   User disabled (none/disable) → { enable_thinking: false } to prevent the
	 *   model's Jinja template from defaulting thinking ON.
	 * - Non-reasoning models (DeepSeek-V3.2, MiniMax-M2.5): no extra params
	 *   (reasoning_effort silently ignored).
	 */
	private buildFriendliReasoningParams(): Partial<FriendliReasoningParams> {
		const { info: modelInfo, reasoningEffort } = this.getModel()
		const extra: Partial<FriendliReasoningParams> = {}

		const isControllableReasoning = Array.isArray(modelInfo.supportsReasoningEffort)

		const useReasoningEffort = modelInfo.supportsReasoningEffort
			? shouldUseReasoningEffort({ model: modelInfo, settings: this.options })
			: false

		// User disabled reasoning on a controllable model — explicitly turn thinking off.
		// The model's Jinja chat template defaults enable_thinking to true, so omitting
		// the param would leave reasoning active (burning tokens against user intent).
		if (isControllableReasoning && !useReasoningEffort) {
			extra.chat_template_kwargs = { enable_thinking: false }
			return extra
		}

		// Non-reasoning model — nothing to send
		if (!useReasoningEffort) {
			return extra
		}

		// Reasoning is enabled
		extra.parse_reasoning = true
		extra.include_reasoning = true
		extra.chat_template_kwargs = { enable_thinking: true }

		if (reasoningEffort) {
			extra.reasoning_effort = reasoningEffort as FriendliReasoningParams["reasoning_effort"]
		}

		return extra
	}

	/**
	 * Override createStream to inject Friendli-specific reasoning params.
	 * The base class createMessage() calls createStream and handles all stream
	 * processing (TagMatcher, extractReasoningFromDelta, tool calls, usage).
	 */
	protected override createStream(
		systemPrompt: string,
		messages: Anthropic.Messages.MessageParam[],
		metadata?: ApiHandlerCreateMessageMetadata,
		requestOptions?: OpenAI.RequestOptions,
	) {
		const friendliExtra = this.buildFriendliReasoningParams()

		const { id: model, info } = this.getModel()

		// Centralized cap: clamp to 20% of the context window
		const max_tokens =
			getModelMaxOutputTokens({
				modelId: model,
				model: info,
				settings: this.options,
				format: "openai",
			}) ?? undefined

		const temperature = this.options.modelTemperature ?? info.defaultTemperature ?? this.defaultTemperature

		const params: FriendliChatCompletionParams = {
			model,
			max_tokens,
			temperature,
			messages: [{ role: "system", content: systemPrompt }, ...convertToOpenAiMessages(messages)],
			stream: true,
			stream_options: { include_usage: true },
			tools: this.convertToolsForOpenAI(metadata?.tools),
			tool_choice: metadata?.tool_choice,
			parallel_tool_calls: metadata?.parallelToolCalls ?? true,
			...friendliExtra,
		}

		try {
			return this.client.chat.completions.create(
				params as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming,
				requestOptions,
			)
		} catch (error) {
			throw handleOpenAIError(error, this.providerName)
		}
	}

	override async completePrompt(prompt: string, options?: CompletePromptOptions): Promise<string> {
		const { id: modelId } = this.getModel()
		const friendliExtra = this.buildFriendliReasoningParams()

		const params: FriendliChatCompletionNonStreamingParams = {
			model: modelId,
			messages: [{ role: "user", content: prompt }],
			...friendliExtra,
		}

		try {
			const requestOptions: OpenAI.RequestOptions | undefined =
				options && (options.abortSignal !== undefined || options.timeoutMs !== undefined)
					? { signal: options.abortSignal, timeout: options.timeoutMs }
					: undefined
			const response = (await this.client.chat.completions.create(
				params as OpenAI.Chat.Completions.ChatCompletionCreateParams,
				requestOptions,
			)) as OpenAI.Chat.Completions.ChatCompletion
			return response.choices?.[0]?.message.content || ""
		} catch (error) {
			throw handleOpenAIError(error, this.providerName)
		}
	}
}
