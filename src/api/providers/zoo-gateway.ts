import * as vscode from "vscode"
import { Anthropic } from "@anthropic-ai/sdk"
import OpenAI, { APIConnectionTimeoutError } from "openai"

import {
	zooGatewayDefaultModelId,
	zooGatewayDefaultModelInfo,
	ZOO_GATEWAY_DEFAULT_TEMPERATURE,
	VERCEL_AI_GATEWAY_PROMPT_CACHING_MODELS,
	providerIdentifiers,
	type ModelRecord,
} from "@roo-code/types"

import { ApiHandlerOptions, GetModelsOptions } from "../../shared/api"
import { clearZooCodeToken, getZooCodeBaseUrl, resolveZooGatewaySessionToken } from "../../services/zoo-code-auth"
import { Package } from "../../shared/package"
import { t } from "../../i18n"

import { ApiStream } from "../transform/stream"
import { convertToOpenAiMessages } from "../transform/openai-format"
import { addCacheBreakpoints } from "../transform/caching/vercel-ai-gateway"
import { resolveCacheTtl } from "../transform/caching/ttl"

import type {
	SingleCompletionHandler,
	ApiHandlerCreateMessageMetadata,
	CompletePromptOptions,
	ModelCacheScope,
} from "../index"
import { NOT_PROVIDED } from "./constants"
import { RouterProvider } from "./router-provider"
import { getZooGatewayModels } from "./fetchers/zoo-gateway"
import {
	bridgeExternalAbortSignal,
	createAbortError,
	hasUsableTimeout,
	isRequestAborted,
	mergeAbortSignalAndTimeout,
	rejectOnAbort,
	settleOnAbort,
	throwIfAborted,
	resolveModelWithAbort,
	toSdkTimeoutMs,
} from "./utils/abort-signal"

const ZOO_GATEWAY_PROVIDER_NAME = "Zoo Gateway"

function getApiErrorStatus(error: unknown): number | undefined {
	if (typeof error === "object" && error !== null && "status" in error) {
		const status = (error as { status: unknown }).status
		if (typeof status === "number") return status
	}
	return undefined
}

function getApiErrorCode(error: unknown): string | undefined {
	const err = error as { code?: unknown; error?: { code?: unknown } } | null
	if (!err) return undefined
	if (typeof err.code === "string") return err.code
	if (typeof err.error?.code === "string") return err.error.code
	return undefined
}

// The gateway sends in-band stream errors as `{ message, status?, code? }`. Rebuild
// them into an Error carrying status/code so the same classify/surface logic that
// handles thrown HTTP errors applies to mid-stream failures too.
// Exported for unit tests.
export function toGatewayStreamError(raw: unknown): Error {
	const err = raw as { message?: unknown; status?: unknown; code?: unknown } | null
	const message =
		typeof err?.message === "string" && err.message.length > 0 ? err.message : "Zoo Gateway stream error"
	return Object.assign(new Error(message), {
		status: typeof err?.status === "number" ? err.status : undefined,
		code: typeof err?.code === "string" ? err.code : undefined,
	})
}

function buildZooCodeSignInUrl(): string {
	const callbackUri = encodeURIComponent(
		`${vscode.env.uriScheme}://${Package.publisher}.${Package.name}/auth-callback`,
	)
	const device = encodeURIComponent(vscode.env.appName || "VS Code")
	const editor = encodeURIComponent("VS Code")
	return `${getZooCodeBaseUrl()}/dashboard/connect?device=${device}&editor=${editor}&version=${Package.version}&callback_uri=${callbackUri}`
}

type ZooGatewayApiErrorAction =
	| { kind: "sign_in" }
	| { kind: "add_credits"; budgetExceeded: boolean }
	| { kind: "contact_support" }
	| { kind: "none" }

// Pure mapping from an API error to the UX action it warrants. No side effects,
// so this is trivial to unit test independently of the VS Code notification flow.
// Exported for unit tests.
export function classifyGatewayApiError(error: unknown): ZooGatewayApiErrorAction {
	const status = getApiErrorStatus(error)
	if (status === undefined) return { kind: "none" }
	const code = getApiErrorCode(error)

	if (status === 401) {
		return { kind: "sign_in" }
	}

	const isBudgetExceeded = status === 429 && (code === "monthly_budget_exceeded" || code === "daily_budget_exceeded")
	if (status === 402 || isBudgetExceeded) {
		return { kind: "add_credits", budgetExceeded: isBudgetExceeded }
	}

	if (status === 403) {
		return { kind: "contact_support" }
	}

	return { kind: "none" }
}

