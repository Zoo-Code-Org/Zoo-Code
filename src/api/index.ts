import { Anthropic } from "@anthropic-ai/sdk"
import OpenAI from "openai"

import {
	isRetiredProvider,
	providerIdentifiers,
	retiredProviderIdentifiers,
	type ProviderSettings,
	type ModelInfo,
	type ResolvedToolCallPolicy,
	type ModelToolCallCapabilities,
} from "@roo-code/types"

import { getRouterRemovalMessage } from "../core/config/routerRemoval"
import { ApiStream } from "./transform/stream"

import {
	AnthropicHandler,
	AwsBedrockHandler,
	OpenRouterHandler,
	PoeHandler,
	VertexHandler,
	AnthropicVertexHandler,
	OpenAiHandler,
	OpenAiCodexHandler,
	LmStudioHandler,
	GeminiHandler,
	OpenAiNativeHandler,
	DeepSeekHandler,
	MoonshotHandler,
	KimiCodeHandler,
	MistralHandler,
	VsCodeLmHandler,
	RequestyHandler,
	UnboundHandler,
	FakeAIHandler,
	XAIHandler,
	LiteLLMHandler,
	QwenCodeHandler,
	SambaNovaHandler,
	ZAiHandler,
	FireworksHandler,
	FriendliHandler,
	VercelAiGatewayHandler,
	OpencodeGoHandler,
	KenariHandler,
	ZooGatewayHandler,
	MiniMaxHandler,
	MimoHandler,
	BasetenHandler,
} from "./providers"
import { NativeOllamaHandler } from "./providers/native-ollama"

/**
 * Options for completePrompt — unified with ApiHandlerCreateMessageMetadata.
 * Uses abortSignal (not signal) to match the metadata pattern used in stream path.
 */
export interface CompletePromptOptions extends Pick<ApiHandlerCreateMessageMetadata, "abortSignal"> {
	/** Optional timeout override (ms) — falls back to provider default if omitted */
	timeoutMs?: number
}

export interface SingleCompletionHandler {
	completePrompt(prompt: string, options?: CompletePromptOptions): Promise<string>
}

export interface ApiHandlerCreateMessageMetadata {
	/**
	 * Task ID used for tracking and provider-specific features:
	 * - Roo: Sent as X-Roo-Task-ID header
	 * - Requesty: Sent as trace_id
	 */
	taskId: string
	/**
	 * Current mode slug for provider-specific tracking:
	 * - Requesty: Sent in extra metadata
	 */
	mode?: string
	suppressPreviousResponseId?: boolean
	/**
	 * Controls whether the response should be stored for 30 days in OpenAI's Responses API.
	 * When true (default), responses are stored and can be referenced in future requests
	 * using the previous_response_id for efficient conversation continuity.
	 * Set to false to opt out of response storage for privacy or compliance reasons.
	 * @default true
	 */
	store?: boolean
	/**
	 * Optional array of tool definitions to pass to the model.
	 * For OpenAI-compatible providers, these are ChatCompletionTool definitions.
	 */
	tools?: OpenAI.Chat.ChatCompletionTool[]
	/**
	 * Controls which (if any) tool is called by the model.
	 * Can be "none", "auto", "required", or a specific tool choice.
	 */
	tool_choice?: OpenAI.Chat.ChatCompletionCreateParams["tool_choice"]
	/**
	 * Controls whether the model can return multiple tool calls in a single response.
	 * When true (default), parallel tool calls are enabled (OpenAI's parallel_tool_calls=true).
	 * When false, only one tool call is returned per response.
	 */
	parallelToolCalls?: boolean
	/**
	 * Optional array of tool names that the model is allowed to call.
	 * When provided, all tool definitions are passed to the model (so it can reference
	 * historical tool calls), but only the specified tools can actually be invoked.
	 * This is used when switching modes to prevent model errors from missing tool
	 * definitions while still restricting callable tools to the current mode's permissions.
	 * Only applies to providers that support function calling restrictions (e.g., Gemini).
	 */
	allowedFunctionNames?: string[]
	/**
	 * Abort signal for cancelling the HTTP request mid-stream.
	 * Passed through to AI SDK's streamText() so the underlying HTTP request is aborted
	 * when the user clicks stop, preventing wasted API tokens/compute on the provider side.
	 */
	abortSignal?: AbortSignal
}

export interface ApiHandler {
	createMessage(
		systemPrompt: string,
		messages: Anthropic.Messages.MessageParam[],
		metadata?: ApiHandlerCreateMessageMetadata,
	): ApiStream

