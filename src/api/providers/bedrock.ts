import {
	BedrockRuntimeClient,
	ConverseStreamCommand,
	ConverseStreamCommandOutput,
	ConverseCommand,
	BedrockRuntimeClientConfig,
	ContentBlock,
	Message,
	SystemContentBlock,
	Tool,
	ToolConfiguration,
	ToolChoice,
} from "@aws-sdk/client-bedrock-runtime"
import OpenAI from "openai"
import { fromIni } from "@aws-sdk/credential-providers"
import { Anthropic } from "@anthropic-ai/sdk"

import {
	type ModelInfo,
	type ProviderSettings,
	type BedrockModelId,
	type BedrockServiceTier,
	bedrockDefaultModelId,
	bedrockModels,
	bedrockDefaultPromptRouterModelId,
	BEDROCK_DEFAULT_TEMPERATURE,
	AWS_INFERENCE_PROFILE_MAPPING,
	BEDROCK_1M_CONTEXT_MODEL_IDS,
	BEDROCK_ADAPTIVE_THINKING_MODEL_IDS,
	BEDROCK_GLOBAL_INFERENCE_MODEL_IDS,
	BEDROCK_NATIVE_1M_CONTEXT_MODEL_IDS,
	BEDROCK_SERVICE_TIER_MODEL_IDS,
	BEDROCK_SERVICE_TIER_PRICING,
	ApiProviderError,
	inferBedrockInvokeTargetKind,
	parseBedrockBaseModelId,
	resolveBedrockModelInfo,
	shouldUseBedrock1MContext,
	stripBedrock1MContextSuffix,
} from "@roo-code/types"
import { TelemetryService } from "@roo-code/telemetry"

import { ApiStream } from "../transform/stream"
import { BaseProvider } from "./base-provider"
import { logger } from "../../utils/logging"
import { Package } from "../../shared/package"
import { MultiPointStrategy } from "../transform/cache-strategy/multi-point-strategy"
import type { ModelInfo as CacheModelInfo, CachePointTtl } from "../transform/cache-strategy/types"
import { convertToBedrockConverseMessages as sharedConverter } from "../transform/bedrock-converse-format"
import { getModelParams } from "../transform/model-params"
import { shouldUseReasoningBudget } from "../../shared/api"
import { normalizeToolSchema, stripBedrockStrictIncompatibleConstraints } from "../../utils/json-schema"
import type { SingleCompletionHandler, ApiHandlerCreateMessageMetadata } from "../index"

/************************************************************************************
 *
 *     TYPES
 *
 *************************************************************************************/

// Define interface for Bedrock inference config
interface BedrockInferenceConfig {
	maxTokens: number
	temperature?: number
}

// Define interface for Bedrock additional model request fields
// This includes thinking configuration, 1M context beta, and other model-specific parameters
//
// Two shapes are supported for the `thinking` field:
//   - Legacy (Claude Sonnet/Opus 4.x, Claude 3.7): { type: "enabled", budget_tokens: N }
//   - Adaptive (Claude Opus 4.7+):                 { type: "adaptive" } paired with a
//     top-level `output_config.effort` string on the payload itself.
interface BedrockAdditionalModelFields {
	thinking?: { type: "enabled"; budget_tokens: number } | { type: "adaptive" }
	anthropic_beta?: string[]
	[key: string]: any // Add index signature to be compatible with DocumentType
}

// Define interface for Bedrock payload
interface BedrockPayload {
	modelId: BedrockModelId | string
	messages: Message[]
	system?: SystemContentBlock[]
	inferenceConfig: BedrockInferenceConfig
	anthropic_version?: string
	additionalModelRequestFields?: BedrockAdditionalModelFields
	toolConfig?: ToolConfiguration
	// Adaptive-thinking models (e.g. Claude Opus 4.7 on Bedrock) use this top-level
	// `output_config.effort` knob instead of the legacy `thinking.budget_tokens` number.
	output_config?: { effort: "low" | "medium" | "high" }
}

/**
 * Map a reasoning budget (in tokens) to a coarse effort bucket for the adaptive
 * thinking payload. Used only when invoking Bedrock models that require the newer
 * `thinking: { type: "adaptive" }` + `output_config.effort` shape.
 *
 * The thresholds mirror the historical budget ranges exposed by the reasoning UI:
 *   <=  4096 tokens → "low"
 *   <= 16384 tokens → "medium"
 *    > 16384 tokens → "high"
 */
function mapReasoningBudgetToBedrockEffort(budget: number | undefined): "low" | "medium" | "high" {
	const b = typeof budget === "number" && Number.isFinite(budget) && budget > 0 ? budget : 0
	if (b <= 4096) return "low"
	if (b <= 16384) return "medium"
	return "high"
}

/**
 * Normalize a freeform reasoning-effort setting string to the three buckets Bedrock
 * accepts on `output_config.effort`. Unknown or disabled values return undefined so
 * the caller can fall back to the budget-derived mapping.
 */
function normalizeReasoningEffortForBedrock(value: unknown): "low" | "medium" | "high" | undefined {
	if (typeof value !== "string") return undefined
	const v = value.toLowerCase()
	if (v === "low" || v === "medium" || v === "high") return v
	if (v === "minimal") return "low"
	return undefined
}

function normalizeBedrockPromptCacheTtl(value: unknown): CachePointTtl | undefined {
	return value === "5m" || value === "1h" ? value : undefined
}

function createBedrockCachePointContentBlock(ttl?: CachePointTtl): ContentBlock {
	return {
		cachePoint: ttl ? { type: "default", ttl } : { type: "default" },
	} as unknown as ContentBlock
}

// Extended payload type that includes service_tier as a top-level parameter
// AWS Bedrock service tiers (STANDARD, FLEX, PRIORITY) are specified at the top level
// https://docs.aws.amazon.com/bedrock/latest/userguide/service-tiers-inference.html
type BedrockPayloadWithServiceTier = BedrockPayload & {
	service_tier?: BedrockServiceTier
}

// Define specific types for content block events to avoid 'as any' usage
// These handle the multiple possible structures returned by AWS SDK
interface ContentBlockStartEvent {
	start?: {
		text?: string
		thinking?: string
		toolUse?: {
			toolUseId?: string
			name?: string
		}
	}
	contentBlockIndex?: number
	// Alternative structure used by some AWS SDK versions
	content_block?: {
		type?: string
		thinking?: string
	}
	// Official AWS SDK structure for reasoning (as documented)
	contentBlock?: {
		type?: string
		thinking?: string
		reasoningContent?: {
			text?: string
		}
		// Tool use block start
		toolUse?: {
			toolUseId?: string
			name?: string
		}
	}
}

interface ContentBlockDeltaEvent {
	delta?: {
		text?: string
		thinking?: string
		type?: string
		// AWS SDK structure for reasoning content deltas
		reasoningContent?: {
			text?: string
		}
		// Tool use input delta
		toolUse?: {
			input?: string
		}
	}
	contentBlockIndex?: number
}

// Define types for stream events based on AWS SDK
export interface StreamEvent {
	messageStart?: {
		role?: string
	}
	messageStop?: {
		stopReason?: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence"
		additionalModelResponseFields?: Record<string, unknown>
	}
	contentBlockStart?: ContentBlockStartEvent
	contentBlockDelta?: ContentBlockDeltaEvent
	metadata?: {
		usage?: {
			inputTokens: number
			outputTokens: number
			totalTokens?: number // Made optional since we don't use it
			// New cache-related fields
			cacheReadInputTokens?: number
			cacheWriteInputTokens?: number
			cacheReadInputTokenCount?: number
			cacheWriteInputTokenCount?: number
		}
		metrics?: {
			latencyMs: number
		}
	}
	// New trace field for prompt router
	trace?: {
		promptRouter?: {
			invokedModelId?: string
			usage?: {
				inputTokens: number
				outputTokens: number
				totalTokens?: number // Made optional since we don't use it
				// New cache-related fields
				cacheReadTokens?: number
				cacheWriteTokens?: number
				cacheReadInputTokenCount?: number
				cacheWriteInputTokenCount?: number
			}
		}
	}
}

// Type for usage information in stream events
export type UsageType = {
	inputTokens?: number
	outputTokens?: number
	cacheReadInputTokens?: number
	cacheWriteInputTokens?: number
	cacheReadInputTokenCount?: number
	cacheWriteInputTokenCount?: number
}

/************************************************************************************
 *
 *     PROVIDER
 *
 *************************************************************************************/