// Caller must always rethrow — this only surfaces UX, never swallows.
async function surfaceGatewayApiError(error: unknown): Promise<void> {
	const action = classifyGatewayApiError(error)

	switch (action.kind) {
		case "sign_in": {
			// Wipe before sign-in so the callback rebinds against an empty slot.
			await clearZooCodeToken()
			const clicked = await vscode.window.showErrorMessage(
				t("common:zooAuth.errors.session_expired"),
				t("common:zooAuth.buttons.sign_in"),
			)
			if (clicked) {
				void vscode.env.openExternal(vscode.Uri.parse(buildZooCodeSignInUrl()))
			}
			return
		}
		case "add_credits": {
			const message = action.budgetExceeded
				? t("common:zooAuth.errors.budget_exceeded")
				: t("common:zooAuth.errors.out_of_credits")
			const clicked = await vscode.window.showErrorMessage(message, t("common:zooAuth.buttons.add_credits"))
			if (clicked) {
				void vscode.env.openExternal(vscode.Uri.parse(`${getZooCodeBaseUrl()}/dashboard/credits`))
			}
			return
		}
		case "contact_support": {
			const clicked = await vscode.window.showErrorMessage(
				t("common:zooAuth.errors.account_unavailable"),
				t("common:zooAuth.buttons.contact_support"),
			)
			if (clicked) {
				void vscode.env.openExternal(vscode.Uri.parse(`${getZooCodeBaseUrl()}/support`))
			}
			return
		}
		default:
			return
	}
}

// Extend OpenAI's CompletionUsage to include Zoo Gateway specific fields (same as Vercel AI Gateway)
interface ZooGatewayUsage extends OpenAI.CompletionUsage {
	cache_creation_input_tokens?: number
	cost?: number
}

const ZOO_GATEWAY_AUTH_ERROR = "Zoo Gateway requires authentication. Please sign in to Zoo Code first."

export class ZooGatewayHandler extends RouterProvider implements SingleCompletionHandler {
	constructor(options: ApiHandlerOptions) {
		const baseURL = options.zooGatewayBaseUrl ?? `${getZooCodeBaseUrl()}/api/gateway/v1`

		const sessionToken = resolveZooGatewaySessionToken(options.zooSessionToken)

		// Merge Zoo-specific enrichment headers into openAiHeaders so they flow through
		// the parent's single OpenAI client. We avoid reassigning `this.client` (which
		// is declared readonly on RouterProvider) and the wasted client allocation it
		// caused. Per-request headers (task id / mode) are set in createMessage below.
		super({
			options: {
				...options,
				openAiHeaders: {
					"X-Zoo-Editor": "vscode",
					"X-Zoo-Extension-Version": Package.version,
					...(options.openAiHeaders || {}),
				},
			},
			name: providerIdentifiers.zooGateway,
			baseURL,
			apiKey: sessionToken || NOT_PROVIDED,
			modelId: options.zooGatewayModelId,
			defaultModelId: zooGatewayDefaultModelId,
			defaultModelInfo: zooGatewayDefaultModelInfo,
		})
	}

	override getModelCacheScope(): ModelCacheScope {
		return { urlScoped: true, keyScoped: true, authScoped: true }
	}

	async fetchModels(options: GetModelsOptions): Promise<ModelRecord> {
		return getZooGatewayModels({ zooSessionToken: options.apiKey, zooGatewayBaseUrl: options.baseUrl })
	}

	private ensureAuthenticated(): void {
		if (!resolveZooGatewaySessionToken(this.options.zooSessionToken)) {
			throw new Error(ZOO_GATEWAY_AUTH_ERROR)
		}
	}

	override async *createMessage(
		systemPrompt: string,
		messages: Anthropic.Messages.MessageParam[],
		metadata?: ApiHandlerCreateMessageMetadata,
	): ApiStream {
		// Fail fast when the task is already cancelled before any model-catalog
		// work starts: the standardized AbortError wins over any failure the
		// fallible resolution could raise — including the auth check below.
		const externalAbortSignal = metadata?.abortSignal
		if (externalAbortSignal?.aborted) {
			throw createAbortError("Zoo Gateway")
		}

		this.ensureAuthenticated()

		// Establish the cancellation scope around model resolution: a signal
		// that fires while model metadata is loading settles on the
		// standardized AbortError; any other resolution failure propagates
		// unchanged.
		const resolved = await resolveModelWithAbort(() => this.fetchModel(), externalAbortSignal, "Zoo Gateway")
		const { id: modelId, info } = resolved

		const openAiMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
			{ role: "system", content: systemPrompt },
			...convertToOpenAiMessages(messages),
		]

		// Apply prompt caching for models that support it
		// Zoo Gateway serves the same models as Vercel AI Gateway, so caching support is identical
		if (VERCEL_AI_GATEWAY_PROMPT_CACHING_MODELS.has(modelId) && info.supportsPromptCache) {
			addCacheBreakpoints(systemPrompt, openAiMessages, resolveCacheTtl(this.options, info))
		}