	getModel(): { id: string; info: ModelInfo }

	/**
	 * Ensures model metadata has been fetched from the remote API so that getModel()
	 * returns accurate info (context window, pricing, etc.) instead of hardcoded defaults.
	 * Only router providers that discover models over the network implement this.
	 */
	ensureModelFetched?(): Promise<void>

	/**
	 * Optional context window for context-management / auto-condense when it must differ from
	 * getModel().info.contextWindow. Only VS Code LM overrides it (static `maxInputTokens` vs its
	 * inflated live window); others leave it undefined and callers fall back.
	 */
	getCondenseContextWindow?(): number

	/**
	 * Counts tokens for content blocks
	 * All providers extend BaseProvider which provides a default tiktoken implementation,
	 * but they can override this to use their native token counting endpoints
	 *
	 * @param content The content to count tokens for
	 * @returns A promise resolving to the token count
	 */
	countTokens(content: Array<Anthropic.Messages.ContentBlockParam>): Promise<number>
}

/**
 * Providers that use the OpenAI-compatible API format and natively support
 * parallel tool calls via the `parallel_tool_calls` request field.
 * When a model from one of these providers has no explicit
 * `toolCallCapabilities`, we preserve the pre-existing parallel behavior.
 */
const OPENAI_COMPATIBLE_PARALLEL_PROVIDERS = new Set<string>([
	"openai",
	"openai-native",
	"openai-codex",
	"openrouter",
	"deepseek",
	"qwen-code",
	"moonshot",
	"kimi-code",
	"mistral",
	"requesty",
	"unbound",
	"xai",
	"litellm",
	"sambanova",
	"zai",
	"fireworks",
	"friendli",
	"vercel-ai-gateway",
	"opencode-go",
	"kenari",
	"zoo-gateway",
	"minimax",
	"baseten",
	"poe",
])

/**
 * Providers that use the Anthropic API format and natively support
 * parallel tool calls via `disable_parallel_tool_use`.
 * When a model from one of these providers has no explicit
 * `toolCallCapabilities`, we preserve the pre-existing parallel behavior.
 */
const ANTHROPIC_PARALLEL_PROVIDERS = new Set<string>(["anthropic", "bedrock", "vertex"])

/**
 * Resolve the tool-call policy for a given model and provider.
 *
 * This is a pure function: given the model info and provider name, it returns
 * a {@link ResolvedToolCallPolicy} that describes whether parallel tool calls
 * should be enabled, the max calls per turn, and how enforcement is applied.
 *
 * Resolution logic:
 * 1. If the model declares `toolCallCapabilities` with `supportsParallelToolCalls: false`,
 *    the policy is "single" with local enforcement (and provider enforcement when
 *    the request control is not "none").
 * 2. If the model declares `supportsParallelToolCalls: true` with a known request
 *    control ("openai" or "anthropic"), the policy is "parallel" with provider enforcement.
 * 3. If capabilities are unknown or absent:
 *    a. If the provider is known to be OpenAI-compatible or Anthropic, preserve
 *       the pre-existing parallel behavior (parallel, unbounded, provider enforcement).
 *    b. Otherwise (e.g. mimo, unknown providers), apply a conservative "single"
 *       default with local enforcement to prevent malformed parallel calls.
 *
 * @param modelInfo - The ModelInfo for the active model.
 * @param providerName - The provider identifier string (e.g. "mimo", "anthropic", "openai").
 * @returns A resolved tool-call policy.
 */
export function resolveToolCallPolicy(modelInfo: ModelInfo, providerName?: string): ResolvedToolCallPolicy {
	const capabilities: ModelToolCallCapabilities | undefined = modelInfo.toolCallCapabilities

	// Case 1: Model explicitly declares it does NOT support parallel tool calls.
	if (capabilities && capabilities.supportsParallelToolCalls === false) {
		const enforcement = capabilities.parallelToolCallsRequestControl === "none" ? "local" : "provider-and-local"
		return {
			generation: "single",
			maxCallsPerTurn: 1,
			enforcement,
			source: "model-capability",
		}
	}

	// Case 2: Model explicitly declares it DOES support parallel tool calls
	// and has a known request control mechanism.
	if (
		capabilities &&
		capabilities.supportsParallelToolCalls === true &&
		(capabilities.parallelToolCallsRequestControl === "openai" ||
			capabilities.parallelToolCallsRequestControl === "anthropic")
	) {
		return {
			generation: "parallel",
			maxCallsPerTurn: "unbounded",
			enforcement: "provider",
			source: "model-capability",
		}
	}

	// Case 3: Unknown or absent capabilities — use provider-based fallback.
	// Known-parallel providers (OpenAI-compatible and Anthropic) preserve their
	// pre-existing parallel behavior. Unknown or explicitly non-parallel providers
	// (e.g. mimo) get a conservative single-call default.
	if (providerName && OPENAI_COMPATIBLE_PARALLEL_PROVIDERS.has(providerName)) {
		return {
			generation: "parallel",
			maxCallsPerTurn: "unbounded",
			enforcement: "provider",
			source: "provider-default",
		}
	}

	if (providerName && ANTHROPIC_PARALLEL_PROVIDERS.has(providerName)) {
		return {
			generation: "parallel",
			maxCallsPerTurn: "unbounded",
			enforcement: "provider",
			source: "provider-default",
		}
	}

	// Conservative default for unknown providers (e.g. mimo, ollama, lmstudio,
	// vscode-lm, gemini, fake-ai) or when providerName is absent.
	return {
		generation: "single",
		maxCallsPerTurn: 1,
		enforcement: "local",
		source: "provider-default",
	}
}