export class AwsBedrockHandler extends BaseProvider implements SingleCompletionHandler {
	protected options: ProviderSettings
	private client: BedrockRuntimeClient
	private arnInfo: any
	private readonly providerName = "Bedrock"

	constructor(options: ProviderSettings) {
		super()
		this.options = options
		let region = this.options.awsRegion

		// process the various user input options, be opinionated about the intent of the options
		// and determine the model to use during inference and for cost calculations
		// There are variations on ARN strings that can be entered making the conditional logic
		// more involved than the non-ARN branch of logic
		if (this.options.awsCustomArn) {
			this.arnInfo = this.parseArn(this.options.awsCustomArn, region)

			if (!this.arnInfo.isValid) {
				logger.error("Invalid ARN format", {
					ctx: "bedrock",
					errorMessage: this.arnInfo.errorMessage,
				})

				// Throw a consistent error with a prefix that can be detected by callers
				const errorMessage =
					this.arnInfo.errorMessage ||
					"Invalid ARN format. ARN should follow the pattern: arn:aws:bedrock:region:account-id:resource-type/resource-name"
				throw new Error("INVALID_ARN_FORMAT:" + errorMessage)
			}

			if (this.arnInfo.region && this.arnInfo.region !== this.options.awsRegion) {
				// Log  if there's a region mismatch between the ARN and the region selected by the user
				// We will use the ARNs region, so execution can continue, but log an info statement.
				// Log a warning if there's a region mismatch between the ARN and the region selected by the user
				// We will use the ARNs region, so execution can continue, but log an info statement.
				logger.info(this.arnInfo.errorMessage, {
					ctx: "bedrock",
					selectedRegion: this.options.awsRegion,
					arnRegion: this.arnInfo.region,
				})

				this.options.awsRegion = this.arnInfo.region
			}

			this.options.apiModelId = this.arnInfo.modelId
			if (this.arnInfo.awsUseCrossRegionInference) this.options.awsUseCrossRegionInference = true
		}

		if (!this.options.modelTemperature) {
			this.options.modelTemperature = BEDROCK_DEFAULT_TEMPERATURE
		}

		this.costModelConfig = this.getModel()

		const clientConfig: BedrockRuntimeClientConfig = {
			userAgentAppId: `RooCode#${Package.version}`,
			region: this.options.awsRegion,
			// Add the endpoint configuration when specified and enabled
			...(this.options.awsBedrockEndpoint &&
				this.options.awsBedrockEndpointEnabled && { endpoint: this.options.awsBedrockEndpoint }),
		}

		if (this.options.awsUseApiKey && this.options.awsApiKey) {
			// Use API key/token-based authentication if enabled and API key is set
			clientConfig.token = { token: this.options.awsApiKey }
			clientConfig.authSchemePreference = ["httpBearerAuth"] // Otherwise there's no end of credential problems.
			clientConfig.requestHandler = {
				// This should be the default anyway, but without setting something
				// this provider fails to work with LiteLLM passthrough.
				requestTimeout: 0,
			}
		} else if (this.options.awsUseProfile && this.options.awsProfile) {
			// Use profile-based credentials if enabled and profile is set
			clientConfig.credentials = fromIni({
				profile: this.options.awsProfile,
				ignoreCache: true,
			})
		} else if (this.options.awsAccessKey && this.options.awsSecretKey) {
			// Use direct credentials if provided
			clientConfig.credentials = {
				accessKeyId: this.options.awsAccessKey,
				secretAccessKey: this.options.awsSecretKey,
				...(this.options.awsSessionToken ? { sessionToken: this.options.awsSessionToken } : {}),
			}
		}

		this.client = new BedrockRuntimeClient(clientConfig)
	}

