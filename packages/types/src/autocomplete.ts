import { z } from "zod"

/**
 * Inline autocomplete (ghost text).
 *
 * This is deliberately a *dedicated* configuration rather than a chat API profile:
 * the model that serves tab-completion is usually a small fill-in-the-middle (FIM)
 * *base* model (e.g. `qwen2.5-coder:1.5b-base`) hosted next to the editor, while the
 * chat model is typically a large instruction-tuned model in the cloud. Coupling the
 * two would force users to choose one at the expense of the other.
 */

/**
 * Transport used to reach the completion model.
 *
 * - `ollama`             native FIM via `POST /api/generate` with a `suffix` field
 * - `openai-compatible`  `POST /v1/completions` with `prompt` + `suffix` (LM Studio, llama.cpp, vLLM, TGI)
 * - `codestral`          Mistral's dedicated FIM endpoint, `POST /v1/fim/completions`
 * - `chat-fallback`      any configured chat provider, prompted to emulate FIM (slower, less accurate)
 */
export const autocompleteProviderIds = ["ollama", "openai-compatible", "codestral", "chat-fallback"] as const

export const autocompleteProviderSchema = z.enum(autocompleteProviderIds)

/**
 * A native-FIM transport id, or any chat provider id from the Providers tab.
 *
 * The union keeps editor autocomplete useful for the three native transports
 * while still accepting the wider set the settings UI now offers.
 */
export type AutocompleteProviderId = z.infer<typeof autocompleteProviderSchema> | (string & {})

/**
 * Fill-in-the-middle prompt formats.
 *
 * `auto` resolves the template from the model id; the remaining values pin it
 * explicitly for models whose names don't advertise their family.
 */
export const fimTemplateIds = [
	"auto",
	"qwen",
	"starcoder",
	"codestral",
	"codellama",
	"deepseek",
	"codegemma",
	"instruct",
	"none",
] as const

export const fimTemplateSchema = z.enum(fimTemplateIds)

export type FimTemplateId = z.infer<typeof fimTemplateSchema>

/**
 * When completions are requested.
 *
 * - `automatic`  as the user types (debounced)
 * - `manual`     only when the user invokes the trigger command/keybinding
 *
 * Note this is *not* VS Code's `editor.quickSuggestions`, which governs the
 * IntelliSense suggest widget rather than inline ghost text.
 */
export const autocompleteTriggerModes = ["automatic", "manual"] as const

export const autocompleteTriggerModeSchema = z.enum(autocompleteTriggerModes)

export type AutocompleteTriggerMode = z.infer<typeof autocompleteTriggerModeSchema>

/**
 * Whether a completion may span multiple lines.
 *
 * `auto` defers to the syntax tree: multi-line is allowed when the cursor sits at a
 * position where a block is expected (e.g. an empty function body) and suppressed
 * when it sits mid-expression.
 */
export const autocompleteMultilineModes = ["always", "never", "auto"] as const

export const autocompleteMultilineModeSchema = z.enum(autocompleteMultilineModes)

export type AutocompleteMultilineMode = z.infer<typeof autocompleteMultilineModeSchema>

/**
 * Single source of truth for autocomplete defaults.
 *
 * Every field on {@link autocompleteConfigSchema} is optional so that persisted
 * settings can round-trip partially; readers resolve missing values from here via
 * `ClineProvider.getState()` so the extension host and the webview never disagree.
 */
