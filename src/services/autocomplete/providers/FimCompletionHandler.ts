import type { AutocompleteModelSummary, AutocompleteProviderId, AutocompleteValidationResult } from "@roo-code/types"

/**
 * A FIM completion handler speaks to one model endpoint and streams the middle of
 * a fill-in-the-middle request.
 *
 * Phase 2 ships only {@link OllamaFimHandler}; Phase 3 adds the OpenAI-compatible,
 * Codestral and chat-fallback handlers behind this interface.
 */
export interface FimCompletionHandler {
	readonly id: AutocompleteProviderId
	/** The endpoint accepts `prefix`/`suffix` and applies the FIM template server-side. */
	readonly usesNativeFim: boolean
	readonly supportsStreaming: boolean

	/**
	 * Streams the completion middle. Each yielded string is a raw model fragment
	 * (post-processing runs separately). The generator ends when the stream
	 * completes or the signal aborts.
	 */
	streamFim(request: FimRequest): AsyncGenerator<string, void, undefined>

	listModels(signal: AbortSignal): Promise<AutocompleteModelSummary[]>
	validate(signal: AbortSignal): Promise<AutocompleteValidationResult>
}

export interface FimRequest {
	readonly modelId: string
	readonly baseUrl: string
	readonly apiKey: string | undefined
	/** The prefix sent to a native-FIM endpoint (snippet preamble already folded in). */
	readonly prefix: string
	readonly suffix: string
	/** The fully-rendered prompt, used for non-native fallback and the 400 retry. */
	readonly renderedPrompt: string
	/**
	 * False when the resolved template has no FIM control tokens (`instruct`/`none`).
	 *
	 * Handlers **must** send {@link renderedPrompt} and omit `suffix` when this is
	 * false. Passing a suffix to a model that has never seen a FIM token does not
	 * fail — the server accepts it and the model simply free-runs, which is the
	 * single largest source of prose-instead-of-code completions.
	 */
	readonly supportsFim: boolean
	/**
	 * True when the model is instruction-tuned and must be driven through the
	 * *chat* endpoint rather than raw completions.
	 *
	 * Raw `/v1/completions` has no instruction channel: a system prompt pasted
	 * into the prompt string is just more text to continue, so the model echoes
	 * the rules back as output. The chat endpoint applies the model's own chat
	 * template, which is the only reliable way to keep instructions out of the
	 * generated text.
	 */
	readonly useChatEndpoint: boolean
	/** System instruction for the chat path. Ignored unless {@link useChatEndpoint}. */
	readonly systemPrompt?: string
	readonly stopSequences: readonly string[]
	readonly temperature: number
	readonly maxOutputTokens: number
	readonly contextLength: number
	readonly requestTimeoutMs: number
	readonly signal: AbortSignal
}

export interface FimHandlerOptions {
	readonly getConfig: () => {
		readonly modelId: string
		readonly baseUrl: string
		readonly temperature: number
		readonly maxOutputTokens: number
		readonly contextLength: number
		readonly requestTimeoutMs: number
	}
	readonly getApiKey: () => string | undefined
}
