import { Anthropic } from "@anthropic-ai/sdk"
import OpenAI from "openai"

import {
	type FriendliModelId,
	friendliDefaultModelId,
	friendliModels,
	type ModelInfo,
	openAiModelInfoSaneDefaults,
	providerIdentifiers,
} from "@roo-code/types"
import type { ModelRecord } from "@roo-code/types"

import type { ApiHandlerOptions } from "../../shared/api"
import { shouldUseReasoningEffort, getModelMaxOutputTokens } from "../../shared/api"

import { convertToOpenAiMessages } from "../transform/openai-format"
import { getModelParams } from "../transform/model-params"

import { BaseOpenAiCompatibleProvider } from "./base-openai-compatible-provider"
import { handleOpenAIError } from "./utils/error-handler"
import { getModels } from "./fetchers/modelCache"
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
 * Model list is dynamic: on construction the handler kicks off a fire-and-forget
 * fetch of the live model list from `https://api.friendli.ai/serverless/v1/models`
 * (public, no auth) via the shared `getModels` cache. `getModel()` falls back to
 * the static `friendliModels` map when dynamic models haven't loaded yet or when
 * the requested model id isn't present in the dynamic set (e.g. the API lags
 * behind a newly released model). This mirrors the OpenRouterHandler pattern.
 *
 * Overrides `createStream` and `completePrompt` to inject Friendli-specific
 * reasoning parameters that the base class doesn't know about.
 */
export class FriendliHandler extends BaseOpenAiCompatibleProvider<FriendliModelId> {
	/**
	 * Dynamically fetched model list (populated asynchronously after construction).
	 * Empty until the background load completes; `getModel()` falls back to the
	 * static `providerModels` (`friendliModels`) in that window.
	 */
	private dynamicModels: ModelRecord = {}

	/**
	 * Tracks whether the background `getModels()` fetch has settled. Until it
	 * does, `getModel()` preserves a configured `requestedId` even when it is
	 * absent from the static `friendliModels` map — dynamic-only models selected
	 * in the webview would otherwise silently fall back to the default model on
	 * the first request after handler construction. After loading completes, the
	 * normal fallback applies.
	 */
	private dynamicModelsLoaded = false

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
			providerModels: friendliModels as Record<FriendliModelId, ModelInfo>,
			defaultTemperature: 0.6,
		})

		// Load dynamic models asynchronously to populate the cache before
		// getModel() is called. Fire-and-forget; errors are logged by the
		// cache layer and we gracefully fall back to static models.
		getModels({ provider: providerIdentifiers.friendli })
			.then((models) => {
				this.dynamicModels = models
				this.dynamicModelsLoaded = true
			})
			.catch((error) => {
				this.dynamicModelsLoaded = true
				console.error("[FriendliHandler] Failed to load dynamic models:", error)
			})
	}

	override getModel() {
		const requestedId = this.options.apiModelId

		// Prefer dynamic info when available; fall back to static `providerModels`
		// (the hardcoded `friendliModels` passed to super) for cold-start, network
		// failure, or models not yet in the dynamic list.
		const dynamicInfo = requestedId ? this.dynamicModels[requestedId] : undefined
		const staticId =
			requestedId && requestedId in this.providerModels
				? (requestedId as FriendliModelId)
				: this.defaultProviderModelId
		const staticInfo = this.providerModels[staticId]

		// Determine which id/info pair to use.
		let id: FriendliModelId
		let info: ModelInfo
		if (dynamicInfo) {
			id = requestedId as FriendliModelId
			info = dynamicInfo
		} else if (requestedId && requestedId in this.providerModels) {
			id = requestedId as FriendliModelId
			info = staticInfo
		} else if (!this.dynamicModelsLoaded && requestedId) {
			// Dynamic load still in-flight and the requested id is dynamic-only
			// (not in the static map). Preserve the requested id so the first
			// request after construction goes to the model the user selected, not
			// the default. Use sane defaults (no reasoning, no cache, no max-tokens)
			// instead of the GLM-5.2 default model's metadata so that reasoning
			// params and max_tokens are not derived from the wrong model's capabilities.
			// Once the dynamic list arrives, getModel() returns the correct metadata.
			id = requestedId as FriendliModelId
			info = openAiModelInfoSaneDefaults
		} else {
			id = staticId
			info = staticInfo
		}

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
	 * - Controllable reasoning models (GLM-5.2): always send `chat_template_kwargs`.
	 *   User enabled → { enable_thinking: true } + reasoning_effort + parse_reasoning.
	 *   User disabled (none/disable) → { enable_thinking: false } to prevent the
	 *   model's Jinja template from defaulting thinking ON.
	 * - Boolean reasoning models (e.g. GLM-5.1, DeepSeek-V3.2, MiniMax-M2.5 from
	 *   the live /v1/models list): reasoning is on/off only — no reasoning_effort
	 *   enum. The handler sends { enable_thinking: true } + parse_reasoning when
	 *   enabled, or nothing when disabled. reasoning_effort is omitted because the
	 *   API doesn't accept it.
	 */
	private buildFriendliReasoningParams(model: {
		info: ModelInfo
		reasoningEffort?: string
	}): Partial<FriendliReasoningParams> {
		const { info: modelInfo, reasoningEffort } = model
		const extra: Partial<FriendliReasoningParams> = {}

		const isControllableReasoning = Array.isArray(modelInfo.supportsReasoningEffort)
		const isBinaryReasoning = !!modelInfo.supportsReasoningBinary

		const useReasoningEffort = modelInfo.supportsReasoningEffort
			? shouldUseReasoningEffort({ model: modelInfo, settings: this.options })
			: false

		// Binary reasoning toggle (no effort enum). These models accept
		// enable_thinking + parse_reasoning but not reasoning_effort.
		if (isBinaryReasoning && !isControllableReasoning) {
			if (this.options.enableReasoningEffort === false) {
				return extra // reasoning disabled — send nothing
			}
			extra.parse_reasoning = true
			extra.include_reasoning = true
			extra.chat_template_kwargs = { enable_thinking: true }
			return extra
		}

		// User disabled reasoning on a controllable model — explicitly turn thinking off.
		// The model's Jinja chat template defaults enable_thinking to true, so omitting
		// the param would leave reasoning active (burning tokens against user intent).
		if (isControllableReasoning && !useReasoningEffort) {
			extra.chat_template_kwargs = { enable_thinking: false }
			return extra
		}

		// Non-reasoning model — nothing to send.
		if (!useReasoningEffort) {
			return extra
		}

		// Reasoning is enabled (controllable model with effort enum)
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
		// Call getModel() once and reuse for both reasoning params and request
		// construction to avoid race conditions during dynamic model loading.
		const modelInfo = this.getModel()
		const friendliExtra = this.buildFriendliReasoningParams(modelInfo)

		const { id: model, info } = modelInfo

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
		const model = this.getModel()
		const { id: modelId } = model
		const friendliExtra = this.buildFriendliReasoningParams(model)

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
