import { Anthropic } from "@anthropic-ai/sdk"
import { createPoe, type PoeProvider, type PoeScopedProviderOptions } from "ai-sdk-provider-poe"
import { extractUsageMetrics, mapToolChoice } from "ai-sdk-provider-poe/code"
import { streamText, generateText, type ToolSet } from "ai"

import {
	poeDefaultModelId,
	getPoeDefaultModelInfo,
	type ModelInfo,
	type ModelRecord,
	type ReasoningEffortExtended,
	ApiProviderError,
	providerIdentifiers,
} from "@roo-code/types"
import { TelemetryService } from "@roo-code/telemetry"

import {
	shouldUseReasoningBudget,
	shouldUseReasoningEffort,
	type ApiHandlerOptions,
	type GetModelsOptions,
} from "../../shared/api"

import { convertToAiSdkMessages, convertToolsForAiSdk, processAiSdkStreamPart } from "../transform/ai-sdk"
import { ApiStream } from "../transform/stream"

import { BaseProvider } from "./base-provider"
import { NOT_PROVIDED } from "./constants"
import type {
	SingleCompletionHandler,
	ApiHandlerCreateMessageMetadata,
	CompletePromptOptions,
	ModelCacheScope,
} from "../index"
import { getModels, getModelsFromCache } from "./fetchers/modelCache"
import {
	bridgeExternalAbortSignal,
	createAbortError,
	hasUsableTimeout,
	mergeAbortSignalAndTimeout,
} from "./utils/abort-signal"
import { createTimeoutError } from "./utils/request-timeout"
import { getPoeModels } from "./fetchers/poe"

const DEFAULT_THINKING_BUDGET = 8192

export class PoeHandler extends BaseProvider implements SingleCompletionHandler {
	protected options: ApiHandlerOptions
	private poe: PoeProvider

	constructor(options: ApiHandlerOptions) {
		super()
		this.options = options
		this.poe = createPoe({
			apiKey: options.poeApiKey ?? NOT_PROVIDED,
			baseURL: options.poeBaseUrl || undefined,
		})
	}

	override getModelCacheScope(): ModelCacheScope {
		return { urlScoped: true, keyScoped: true, authScoped: false }
	}

	async fetchModels(options: GetModelsOptions, signal?: AbortSignal): Promise<ModelRecord> {
		const fetchOpts: [] | [{ signal: AbortSignal }] = signal ? [{ signal }] : []
		return getPoeModels(options.apiKey, options.baseUrl, ...fetchOpts)
	}

	async ensureModelFetched(signal?: AbortSignal): Promise<void> {
		await this.ensureCatalogLoaded(async () => {
			const models = await getModels(
				{
					provider: providerIdentifiers.poe,
					apiKey: this.options.poeApiKey,
					baseUrl: this.options.poeBaseUrl,
				},
				this,
			)
			// getModels() does not cache an empty response, so an empty catalog must
			// stay retryable instead of being memoized as a successful load.
			return Object.keys(models).length > 0
		}, signal)
	}

	override getModel() {
		const id = this.options.apiModelId ?? poeDefaultModelId
		const cached = getModelsFromCache(
			{
				provider: providerIdentifiers.poe,
				apiKey: this.options.poeApiKey,
				baseUrl: this.options.poeBaseUrl,
			},
			this,
		)
		const info: ModelInfo = cached?.[id] ?? getPoeDefaultModelInfo()
		return { id, info }
	}