export const AUTOCOMPLETE_DEFAULTS = {
	ENABLED: false,
	PROVIDER: "ollama",
	BASE_URL: "http://localhost:11434",
	TRIGGER_MODE: "automatic",
	MULTILINE_MODE: "auto",
	FIM_TEMPLATE: "auto",

	/** Idle time after the last keystroke before a request is issued. */
	DEBOUNCE_MS: 300,
	/** Characters that must be typed since the last suggestion before auto-triggering again. */
	MIN_CHARS_TYPED: 0,

	/** Assumed model context window when the endpoint doesn't report one. */
	CONTEXT_LENGTH: 8192,
	MAX_PREFIX_TOKENS: 1024,
	MAX_SUFFIX_TOKENS: 512,
	MAX_SNIPPET_TOKENS: 512,
	/**
	 * Ghost text is read at a glance, so a long completion is not a better one.
	 * A tight ceiling also cuts short the degenerate runs small models fall into
	 * once they pass the code that was actually wanted.
	 */
	MAX_OUTPUT_TOKENS: 160,
	/**
	 * Fully greedy. Any sampling at all is a liability here: a completion is either
	 * the obvious next code or it should not appear, and non-zero temperature is
	 * what lets a small model wander into invented names and repetition loops.
	 */
	TEMPERATURE: 0,

	/**
	 * Hard ceiling on a single completion request.
	 *
	 * Sized for a hosted model rather than a local one: a large cloud model behind
	 * a network hop routinely needs more than a few seconds for its first token,
	 * and a timeout there is indistinguishable from "autocomplete is broken".
	 * A stale request is cancelled by the next keystroke anyway, so a generous
	 * ceiling costs nothing in the common case.
	 */
	REQUEST_TIMEOUT_MS: 20_000,
	/** Ghost text is rendered from whatever has streamed in by this deadline. */
	FIRST_RENDER_BUDGET_MS: 350,
	/** Wall-clock budget for all context sources combined; stragglers are dropped. */
	CONTEXT_BUDGET_MS: 120,

	CACHE_ENTRIES: 500,

	USE_RECENTLY_EDITED: true,
	USE_OPEN_TABS: true,
	USE_IMPORT_DEFINITIONS: true,
	USE_AST: true,
} as const

/**
 * Stop sequences applied to **every** completion regardless of template.
 *
 * The per-family templates in `templates.ts` contribute their own control tokens,
 * but the `none`/`instruct` templates contribute none — leaving the stream with no
 * terminator at all. These cover the failure modes seen across model families:
 * chat turn markers, markdown fences, and reasoning-block openers emitted by
 * hybrid-reasoning models (LFM2.5, Qwen3, DeepSeek-R1).
 */
export const UNIVERSAL_STOP_SEQUENCES = [
	"<|endoftext|>",
	"<|im_end|>",
	"<|im_start|>",
	"<|eot_id|>",
	"<|end|>",
	"</s>",
	"<think>",
	"<thinking>",
	"<reasoning>",
	"```",
] as const

/**
 * Reasoning/commentary blocks stripped from a completion before it is rendered.
 *
 * Stop sequences catch these only when the model emits the opener as its own
 * token; models that emit `<think>` mid-chunk, or that open with prose before the
 * tag, slip past. Post-processing removes the block outright.
 */
export const REASONING_TAG_NAMES = ["think", "thinking", "reasoning", "reflection", "analysis"] as const

/**
 * Bounds shared by the zod schema and the settings UI so both agree on what is valid.
 */
export const AUTOCOMPLETE_LIMITS = {
	DEBOUNCE_MS: { min: 0, max: 2_000 },
	MIN_CHARS_TYPED: { min: 0, max: 10 },
	CONTEXT_LENGTH: { min: 512, max: 1_048_576 },
	MAX_PREFIX_TOKENS: { min: 64, max: 16_384 },
	MAX_SUFFIX_TOKENS: { min: 0, max: 16_384 },
	MAX_SNIPPET_TOKENS: { min: 0, max: 8_192 },
	MAX_OUTPUT_TOKENS: { min: 1, max: 2_048 },
	TEMPERATURE: { min: 0, max: 2 },
	REQUEST_TIMEOUT_MS: { min: 500, max: 60_000 },
	STOP_SEQUENCES: { max: 16 },
} as const

