import type { Anthropic } from "@anthropic-ai/sdk"

import {
	KIMI_CODE_BASE_URL,
	kimiCodeDefaultModelId,
	kimiCodeDefaultModelInfo,
	type ModelInfo,
	type ModelRecord,
} from "@roo-code/types"

import type { ApiHandlerOptions } from "../../shared/api"
import { kimiCodeOAuthManager } from "../../integrations/kimi-code/oauth"

import type { ApiHandlerCreateMessageMetadata } from "../index"
import type { ApiStream } from "../transform/stream"
import { getModelParams } from "../transform/model-params"

import { OpenAiHandler } from "./openai"
import { getModels } from "./fetchers/modelCache"

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
			openAiApiKey: options.kimiCodeApiKey ?? "not-provided",
			openAiModelId: options.apiModelId ?? kimiCodeDefaultModelId,
			openAiStreamingEnabled: true,
		})
		this.kimiOptions = options
	}

	private async resolveAccessToken(forceRefresh = false): Promise<string> {
		if ((this.kimiOptions.kimiCodeAuthMethod ?? "oauth") === "api-key") {
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
				this.models = await getModels({ provider: "kimi-code", apiKey: accessToken })
			} catch (error) {
				// Model discovery is best-effort; preserve the configured ID and fallback metadata.
				console.debug("[KimiCode] Model discovery failed; using fallback model metadata", {
					message: error instanceof Error ? error.message : String(error),
				})
			}
		}
	}

	private canRefreshOAuth(): boolean {
		return (this.kimiOptions.kimiCodeAuthMethod ?? "oauth") === "oauth"
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
		const info: ModelInfo = this.models[id] ?? kimiCodeDefaultModelInfo
		const params = getModelParams({
			format: "openai",
			modelId: id,
			model: info,
			settings: this.kimiOptions,
			defaultTemperature: 0,
		})
		return { id, info, ...params }
	}
}
