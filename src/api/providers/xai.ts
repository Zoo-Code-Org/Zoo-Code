import { Anthropic } from "@anthropic-ai/sdk"
import OpenAI from "openai"

import { type XAIModelId, xaiDefaultModelId, xaiModels, ApiProviderError } from "@roo-code/types"
import { TelemetryService } from "@roo-code/telemetry"

import type { ApiHandlerOptions } from "../../shared/api"

import { ApiStream } from "../transform/stream"
import { convertToResponsesApiInput } from "../transform/responses-api-input"
import { processResponsesApiStream, createUsageNormalizer } from "../transform/responses-api-stream"
import { getModelParams } from "../transform/model-params"

import { DEFAULT_HEADERS, NOT_PROVIDED } from "./constants"
import { BaseProvider } from "./base-provider"
import {
	bridgeExternalAbortSignal,
	createAbortError,
	hasUsableTimeout,
	toSdkTimeoutMs,
	isRequestAborted,
} from "./utils/abort-signal"
import type { SingleCompletionHandler, ApiHandlerCreateMessageMetadata, CompletePromptOptions } from "../index"
import { handleOpenAIError } from "./utils/error-handler"
import { isMcpTool } from "../../utils/mcp-name"

const XAI_DEFAULT_TEMPERATURE = 0

export class XAIHandler extends BaseProvider implements SingleCompletionHandler {
	protected options: ApiHandlerOptions
	private client: OpenAI
	private readonly providerName = "xAI"

	constructor(options: ApiHandlerOptions) {
		super()
		this.options = options

		const apiKey = this.options.xaiApiKey ?? NOT_PROVIDED

		this.client = new OpenAI({
			baseURL: "https://api.x.ai/v1",
			apiKey: apiKey,
			defaultHeaders: DEFAULT_HEADERS,
			timeout: this.timeoutMs,
		})
	}

	override getModel() {
		const id =
			this.options.apiModelId && this.options.apiModelId in xaiModels
				? (this.options.apiModelId as XAIModelId)
				: xaiDefaultModelId

		const info = xaiModels[id]
		const params = getModelParams({
			format: "openai",
			modelId: id,
			model: info,
			settings: this.options,
			defaultTemperature: XAI_DEFAULT_TEMPERATURE,
		})
		return { id, info, ...params }
	}

	/**
	 * Map a Chat Completions tool choice to the Responses API shape so TypeScript
	 * validates the provider payload (the APIs use different object forms for the
	 * named-tool choices: Chat Completions nests the name under `function`/`custom`,
	 * Responses API puts it at the top level). String options (auto/required/none)
	 * are identical in both APIs and pass through unchanged. `allowed_tools`
	 * entries keep their allowlist mode, but Chat Completions function references
	 * ({ type: "function", function: { name } }) are flattened to the Responses
	 * API shape ({ type: "function", name }); other entry types pass through
	 * unchanged.
	 */
	private mapToolChoice(
		toolChoice: NonNullable<OpenAI.Chat.ChatCompletionCreateParams["tool_choice"]>,
	): OpenAI.Responses.ResponseCreateParamsStreaming["tool_choice"] {
		if (typeof toolChoice === "string") {
			return toolChoice
		}
		switch (toolChoice.type) {
			case "function":
				return { type: "function", name: toolChoice.function.name }
			case "custom":
				return { type: "custom", name: toolChoice.custom.name }
			case "allowed_tools":
				return {
					type: "allowed_tools",
					mode: toolChoice.allowed_tools.mode,
					tools: toolChoice.allowed_tools.tools.map((entry) => {
						// Chat Completions allowlist entries nest the function reference
						// ({ type: "function", function: { name } }); the Responses API
						// expects the name at the top level ({ type: "function", name }).
						// The Chat Completions type allows open records, so a function
						// entry can arrive malformed (missing or non-string name).
						// Forwarding it unchanged would send the nested Chat Completions
						// shape to the Responses API, which cannot express that allowlist
						// entry, and how xAI handles the malformed payload is unspecified;
						// reject it at the boundary instead.
						if (entry["type"] === "function") {
							const functionRef = entry["function"]
							const name =
								functionRef != null && typeof functionRef === "object"
									? (functionRef as Record<string, unknown>)["name"]
									: undefined
							if (typeof name !== "string") {
								throw new Error(
									'xAI: allowed_tools entry of type "function" is missing a valid function name',
								)
							}
							return { type: "function", name }
						}
						return entry
					}),
				}
		}
	}

	/**
	 * Convert tools from OpenAI Chat Completions format to Responses API format.
	 * Chat Completions: { type: "function", function: { name, description, parameters } }
	 * Responses API: { type: "function", name, description, parameters }
	 *
	 * Uses base provider's convertToolSchemaForOpenAI() for schema hardening
	 * (additionalProperties: false, ensureAllRequired) and handles MCP tools.
	 */
	private mapResponseTools(tools?: any[]): any[] | undefined {
		const converted = this.convertToolsForOpenAI(tools)
		if (!converted?.length) {
			return undefined
		}
		return converted
			.filter((tool) => tool?.type === "function")
			.map((tool) => {
				const isMcp = isMcpTool(tool.function.name)
				return {
					type: "function",
					name: tool.function.name,
					description: tool.function.description,
					parameters: isMcp
						? tool.function.parameters
						: this.convertToolSchemaForOpenAI(tool.function.parameters),
					strict: !isMcp,
				}
			})
	}