export function buildApiHandler(configuration: ProviderSettings): ApiHandler {
	const { apiProvider, ...options } = configuration

	if (apiProvider === retiredProviderIdentifiers.roo) {
		throw new Error(getRouterRemovalMessage())
	}

	if (apiProvider && isRetiredProvider(apiProvider)) {
		throw new Error(
			`Sorry, this provider is no longer supported. We saw very few Roo users actually using it and we need to reduce the surface area of our codebase so we can keep shipping fast and serving our community well in this space. It was a really hard decision but it lets us focus on what matters most to you. It sucks, we know.\n\nPlease select a different provider in your API profile settings.`,
		)
	}

	switch (apiProvider) {
		case providerIdentifiers.anthropic:
			return new AnthropicHandler(options)
		case providerIdentifiers.openrouter:
			return new OpenRouterHandler(options)
		case providerIdentifiers.bedrock:
			return new AwsBedrockHandler(options)
		case providerIdentifiers.vertex:
			return options.apiModelId?.startsWith("claude")
				? new AnthropicVertexHandler(options)
				: new VertexHandler(options)
		case providerIdentifiers.openai:
			return new OpenAiHandler(options)
		case providerIdentifiers.ollama:
			return new NativeOllamaHandler(options)
		case providerIdentifiers.lmstudio:
			return new LmStudioHandler(options)
		case providerIdentifiers.gemini:
			return new GeminiHandler(options)
		case providerIdentifiers.openaiCodex:
			return new OpenAiCodexHandler(options)
		case providerIdentifiers.openaiNative:
			return new OpenAiNativeHandler(options)
		case providerIdentifiers.deepseek:
			return new DeepSeekHandler(options)
		case providerIdentifiers.qwenCode:
			return new QwenCodeHandler(options)
		case providerIdentifiers.moonshot:
			return new MoonshotHandler(options)
		case providerIdentifiers.kimiCode:
			return new KimiCodeHandler(options)
		case providerIdentifiers.vscodeLm:
			return new VsCodeLmHandler(options)
		case providerIdentifiers.mistral:
			return new MistralHandler(options)
		case providerIdentifiers.requesty:
			return new RequestyHandler(options)
		case providerIdentifiers.unbound:
			return new UnboundHandler(options)
		case providerIdentifiers.fakeAi:
			return new FakeAIHandler(options)
		case providerIdentifiers.xai:
			return new XAIHandler(options)
		case providerIdentifiers.litellm:
			return new LiteLLMHandler(options)
		case providerIdentifiers.sambanova:
			return new SambaNovaHandler(options)
		case providerIdentifiers.mimo:
			return new MimoHandler(options)
		case providerIdentifiers.zai:
			return new ZAiHandler(options)
		case providerIdentifiers.fireworks:
			return new FireworksHandler(options)
		case providerIdentifiers.friendli:
			return new FriendliHandler(options)
		case providerIdentifiers.vercelAiGateway:
			return new VercelAiGatewayHandler(options)
		case providerIdentifiers.opencodeGo:
			return new OpencodeGoHandler(options)
		case providerIdentifiers.kenari:
			return new KenariHandler(options)
		case providerIdentifiers.zooGateway:
			return new ZooGatewayHandler(options)
		case providerIdentifiers.minimax:
			return new MiniMaxHandler(options)
		case providerIdentifiers.baseten:
			return new BasetenHandler(options)
		case providerIdentifiers.poe:
			return new PoeHandler(options)
		default:
			return new AnthropicHandler(options)
	}
}
