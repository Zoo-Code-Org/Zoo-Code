import { Anthropic } from "@anthropic-ai/sdk"
import OpenAI from "openai"

import {
	isRetiredProvider,
	providerIdentifiers,
	retiredProviderIdentifiers,
	type ProviderSettings,
	type ModelInfo,
	type ReasoningEffortExtended,
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
	NanoGptHandler,
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
	/**
	 * Per-request thinking effort override (DTE series 2/5).
	 * When defined, takes precedence over the settings-derived `reasoningEffort`
	 * wherever the effective effort is resolved (see `resolveEffectiveReasoningEffort`).
	 * Task-scoped and transient: it applies to this request only (the next request
	 * after being set — no mid-stream effect) and is never persisted to settings.
	 */
	reasoningEffort?: ReasoningEffortExtended
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
		case providerIdentifiers.nanogpt:
			return new NanoGptHandler(options)
		case providerIdentifiers.zooGateway:
			return new ZooGatewayHandler(options)
		case providerIdentifiers.minimax:
			return new MiniMaxHandler(options)
		case providerIdentifiers.baseten:
			return new BasetenHandler(options)
		case providerIdentifiers.poe:
			return new PoeHandler(options)
		case providerIdentifiers.geminiCli:
		// Intentionally falls through to the Anthropic handler pending a dedicated Gemini CLI handler implementation.
		default:
			return new AnthropicHandler(options)
	}
}