	override async *createMessage(
		systemPrompt: string,
		messages: Anthropic.Messages.MessageParam[],
		metadata?: ApiHandlerCreateMessageMetadata & {
			thinking?: {
				enabled: boolean
				maxTokens?: number
				maxThinkingTokens?: number
			}
		},
	): ApiStream {
		const modelConfig = this.getModel()
		const usePromptCache = Boolean(
			(this.options.awsUsePromptCache ?? true) && this.supportsAwsPromptCache(modelConfig),
		)

		const conversationId =
			messages.length > 0
				? `conv_${messages[0].role}_${
						typeof messages[0].content === "string"
							? messages[0].content.substring(0, 20)
							: "complex_content"
					}`
				: "default_conversation"

		const formatted = this.convertToBedrockConverseMessages(
			messages,
			systemPrompt,
			usePromptCache,
			modelConfig.info,
			conversationId,
		)

		let additionalModelRequestFields: BedrockAdditionalModelFields | undefined
		let thinkingEnabled = false
		let adaptiveThinkingEffort: "low" | "medium" | "high" | undefined

		// Resolve the base model id first so the thinking branch can decide between the
		// legacy budget_tokens payload and the newer adaptive + output_config.effort payload.
		// parseBaseModelId strips cross-region inference prefixes (e.g. `us.`, `eu.`) and the
		// synthetic `:1m` dropdown suffix.
		const baseModelId = this.parseBaseModelId(modelConfig.id)
		const requiresAdaptiveThinking = BEDROCK_ADAPTIVE_THINKING_MODEL_IDS.includes(baseModelId as any)

		// Determine if thinking should be enabled
		// metadata?.thinking?.enabled: Explicitly enabled through API metadata (direct request)
		// shouldUseReasoningBudget(): Enabled through user settings (enableReasoningEffort = true)
		const isThinkingExplicitlyEnabled = metadata?.thinking?.enabled
		const isThinkingEnabledBySettings =
			shouldUseReasoningBudget({ model: modelConfig.info, settings: this.options }) &&
			modelConfig.reasoning &&
			modelConfig.reasoningBudget

		if ((isThinkingExplicitlyEnabled || isThinkingEnabledBySettings) && modelConfig.info.supportsReasoningBudget) {
			thinkingEnabled = true
			const effectiveBudget = metadata?.thinking?.maxThinkingTokens || modelConfig.reasoningBudget || 4096

			if (requiresAdaptiveThinking) {
				// Newer Claude models on Bedrock (e.g. Opus 4.7) reject the legacy
				// `thinking: { type: "enabled", budget_tokens: N }` shape with:
				//   invalid_request_error: "thinking.type.enabled" is not supported for this model.
				//   Use "thinking.type.adaptive" and "output_config.effort" to control thinking behavior.
				// Honor that by emitting `thinking: { type: "adaptive" }` plus a top-level
				// `output_config.effort`. Effort comes from the user's reasoningEffort setting
				// when present, otherwise we derive it from the token budget.
				adaptiveThinkingEffort =
					normalizeReasoningEffortForBedrock(
						(this.options as ProviderSettings & { reasoningEffort?: unknown }).reasoningEffort,
					) ?? mapReasoningBudgetToBedrockEffort(effectiveBudget)
				additionalModelRequestFields = {
					thinking: { type: "adaptive" },
				}
				logger.info("Adaptive thinking enabled for Bedrock request", {
					ctx: "bedrock",
					modelId: modelConfig.id,
					thinking: additionalModelRequestFields.thinking,
					effort: adaptiveThinkingEffort,
				})
			} else {
				additionalModelRequestFields = {
					thinking: {
						type: "enabled",
						budget_tokens: effectiveBudget,
					},
				}
				logger.info("Extended thinking enabled for Bedrock request", {
					ctx: "bedrock",
					modelId: modelConfig.id,
					thinking: additionalModelRequestFields.thinking,
				})
			}
		}

		const inferenceConfig: BedrockInferenceConfig = {
			maxTokens: modelConfig.maxTokens || (modelConfig.info.maxTokens as number),
			temperature: modelConfig.temperature ?? (this.options.modelTemperature as number),
		}

		// Check if 1M context is enabled for supported Claude 4 models.
		// 1M is enabled when ANY of:
		//   - the configured target id contains the `:1m` / `[1m]` indicator (user picked the
		//     1M variant from the dropdown), OR
		//   - the awsBedrock1MContext opt-in toggle is set by the user.
		const configuredTargetForIndicator =
			this.options.awsBedrockInvokeTarget || this.options.awsCustomArn || modelConfig.id
		const is1MContextEnabled =
			BEDROCK_1M_CONTEXT_MODEL_IDS.includes(baseModelId as any) &&
			shouldUseBedrock1MContext({
				targetId: configuredTargetForIndicator,
				baseModelId,
				optIn1MContext: this.options.awsBedrock1MContext,
			}).enabled

		// AWS Bedrock Converse validates anthropic_beta against a per-model allow list
		// and returns `invalid_request_error: invalid beta flag` for unknown values.
		// Newer Claudes (Opus 4.7) have native 1M context and reject BOTH the 1M beta and
		// the fine-grained-tool-streaming beta, so we must omit anthropic_beta entirely
		// for those models. Older Claudes silently accept (and effectively ignore) them,
		// so we keep the current behavior for them.
		const skipAnthropicBetaFlags = BEDROCK_NATIVE_1M_CONTEXT_MODEL_IDS.includes(baseModelId as any)

		// Determine if service tier should be applied (checked later when building payload)
		const useServiceTier =
			this.options.awsBedrockServiceTier && BEDROCK_SERVICE_TIER_MODEL_IDS.includes(baseModelId as any)
		if (useServiceTier) {
			logger.info("Service tier specified for Bedrock request", {
				ctx: "bedrock",
				modelId: modelConfig.id,
				serviceTier: this.options.awsBedrockServiceTier,
			})
		}

		// Add anthropic_beta headers for various features
		// Start with an empty array and add betas as needed
		const anthropicBetas: string[] = []

		if (!skipAnthropicBetaFlags) {
			// Add 1M context beta if enabled
			if (is1MContextEnabled) {
				anthropicBetas.push("context-1m-2025-08-07")
			}

			// Add fine-grained tool streaming beta for Claude models.
			// This enables proper tool use streaming for Anthropic models on Bedrock.
			if (baseModelId.includes("claude")) {
				anthropicBetas.push("fine-grained-tool-streaming-2025-05-14")
			}
		}

		// Apply anthropic_beta to additionalModelRequestFields if any betas are needed
		if (anthropicBetas.length > 0) {
			if (!additionalModelRequestFields) {
				additionalModelRequestFields = {} as BedrockAdditionalModelFields
			}
			additionalModelRequestFields.anthropic_beta = anthropicBetas
		}

		// Decide whether to attempt strict structured output on this request. The profile
		// toggle defaults to ON (enabled when the setting is missing). Strict is only useful
		// when native tools are present, and we skip it for models we've cached as
		// unsupported (30-day TTL, see bedrock-structured-output-cache helper).
		const profileWantsStructuredOutput = this.options.awsBedrockStructuredOutput ?? true
		const haveNativeTools = (metadata?.tools?.length ?? 0) > 0
		const modelKnownUnsupported = metadata?.isModelStructuredOutputUnsupported?.(modelConfig.id) ?? false
		let useStrictStructuredOutput = profileWantsStructuredOutput && haveNativeTools && !modelKnownUnsupported

		const buildToolConfig = (strict: boolean): ToolConfiguration => ({
			tools: this.convertToolsForBedrock(metadata?.tools ?? [], { strict }),
			toolChoice: this.convertToolChoiceForBedrock(metadata?.tool_choice),
		})

		const buildPayload = (strict: boolean): BedrockPayloadWithServiceTier => ({
			modelId: modelConfig.id,
			messages: formatted.messages,
			system: formatted.system,
			inferenceConfig,
			...(additionalModelRequestFields && { additionalModelRequestFields }),
			// Add anthropic_version at top level when using thinking features
			...(thinkingEnabled && { anthropic_version: "bedrock-2023-05-31" }),
			// Adaptive-thinking models require the effort knob at the top level alongside
			// `thinking: { type: "adaptive" }` inside additionalModelRequestFields.
			...(adaptiveThinkingEffort && { output_config: { effort: adaptiveThinkingEffort } }),
			toolConfig: buildToolConfig(strict),
			// Add service_tier as a top-level parameter (not inside additionalModelRequestFields)
			...(useServiceTier && { service_tier: this.options.awsBedrockServiceTier }),
		})

		let payload: BedrockPayloadWithServiceTier = buildPayload(useStrictStructuredOutput)

		// Schema-compile backoff parameters. AWS docs say first-time compilation can take
		// "up to a few minutes"; we cap total wait at 180s over at most 6 attempts.
		const COMPILE_INITIAL_DELAY_MS = 3000
		const COMPILE_GROWTH_FACTOR = 1.7
		const COMPILE_MAX_STEP_MS = 45_000
		const COMPILE_MAX_TOTAL_MS = 180_000
		const COMPILE_MAX_ATTEMPTS = 6
		let compileAttempts = 0
		let compileCumulativeMs = 0

		// Create AbortController with 10 minute timeout
		const controller = new AbortController()
		let timeoutId: NodeJS.Timeout | undefined

		try {
			timeoutId = setTimeout(
				() => {
					controller.abort()
				},
				10 * 60 * 1000,
			)

			// Retry wrapper for silent recovery from two Bedrock-specific failures at
			// command-send time (before any stream chunks are yielded):
			// 1. STRUCTURED_OUTPUT_UNSUPPORTED (400) — strip strict and retry once
			// 2. STRUCTURED_OUTPUT_COMPILING (400/503) — wait with backoff and retry
			// Other errors (and any error thrown once the stream has started) fall through
			// to the existing error handler below.
			let response: ConverseStreamCommandOutput | undefined
			while (true) {
				try {
					const command = new ConverseStreamCommand(payload)
					response = await this.client.send(command, {
						abortSignal: controller.signal,
					})
					break
				} catch (innerError: unknown) {
					const innerType = this.getErrorType(innerError)

					// STRUCTURED_OUTPUT_UNSUPPORTED: cache the model as unsupported, emit a
					// user-visible notice containing the verbatim Bedrock error, and retry
					// once with strict mode stripped.
					if (innerType === "STRUCTURED_OUTPUT_UNSUPPORTED" && useStrictStructuredOutput) {
						metadata?.markModelStructuredOutputUnsupported?.(modelConfig.id)
						const notice = this.formatErrorMessage(innerError, innerType, true)
						logger.warn(notice, {
							ctx: "bedrock",
							modelId: modelConfig.id,
							errorType: innerType,
							errorMessage: innerError instanceof Error ? innerError.message : String(innerError),
						})
						yield { type: "text", text: notice + "\n" }
						useStrictStructuredOutput = false
						payload = buildPayload(false)
						continue // retry without strict
					}

					// STRUCTURED_OUTPUT_COMPILING: Bedrock is compiling the schema grammar
					// for first-time use. Wait with bounded exponential backoff and poll.
					if (
						innerType === "STRUCTURED_OUTPUT_COMPILING" &&
						compileAttempts < COMPILE_MAX_ATTEMPTS &&
						compileCumulativeMs < COMPILE_MAX_TOTAL_MS
					) {
						const delay = Math.min(
							COMPILE_INITIAL_DELAY_MS * Math.pow(COMPILE_GROWTH_FACTOR, compileAttempts),
							COMPILE_MAX_STEP_MS,
						)
						const waitSec = Math.round(delay / 1000)
						const notice = `Bedrock is compiling the tool schema for ${modelConfig.id}. First-time compilation can take a few minutes. Waiting ${waitSec}s before retry ${compileAttempts + 2}/${COMPILE_MAX_ATTEMPTS + 1}...`
						logger.info(notice, {
							ctx: "bedrock",
							modelId: modelConfig.id,
							errorType: innerType,
							attempt: compileAttempts + 1,
						})
						yield { type: "text", text: notice + "\n" }
						await new Promise<void>((resolve, reject) => {
							const handle = setTimeout(resolve, delay)
							const onAbort = () => {
								clearTimeout(handle)
								reject(new Error("Request aborted while waiting for Bedrock schema compile"))
							}
							if (controller.signal.aborted) {
								clearTimeout(handle)
								reject(new Error("Request aborted before Bedrock schema compile wait"))
							} else {
								controller.signal.addEventListener("abort", onAbort, { once: true })
							}
						})
						compileCumulativeMs += delay
						compileAttempts++
						continue // poll again
					}

					// Any other error — or exhausted retry budgets — propagate to the outer handler.
					throw innerError
				}
			}

			if (!response || !response.stream) {
				clearTimeout(timeoutId)
				throw new Error("No stream available in the response")
			}

			for await (const chunk of response.stream) {
				// Parse the chunk as JSON if it's a string (for tests)
				let streamEvent: StreamEvent
				try {
					streamEvent = typeof chunk === "string" ? JSON.parse(chunk) : (chunk as unknown as StreamEvent)
				} catch (e) {
					logger.error("Failed to parse stream event", {
						ctx: "bedrock",
						error: e instanceof Error ? e : String(e),
						chunk: typeof chunk === "string" ? chunk : "binary data",
					})
					continue
				}

				// Handle metadata events first
				if (streamEvent.metadata?.usage) {
					const usage = (streamEvent.metadata?.usage || {}) as UsageType

					// Check both field naming conventions for cache tokens
					const cacheReadTokens = usage.cacheReadInputTokens || usage.cacheReadInputTokenCount || 0
					const cacheWriteTokens = usage.cacheWriteInputTokens || usage.cacheWriteInputTokenCount || 0

					// Always include all available token information
					yield {
						type: "usage",
						inputTokens: usage.inputTokens || 0,
						outputTokens: usage.outputTokens || 0,
						cacheReadTokens: cacheReadTokens,
						cacheWriteTokens: cacheWriteTokens,
					}
					continue
				}

				if (streamEvent?.trace?.promptRouter?.invokedModelId) {
					try {
						//update the in-use model info to be based on the invoked Model Id for the router
						//so that pricing, context window, caching etc have values that can be used
						//However, we want to keep the id of the model to be the ID for the router for
						//subsequent requests so they are sent back through the router
						let invokedArnInfo = this.parseArn(streamEvent.trace.promptRouter.invokedModelId)
						let invokedModel = this.getModelById(invokedArnInfo.modelId as string, invokedArnInfo.modelType)
						if (invokedModel) {
							invokedModel.id = modelConfig.id
							this.costModelConfig = invokedModel
						}

						// Handle metadata events for the promptRouter.
						if (streamEvent?.trace?.promptRouter?.usage) {
							const routerUsage = streamEvent.trace.promptRouter.usage

							// Check both field naming conventions for cache tokens
							const cacheReadTokens =
								routerUsage.cacheReadTokens || routerUsage.cacheReadInputTokenCount || 0
							const cacheWriteTokens =
								routerUsage.cacheWriteTokens || routerUsage.cacheWriteInputTokenCount || 0

							yield {
								type: "usage",
								inputTokens: routerUsage.inputTokens || 0,
								outputTokens: routerUsage.outputTokens || 0,
								cacheReadTokens: cacheReadTokens,
								cacheWriteTokens: cacheWriteTokens,
							}
						}
					} catch (error) {
						logger.error("Error handling Bedrock invokedModelId", {
							ctx: "bedrock",
							error: error instanceof Error ? error : String(error),
						})
					} finally {
						// eslint-disable-next-line no-unsafe-finally
						continue
					}
				}

				// Handle message start
				if (streamEvent.messageStart) {
					continue
				}

				// Handle content blocks
				if (streamEvent.contentBlockStart) {
					const cbStart = streamEvent.contentBlockStart

					// Check if this is a reasoning block (AWS SDK structure)
					if (cbStart.contentBlock?.reasoningContent) {
						if (cbStart.contentBlockIndex && cbStart.contentBlockIndex > 0) {
							yield { type: "reasoning", text: "\n" }
						}
						yield {
							type: "reasoning",
							text: cbStart.contentBlock.reasoningContent.text || "",
						}
					}
					// Check for thinking block - handle both possible AWS SDK structures
					// cbStart.contentBlock: newer structure
					// cbStart.content_block: alternative structure seen in some AWS SDK versions
					else if (cbStart.contentBlock?.type === "thinking" || cbStart.content_block?.type === "thinking") {
						const contentBlock = cbStart.contentBlock || cbStart.content_block
						if (cbStart.contentBlockIndex && cbStart.contentBlockIndex > 0) {
							yield { type: "reasoning", text: "\n" }
						}
						if (contentBlock?.thinking) {
							yield {
								type: "reasoning",
								text: contentBlock.thinking,
							}
						}
					}
					// Handle tool use block start
					else if (cbStart.start?.toolUse || cbStart.contentBlock?.toolUse) {
						const toolUse = cbStart.start?.toolUse || cbStart.contentBlock?.toolUse
						if (toolUse) {
							yield {
								type: "tool_call_partial",
								index: cbStart.contentBlockIndex ?? 0,
								id: toolUse.toolUseId,
								name: toolUse.name,
								arguments: undefined,
							}
						}
					} else if (cbStart.start?.text) {
						yield {
							type: "text",
							text: cbStart.start.text,
						}
					}
					continue
				}

				// Handle content deltas
				if (streamEvent.contentBlockDelta) {
					const cbDelta = streamEvent.contentBlockDelta
					const delta = cbDelta.delta

					// Process reasoning and text content deltas
					// Multiple structures are supported for AWS SDK compatibility:
					// - delta.reasoningContent.text: AWS docs structure for reasoning
					// - delta.thinking: alternative structure for thinking content
					// - delta.text: standard text content
					// - delta.toolUse.input: tool input arguments
					if (delta) {
						// Check for reasoningContent property (AWS SDK structure)
						if (delta.reasoningContent?.text) {
							yield {
								type: "reasoning",
								text: delta.reasoningContent.text,
							}
							continue
						}

						// Handle tool use input delta
						if (delta.toolUse?.input) {
							yield {
								type: "tool_call_partial",
								index: cbDelta.contentBlockIndex ?? 0,
								id: undefined,
								name: undefined,
								arguments: delta.toolUse.input,
							}
							continue
						}

						// Handle alternative thinking structure (fallback for older SDK versions)
						if (delta.type === "thinking_delta" && delta.thinking) {
							yield {
								type: "reasoning",
								text: delta.thinking,
							}
						} else if (delta.text) {
							yield {
								type: "text",
								text: delta.text,
							}
						}
					}
					continue
				}
				// Handle message stop
				if (streamEvent.messageStop) {
					continue
				}
			}
			// Clear timeout after stream completes
			clearTimeout(timeoutId)
		} catch (error: unknown) {
			// Clear timeout on error
			clearTimeout(timeoutId)

			const telemetryErrorMessage = error instanceof Error ? error.message : String(error)
			const apiError = new ApiProviderError(
				telemetryErrorMessage,
				this.providerName,
				this.getModel().id,
				"createMessage",
			)
			TelemetryService.instance.captureException(apiError)

			// Check if this is a throttling error that should trigger retry logic
			const errorType = this.getErrorType(error)

			// For throttling errors, throw immediately without yielding chunks
			// This allows the retry mechanism in attemptApiRequest() to catch and handle it
			// The retry logic in Task.ts (around line 1817) expects errors to be thrown
			// on the first chunk for proper exponential backoff behavior
			if (errorType === "THROTTLING") {
				if (error instanceof Error) {
					throw error
				} else {
					throw new Error("Throttling error occurred")
				}
			}

			// For non-throttling errors, use the standard error handling with chunks
			const errorChunks = this.handleBedrockError(error, true) // true for streaming context
			// Yield each chunk individually to ensure type compatibility
			for (const chunk of errorChunks) {
				yield chunk as any // Cast to any to bypass type checking since we know the structure is correct
			}

			// Re-throw with enhanced error message for retry system
			const enhancedErrorMessage = this.formatErrorMessage(error, this.getErrorType(error), true)
			if (error instanceof Error) {
				const enhancedError = new Error(enhancedErrorMessage)
				// Preserve important properties from the original error
				enhancedError.name = error.name
				// Validate and preserve status property
				if ("status" in error && typeof (error as any).status === "number") {
					;(enhancedError as any).status = (error as any).status
				}
				// Validate and preserve $metadata property
				if (
					"$metadata" in error &&
					typeof (error as any).$metadata === "object" &&
					(error as any).$metadata !== null
				) {
					;(enhancedError as any).$metadata = (error as any).$metadata
				}
				throw enhancedError
			} else {
				throw new Error("An unknown error occurred")
			}
		}
	}