		// Build request headers with enrichment metadata
		const requestHeaders: Record<string, string> = {}
		if (metadata?.taskId) {
			requestHeaders["X-Zoo-Task-ID"] = metadata.taskId
		}
		if (metadata?.mode) {
			requestHeaders["X-Zoo-Mode"] = metadata.mode
		}

		const body: OpenAI.Chat.ChatCompletionCreateParams = {
			model: modelId,
			messages: openAiMessages,
			temperature: this.supportsTemperature(modelId)
				? (this.options.modelTemperature ?? ZOO_GATEWAY_DEFAULT_TEMPERATURE)
				: undefined,
			max_completion_tokens: info.maxTokens,
			stream: true,
			stream_options: { include_usage: true },
			tools: this.convertToolsForOpenAI(metadata?.tools),
			tool_choice: metadata?.tool_choice,
			parallel_tool_calls: metadata?.parallelToolCalls ?? true,
		}

		// Per-request signal bridged from the caller's abort signal via the shared helper
		// (pre-aborted guard, once-only listener, retained cleanup). The never-aborting
		// fallback preserves the previous always-signal behaviour when the caller has no
		// external signal, and dispose() detaches the listener when the request ends.
		const { signal: bridgedSignal, dispose: detachExternalAbortSignal } =
			bridgeExternalAbortSignal(externalAbortSignal)
		const requestSignal = bridgedSignal ?? new AbortController().signal