export const autocompleteConfigSchema = z.object({
	// --- identity / transport ---
	enabled: z.boolean().optional(),
	/**
	 * Transport, or a chat provider id from the Providers tab.
	 *
	 * Kept as a free string rather than the `autocompleteProviderIds` enum so the
	 * settings UI can offer every provider the extension supports without this
	 * schema having to be edited each time one is added. Unknown values resolve to
	 * the chat-model path at runtime.
	 */
	provider: z.string().optional(),
	modelId: z.string().optional(),
	baseUrl: z.string().optional(),
	/** Only meaningful when `provider === "chat-fallback"`: which chat provider to build a handler for. */
	chatFallbackProvider: z.string().optional(),

	// --- trigger / UX ---
	triggerMode: autocompleteTriggerModeSchema.optional(),
	debounceMs: z
		.number()
		.int()
		.min(AUTOCOMPLETE_LIMITS.DEBOUNCE_MS.min)
		.max(AUTOCOMPLETE_LIMITS.DEBOUNCE_MS.max)
		.optional(),
	minCharsTyped: z
		.number()
		.int()
		.min(AUTOCOMPLETE_LIMITS.MIN_CHARS_TYPED.min)
		.max(AUTOCOMPLETE_LIMITS.MIN_CHARS_TYPED.max)
		.optional(),
	multilineMode: autocompleteMultilineModeSchema.optional(),

	// --- prompt budget ---
	contextLength: z
		.number()
		.int()
		.min(AUTOCOMPLETE_LIMITS.CONTEXT_LENGTH.min)
		.max(AUTOCOMPLETE_LIMITS.CONTEXT_LENGTH.max)
		.optional(),
	maxPrefixTokens: z
		.number()
		.int()
		.min(AUTOCOMPLETE_LIMITS.MAX_PREFIX_TOKENS.min)
		.max(AUTOCOMPLETE_LIMITS.MAX_PREFIX_TOKENS.max)
		.optional(),
	maxSuffixTokens: z
		.number()
		.int()
		.min(AUTOCOMPLETE_LIMITS.MAX_SUFFIX_TOKENS.min)
		.max(AUTOCOMPLETE_LIMITS.MAX_SUFFIX_TOKENS.max)
		.optional(),
	maxSnippetTokens: z
		.number()
		.int()
		.min(AUTOCOMPLETE_LIMITS.MAX_SNIPPET_TOKENS.min)
		.max(AUTOCOMPLETE_LIMITS.MAX_SNIPPET_TOKENS.max)
		.optional(),
	maxOutputTokens: z
		.number()
		.int()
		.min(AUTOCOMPLETE_LIMITS.MAX_OUTPUT_TOKENS.min)
		.max(AUTOCOMPLETE_LIMITS.MAX_OUTPUT_TOKENS.max)
		.optional(),
	temperature: z
		.number()
		.min(AUTOCOMPLETE_LIMITS.TEMPERATURE.min)
		.max(AUTOCOMPLETE_LIMITS.TEMPERATURE.max)
		.optional(),
	requestTimeoutMs: z
		.number()
		.int()
		.min(AUTOCOMPLETE_LIMITS.REQUEST_TIMEOUT_MS.min)
		.max(AUTOCOMPLETE_LIMITS.REQUEST_TIMEOUT_MS.max)
		.optional(),

	// --- context engine toggles ---
	useRecentlyEdited: z.boolean().optional(),
	useOpenTabs: z.boolean().optional(),
	useImportDefinitions: z.boolean().optional(),
	useAst: z.boolean().optional(),

	// --- templating overrides ---
	fimTemplate: fimTemplateSchema.optional(),
	stopSequences: z.array(z.string()).max(AUTOCOMPLETE_LIMITS.STOP_SEQUENCES.max).optional(),

	// --- scoping ---
	/** VS Code language ids for which completions are suppressed (e.g. `markdown`, `plaintext`). */
	disabledLanguages: z.array(z.string()).optional(),
})

export type AutocompleteConfig = z.infer<typeof autocompleteConfigSchema>

/**
 * A named, saved autocomplete configuration.
 *
 * Deliberately far simpler than the chat `ProviderSettings` profile system: a
 * completion profile is just a name plus the same config object, with no secret
 * of its own. The API key remains a single global secret because switching
 * between (say) a local Ollama profile and a cloud Codestral profile changes the
 * endpoint, not the credential store — and wiping a key on every profile switch
 * is exactly the bug `SECRET_STATE_KEYS` causes for chat profiles.
 */
export const autocompleteProfileSchema = z.object({
	id: z.string(),
	name: z.string().min(1).max(64),
	config: autocompleteConfigSchema,
})

export type AutocompleteProfile = z.infer<typeof autocompleteProfileSchema>

export const AUTOCOMPLETE_PROFILE_LIMITS = { MAX_PROFILES: 20, NAME_MAX: 64 } as const

/**
 * {@link AutocompleteConfig} with every defaultable field resolved.
 *
 * Optional fields that have no sensible default (`modelId`, `chatFallbackProvider`,
 * `stopSequences`) stay optional; everything else is guaranteed present so consumers
 * never repeat `?? DEFAULT`.
 */
export type ResolvedAutocompleteConfig = Required<
	Omit<AutocompleteConfig, "modelId" | "chatFallbackProvider" | "stopSequences">
> &
	Pick<AutocompleteConfig, "modelId" | "chatFallbackProvider" | "stopSequences">