	async completePrompt(prompt: string): Promise<string> {
		try {
			const modelConfig = this.getModel()

			// For completePrompt, thinking is typically not used, but we should still check
			// if thinking was somehow enabled in the model config
			const thinkingEnabled =
				shouldUseReasoningBudget({ model: modelConfig.info, settings: this.options }) &&
				modelConfig.reasoning &&
				modelConfig.reasoningBudget

			const inferenceConfig: BedrockInferenceConfig = {
				maxTokens: modelConfig.maxTokens || (modelConfig.info.maxTokens as number),
				temperature: modelConfig.temperature ?? (this.options.modelTemperature as number),
			}

			// For completePrompt, use a unique conversation ID based on the prompt
			const conversationId = `prompt_${prompt.substring(0, 20)}`

			const payload = {
				modelId: modelConfig.id,
				messages: this.convertToBedrockConverseMessages(
					[
						{
							role: "user",
							content: prompt,
						},
					],
					undefined,
					false,
					modelConfig.info,
					conversationId,
				).messages,
				inferenceConfig,
			}

			const command = new ConverseCommand(payload)
			const response = await this.client.send(command)

			if (
				response?.output?.message?.content &&
				response.output.message.content.length > 0 &&
				response.output.message.content[0].text &&
				response.output.message.content[0].text.trim().length > 0
			) {
				try {
					return response.output.message.content[0].text
				} catch (parseError) {
					logger.error("Failed to parse Bedrock response", {
						ctx: "bedrock",
						error: parseError instanceof Error ? parseError : String(parseError),
					})
				}
			}
			return ""
		} catch (error) {
			const model = this.getModel()
			const telemetryErrorMessage = error instanceof Error ? error.message : String(error)
			const apiError = new ApiProviderError(telemetryErrorMessage, this.providerName, model.id, "completePrompt")
			TelemetryService.instance.captureException(apiError)

			// Use the extracted error handling method for all errors
			const errorResult = this.handleBedrockError(error, false) // false for non-streaming context
			// Since we're in a non-streaming context, we know the result is a string
			const errorMessage = errorResult as string

			// Create enhanced error for retry system
			const enhancedError = new Error(errorMessage)
			if (error instanceof Error) {
				// Preserve important properties from the original error
				enhancedError.name = error.name
				// Validate and preserve status property
				if ("status" in error && typeof (error as any).status === "number") {
					;(enhancedError as any).status = (error as any).status
				}
				// Validate and preserve $metadata property
				if (
					"$metadata" in error &&
					typeof (error as any).$metadata === "object" &&
					(error as any).$metadata !== null
				) {
					;(enhancedError as any).$metadata = (error as any).$metadata
				}
			}
			throw enhancedError
		}
	}