		try {
			const pendingCompletion = this.client.chat.completions.create(body, {
				headers: requestHeaders,
				signal: requestSignal,
			})
			// Race the create: the SDK sleeps out a Retry-After backoff without observing the signal, so
			// awaiting it alone can outlive the cancel (the completion path below already races this way).
			const completion = await settleOnAbort(pendingCompletion, bridgedSignal, "Zoo Gateway")

			for await (const chunk of completion) {
				// The SDK swallows the body-read abort and can end the iterator normally, so leave the loop
				// here and let the checks below raise the contract AbortError.
				if (externalAbortSignal?.aborted) {
					break
				}

				// Once the gateway starts streaming the HTTP status is already 200, so it
				// reports upstream failures (e.g. provider rate limits) as an in-band error
				// chunk. Surface it so the user sees the real reason instead of an empty reply.
				if ("error" in chunk && chunk.error) {
					throw toGatewayStreamError(chunk.error)
				}

				const delta = chunk.choices[0]?.delta
				if (delta?.content) {
					yield {
						type: "text",
						text: delta.content,
					}
				}

				// Emit raw tool call chunks - NativeToolCallParser handles state management
				if (delta?.tool_calls) {
					for (const toolCall of delta.tool_calls) {
						if (externalAbortSignal?.aborted) {
							throw createAbortError("Zoo Gateway") // a cancel must not emit the rest of this chunk
						}

						yield {
							type: "tool_call_partial",
							index: toolCall.index,
							id: toolCall.id,
							name: toolCall.function?.name,
							arguments: toolCall.function?.arguments,
						}
					}
				}

				if (chunk.usage) {
					// A cancel that lands after the text of this frame must not be billed: the usage item is the
					// last thing the same iteration can still hand over.
					if (externalAbortSignal?.aborted) {
						throw createAbortError("Zoo Gateway") // no usage chunk for a cancelled turn
					}

					const usage = chunk.usage as ZooGatewayUsage
					yield {
						type: "usage",
						inputTokens: usage.prompt_tokens || 0,
						outputTokens: usage.completion_tokens || 0,
						cacheWriteTokens: usage.cache_creation_input_tokens || undefined,
						cacheReadTokens: usage.prompt_tokens_details?.cached_tokens || undefined,
						totalCost: usage.cost ?? 0,
					}
				}
			}
		} catch (error) {
			// Preserve abort identity (series standard): a cancelled request
			// must surface as a DOM-standard AbortError before the gateway
			// error surfacing/telemetry path, not the raw SDK abort error.
			if (isRequestAborted(error, externalAbortSignal)) {
				throw createAbortError("Zoo Gateway")
			}
			try {
				// The notification can wait for the user: a cancel that arrives while it is open must settle at
				// once instead of holding the iterator on the original 402 (same shape as completePrompt).
				const surfacing = surfaceGatewayApiError(error)
				await settleOnAbort(surfacing, bridgedSignal, "Zoo Gateway")
			} catch (surfaceError) {
				if (!externalAbortSignal?.aborted) {
					console.error(
						"Failed to surface Zoo Gateway error:",
						surfaceError instanceof Error ? surfaceError.message : surfaceError,
					)
				}
			}
			if (externalAbortSignal?.aborted) {
				throw createAbortError("Zoo Gateway") // cancelled while the notification was open
			}
			throw error
		} finally {
			detachExternalAbortSignal()
		}
		// The SDK can close the SSE iterator without throwing after a cancel: a cancelled stream must not
		// read as a completed turn, so reject with the contract AbortError before the generator returns.
		if (externalAbortSignal?.aborted) {
			throw createAbortError("Zoo Gateway")
		}
	}

	async completePrompt(prompt: string, options?: CompletePromptOptions): Promise<string> {
		// Same entry guard as createMessage: a cancelled task must not run the
		// fallible auth check, and the standardized AbortError wins over anything
		// the auth step or the lookup could raise.
		if (options?.abortSignal?.aborted) {
			throw createAbortError("Zoo Gateway")
		}

		// Same abort-signal contract as the other providers (see requesty.ts): the SDK gets a
		// per-request signal bridged from the caller's signal, so its abort listener does not stay on
		// the caller's long-lived signal. The `finally` below detaches the bridge on every exit path.
		const { signal: bridgedCallerSignal, dispose: removeExternalAbortListener } = bridgeExternalAbortSignal(
			options?.abortSignal,
		)
		const requestAbortSignal = mergeAbortSignalAndTimeout(bridgedCallerSignal, options?.timeoutMs)

		try {
			// A cancel that came first wins over every other failure, also a missing session.
			throwIfAborted(requestAbortSignal)
			this.ensureAuthenticated()

			let model: Awaited<ReturnType<ZooGatewayHandler["fetchModel"]>>
			try {
				model = requestAbortSignal
					? await rejectOnAbort(this.fetchModel(), requestAbortSignal, ZOO_GATEWAY_PROVIDER_NAME)
					: await this.fetchModel()
			} catch (error) {
				if (isRequestAborted(error, requestAbortSignal)) {
					throw createAbortError(ZOO_GATEWAY_PROVIDER_NAME)
				}
				throw error
			}
			const { id: modelId, info } = model

			const requestOptions: OpenAI.Chat.ChatCompletionCreateParams = {
				model: modelId,
				messages: [{ role: "user", content: prompt }],
				stream: false,
			}

			if (this.supportsTemperature(modelId)) {
				requestOptions.temperature = this.options.modelTemperature ?? ZOO_GATEWAY_DEFAULT_TEMPERATURE
			}

			requestOptions.max_completion_tokens = info.maxTokens
			// Build request options with abortSignal and/or timeout.
			// timeoutMs <= 0 means "no explicit timeout": omit the SDK timeout
			// option entirely — the OpenAI SDK treats timeout: 0 as an immediate
			// abort, which would cancel the request right away.

			const createOptions: OpenAI.RequestOptions = {
				...(requestAbortSignal && { signal: requestAbortSignal }),
				...(hasUsableTimeout(options?.timeoutMs) && { timeout: toSdkTimeoutMs(options.timeoutMs) }),
			}

			let response: OpenAI.Chat.ChatCompletion
			try {
				const pendingCompletion = this.client.chat.completions.create(requestOptions, createOptions)
				// Race the completion against the signal: the SDK does not observe the signal while it
				// sleeps between retries, so awaiting the SDK call alone can outlive the cancel.
				response = requestAbortSignal
					? await rejectOnAbort(pendingCompletion, requestAbortSignal, ZOO_GATEWAY_PROVIDER_NAME)
					: await pendingCompletion
			} catch (error) {
				// A cancel or timeout is not a gateway failure: do not show a gateway error for it.
				// The series standard also maps a name-based abort rejection and the SDK's own
				// timeout class onto the same AbortError identity, in case the SDK rejects a
				// moment before the merged request signal flips.
				if (isRequestAborted(error, requestAbortSignal) || error instanceof APIConnectionTimeoutError) {
					throw createAbortError(ZOO_GATEWAY_PROVIDER_NAME)
				}
				try {
					// The notification can wait for the user. A cancel or timeout must still settle at once.
					const surfacing = surfaceGatewayApiError(error)
					await (requestAbortSignal
						? rejectOnAbort(surfacing, requestAbortSignal, ZOO_GATEWAY_PROVIDER_NAME)
						: surfacing)
				} catch (surfaceError) {
					if (!requestAbortSignal?.aborted) {
						console.error(
							"Failed to surface Zoo Gateway error:",
							surfaceError instanceof Error ? surfaceError.message : surfaceError,
						)
					}
				}
				if (requestAbortSignal?.aborted) {
					throw createAbortError(ZOO_GATEWAY_PROVIDER_NAME)
				}
				if (error instanceof Error) {
					throw new Error(`Zoo Gateway completion error: ${error.message}`)
				}
				throw error
			}

			if (requestAbortSignal?.aborted) {
				// The response resolved after the request was aborted: do not return the late result.
				throw createAbortError(ZOO_GATEWAY_PROVIDER_NAME)
			}
			return response.choices[0]?.message.content || ""
		} finally {
			removeExternalAbortListener()
		}
	}
}
