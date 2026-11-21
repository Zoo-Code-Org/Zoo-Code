import { Anthropic } from "@anthropic-ai/sdk"
import OpenAI from "openai"

import {
	type FriendliModelId,
	type ModelRecord,
	friendliDefaultModelId,
	friendliModels,
	openAiModelInfoSaneDefaults,
	providerIdentifiers,
} from "@roo-code/types"

import type { ApiHandlerOptions, GetModelsOptions } from "../../shared/api"
import { shouldUseReasoningEffort, getModelMaxOutputTokens } from "../../shared/api"

import { convertToOpenAiMessages } from "../transform/openai-format"
import { getModelParams } from "../transform/model-params"

import { BaseOpenAiCompatibleProvider } from "./base-openai-compatible-provider"
import { handleOpenAIError } from "./utils/error-handler"
import {
	bridgeExternalAbortSignal,
	createAbortError,
	createTimeoutError,
	hasUsableTimeout,
	isRequestAborted,
	isTimeoutAbort,
	mergeAbortSignalAndTimeout,
	toSdkTimeoutMs,
} from "./utils/abort-signal"
import { NOT_PROVIDED } from "./constants"
import { getModels } from "./fetchers/modelCache"
import { getFriendliModels } from "./fetchers/friendli"
import type { ApiStream } from "../transform/stream"
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
		OpenAI.Chat.Completions.ChatCompletionCreateParams["reasoning_effort"] | "minimal" | "xhigh" | "max"
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
	private models: ModelRecord = Object.create(null)

	constructor(options: ApiHandlerOptions) {
		super({
			...options,
			providerName: "Friendli",
			baseURL: "https://api.friendli.ai/serverless/v1",
			apiKey: options.friendliApiKey || NOT_PROVIDED,
			defaultProviderModelId: friendliDefaultModelId,
			providerModels: friendliModels,
			defaultTemperature: 0.6,
		})
	}

	/** Loads the fetched catalog so task preparation reads its context window before any request. */
	async ensureModelFetched(signal?: AbortSignal): Promise<void> {
		await this.ensureCatalogLoaded(async () => {
			this.models = await getModels({ provider: providerIdentifiers.friendli }, this)
			// getModels() does not cache an empty response, so keep it retryable.
			return Object.keys(this.models).length > 0
		}, signal)
	}

	/**
	 * Waits for the catalog before a request. A failed load keeps the static `friendliModels`
	 * fallback; a cancelled or timed-out wait rejects so no request starts.
	 */
	private async waitForCatalog(abortSignal?: AbortSignal, timeoutMs?: number): Promise<void> {
		const signal = mergeAbortSignalAndTimeout(abortSignal, timeoutMs)
		try {
			await this.ensureModelFetched(signal)
		} catch {
			// Classified below: only a cut-short wait is fatal.
		}
		if (isTimeoutAbort(signal)) throw createTimeoutError(this.providerName)
		if (signal?.aborted) throw createAbortError(this.providerName)
	}

	override async *createMessage(
		systemPrompt: string,
		messages: Anthropic.Messages.MessageParam[],
		metadata?: ApiHandlerCreateMessageMetadata,
	): ApiStream {
		await this.waitForCatalog(metadata?.abortSignal)
		// The SDK never removes its listener from the signal it receives, so hand it a
		// per-request signal and detach that from the caller's long-lived one when the stream ends.
		const { signal, dispose } = bridgeExternalAbortSignal(metadata?.abortSignal)
		try {
			yield* super.createMessage(systemPrompt, messages, metadata && { ...metadata, abortSignal: signal })
		} catch (error) {
			// The SDK's abort error is not the AbortError contract callers check for.
			if (isRequestAborted(error, signal)) throw createAbortError(this.providerName)
			throw error
		} finally {
			dispose()
		}
	}

	async fetchModels(_options: GetModelsOptions, signal?: AbortSignal): Promise<ModelRecord> {
		return getFriendliModels({ signal })
	}

	override getModel() {
		const id = (this.options.apiModelId || this.defaultProviderModelId) as FriendliModelId
		// Own-property reads: the cached catalog may come back as a plain object, so an ID
		// such as "toString" must not resolve to an inherited member.
		const info =
			(Object.hasOwn(this.models, id) ? this.models[id] : undefined) ??
			(Object.hasOwn(this.providerModels, id) ? this.providerModels[id] : undefined) ??
			openAiModelInfoSaneDefaults
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
	 * - Toggle-only models (`supportsReasoningBinary`, e.g. GLM-5.1, Gemma): send
	 *   `enable_thinking` from the on/off setting and never a reasoning_effort.
	 */
	private buildFriendliReasoningParams(): Partial<FriendliReasoningParams> {
		const { info: modelInfo, reasoningEffort } = this.getModel()
		const extra: Partial<FriendliReasoningParams> = {}

		if (modelInfo.supportsReasoningBinary && !modelInfo.supportsReasoningEffort) {
			if (!this.options.enableReasoningEffort) {
				// The chat template defaults thinking on, so "off" must be explicit.
				extra.chat_template_kwargs = { enable_thinking: false }
				return extra
			}
			extra.parse_reasoning = true
			extra.include_reasoning = true
			extra.chat_template_kwargs = { enable_thinking: true }
			return extra
		}

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

		const signal = metadata?.abortSignal
		try {
			return this.client.chat.completions.create(
				params as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming,
				requestOptions ?? (signal ? { signal } : undefined),
			)
		} catch (error) {
			throw handleOpenAIError(error, this.providerName)
		}
	}

	override async completePrompt(prompt: string, options?: CompletePromptOptions): Promise<string> {
		// The catalog wait and the completion share one deadline, started before the wait.
		const timeoutMs = options?.timeoutMs
		const deadline = hasUsableTimeout(timeoutMs) ? Date.now() + timeoutMs : undefined
		await this.waitForCatalog(options?.abortSignal, timeoutMs)
		const remainingMs = deadline === undefined ? undefined : deadline - Date.now()
		if (remainingMs !== undefined && remainingMs <= 0) throw createTimeoutError(this.providerName)
		const { id: modelId } = this.getModel()
		const friendliExtra = this.buildFriendliReasoningParams()

		const params: FriendliChatCompletionNonStreamingParams = {
			model: modelId,
			messages: [{ role: "user", content: prompt }],
			...friendliExtra,
		}

		// Per-request signal: the SDK never removes its listener (see createMessage).
		const { signal, dispose } = bridgeExternalAbortSignal(options?.abortSignal)
		try {
			// The OpenAI SDK rejects a present-but-undefined or unusable `timeout`, so
			// only forward a real value, rounded and capped like mergeAbortSignalAndTimeout.
			const requestOptions: OpenAI.RequestOptions = {}
			if (signal !== undefined) {
				requestOptions.signal = signal
			}
			if (remainingMs !== undefined) {
				requestOptions.timeout = toSdkTimeoutMs(remainingMs)
			}
			const response = (await this.client.chat.completions.create(
				params as OpenAI.Chat.Completions.ChatCompletionCreateParams,
				Object.keys(requestOptions).length > 0 ? requestOptions : undefined,
			)) as OpenAI.Chat.Completions.ChatCompletion
			return response.choices?.[0]?.message.content || ""
		} catch (error) {
			throw handleOpenAIError(error, this.providerName)
		} finally {
			dispose()
		}
	}
}
