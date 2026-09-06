import { Anthropic } from "@anthropic-ai/sdk"
import { createPoe, type PoeProvider, type PoeScopedProviderOptions } from "ai-sdk-provider-poe"
import { extractUsageMetrics, mapToolChoice } from "ai-sdk-provider-poe/code"
import { streamText, generateText, type ToolSet } from "ai"

import {
	poeDefaultModelId,
	getPoeDefaultModelInfo,
	type ModelInfo,
	type ReasoningEffortExtended,
	ApiProviderError,
	providerIdentifiers,
} from "@roo-code/types"
import { TelemetryService } from "@roo-code/telemetry"

import { shouldUseReasoningBudget, shouldUseReasoningEffort, type ApiHandlerOptions } from "../../shared/api"

import { convertToAiSdkMessages, convertToolsForAiSdk, processAiSdkStreamPart } from "../transform/ai-sdk"
import { ApiStream } from "../transform/stream"

import { BaseProvider } from "./base-provider"
import { NOT_PROVIDED } from "./constants"
import type { SingleCompletionHandler, ApiHandlerCreateMessageMetadata, CompletePromptOptions } from "../index"
import { getModelsFromCache } from "./fetchers/modelCache"
import { createAbortError, mergeAbortSignalAndTimeout } from "./utils/abort-signal"

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

	override getModel() {
		const id = this.options.apiModelId ?? poeDefaultModelId
		const cached = getModelsFromCache({
			provider: providerIdentifiers.poe,
			apiKey: this.options.poeApiKey,
			baseUrl: this.options.poeBaseUrl,
		})
		const info: ModelInfo = cached?.[id] ?? getPoeDefaultModelInfo()
		return { id, info }
	}

	override async *createMessage(
		systemPrompt: string,
		messages: Anthropic.Messages.MessageParam[],
		metadata?: ApiHandlerCreateMessageMetadata,
	): ApiStream {
		// Per-request AbortController: external aborts cancel the in-flight AI SDK request
		// (the AI SDK aborts the underlying fetch when its abortSignal fires).
		const controller = new AbortController()

		// Bridge the external abort signal into the per-request controller:
		// - pre-aborted guard: abort immediately when the signal is already aborted
		// - { once: true }: the listener removes itself after the first abort
		// - explicit removal in finally: the listener must not outlive a request that
		//   completes (or fails) without being aborted
		const externalAbortSignal = metadata?.abortSignal
		let removeExternalAbortListener: (() => void) | undefined
		if (externalAbortSignal) {
			if (externalAbortSignal.aborted) {
				controller.abort()
			} else {
				const onExternalAbort = () => controller.abort()
				// Stryker disable next-line ObjectLiteral,BooleanLiteral: an AbortSignal fires its "abort" event at most once and the finally block removes this listener explicitly, so the once flag is unobservable
				externalAbortSignal.addEventListener("abort", onExternalAbort, { once: true })
				removeExternalAbortListener = () => externalAbortSignal.removeEventListener("abort", onExternalAbort)
			}
		}

		try {
			// The request was already aborted before we started: fail fast without calling the API.
			if (controller.signal.aborted) {
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
					abortSignal: controller.signal,
				})
			} catch (error) {
				// Aborted requests are user-initiated: surface them as AbortError instead of
				// a completion error.
				if (controller.signal.aborted) {
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
						if (controller.signal.aborted) {
							// Stryker disable next-line StringLiteral: this error is only thrown while the signal is already aborted, and the catch below rethrows the canonical abort error, so the message built here is never observable
							throw createAbortError("Poe")
						}
						yield chunk
					}
				}

				// Stop yielding once cancelled: do not await usage after the request was aborted.
				if (controller.signal.aborted) {
					// Stryker disable next-line StringLiteral: this error is only thrown while the signal is already aborted, and the catch below rethrows the canonical abort error, so the message built here is never observable
					throw createAbortError("Poe")
				}
				const usage = await result.usage
				// Usage may resolve while the request is already aborted: reject instead of yielding it.
				if (controller.signal.aborted) {
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
				if (controller.signal.aborted) {
					throw createAbortError("Poe")
				}
				const errorMessage = error instanceof Error ? error.message : String(error)
				TelemetryService.instance.captureException(
					new ApiProviderError(errorMessage, providerIdentifiers.poe, id, "createMessage"),
				)
				throw new Error(`Poe streaming error: ${errorMessage}`)
			}
		} finally {
			removeExternalAbortListener?.()
		}
	}

	async completePrompt(prompt: string, options?: CompletePromptOptions): Promise<string> {
		const { id } = this.getModel()
		// Merge the caller's abort signal with the per-request timeout (timeoutMs <= 0 disables it).
		const mergedAbortSignal = mergeAbortSignalAndTimeout(options?.abortSignal, options?.timeoutMs)
		try {
			const { text } = await generateText({
				model: this.poe(id),
				prompt,
				...(mergedAbortSignal && { abortSignal: mergedAbortSignal }),
			})

			if (mergedAbortSignal?.aborted) {
				// The response resolved after the request was aborted: do not return the late result.
				// Stryker disable next-line StringLiteral: this late-result error is always caught by the catch below, which rethrows the canonical abort error while the signal is still aborted, so the message built here is never observable
				throw createAbortError("Poe")
			}
			return text
		} catch (error) {
			// Aborted requests are user-initiated: surface them as AbortError (this also covers
			// timeouts, which abort the same signal) instead of a completion error.
			if (mergedAbortSignal?.aborted) {
				throw createAbortError("Poe")
			}
			const errorMessage = error instanceof Error ? error.message : String(error)
			TelemetryService.instance.captureException(
				new ApiProviderError(errorMessage, providerIdentifiers.poe, id, "completePrompt"),
			)
			throw new Error(`Poe completion error: ${errorMessage}`)
		}
	}
}