/**
 * Applies {@link AUTOCOMPLETE_DEFAULTS} to a persisted (possibly partial) config.
 *
 * Single source of truth for defaulting, shared by `ClineProvider.getState()`,
 * `getStateToPostToWebview()`, and the completion engine, so the extension host and
 * the webview can never disagree about what an unset field means.
 */
export const resolveAutocompleteConfig = (config?: AutocompleteConfig): ResolvedAutocompleteConfig => ({
	enabled: config?.enabled ?? AUTOCOMPLETE_DEFAULTS.ENABLED,
	provider: normalizeProviderId(config?.provider) ?? AUTOCOMPLETE_DEFAULTS.PROVIDER,
	modelId: config?.modelId,
	baseUrl: config?.baseUrl ?? AUTOCOMPLETE_DEFAULTS.BASE_URL,
	chatFallbackProvider: config?.chatFallbackProvider,

	triggerMode: config?.triggerMode ?? AUTOCOMPLETE_DEFAULTS.TRIGGER_MODE,
	debounceMs: config?.debounceMs ?? AUTOCOMPLETE_DEFAULTS.DEBOUNCE_MS,
	minCharsTyped: config?.minCharsTyped ?? AUTOCOMPLETE_DEFAULTS.MIN_CHARS_TYPED,
	multilineMode: config?.multilineMode ?? AUTOCOMPLETE_DEFAULTS.MULTILINE_MODE,

	contextLength: config?.contextLength ?? AUTOCOMPLETE_DEFAULTS.CONTEXT_LENGTH,
	maxPrefixTokens: config?.maxPrefixTokens ?? AUTOCOMPLETE_DEFAULTS.MAX_PREFIX_TOKENS,
	maxSuffixTokens: config?.maxSuffixTokens ?? AUTOCOMPLETE_DEFAULTS.MAX_SUFFIX_TOKENS,
	maxSnippetTokens: config?.maxSnippetTokens ?? AUTOCOMPLETE_DEFAULTS.MAX_SNIPPET_TOKENS,
	maxOutputTokens: config?.maxOutputTokens ?? AUTOCOMPLETE_DEFAULTS.MAX_OUTPUT_TOKENS,
	temperature: config?.temperature ?? AUTOCOMPLETE_DEFAULTS.TEMPERATURE,
	requestTimeoutMs: config?.requestTimeoutMs ?? AUTOCOMPLETE_DEFAULTS.REQUEST_TIMEOUT_MS,

	useRecentlyEdited: config?.useRecentlyEdited ?? AUTOCOMPLETE_DEFAULTS.USE_RECENTLY_EDITED,
	useOpenTabs: config?.useOpenTabs ?? AUTOCOMPLETE_DEFAULTS.USE_OPEN_TABS,
	useImportDefinitions: config?.useImportDefinitions ?? AUTOCOMPLETE_DEFAULTS.USE_IMPORT_DEFINITIONS,
	useAst: config?.useAst ?? AUTOCOMPLETE_DEFAULTS.USE_AST,

	fimTemplate: config?.fimTemplate ?? AUTOCOMPLETE_DEFAULTS.FIM_TEMPLATE,
	stopSequences: config?.stopSequences,

	disabledLanguages: config?.disabledLanguages ?? [],
})

/**
 * A model offered by the configured autocomplete endpoint.
 *
 * Intentionally narrower than `ModelInfo`: autocomplete never needs pricing or
 * tool-use metadata, and FIM base models rarely report any of it.
 */
/**
 * Maps a chat-provider id onto the native transport that serves the same server.
 *
 * The Providers tab and this feature name overlapping things: its `openai` entry
 * ("OpenAI Compatible") and `lmstudio` both describe endpoints our
 * `openai-compatible` transport already speaks to natively. A config that stored
 * one of those would otherwise be routed through the slower chat path with no
 * endpoint field to configure.
 */
export const normalizeProviderId = (provider: string | undefined): string | undefined => {
	if (!provider) {
		return undefined
	}

	return PROVIDER_ALIASES[provider] ?? provider
}

const PROVIDER_ALIASES: Readonly<Record<string, string>> = {
	openai: "openai-compatible",
	lmstudio: "openai-compatible",
	mistral: "codestral",
}

export interface AutocompleteModelSummary {
	id: string
	label?: string
	contextWindow?: number
	/** True when the endpoint reports the model can insert between a prefix and a suffix. */
	supportsFim?: boolean
}

/** Outcome of a "Test connection" round trip from the settings UI. */
export type AutocompleteValidationResult = { ok: true; detail?: string } | { ok: false; error: string }