	/**
	 * Convert Anthropic messages to Bedrock Converse format
	 */
	private convertToBedrockConverseMessages(
		anthropicMessages: Anthropic.Messages.MessageParam[] | { role: string; content: string }[],
		systemMessage?: string,
		usePromptCache: boolean = false,
		modelInfo?: any,
		conversationId?: string, // Optional conversation ID to track cache points across messages
	): { system: SystemContentBlock[]; messages: Message[] } {
		// First convert messages using shared converter for proper image handling
		const convertedMessages = sharedConverter(anthropicMessages as Anthropic.Messages.MessageParam[])

		// If prompt caching is disabled, return the converted messages directly
		if (!usePromptCache) {
			return {
				system: systemMessage ? [{ text: systemMessage } as SystemContentBlock] : [],
				messages: convertedMessages,
			}
		}

		// Convert model info to expected format for cache strategy
		const promptCacheTtl = normalizeBedrockPromptCacheTtl(modelInfo?.promptCacheTtl)
		const cacheModelInfo: CacheModelInfo = {
			maxTokens: modelInfo?.maxTokens || 8192,
			contextWindow: modelInfo?.contextWindow || 200_000,
			supportsPromptCache: modelInfo?.supportsPromptCache || false,
			maxCachePoints: modelInfo?.maxCachePoints || 0,
			minTokensPerCachePoint: modelInfo?.minTokensPerCachePoint || 50,
			cachableFields: modelInfo?.cachableFields || [],
			promptCacheTtl,
		}

		// Get previous cache point placements for this conversation if available
		const previousPlacements =
			conversationId && this.previousCachePointPlacements[conversationId]
				? this.previousCachePointPlacements[conversationId]
				: undefined

		// Create config for cache strategy
		const config = {
			modelInfo: cacheModelInfo,
			systemPrompt: systemMessage,
			messages: anthropicMessages as Anthropic.Messages.MessageParam[],
			usePromptCache,
			previousCachePointPlacements: previousPlacements,
		}

		// Get cache point placements
		let strategy = new MultiPointStrategy(config)
		const cacheResult = strategy.determineOptimalCachePoints()

		// Store cache point placements for future use if conversation ID is provided
		if (conversationId && cacheResult.messageCachePointPlacements) {
			this.previousCachePointPlacements[conversationId] = cacheResult.messageCachePointPlacements
		}

		// Apply cache points to the properly converted messages
		const messagesWithCache = convertedMessages.map((msg, index) => {
			const placement = cacheResult.messageCachePointPlacements?.find((p) => p.index === index)
			if (placement) {
				return {
					...msg,
					content: [...(msg.content || []), createBedrockCachePointContentBlock(promptCacheTtl)],
				}
			}
			return msg
		})

		return {
			system: cacheResult.system,
			messages: messagesWithCache,
		}
	}

	/************************************************************************************
	 *
	 *     MODEL IDENTIFICATION
	 *
	 *************************************************************************************/

	private costModelConfig: { id: BedrockModelId | string; info: ModelInfo } = {
		id: "",
		info: { maxTokens: 0, contextWindow: 0, supportsPromptCache: false, supportsImages: false },
	}

	private parseArn(arn: string, region?: string) {
		/*
		 * VIA Roo analysis: platform-independent Regex. It's designed to parse Amazon Bedrock ARNs and doesn't rely on any platform-specific features
		 * like file path separators, line endings, or case sensitivity behaviors. The forward slashes in the regex are properly escaped and
		 * represent literal characters in the AWS ARN format, not filesystem paths. This regex will function consistently across Windows,
		 * macOS, Linux, and any other operating system where JavaScript runs.
		 *
		 * Supports any AWS partition (aws, aws-us-gov, aws-cn, or future partitions).
		 * The partition is not captured since we don't need to use it.
		 *
		 *  This matches ARNs like:
		 *  - Foundation Model: arn:aws:bedrock:us-west-2::foundation-model/anthropic.claude-v2
		 *  - GovCloud Inference Profile: arn:aws-us-gov:bedrock:us-gov-west-1:123456789012:inference-profile/us-gov.anthropic.claude-sonnet-4-5-20250929-v1:0
		 *  - Prompt Router: arn:aws:bedrock:us-west-2:123456789012:prompt-router/anthropic-claude
		 *  - Inference Profile: arn:aws:bedrock:us-west-2:123456789012:inference-profile/anthropic.claude-v2
		 *  - Cross Region Inference Profile: arn:aws:bedrock:us-west-2:123456789012:inference-profile/us.anthropic.claude-3-5-sonnet-20241022-v2:0
		 *  - Custom Model (Provisioned Throughput): arn:aws:bedrock:us-west-2:123456789012:provisioned-model/my-custom-model
		 *  - Imported Model: arn:aws:bedrock:us-west-2:123456789012:imported-model/my-imported-model
		 *
		 * match[0] - The entire matched string
		 * match[1] - The region (e.g., "us-east-1", "us-gov-west-1")
		 * match[2] - The account ID (can be empty string for AWS-managed resources)
		 * match[3] - The resource type (e.g., "foundation-model")
		 * match[4] - The resource ID (e.g., "anthropic.claude-3-sonnet-20240229-v1:0")
		 */

		const arnRegex = /^arn:[^:]+:(?:bedrock|sagemaker):([^:]+):([^:]*):(?:([^\/]+)\/([\w\.\-:]+)|([^\/]+))$/
		let match = arn.match(arnRegex)

		if (match && match[1] && match[3] && match[4]) {
			// Create the result object
			const result: {
				isValid: boolean
				region?: string
				modelType?: string
				modelId?: string
				errorMessage?: string
				crossRegionInference: boolean
			} = {
				isValid: true,
				crossRegionInference: false, // Default to false
			}

			result.modelType = match[3]
			const originalModelId = match[4]
			result.modelId = this.parseBaseModelId(originalModelId)

			// Extract the region from the first capture group
			const arnRegion = match[1]
			result.region = arnRegion

			// Check if the original model ID had a region prefix
			if (originalModelId && result.modelId !== originalModelId) {
				// If the model ID changed after parsing, it had a region prefix
				let prefix = originalModelId.replace(result.modelId, "")
				result.crossRegionInference = AwsBedrockHandler.isSystemInferenceProfile(prefix)
			}

			// Check if region in ARN matches provided region (if specified)
			if (region && arnRegion !== region) {
				result.errorMessage = `Region mismatch: The region in your ARN (${arnRegion}) does not match your selected region (${region}). This may cause access issues. The provider will use the region from the ARN.`
				result.region = arnRegion
			}

			return result
		}

		// If we get here, the regex didn't match
		return {
			isValid: false,
			region: undefined,
			modelType: undefined,
			modelId: undefined,
			errorMessage: "Invalid ARN format. ARN should follow the Amazon Bedrock ARN pattern.",
			crossRegionInference: false,
		}
	}