	override async *createMessage(
		systemPrompt: string,
		messages: Anthropic.Messages.MessageParam[],
		metadata?: ApiHandlerCreateMessageMetadata,
	): ApiStream {
		// Bridge the external abort signal into a per-request signal: the AI SDK aborts the
		// underlying fetch when it fires. The shared bridge owns the pre-aborted guard, the
		// listener bookkeeping and the detach handle, so this provider reads like
		// anthropic.ts / xai.ts / minimax.ts instead of re-implementing the same bridge.
		// dispose() must run in finally: the listener lives on the caller's long-lived signal
		// and must not outlive a request that completes, fails, or exits early.
		const { signal: abortSignal, dispose: removeExternalAbortListener } = bridgeExternalAbortSignal(
			metadata?.abortSignal,
		)

		try {
			// The request was already aborted before we started: fail fast without calling the API.
			if (abortSignal?.aborted) {
				throw createAbortError("Poe")
			}

			const { id, info } = this.getModel()
			const languageModel = this.poe(id)
			const aiSdkMessages = convertToAiSdkMessages(messages)
			const openAiTools = this.convertToolsForOpenAI(metadata?.tools)
			const aiSdkTools = convertToolsForAiSdk(openAiTools) as ToolSet | undefined

			const useBudget = shouldUseReasoningBudget({ model: info, settings: this.options })
			const useEffort = !useBudget && shouldUseReasoningEffort({ model: info, settings: this.options })

			// Only pass temperature when the user explicitly configured it.
			let temperature: number | undefined = this.options.modelTemperature ?? undefined
			let maxOutputTokens: number | undefined
			const providerOptions: NonNullable<Parameters<typeof streamText>[0]["providerOptions"]> & {
				poe?: PoeScopedProviderOptions
			} = {}

			if (useBudget) {
				const requestedBudget = this.options.modelMaxThinkingTokens ?? DEFAULT_THINKING_BUDGET
				// maxOutputTokens is the text-only budget; reasoningBudgetTokens is
				// separate, so total output = maxOutputTokens + reasoningBudgetTokens.
				maxOutputTokens = this.options.modelMaxTokens ?? Math.max(0, (info.maxTokens ?? 0) - requestedBudget)
				providerOptions.poe = {
					reasoningBudgetTokens: requestedBudget,
				}
				temperature = 1.0
			} else if (useEffort) {
				let effort = (this.options.reasoningEffort ??
					info.reasoningEffort ??
					"medium") as ReasoningEffortExtended
				// Validate that the effort level is actually supported by the current model
				const supportedEfforts = info.supportsReasoningEffort
				// Stryker disable next-line ConditionalExpression,BlockStatement: shouldUseReasoningEffort already validated this effort against this capability array, and non-array capabilities fail the Array.isArray check, so this branch never executes
				if (Array.isArray(supportedEfforts) && !supportedEfforts.includes(effort as any)) {
					// Stryker disable next-line StringLiteral,LogicalOperator: the same shouldUseReasoningEffort gate guarantee makes this fallback unreachable
					effort = (info.reasoningEffort as ReasoningEffortExtended) ?? "medium"
				}
				providerOptions.poe = {
					reasoningEffort: effort,
					reasoningSummary: "auto",
				}
				if (this.options.modelMaxTokens) {
					maxOutputTokens = this.options.modelMaxTokens
				}
			}

			let result
			try {
				result = streamText({
					model: languageModel,
					system: systemPrompt,
					messages: aiSdkMessages,
					temperature,
					maxOutputTokens,
					tools: aiSdkTools,
					toolChoice: mapToolChoice(metadata?.tool_choice as any),
					...(Object.keys(providerOptions).length > 0 && { providerOptions }),
					abortSignal,
				})
			} catch (error) {
				// Aborted requests are user-initiated: surface them as AbortError instead of
				// a completion error.
				if (abortSignal?.aborted) {
					throw createAbortError("Poe")
				}
				const errorMessage = error instanceof Error ? error.message : String(error)
				TelemetryService.instance.captureException(
					new ApiProviderError(errorMessage, providerIdentifiers.poe, id, "createMessage"),
				)
				throw new Error(`Poe completion error: ${errorMessage}`)
			}

			try {
				for await (const part of result.fullStream) {
					for (const chunk of processAiSdkStreamPart(part)) {
						// Stop yielding once cancelled: a late chunk must not reach the caller.
						if (abortSignal?.aborted) {
							// Stryker disable next-line StringLiteral: this error is only thrown while the signal is already aborted, and the catch below rethrows the canonical abort error, so the message built here is never observable
							throw createAbortError("Poe")
						}
						yield chunk
					}
				}

				// Stop yielding once cancelled: do not await usage after the request was aborted.
				if (abortSignal?.aborted) {
					// Stryker disable next-line StringLiteral: this error is only thrown while the signal is already aborted, and the catch below rethrows the canonical abort error, so the message built here is never observable
					throw createAbortError("Poe")
				}
				const usage = await result.usage
				// Usage may resolve while the request is already aborted: reject instead of yielding it.
				if (abortSignal?.aborted) {
					// Stryker disable next-line StringLiteral: this error is only thrown while the signal is already aborted, and the catch below rethrows the canonical abort error, so the message built here is never observable
					throw createAbortError("Poe")
				}
				if (usage) {
					const metrics = extractUsageMetrics(usage as any)
					yield {
						type: "usage" as const,
						inputTokens: metrics.inputTokens,
						outputTokens: metrics.outputTokens,
						cacheReadTokens: metrics.cacheReadTokens,
						cacheWriteTokens: metrics.cacheWriteTokens,
						reasoningTokens: metrics.reasoningTokens,
					}
				}
			} catch (error) {
				// Aborted requests are user-initiated: surface them as AbortError instead of
				// a completion error.
				if (abortSignal?.aborted) {
					throw createAbortError("Poe")
				}
				const errorMessage = error instanceof Error ? error.message : String(error)
				TelemetryService.instance.captureException(
					new ApiProviderError(errorMessage, providerIdentifiers.poe, id, "createMessage"),
				)
				throw new Error(`Poe streaming error: ${errorMessage}`)
			}
		} finally {
			// Detach on every exit path - completion, failure, abort, or the caller closing the
			// generator. The listener lives on the caller's long-lived signal and would outlive this
			// request otherwise.
			removeExternalAbortListener()
		}
	}

