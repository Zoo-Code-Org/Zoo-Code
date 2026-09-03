import type { Anthropic } from "@anthropic-ai/sdk"
import type OpenAI from "openai"

import {
	KIMI_CODE_BASE_URL,
	getKimiCodeModelInfo,
	getKimiCodeRequestProtocol,
	kimiCodeDefaultModelId,
	providerIdentifiers,
	type KimiCodeAuthMethod,
	type ModelInfo,
	type ModelRecord,
} from "@roo-code/types"

import type { ApiHandlerOptions } from "../../shared/api"
import { kimiCodeOAuthManager } from "../../integrations/kimi-code/oauth"

import type { ApiHandlerCreateMessageMetadata } from "../index"
import { convertToOpenAiMessages } from "../transform/openai-format"
import type { ApiStream } from "../transform/stream"
import { getModelParams } from "../transform/model-params"

import { OpenAiHandler } from "./openai"
import { NOT_PROVIDED } from "./constants"
import { getModels } from "./fetchers/modelCache"

const OAUTH_AUTH_METHOD: KimiCodeAuthMethod = "oauth"
const API_KEY_AUTH_METHOD: KimiCodeAuthMethod = "api-key"

function getHttpStatus(error: unknown): number | undefined {
	if (!error || typeof error !== "object") return undefined
	const candidate = error as { status?: unknown; cause?: { status?: unknown } }
	return typeof candidate.status === "number"
		? candidate.status
		: typeof candidate.cause?.status === "number"
			? candidate.cause.status
			: undefined
}

export class KimiCodeHandler extends OpenAiHandler {
	private readonly kimiOptions: ApiHandlerOptions
	private models: ModelRecord = {}
	private modelDiscoveryAttempted = false

	constructor(options: ApiHandlerOptions) {
		super({
			...options,
			openAiBaseUrl: KIMI_CODE_BASE_URL,
			openAiApiKey: options.kimiCodeApiKey ?? NOT_PROVIDED,
			openAiModelId: options.apiModelId ?? kimiCodeDefaultModelId,
			openAiStreamingEnabled: true,
		})
		this.kimiOptions = options
	}

	private async resolveAccessToken(forceRefresh = false): Promise<string> {
		if ((this.kimiOptions.kimiCodeAuthMethod ?? OAUTH_AUTH_METHOD) === API_KEY_AUTH_METHOD) {
			if (!this.kimiOptions.kimiCodeApiKey) throw new Error("Kimi Code API key is required")
			return this.kimiOptions.kimiCodeApiKey
		}

		const token = forceRefresh
			? await kimiCodeOAuthManager.forceRefreshAccessToken()
			: await kimiCodeOAuthManager.getAccessToken()
		if (!token) throw new Error("Not authenticated with Kimi Code. Sign in from provider settings.")
		return token
	}

	private async prepareRequest(forceRefresh = false): Promise<void> {
		const accessToken = await this.resolveAccessToken(forceRefresh)
		this.client.apiKey = accessToken
		if (!this.modelDiscoveryAttempted) {
			this.modelDiscoveryAttempted = true
			try {
				this.models = await getModels({ provider: providerIdentifiers.kimiCode, apiKey: accessToken })
			} catch (error) {
				// Model discovery is best-effort; preserve the configured ID and fallback metadata.
				console.debug("[KimiCode] Model discovery failed; using fallback model metadata", {
					message: error instanceof Error ? error.message : String(error),
				})
			}
		}
	}

	private canRefreshOAuth(): boolean {
		return (this.kimiOptions.kimiCodeAuthMethod ?? OAUTH_AUTH_METHOD) === OAUTH_AUTH_METHOD
	}

	override async *createMessage(
		systemPrompt: string,
		messages: Anthropic.Messages.MessageParam[],
		metadata?: ApiHandlerCreateMessageMetadata,
	): ApiStream {
		await this.prepareRequest()
		try {
			yield* super.createMessage(systemPrompt, messages, metadata)
		} catch (error) {
			if (getHttpStatus(error) !== 401 || !this.canRefreshOAuth()) throw error
			await this.prepareRequest(true)
			yield* super.createMessage(systemPrompt, messages, metadata)
		}
	}

	override async completePrompt(prompt: string): Promise<string> {
		await this.prepareRequest()
		try {
			return await super.completePrompt(prompt)
		} catch (error) {
			if (getHttpStatus(error) !== 401 || !this.canRefreshOAuth()) throw error
			await this.prepareRequest(true)
			return super.completePrompt(prompt)
		}
	}

	override getModel() {
		const id = this.kimiOptions.apiModelId || kimiCodeDefaultModelId
		const info: ModelInfo = this.models[id] ?? getKimiCodeModelInfo(id)
		const params = getModelParams({
			format: "openai",
			modelId: id,
			model: info,
			settings: this.kimiOptions,
			defaultTemperature: 0,
		})
		return { id, info, ...params }
	}

	protected override transformChatCompletionRequest<T extends OpenAI.Chat.Completions.ChatCompletionCreateParams>(
		requestOptions: T,
	): T {
		const transformed = { ...requestOptions } as T & {
			thinking?: { type: "enabled"; keep: "all" }
		}
		delete transformed.temperature

		const protocol = getKimiCodeRequestProtocol(requestOptions.model)
		if (protocol === "reasoning-effort") {
			const effort = this.getModel().reasoning?.reasoning_effort
			if (effort) transformed.reasoning_effort = effort
		} else if (protocol === "thinking") {
			delete transformed.reasoning_effort
			transformed.thinking = { type: "enabled", keep: "all" }
		}

		return transformed
	}

	protected override convertMessagesForRequest(
		messages: Anthropic.Messages.MessageParam[],
	): OpenAI.Chat.ChatCompletionMessageParam[] {
		return convertToOpenAiMessages(messages, { mergeToolResultText: true })
	}
}