	//This strips any region prefix that used on cross-region model inference ARNs
	private parseBaseModelId(modelId: string): string {
		return parseBedrockBaseModelId(modelId)
	}

	//Prompt Router responses come back in a different sequence and the model used is in the response and must be fetched by name
	getModelById(modelId: string, modelType?: string): { id: BedrockModelId | string; info: ModelInfo } {
		let model
		const resolved = resolveBedrockModelInfo({
			baseModelId: this.parseBaseModelId(modelId),
			targetId: modelId,
			optIn1MContext: this.options.awsBedrock1MContext,
			modelMaxTokens: this.options.modelMaxTokens,
			contextWindowOverride: this.options.awsModelContextWindow,
			// Empirically detected per-config max output tokens (from the "Detect" probe in the
			// settings UI) widens the static cap so downstream request builders pick it up too.
			maxOutputTokensOverride: this.options.awsModelMaxOutputTokens,
		})

		if (resolved.baseModelId in bedrockModels) {
			//Do a deep copy of the model info so that later in the code the model id and maxTokens can be set.
			// The bedrockModels array is a constant and updating the model ID from the returned invokedModelID value
			// in a prompt router response isn't possible on the constant.
			model = { id: resolved.baseModelId, info: resolved.info }
		} else if (modelType && modelType.includes("router")) {
			model = {
				id: bedrockDefaultPromptRouterModelId,
				info: JSON.parse(JSON.stringify(bedrockModels[bedrockDefaultPromptRouterModelId])),
			}
		} else {
			model = {
				id: resolved.baseModelId || bedrockDefaultModelId,
				info: resolved.info,
			}
		}

		return model
	}

	override getModel(): {
		id: BedrockModelId | string
		info: ModelInfo
		maxTokens?: number
		temperature?: number
		reasoning?: any
		reasoningBudget?: number
	} {
		if (this.costModelConfig?.id?.trim().length > 0) {
			// Get model params for cost model config
			const params = getModelParams({
				format: "anthropic",
				modelId: this.costModelConfig.id,
				model: this.costModelConfig.info,
				settings: this.options,
				defaultTemperature: BEDROCK_DEFAULT_TEMPERATURE,
			})
			return { ...this.costModelConfig, ...params }
		}

		let modelConfig = undefined
		const explicitTargetKind = this.options.awsCustomArn
			? "custom-arn"
			: inferBedrockInvokeTargetKind({
					targetId: this.options.awsBedrockInvokeTarget || (this.options.apiModelId as string),
					explicitKind: this.options.awsBedrockTargetKind,
				})

		// If custom ARN is provided, use it
		if (this.options.awsCustomArn) {
			modelConfig = this.getModelById(this.arnInfo.modelId, this.arnInfo.modelType)

			//If the user entered an ARN for a foundation-model they've done the same thing as picking from our list of options.
			//We leave the model data matching the same as if a drop-down input method was used by not overwriting the model ID with the user input ARN
			//Otherwise the ARN is not a foundation-model resource type that ARN should be used as the identifier in Bedrock interactions
			if (this.arnInfo.modelType !== "foundation-model") modelConfig.id = this.options.awsCustomArn
		} else {
			const configuredTargetId = this.options.awsBedrockInvokeTarget || (this.options.apiModelId as string)

			// A discovered/profile target was explicitly selected, so invoke it directly.
			if (
				explicitTargetKind === "system-profile" ||
				explicitTargetKind === "application-profile" ||
				explicitTargetKind === "prompt-router"
			) {
				modelConfig = this.getModelById(configuredTargetId)
				// Strip any synthetic `:1m` (or `[1m]`) suffix before sending to AWS.
				// The suffix is purely a UI marker for the 1M-context variant and is not
				// a real part of the AWS inference profile / foundation model id.
				// The 1M context-window and `context-1m-2025-08-07` beta header have
				// already been applied inside getModelById via resolveBedrockModelInfo.
				modelConfig.id = stripBedrock1MContextSuffix(configuredTargetId)
			} else {
				// A foundation model was selected, so optional routing toggles still apply.
				modelConfig = this.getModelById(configuredTargetId)

				// Apply Global Inference prefix if enabled and supported (takes precedence over cross-region)
				const baseIdForGlobal = this.parseBaseModelId(modelConfig.id)
				if (
					this.options.awsUseGlobalInference &&
					BEDROCK_GLOBAL_INFERENCE_MODEL_IDS.includes(baseIdForGlobal as any)
				) {
					modelConfig.id = `global.${baseIdForGlobal}`
				}
				// Otherwise, add cross-region inference prefix if enabled
				else if (this.options.awsUseCrossRegionInference && this.options.awsRegion) {
					const prefix = AwsBedrockHandler.getPrefixForRegion(this.options.awsRegion)
					if (prefix) {
						modelConfig.id = `${prefix}${modelConfig.id}`
					}
				}
			}
		}

		// Check if 1M context is enabled for supported Claude 4 models
		// Use parseBaseModelId to handle cross-region inference prefixes
		const baseModelId = this.parseBaseModelId(modelConfig.id)
		if (BEDROCK_1M_CONTEXT_MODEL_IDS.includes(baseModelId as any) && this.options.awsBedrock1MContext) {
			// Update context window and pricing to 1M tier when 1M context beta is enabled
			const tier = modelConfig.info.tiers?.[0]
			modelConfig.info = {
				...modelConfig.info,
				contextWindow: tier?.contextWindow ?? 1_000_000,
				inputPrice: tier?.inputPrice ?? modelConfig.info.inputPrice,
				outputPrice: tier?.outputPrice ?? modelConfig.info.outputPrice,
				cacheWritesPrice: tier?.cacheWritesPrice ?? modelConfig.info.cacheWritesPrice,
				cacheReadsPrice: tier?.cacheReadsPrice ?? modelConfig.info.cacheReadsPrice,
			}
		}

		// Get model params including reasoning configuration
		const params = getModelParams({
			format: "anthropic",
			modelId: modelConfig.id,
			model: modelConfig.info,
			settings: this.options,
			defaultTemperature: BEDROCK_DEFAULT_TEMPERATURE,
		})

		// Apply service tier pricing if specified and model supports it
		const baseModelIdForTier = this.parseBaseModelId(modelConfig.id)
		if (this.options.awsBedrockServiceTier && BEDROCK_SERVICE_TIER_MODEL_IDS.includes(baseModelIdForTier as any)) {
			const pricingMultiplier = BEDROCK_SERVICE_TIER_PRICING[this.options.awsBedrockServiceTier]
			if (pricingMultiplier && pricingMultiplier !== 1.0) {
				// Apply pricing multiplier to all price fields
				modelConfig.info = {
					...modelConfig.info,
					inputPrice: modelConfig.info.inputPrice
						? modelConfig.info.inputPrice * pricingMultiplier
						: undefined,
					outputPrice: modelConfig.info.outputPrice
						? modelConfig.info.outputPrice * pricingMultiplier
						: undefined,
					cacheWritesPrice: modelConfig.info.cacheWritesPrice
						? modelConfig.info.cacheWritesPrice * pricingMultiplier
						: undefined,
					cacheReadsPrice: modelConfig.info.cacheReadsPrice
						? modelConfig.info.cacheReadsPrice * pricingMultiplier
						: undefined,
				}
			}
		}

		// Don't override maxTokens/contextWindow here; handled in getModelById (and includes user overrides)
		return { ...modelConfig, ...params } as {
			id: BedrockModelId | string
			info: ModelInfo
			maxTokens?: number
			temperature?: number
			reasoning?: any
			reasoningBudget?: number
		}
	}

	/************************************************************************************
	 *
	 *     CACHE
	 *
	 *************************************************************************************/

	// Store previous cache point placements for maintaining consistency across consecutive messages
	private previousCachePointPlacements: { [conversationId: string]: any[] } = {}

