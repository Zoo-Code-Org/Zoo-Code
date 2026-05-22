import type { Anthropic } from "@anthropic-ai/sdk"
import {
	GoogleGenAI,
	type GenerateContentResponseUsageMetadata,
	type GenerateContentParameters,
	type GenerateContentConfig,
	type GroundingMetadata,
	FunctionCallingConfigMode,
} from "@google/genai"
import type { JWTInput } from "google-auth-library"

import {
	type ModelInfo,
	type GeminiModelId,
	geminiDefaultModelId,
	geminiModels,
	ApiProviderError,
} from "@roo-code/types"
import { safeJsonParse } from "@roo-code/core"
import { TelemetryService } from "@roo-code/telemetry"

import type { ApiHandlerOptions } from "../../shared/api"

import { convertAnthropicMessageToGemini } from "../transform/gemini-format"
import { t } from "i18next"
import type { ApiStream, GroundingSource } from "../transform/stream"
import { getModelParams } from "../transform/model-params"

import type { SingleCompletionHandler, ApiHandlerCreateMessageMetadata } from "../index"
import { BaseProvider } from "./base-provider"

type GeminiHandlerOptions = ApiHandlerOptions & {
	isVertex?: boolean
}

// Gemini documents function declaration schemas as a selected OpenAPI-style
// subset with single-value `type` plus `nullable`. In practice, third-party
// MCP schemas often include broader JSON Schema metadata/composition that has
// produced opaque INVALID_ARGUMENT responses. Keep the outbound schema narrow.
const GEMINI_SCHEMA_COMPATIBILITY_DROP_KEYS = new Set([
	"$schema",
	"$id",
	"$defs",
	"additionalProperties",
	"default",
	"definitions",
])