	async completePrompt(prompt: string, options?: CompletePromptOptions): Promise<string> {
		const { id } = this.getModel()
		// Backward compatible with callers that pass no options: only a caller-supplied timeout
		// bounds the request (timeoutMs <= 0 disables it). The configured provider request timeout
		// is NOT applied here, matching the pre-PR behavior of this method.
		const callerAbortSignal = options?.abortSignal
		// The timeout decision is taken once, here, and the classification below reads this
		// local rather than options.timeoutMs: the caller still holds that object and can
		// rewrite timeoutMs while the request is in flight, which would otherwise make our
		// own fired TimeoutError read as a plain caller abort.
		const configuredTimeoutUsable = hasUsableTimeout(options?.timeoutMs)
		const mergedAbortSignal = mergeAbortSignalAndTimeout(callerAbortSignal, options?.timeoutMs)
		// The shared timeout error keeps the series contract (name TimeoutError, distinct from the
		// abort contract) instead of a provider-local closure, as mistral.ts and gemini.ts do.
		// The merged signal keeps the FIRST abort reason. A timeout that fires before the caller
		// aborts must stay a TimeoutError even if the caller signal aborts before the late result
		// settles, so classify by the signal's reason rather than the caller signal's later state.
		// A reason named TimeoutError is not proof of our own deadline: AbortSignal.timeout()
		// produces exactly that reason, so a caller that passes a timeout signal without
		// timeoutMs would otherwise be reported as this provider timing out. The reading is
		// sound only when this method configured a timeout, so a caller-only timeout abort
		// stays on the AbortError contract. Where a caller timeout signal and our own
		// timeoutMs both exist the two reasons are indistinguishable and the timeout reading
		// wins, which is the series contract.
		const abortedByTimeout = () =>
			Boolean(mergedAbortSignal?.aborted) &&
			configuredTimeoutUsable &&
			(mergedAbortSignal?.reason as { name?: string } | undefined)?.name === "TimeoutError"
		let text: string
		try {
			text = (
				await generateText({
					model: this.poe(id),
					prompt,
					...(mergedAbortSignal && { abortSignal: mergedAbortSignal }),
				})
			).text
		} catch (error) {
			// A caller abort is user-initiated: surface it as the contract AbortError and do not
			// report it as a provider failure. A per-request timeout that the caller's signal did
			// not cause is surfaced as the distinct TimeoutError (the series contract), also
			// without a telemetry capture.
			if (mergedAbortSignal?.aborted) {
				if (abortedByTimeout()) {
					throw createTimeoutError("Poe", "completion request")
				}
				throw createAbortError("Poe")
			}
			const errorMessage = error instanceof Error ? error.message : String(error)
			TelemetryService.instance.captureException(
				new ApiProviderError(errorMessage, providerIdentifiers.poe, id, "completePrompt"),
			)
			throw new Error(`Poe completion error: ${errorMessage}`)
		}

		// The response resolved after the request was cancelled: do not return the late result.
		// This check lives after the catch on purpose - a cancellation error raised inside the try
		// would be caught below and replaced by an identical one, which makes the error built here
		// unobservable to tests (and to callers who inspect it).
		if (mergedAbortSignal?.aborted) {
			if (abortedByTimeout()) {
				throw createTimeoutError("Poe", "completion request")
			}
			throw createAbortError("Poe")
		}
		return text
	}
}