	private supportsAwsPromptCache(modelConfig: { id: BedrockModelId | string; info: ModelInfo }): boolean | undefined {
		// Check if the model supports prompt cache
		// The cachableFields property is not part of the ModelInfo type in schemas
		// but it's used in the bedrockModels object in shared/api.ts
		return (
			modelConfig?.info?.supportsPromptCache &&
			// Use optional chaining and type assertion to access cachableFields
			(modelConfig?.info as any)?.cachableFields &&
			(modelConfig?.info as any)?.cachableFields?.length > 0
		)
	}

	/**
	 * Removes any existing cachePoint nodes from content blocks
	 */
	private removeCachePoints(content: any): any {
		if (Array.isArray(content)) {
			return content.map((block) => {
				// Use destructuring to remove cachePoint property
				const { cachePoint: _, ...rest } = block
				return rest
			})
		}

		return content
	}

	/************************************************************************************
	 *
	 *     NATIVE TOOLS
	 *
	 *************************************************************************************/

	/**
	 * Convert OpenAI tool definitions to Bedrock Converse format
	 * Transforms JSON Schema to draft 2020-12 compliant format required by Claude models.
	 * When `opts.strict` is true, sets `strict: true` on each toolSpec so Bedrock enforces
	 * the tool input schema (structured output). Models that don't support strict return a
	 * 400 ValidationException; the caller is responsible for detecting that and retrying.
	 * @param tools Array of OpenAI ChatCompletionTool definitions
	 * @param opts Configuration options; `strict` enables Bedrock strict structured output.
	 * @returns Array of Bedrock Tool definitions
	 */
	private convertToolsForBedrock(
		tools: OpenAI.Chat.ChatCompletionTool[],
		opts: { strict: boolean } = { strict: false },
	): Tool[] {
		return tools
			.filter((tool) => tool.type === "function")
			.map((tool) => {
				// The AWS SDK's `ToolSpecification` type doesn't yet expose the `strict` field,
				// so we build it as a locally-typed object and cast. The field is supported by
				// the Converse API for models that advertise structured-output capability.
				// Normalize schema to JSON Schema draft 2020-12 compliant format.
				// Then, when strict is enabled, strip Bedrock-incompatible constraints
				// (numeric `minimum`/`maximum`/etc., array `maxItems`, array `minItems > 1`)
				// that Bedrock strict mode rejects even on supported models. Stripped values
				// are appended to the schema's description so the model still sees them as hints.
				let inputSchemaJson = normalizeToolSchema(tool.function.parameters as Record<string, unknown>)
				if (opts.strict) {
					inputSchemaJson = stripBedrockStrictIncompatibleConstraints(inputSchemaJson)
				}
				const toolSpec: {
					name: string
					description?: string
					inputSchema: { json: Record<string, unknown> }
					strict?: boolean
				} = {
					name: tool.function.name,
					description: tool.function.description,
					inputSchema: {
						json: inputSchemaJson,
					},
				}
				if (opts.strict) {
					toolSpec.strict = true
				}
				return { toolSpec } as unknown as Tool
			})
	}

	/**
	 * Convert OpenAI tool_choice to Bedrock ToolChoice format
	 * @param toolChoice OpenAI tool_choice parameter
	 * @returns Bedrock ToolChoice configuration
	 */
	private convertToolChoiceForBedrock(
		toolChoice: OpenAI.Chat.ChatCompletionCreateParams["tool_choice"],
	): ToolChoice | undefined {
		if (!toolChoice) {
			// Default to auto - model decides whether to use tools
			return { auto: {} } as ToolChoice
		}

		if (typeof toolChoice === "string") {
			switch (toolChoice) {
				case "none":
					return undefined // Bedrock doesn't have "none", just omit tools
				case "auto":
					return { auto: {} } as ToolChoice
				case "required":
					return { any: {} } as ToolChoice // Model must use at least one tool
				default:
					return { auto: {} } as ToolChoice
			}
		}

		// Handle object form { type: "function", function: { name: string } }
		if (typeof toolChoice === "object" && "function" in toolChoice) {
			return {
				tool: {
					name: toolChoice.function.name,
				},
			} as ToolChoice
		}

		return { auto: {} } as ToolChoice
	}

	/************************************************************************************
	 *
	 *     AMAZON REGIONS
	 *
	 *************************************************************************************/

	private static getPrefixForRegion(region: string): string | undefined {
		// Use AWS recommended inference profile prefixes
		// Array is pre-sorted by pattern length (descending) to ensure more specific patterns match first
		for (const [regionPattern, inferenceProfile] of AWS_INFERENCE_PROFILE_MAPPING) {
			if (region.startsWith(regionPattern)) {
				return inferenceProfile
			}
		}

		return undefined
	}

	private static isSystemInferenceProfile(prefix: string): boolean {
		// Check if the prefix is defined in AWS_INFERENCE_PROFILE_MAPPING
		for (const [_, inferenceProfile] of AWS_INFERENCE_PROFILE_MAPPING) {
			if (prefix === inferenceProfile) {
				return true
			}
		}
		return false
	}

	/************************************************************************************
	 *
	 *     ERROR HANDLING
	 *
	 *************************************************************************************/

	/**
	 * Error type definitions for Bedrock API errors
	 */
	private static readonly ERROR_TYPES: Record<
		string,
		{
			patterns: string[] // Strings to match in lowercase error message or name
			messageTemplate: string // Template with placeholders like {region}, {modelId}, etc.
			logLevel: "error" | "warn" | "info" // Log level for this error type
		}
	> = {
		ACCESS_DENIED: {
			patterns: ["access", "denied", "permission"],
			messageTemplate: `You don't have access to the model specified.

Please verify:
1. Try cross-region inference if you're using a foundation model
2. If using an ARN, verify the ARN is correct and points to a valid model
3. Your AWS credentials have permission to access this model (check IAM policies)
4. The region in the ARN matches the region where the model is deployed
5. If using a provisioned model, ensure it's active and not in a failed state`,
			logLevel: "error",
		},
		NOT_FOUND: {
			patterns: ["not found", "does not exist"],
			messageTemplate: `The specified ARN does not exist or is invalid. Please check:

1. The ARN format is correct (arn:aws:bedrock:region:account-id:resource-type/resource-name)
2. The model exists in the specified region
3. The account ID in the ARN is correct`,
			logLevel: "error",
		},
		THROTTLING: {
			patterns: [
				"throttl",
				"rate",
				"limit",
				"bedrock is unable to process your request", // Amazon Bedrock specific throttling message
				"please wait",
				"quota exceeded",
				"service unavailable",
				"busy",
				"overloaded",
				"too many requests",
				"request limit",
				"concurrent requests",
			],
			messageTemplate: `Request was throttled or rate limited. Please try:
1. Reducing the frequency of requests
2. If using a provisioned model, check its throughput settings
3. Contact AWS support to request a quota increase if needed

`,
			logLevel: "error",
		},
		TOO_MANY_TOKENS: {
			patterns: ["too many tokens", "token limit exceeded", "context length", "maximum context length"],
			messageTemplate: `"Too many tokens" error detected.
Possible Causes:
1. Input exceeds model's context window limit
2. Rate limiting (too many tokens per minute)
3. Quota exceeded for token usage
4. Other token-related service limitations

Suggestions:
1. Reduce the size of your input
2. Split your request into smaller chunks
3. Use a model with a larger context window
4. If rate limited, reduce request frequency
5. Check your Amazon Bedrock quotas and limits

`,
			logLevel: "error",
		},
		SERVICE_QUOTA_EXCEEDED: {
			patterns: ["service quota exceeded", "service quota", "quota exceeded for model"],
			messageTemplate: `Service quota exceeded. This error indicates you've reached AWS service limits.

Please try:
1. Contact AWS support to request a quota increase
2. Reduce request frequency temporarily
3. Check your Amazon Bedrock quotas in the AWS console
4. Consider using a different model or region with available capacity

`,
			logLevel: "error",
		},
		MODEL_NOT_READY: {
			patterns: ["model not ready", "model is not ready", "provisioned throughput not ready", "model loading"],
			messageTemplate: `Model is not ready or still loading. This can happen with:
1. Provisioned throughput models that are still initializing
2. Custom models that are being loaded
3. Models that are temporarily unavailable

Please try:
1. Wait a few minutes and retry
2. Check the model status in Amazon Bedrock console
3. Verify the model is properly provisioned

`,
			logLevel: "error",
		},
		INTERNAL_SERVER_ERROR: {
			patterns: ["internal server error", "internal error", "server error", "service error"],
			messageTemplate: `Amazon Bedrock internal server error. This is a temporary service issue.

Please try:
1. Retry the request after a brief delay
2. If the error persists, check AWS service health
3. Contact AWS support if the issue continues

`,
			logLevel: "error",
		},
		ON_DEMAND_NOT_SUPPORTED: {
			patterns: ["with on-demand throughput isn’t supported."],
			messageTemplate: `
1. Try enabling cross-region inference in settings.
2. Or, create an inference profile and then leverage the "Use custom ARN..." option of the model selector in settings.`,
			logLevel: "error",
		},
		ABORT: {
			patterns: ["aborterror"], // This will match error.name.toLowerCase() for AbortError
			messageTemplate: `Request was aborted: The operation timed out or was manually cancelled. Please try again or check your network connection.`,
			logLevel: "info",
		},
		INVALID_ARN_FORMAT: {
			patterns: ["invalid_arn_format:", "invalid arn format"],
			messageTemplate: `Invalid ARN format. ARN should follow the pattern: arn:aws:bedrock:region:account-id:resource-type/resource-name`,
			logLevel: "error",
		},
		VALIDATION_ERROR: {
			patterns: [
				"input tag",
				"does not match any of the expected tags",
				"field required",
				"validation",
				"invalid parameter",
			],
			messageTemplate: `Parameter validation error: {errorMessage}

This error indicates that the request parameters don't match Amazon Bedrock's expected format.

Common causes:
1. Extended thinking parameter format is incorrect
2. Model-specific parameters are not supported by this model
3. API parameter structure has changed

Please check:
- Model supports the requested features (extended thinking, etc.)
- Parameter format matches Amazon Bedrock specification
- Model ID is correct for the requested features`,
			logLevel: "error",
		},
		STRUCTURED_OUTPUT_UNSUPPORTED: {
			patterns: [
				"does not support strict",
				"strict is not supported",
				"strict schema is not supported",
				"structured output is not supported",
				"strict tool",
				"strict mode is not supported",
				"strict: true",
				"textformat is not supported",
				"output_config is not supported",
				"outputconfig.textformat",
			],
			messageTemplate: `Model {modelId} does not appear to support strict structured output. Bedrock returned: {errorMessage}. Disabling structured output for this model for 30 days; retrying without strict mode.`,
			logLevel: "warn",
		},
		STRUCTURED_OUTPUT_COMPILING: {
			patterns: [
				"schema is being compiled",
				"schema compilation in progress",
				"compiling schema",
				"compiling grammar",
				"grammar compilation",
				"schema is being prepared",
				"schema compile",
			],
			messageTemplate: `Bedrock is compiling the tool schema for {modelId}. First-time compilation can take a few minutes. Waiting and retrying...`,
			logLevel: "info",
		},
		// Default/generic error
		GENERIC: {
			patterns: [], // Empty patterns array means this is the default
			messageTemplate: `Unknown Error: {errorMessage}`,
			logLevel: "error",
		},
	}