	override async *createMessage(
		systemPrompt: string,
		messages: Anthropic.Messages.MessageParam[],
		metadata?: ApiHandlerCreateMessageMetadata,
	): ApiStream {
		const model = this.getModel()

		// Convert directly from Anthropic format to Responses API input format
		const input = convertToResponsesApiInput(messages)
		const responseTools = this.mapResponseTools(metadata?.tools)
		const toolChoice = metadata?.tool_choice
		const parallelToolCalls = metadata?.parallelToolCalls

		// Build request options
		const requestBody: OpenAI.Responses.ResponseCreateParamsStreaming = {
			model: model.id,
			instructions: systemPrompt,
			input: input,
			stream: true,
			store: false, // Don't store responses server-side for privacy
			include: ["reasoning.encrypted_content"],
		}

		// Model params are always resolved by getModel(); send them unconditionally.
		requestBody.max_output_tokens = model.maxTokens
		requestBody.temperature = model.temperature

		if (responseTools) {
			requestBody.tools = responseTools
			// Metadata carries a Chat Completions tool choice; the Responses API
			// uses its own shape, so map it explicitly instead of casting.
			requestBody.tool_choice = this.mapToolChoice(toolChoice === undefined ? "auto" : toolChoice)
			requestBody.parallel_tool_calls = parallelToolCalls ?? true
		}

		// Pass reasoning effort for models that support it (e.g., grok-4.5, grok-3-mini).
		// The xAI Responses API uses `reasoning: { effort }` format (not `reasoning_effort`
		// which is the Chat Completions format), so we convert from the OpenAI params shape.
		if (model.reasoning) {
			requestBody.reasoning = { effort: model.reasoning.reasoning_effort }
		}

		// Bridge the external abort signal only after every throw-prone part of the request
		// construction (notably mapToolChoice, which rejects malformed allowed_tools entries)
		// has run: the bridge's cleanup covers the request below, not construction failures,
		// so registering earlier would leak a listener on metadata.abortSignal.
		const externalAbortSignal = metadata?.abortSignal
		const { signal: abortSignal, dispose: removeExternalAbortListener } =
			bridgeExternalAbortSignal(externalAbortSignal)

		try {
			let stream: AsyncIterable<any>
			try {
				stream = (await this.client.responses.create(
					requestBody,
					abortSignal ? { signal: abortSignal } : undefined,
				)) as unknown as AsyncIterable<any>
			} catch (error) {
				// Normalize cancellations to the contract error: the OpenAI SDK's
				// APIUserAbortError carries name "Error" and message "Request was
				// aborted.", so rethrowing it raw would leak a non-conforming shape to
				// the caller's AbortError guard.
				if (isRequestAborted(error, abortSignal)) {
					throw createAbortError(this.providerName)
				}
				const errorMessage = error instanceof Error ? error.message : String(error)
				const apiError = new ApiProviderError(errorMessage, this.providerName, model.id, "createMessage")
				TelemetryService.instance.captureException(apiError)
				throw handleOpenAIError(error, this.providerName)
			}

			const normalizeUsage = createUsageNormalizer()
			try {
				yield* processResponsesApiStream(stream, normalizeUsage)
			} catch (error) {
				// An abort landing after responses.create resolved surfaces here as
				// the SDK's APIUserAbortError thrown from stream iteration (name
				// "Error", message "Request was aborted."), outside the create
				// catch above. Normalize it to the contract AbortError too, so
				// callers never classify a cancellation as a provider failure.
				if (isRequestAborted(error, abortSignal)) {
					throw createAbortError(this.providerName)
				}
				throw error
			}
		} finally {
			// Release the listener once the stream is consumed, whether the
			// request completed, failed, or the generator was closed early.
			removeExternalAbortListener?.()
		}
	}

	async completePrompt(prompt: string, options?: CompletePromptOptions): Promise<string> {
		const model = this.getModel()

		try {
			// Build request options with abortSignal and/or timeout handling
			const requestOptions: OpenAI.RequestOptions = {}
			if (options?.abortSignal) {
				requestOptions.signal = options.abortSignal
			}
			const timeoutMs = options?.timeoutMs
			// Only a usable finite positive timeout may be forwarded: the SDKs treat
			// timeout: 0 as an immediate abort and throw on negative/non-finite values.
			// Fractional delays are rounded up, matching mergeAbortSignalAndTimeout.
			if (hasUsableTimeout(timeoutMs)) {
				requestOptions.timeout = toSdkTimeoutMs(timeoutMs)
			}

			const response = await this.client.responses.create(
				{
					model: model.id,
					input: [{ role: "user", content: [{ type: "input_text", text: prompt }] }],
					store: false,
				},
				Object.keys(requestOptions).length > 0 ? requestOptions : undefined,
			)

			// output_text is a convenience field on the Responses API response
			return response.output_text || ""
		} catch (error) {
			// Normalize cancellations to the contract error: the OpenAI SDK's
			// APIUserAbortError carries name "Error" and message "Request was
			// aborted.", so rethrowing it raw would leak a non-conforming shape to
			// the caller's AbortError guard.
			if (isRequestAborted(error, options?.abortSignal)) {
				throw createAbortError(this.providerName)
			}
			const errorMessage = error instanceof Error ? error.message : String(error)
			const apiError = new ApiProviderError(errorMessage, this.providerName, model.id, "completePrompt")
			TelemetryService.instance.captureException(apiError)
			throw handleOpenAIError(error, this.providerName)
		}
	}
}