function sanitizeSchemaForGemini(
	schema: unknown,
	defs?: Record<string, unknown>,
	activeRefs: Set<string> = new Set(),
): unknown {
	if (!schema || typeof schema !== "object") {
		return schema
	}

	if (Array.isArray(schema)) {
		return schema.map((item) => sanitizeSchemaForGemini(item, defs, activeRefs))
	}

	const source = schema as Record<string, unknown>

	// Extract $defs / definitions from the root schema on the first call so
	// they can be used to resolve $ref entries encountered deeper in the tree.
	const resolvedDefs = defs ?? ((source.$defs ?? source.definitions) as Record<string, unknown> | undefined)

	// Resolve local JSON Pointer $ref before any other processing.
	// Without this, dropping $defs leaves dangling references that Gemini rejects.
	if (typeof source.$ref === "string" && resolvedDefs) {
		const match = source.$ref.match(/^#\/(?:\$defs|definitions)\/(.+)$/)
		if (match) {
			const resolved = resolvedDefs[match[1]]
			if (resolved !== undefined) {
				// Recursive MCP schemas are valid JSON Schema but not something Gemini
				// can consume directly. Stop at the recursive edge so we still send a
				// finite, serializable schema instead of overflowing the stack.
				if (activeRefs.has(match[1])) {
					return {}
				}

				activeRefs.add(match[1])
				try {
					return sanitizeSchemaForGemini(resolved, resolvedDefs, activeRefs)
				} finally {
					activeRefs.delete(match[1])
				}
			}
		}
	}

	const result: Record<string, unknown> = {}
	let nullable = source.nullable === true

	const composition = source.anyOf ?? source.oneOf
	if (Array.isArray(composition)) {
		const variants = composition.filter((variant) => {
			return variant && typeof variant === "object" && !Array.isArray(variant)
				? (variant as Record<string, unknown>).type !== "null"
				: true
		})
		nullable = nullable || variants.length < composition.length
		Object.assign(result, sanitizeSchemaForGemini(variants[0] ?? {}, resolvedDefs, activeRefs))
	}

	if (Array.isArray(source.allOf)) {
		for (const variant of source.allOf) {
			const sanitized = sanitizeSchemaForGemini(variant, resolvedDefs, activeRefs)
			if (sanitized && typeof sanitized === "object" && !Array.isArray(sanitized)) {
				const s = sanitized as Record<string, unknown>
				// Deep-merge properties so later allOf fragments don't overwrite
				// earlier ones (last-write-wins Object.assign drops prior keys).
				if (s.properties && typeof s.properties === "object") {
					result.properties = {
						...(result.properties as Record<string, unknown> | undefined),
						...(s.properties as Record<string, unknown>),
					}
				}
				if (Array.isArray(s.required)) {
					const existing = Array.isArray(result.required) ? (result.required as string[]) : []
					result.required = [...new Set([...existing, ...(s.required as string[])])]
				}
				const { properties: _p, required: _r, ...rest } = s
				Object.assign(result, rest)
			}
		}
	}

	for (const [key, value] of Object.entries(source)) {
		if (GEMINI_SCHEMA_COMPATIBILITY_DROP_KEYS.has(key) || key === "anyOf" || key === "oneOf" || key === "allOf") {
			continue
		}

		if (key === "properties" && value && typeof value === "object" && !Array.isArray(value)) {
			// Iterate the property map directly so that property names that happen
			// to match schema keywords (e.g. "default", "additionalProperties") are
			// preserved as-is; only each property's schema value is sanitized.
			const sanitizedProperties: Record<string, unknown> = {}
			for (const [propName, propSchema] of Object.entries(value as Record<string, unknown>)) {
				sanitizedProperties[propName] = sanitizeSchemaForGemini(propSchema, resolvedDefs, activeRefs)
			}
			result.properties = {
				...(result.properties as Record<string, unknown> | undefined),
				...sanitizedProperties,
			}
			continue
		}

		if (key === "required" && Array.isArray(value)) {
			const existing = Array.isArray(result.required) ? (result.required as string[]) : []
			result.required = [
				...new Set([...existing, ...value.filter((item): item is string => typeof item === "string")]),
			]
			continue
		}

		if (key === "type" && Array.isArray(value)) {
			const nonNullTypes = value.filter((item) => item !== "null")
			if (nonNullTypes.length > 0) {
				result.type = nonNullTypes[0]
			}
			nullable = nullable || nonNullTypes.length < value.length
			continue
		}

		result[key] = sanitizeSchemaForGemini(value, resolvedDefs, activeRefs)
	}

	if (nullable) {
		result.nullable = true
	}

	return result
}

export class GeminiHandler extends BaseProvider implements SingleCompletionHandler {
	protected options: ApiHandlerOptions

	private client: GoogleGenAI
	private lastThoughtSignature?: string
	private lastResponseId?: string
	private readonly providerName = "Gemini"

	constructor({ isVertex, ...options }: GeminiHandlerOptions) {
		super()

		this.options = options

		const project = this.options.vertexProjectId ?? "not-provided"
		const location = this.options.vertexRegion ?? "not-provided"
		const apiKey = this.options.geminiApiKey ?? "not-provided"

		this.client = this.options.vertexJsonCredentials
			? new GoogleGenAI({
					vertexai: true,
					project,
					location,
					googleAuthOptions: {
						credentials: safeJsonParse<JWTInput>(this.options.vertexJsonCredentials, undefined),
					},
				})
			: this.options.vertexKeyFile
				? new GoogleGenAI({
						vertexai: true,
						project,
						location,
						googleAuthOptions: { keyFile: this.options.vertexKeyFile },
					})
				: isVertex
					? new GoogleGenAI({ vertexai: true, project, location })
					: new GoogleGenAI({ apiKey })
	}

	async *createMessage(
		systemInstruction: string,
		messages: Anthropic.Messages.MessageParam[],
		metadata?: ApiHandlerCreateMessageMetadata,
	): ApiStream {
		const { id: model, info, reasoning: thinkingConfig, maxTokens } = this.getModel()
		// Reset per-request metadata that we persist into apiConversationHistory.
		this.lastThoughtSignature = undefined
		this.lastResponseId = undefined

		// For hybrid/budget reasoning models (e.g. Gemini 2.5 Pro), respect user-configured
		// modelMaxTokens so the ThinkingBudget slider can control the cap. For effort-only or
		// standard models (like gemini-3-pro-preview), ignore any stale modelMaxTokens and
		// default to the model's computed maxTokens from getModelMaxOutputTokens.
		const isHybridReasoningModel = info.supportsReasoningBudget || info.requiredReasoningBudget
		const maxOutputTokens = isHybridReasoningModel
			? (this.options.modelMaxTokens ?? maxTokens ?? undefined)
			: (maxTokens ?? undefined)

		// Gemini 3 validates thought signatures for tool/function calling steps.
		// We must round-trip the signature when tools are in use, even if the user chose
		// a minimal thinking level (or thinkingConfig is otherwise absent).
		const includeThoughtSignatures = Boolean(thinkingConfig) || Boolean(metadata?.tools?.length)

		// The message list can include provider-specific meta entries such as
		// `{ type: "reasoning", ... }` that are intended only for providers like
		// openai-native. Gemini should never see those; they are not valid
		// Anthropic.MessageParam values and will cause failures (e.g. missing
		// `content` for the converter). Filter them out here.
		type ReasoningMetaLike = { type?: string }

		const geminiMessages = messages.filter((message): message is Anthropic.Messages.MessageParam => {
			const meta = message as ReasoningMetaLike
			if (meta.type === "reasoning") {
				return false
			}
			return true
		})

		// Build a map of tool IDs to names from previous messages
		// This is needed because Anthropic's tool_result blocks only contain the ID,
		// but Gemini requires the name in functionResponse
		const toolIdToName = new Map<string, string>()
		for (const message of messages) {
			if (Array.isArray(message.content)) {
				for (const block of message.content) {
					if (block.type === "tool_use") {
						toolIdToName.set(block.id, block.name)
					}
				}
			}
		}

		const contents = geminiMessages
			.map((message) => convertAnthropicMessageToGemini(message, { includeThoughtSignatures, toolIdToName }))
			.flat()

		// Tools are always present (minimum ALWAYS_AVAILABLE_TOOLS).
		// Google built-in tools (Grounding, URL Context) are mutually exclusive
		// with function declarations in the Gemini API, so we always use
		// function declarations when tools are provided.
		const functionDeclarations = (metadata?.tools ?? []).map((tool) => ({
			name: (tool as any).function.name,
			description: (tool as any).function.description,
			parametersJsonSchema: sanitizeSchemaForGemini((tool as any).function.parameters),
		}))
		const availableFunctionNameSet = new Set(functionDeclarations.map((declaration) => declaration.name))

		const tools: GenerateContentConfig["tools"] = [
			{
				functionDeclarations,
			},
		]

		// Determine temperature respecting model capabilities and defaults:
		// - If supportsTemperature is explicitly false, ignore user overrides
		//   and pin to the model's defaultTemperature (or omit if undefined).
		// - Otherwise, allow the user setting to override, falling back to model default,
		//   then to 1 for Gemini provider default.
		const supportsTemperature = info.supportsTemperature !== false
		const temperatureConfig: number | undefined = supportsTemperature
			? (this.options.modelTemperature ?? info.defaultTemperature ?? 1)
			: info.defaultTemperature

		const config: GenerateContentConfig = {
			systemInstruction,
			httpOptions: this.options.googleGeminiBaseUrl ? { baseUrl: this.options.googleGeminiBaseUrl } : undefined,
			thinkingConfig,
			maxOutputTokens,
			temperature: temperatureConfig,
			...(tools.length > 0 ? { tools } : {}),
		}

		// Do not pass metadata.allowedFunctionNames to Gemini. Live API testing showed
		// that allowedFunctionNames triggers a generic 400 INVALID_ARGUMENT at 26 or more
		// names. It can also
		// reject prior function calls if their names are absent from the current
		// allowed list. We still pass all declarations for history compatibility;
		// mode/tool restrictions are enforced by the tool execution layer.
		if (metadata?.tool_choice) {
			const choice = metadata.tool_choice
			let mode: FunctionCallingConfigMode
			let allowedFunctionNames: string[] | undefined

			if (choice === "auto") {
				mode = FunctionCallingConfigMode.AUTO
			} else if (choice === "none") {
				mode = FunctionCallingConfigMode.NONE
			} else if (choice === "required") {
				// "required" means the model must call at least one tool; Gemini uses ANY for this.
				mode = FunctionCallingConfigMode.ANY
			} else if (typeof choice === "object" && "function" in choice && choice.type === "function") {
				const selectedToolName = choice.function.name
				if (availableFunctionNameSet.has(selectedToolName)) {
					mode = FunctionCallingConfigMode.ANY
					allowedFunctionNames = [selectedToolName]
				} else {
					mode = FunctionCallingConfigMode.AUTO
				}
			} else {
				// Fall back to AUTO for unknown values to avoid unintentionally broadening tool access.
				mode = FunctionCallingConfigMode.AUTO
			}

			config.toolConfig = {
				functionCallingConfig: {
					mode,
					...(allowedFunctionNames ? { allowedFunctionNames } : {}),
				},
			}
		}

		const params: GenerateContentParameters = { model, contents, config }

		try {
			const result = await this.client.models.generateContentStream(params)

			let lastUsageMetadata: GenerateContentResponseUsageMetadata | undefined
			let pendingGroundingMetadata: GroundingMetadata | undefined
			let finalResponse: { responseId?: string } | undefined
			let finishReason: string | undefined

			let toolCallCounter = 0
			let hasContent = false
			let hasReasoning = false

			for await (const chunk of result) {
				// Track the final structured response (per SDK pattern: candidate.finishReason)
				if (chunk.candidates && chunk.candidates[0]?.finishReason) {
					finalResponse = chunk as { responseId?: string }
					finishReason = chunk.candidates[0].finishReason
				}
				// Process candidates and their parts to separate thoughts from content
				if (chunk.candidates && chunk.candidates.length > 0) {
					const candidate = chunk.candidates[0]

					if (candidate.groundingMetadata) {
						pendingGroundingMetadata = candidate.groundingMetadata
					}

					if (candidate.content && candidate.content.parts) {
						for (const part of candidate.content.parts as Array<{
							thought?: boolean
							text?: string
							thoughtSignature?: string
							functionCall?: { name: string; args: Record<string, unknown> }
						}>) {
							// Capture thought signatures so they can be persisted into API history.
							const thoughtSignature = part.thoughtSignature
							// Persist thought signatures so they can be round-tripped in the next step.
							// Gemini 3 requires this during tool calling; other Gemini thinking models
							// benefit from it for continuity.
							if (includeThoughtSignatures && thoughtSignature) {
								this.lastThoughtSignature = thoughtSignature
							}

							if (part.thought) {
								// This is a thinking/reasoning part
								if (part.text) {
									hasReasoning = true
									yield { type: "reasoning", text: part.text }
								}
							} else if (part.functionCall) {
								hasContent = true
								// Gemini sends complete function calls in a single chunk
								// Emit as partial chunks for consistent handling with NativeToolCallParser
								const callId = `${part.functionCall.name}-${toolCallCounter}`
								const args = JSON.stringify(part.functionCall.args)

								// Emit name first
								yield {
									type: "tool_call_partial",
									index: toolCallCounter,
									id: callId,
									name: part.functionCall.name,
									arguments: undefined,
								}

								// Then emit arguments
								yield {
									type: "tool_call_partial",
									index: toolCallCounter,
									id: callId,
									name: undefined,
									arguments: args,
								}

								toolCallCounter++
							} else {
								// This is regular content
								if (part.text) {
									hasContent = true
									yield { type: "text", text: part.text }
								}
							}
						}
					}
				}

				// Fallback to the original text property if no candidates structure
				else if (chunk.text) {
					hasContent = true
					yield { type: "text", text: chunk.text }
				}

				if (chunk.usageMetadata) {
					lastUsageMetadata = chunk.usageMetadata
				}
			}

			if (finalResponse?.responseId) {
				// Capture responseId so Task.addToApiConversationHistory can store it
				// alongside the assistant message in api_history.json.
				this.lastResponseId = finalResponse.responseId
			}

			if (pendingGroundingMetadata) {
				const sources = this.extractGroundingSources(pendingGroundingMetadata)
				if (sources.length > 0) {
					yield { type: "grounding", sources }
				}
			}

			if (lastUsageMetadata) {
				const inputTokens = lastUsageMetadata.promptTokenCount ?? 0
				const outputTokens = lastUsageMetadata.candidatesTokenCount ?? 0
				const cacheReadTokens = lastUsageMetadata.cachedContentTokenCount
				const reasoningTokens = lastUsageMetadata.thoughtsTokenCount

				yield {
					type: "usage",
					inputTokens,
					outputTokens,
					cacheReadTokens,
					reasoningTokens,
					totalCost: this.calculateCost({
						info,
						inputTokens,
						outputTokens,
						cacheReadTokens,
						reasoningTokens,
					}),
				}
			}
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error)
			const apiError = new ApiProviderError(errorMessage, this.providerName, model, "createMessage")
			TelemetryService.instance.captureException(apiError)

			if (error instanceof Error) {
				throw new Error(t("common:errors.gemini.generate_stream", { error: error.message }))
			}

			throw error
		}
	}

	override getModel() {
		const modelId = this.options.apiModelId
		let id = modelId && modelId in geminiModels ? (modelId as GeminiModelId) : geminiDefaultModelId
		let info: ModelInfo = geminiModels[id]

		const params = getModelParams({
			format: "gemini",
			modelId: id,
			model: info,
			settings: this.options,
			defaultTemperature: info.defaultTemperature ?? 1,
		})

		// Gemini models perform better with the edit tool instead of apply_diff.
		info = {
			...info,
			excludedTools: [...new Set([...(info.excludedTools || []), "apply_diff"])],
			includedTools: [...new Set([...(info.includedTools || []), "edit"])],
		}

		// The `:thinking` suffix indicates that the model is a "Hybrid"
		// reasoning model and that reasoning is required to be enabled.
		// The actual model ID honored by Gemini's API does not have this
		// suffix.
		return { id: id.endsWith(":thinking") ? id.replace(":thinking", "") : id, info, ...params }
	}

	private extractGroundingSources(groundingMetadata?: GroundingMetadata): GroundingSource[] {
		const chunks = groundingMetadata?.groundingChunks

		if (!chunks) {
			return []
		}

		return chunks
			.map((chunk): GroundingSource | null => {
				const uri = chunk.web?.uri
				const title = chunk.web?.title || uri || "Unknown Source"

				if (uri) {
					return {
						title,
						url: uri,
					}
				}
				return null
			})
			.filter((source): source is GroundingSource => source !== null)
	}

	private extractCitationsOnly(groundingMetadata?: GroundingMetadata): string | null {
		const sources = this.extractGroundingSources(groundingMetadata)

		if (sources.length === 0) {
			return null
		}

		const citationLinks = sources.map((source, i) => `[${i + 1}](${source.url})`)
		return citationLinks.join(", ")
	}

	async completePrompt(prompt: string): Promise<string> {
		const { id: model, info } = this.getModel()

		try {
			const supportsTemperature = info.supportsTemperature !== false
			const temperatureConfig: number | undefined = supportsTemperature
				? (this.options.modelTemperature ?? info.defaultTemperature ?? 1)
				: info.defaultTemperature

			const promptConfig: GenerateContentConfig = {
				httpOptions: this.options.googleGeminiBaseUrl
					? { baseUrl: this.options.googleGeminiBaseUrl }
					: undefined,
				temperature: temperatureConfig,
			}

			const request = {
				model,
				contents: [{ role: "user", parts: [{ text: prompt }] }],
				config: promptConfig,
			}

			const result = await this.client.models.generateContent(request)

			let text = result.text ?? ""

			const candidate = result.candidates?.[0]
			if (candidate?.groundingMetadata) {
				const citations = this.extractCitationsOnly(candidate.groundingMetadata)
				if (citations) {
					text += `\n\n${t("common:errors.gemini.sources")} ${citations}`
				}
			}

			return text
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error)
			const apiError = new ApiProviderError(errorMessage, this.providerName, model, "completePrompt")
			TelemetryService.instance.captureException(apiError)

			if (error instanceof Error) {
				throw new Error(t("common:errors.gemini.generate_complete_prompt", { error: error.message }))
			}

			throw error
		}
	}

	public getThoughtSignature(): string | undefined {
		return this.lastThoughtSignature
	}

	public getResponseId(): string | undefined {
		return this.lastResponseId
	}

	public calculateCost({
		info,
		inputTokens,
		outputTokens,
		cacheReadTokens = 0,
		reasoningTokens = 0,
	}: {
		info: ModelInfo
		inputTokens: number
		outputTokens: number
		cacheReadTokens?: number
		reasoningTokens?: number
	}) {
		// For models with tiered pricing, prices might only be defined in tiers
		let inputPrice = info.inputPrice
		let outputPrice = info.outputPrice
		let cacheReadsPrice = info.cacheReadsPrice

		// If there's tiered pricing then adjust the input and output token prices
		// based on the input tokens used.
		if (info.tiers) {
			const tier = info.tiers.find((tier) => inputTokens <= tier.contextWindow)

			if (tier) {
				inputPrice = tier.inputPrice ?? inputPrice
				outputPrice = tier.outputPrice ?? outputPrice
				cacheReadsPrice = tier.cacheReadsPrice ?? cacheReadsPrice
			}
		}

		// Check if we have the required prices after considering tiers
		if (!inputPrice || !outputPrice) {
			return undefined
		}

		// cacheReadsPrice is optional - if not defined, treat as 0
		if (!cacheReadsPrice) {
			cacheReadsPrice = 0
		}

		// Subtract the cached input tokens from the total input tokens.
		const uncachedInputTokens = inputTokens - cacheReadTokens

		// Bill both completion and reasoning ("thoughts") tokens as output.
		const billedOutputTokens = outputTokens + reasoningTokens

		let cacheReadCost = cacheReadTokens > 0 ? cacheReadsPrice * (cacheReadTokens / 1_000_000) : 0

		const inputTokensCost = inputPrice * (uncachedInputTokens / 1_000_000)
		const outputTokensCost = outputPrice * (billedOutputTokens / 1_000_000)
		const totalCost = inputTokensCost + outputTokensCost + cacheReadCost

		const trace: Record<string, { price: number; tokens: number; cost: number }> = {
			input: { price: inputPrice, tokens: uncachedInputTokens, cost: inputTokensCost },
			output: { price: outputPrice, tokens: billedOutputTokens, cost: outputTokensCost },
		}

		if (cacheReadTokens > 0) {
			trace.cacheRead = { price: cacheReadsPrice, tokens: cacheReadTokens, cost: cacheReadCost }
		}

		return totalCost
	}
}