	/**
	 * Determines the error type based on the error message or name
	 */
	private getErrorType(error: unknown): string {
		if (!(error instanceof Error)) {
			return "GENERIC"
		}

		// Check for HTTP 429 status code (Too Many Requests)
		if ((error as any).status === 429 || (error as any).$metadata?.httpStatusCode === 429) {
			return "THROTTLING"
		}

		// Check for Amazon Bedrock specific throttling exception names
		if ((error as any).name === "ThrottlingException" || (error as any).__type === "ThrottlingException") {
			return "THROTTLING"
		}

		const errorMessage = error.message.toLowerCase()
		const errorName = error.name.toLowerCase()
		const httpStatus =
			typeof (error as any).status === "number"
				? (error as any).status
				: typeof (error as any).$metadata?.httpStatusCode === "number"
					? (error as any).$metadata.httpStatusCode
					: undefined

		// Structured output errors are checked first so they don't get swallowed by the
		// broad VALIDATION_ERROR / INTERNAL_SERVER_ERROR patterns. Gated by HTTP status
		// to avoid misclassifying unrelated 4xx/5xx errors that happen to mention "schema".
		if (httpStatus === 400 || httpStatus === undefined) {
			const structuredUnsupported = AwsBedrockHandler.ERROR_TYPES.STRUCTURED_OUTPUT_UNSUPPORTED
			if (
				structuredUnsupported.patterns.some(
					(pattern) => errorMessage.includes(pattern) || errorName.includes(pattern),
				)
			) {
				return "STRUCTURED_OUTPUT_UNSUPPORTED"
			}
		}
		if (httpStatus === 400 || httpStatus === 503 || httpStatus === undefined) {
			const structuredCompiling = AwsBedrockHandler.ERROR_TYPES.STRUCTURED_OUTPUT_COMPILING
			if (
				structuredCompiling.patterns.some(
					(pattern) => errorMessage.includes(pattern) || errorName.includes(pattern),
				)
			) {
				return "STRUCTURED_OUTPUT_COMPILING"
			}
		}

		// Check each error type's patterns in order of specificity (most specific first)
		const errorTypeOrder = [
			"SERVICE_QUOTA_EXCEEDED", // Most specific - check before THROTTLING
			"MODEL_NOT_READY",
			"TOO_MANY_TOKENS",
			"INTERNAL_SERVER_ERROR",
			"ON_DEMAND_NOT_SUPPORTED",
			"NOT_FOUND",
			"ACCESS_DENIED",
			"THROTTLING", // Less specific - check after more specific patterns
		]

		for (const errorType of errorTypeOrder) {
			const definition = AwsBedrockHandler.ERROR_TYPES[errorType]
			if (!definition) continue

			// If any pattern matches in either message or name, return this error type
			if (definition.patterns.some((pattern) => errorMessage.includes(pattern) || errorName.includes(pattern))) {
				return errorType
			}
		}

		// Default to generic error
		return "GENERIC"
	}

	/**
	 * Formats an error message based on the error type and context
	 */
	private formatErrorMessage(error: unknown, errorType: string, _isStreamContext: boolean): string {
		const definition = AwsBedrockHandler.ERROR_TYPES[errorType] || AwsBedrockHandler.ERROR_TYPES.GENERIC
		let template = definition.messageTemplate

		// Prepare template variables
		const templateVars: Record<string, string> = {}

		if (error instanceof Error) {
			templateVars.errorMessage = error.message
			templateVars.errorName = error.name

			const modelConfig = this.getModel()
			templateVars.modelId = modelConfig.id
			templateVars.contextWindow = String(modelConfig.info.contextWindow || "unknown")
		}

		// Add context-specific template variables
		const region =
			typeof this?.client?.config?.region === "function"
				? this?.client?.config?.region()
				: this?.client?.config?.region
		templateVars.regionInfo = `(${region})`

		// Replace template variables
		for (const [key, value] of Object.entries(templateVars)) {
			template = template.replace(new RegExp(`{${key}}`, "g"), value || "")
		}

		return template
	}

	/**
	 * Handles Bedrock API errors and generates appropriate error messages
	 * @param error The error that occurred
	 * @param isStreamContext Whether the error occurred in a streaming context (true) or not (false)
	 * @returns Error message string for non-streaming context or array of stream chunks for streaming context
	 */
	private handleBedrockError(
		error: unknown,
		isStreamContext: boolean,
	): string | Array<{ type: string; text?: string; inputTokens?: number; outputTokens?: number }> {
		// Determine error type
		const errorType = this.getErrorType(error)

		// Format error message
		const errorMessage = this.formatErrorMessage(error, errorType, isStreamContext)

		// Log the error
		const definition = AwsBedrockHandler.ERROR_TYPES[errorType]
		const logMethod = definition.logLevel
		const contextName = isStreamContext ? "createMessage" : "completePrompt"
		logger[logMethod](`${errorType} error in ${contextName}`, {
			ctx: "bedrock",
			customArn: this.options.awsCustomArn,
			errorType,
			errorMessage: error instanceof Error ? error.message : String(error),
			...(error instanceof Error && error.stack ? { errorStack: error.stack } : {}),
			...(this.client?.config?.region ? { clientRegion: this.client.config.region } : {}),
		})

		// Return appropriate response based on isStreamContext
		if (isStreamContext) {
			return [
				{ type: "text", text: `Error: ${errorMessage}` },
				{ type: "usage", inputTokens: 0, outputTokens: 0 },
			]
		} else {
			// For non-streaming context, add the expected prefix
			return `Bedrock completion error: ${errorMessage}`
		}
	}
}
