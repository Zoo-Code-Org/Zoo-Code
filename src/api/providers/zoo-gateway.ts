import * as vscode from "vscode"
import { Anthropic } from "@anthropic-ai/sdk"
import OpenAI from "openai"

import {
	zooGatewayDefaultModelId,
	zooGatewayDefaultModelInfo,
	ZOO_GATEWAY_DEFAULT_TEMPERATURE,
	VERCEL_AI_GATEWAY_PROMPT_CACHING_MODELS,
} from "@roo-code/types"

import { ApiHandlerOptions } from "../../shared/api"
import { clearZooCodeToken, getZooCodeBaseUrl, resolveZooGatewaySessionToken } from "../../services/zoo-code-auth"
import { Package } from "../../shared/package"
import { t } from "../../i18n"

import { ApiStream } from "../transform/stream"
import { convertToOpenAiMessages } from "../transform/openai-format"
import { addCacheBreakpoints } from "../transform/caching/vercel-ai-gateway"

import type { SingleCompletionHandler, ApiHandlerCreateMessageMetadata } from "../index"
import { RouterProvider } from "./router-provider"

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
			name: "zoo-gateway",
			baseURL,
			apiKey: sessionToken || "not-provided",
			modelId: options.zooGatewayModelId,
			defaultModelId: zooGatewayDefaultModelId,
			defaultModelInfo: zooGatewayDefaultModelInfo,
		})
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
		this.ensureAuthenticated()

		const { id: modelId, info } = await this.fetchModel()

		const openAiMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
			{ role: "system", content: systemPrompt },
			...convertToOpenAiMessages(messages),
		]

		// Apply prompt caching for models that support it
		// Zoo Gateway serves the same models as Vercel AI Gateway, so caching support is identical
		if (VERCEL_AI_GATEWAY_PROMPT_CACHING_MODELS.has(modelId) && info.supportsPromptCache) {
			addCacheBreakpoints(systemPrompt, openAiMessages)
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

		try {
			const completion = await this.client.chat.completions.create(body, {
				headers: requestHeaders,
			})

			for await (const chunk of completion) {
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
			try {
				await surfaceGatewayApiError(error)
			} catch (surfaceError) {
				console.error(
					"Failed to surface Zoo Gateway error:",
					surfaceError instanceof Error ? surfaceError.message : surfaceError,
				)
			}
			throw error
		}
	}

	async completePrompt(prompt: string): Promise<string> {
		this.ensureAuthenticated()

		const { id: modelId, info } = await this.fetchModel()

		try {
			const requestOptions: OpenAI.Chat.ChatCompletionCreateParams = {
				model: modelId,
				messages: [{ role: "user", content: prompt }],
				stream: false,
			}

			if (this.supportsTemperature(modelId)) {
				requestOptions.temperature = this.options.modelTemperature ?? ZOO_GATEWAY_DEFAULT_TEMPERATURE
			}

			requestOptions.max_completion_tokens = info.maxTokens

			const response = await this.client.chat.completions.create(requestOptions)
			return response.choices[0]?.message.content || ""
		} catch (error) {
			try {
				await surfaceGatewayApiError(error)
			} catch (surfaceError) {
				console.error(
					"Failed to surface Zoo Gateway error:",
					surfaceError instanceof Error ? surfaceError.message : surfaceError,
				)
			}
			if (error instanceof Error) {
				throw new Error(`Zoo Gateway completion error: ${error.message}`)
			}
			throw error
		}
	}
}
