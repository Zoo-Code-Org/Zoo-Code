/**
 * Normalization of OpenAI-shaped chat-completions usage objects into the
 * cache token fields Zoo Code bills on.
 *
 * Providers that speak the OpenAI chat-completions wire format disagree on
 * where they put cache counters. Some publish them top level, some nest them
 * under `prompt_tokens_details`, and some publish both shapes describing the
 * same quantities. Every reader here therefore resolves a single field through
 * an ordered list of aliases and stops at the first numeric value. The aliases
 * are never summed: a response that carries both shapes reports the same
 * tokens twice, so adding them would double-count.
 */

/**
 * A usage object as it arrives off the wire, before any provider-specific
 * typing. Fields are deliberately `unknown`: providers type their own usage
 * loosely and the normalizer is the single place that validates them.
 */
export interface ChatUsageLike {
	prompt_tokens?: unknown
	completion_tokens?: unknown
	prompt_tokens_details?: unknown
	[key: string]: unknown
}

export interface NormalizedChatUsage {
	/** Total prompt tokens, including cache reads and cache writes. */
	inputTokens: number
	outputTokens: number
	/**
	 * Tokens written into the provider's prompt cache on this request.
	 * `undefined` when the provider reported no such counter at all, which is
	 * distinct from a reported zero.
	 */
	cacheReadTokens?: number
	cacheWriteTokens?: number
}

/**
 * Aliases for cache-write (cache-miss) tokens, highest priority first.
 *
 * DeepSeek documents `prompt_cache_miss_tokens` at the top level of the usage
 * object and marks it required; its `prompt_tokens_details` schema declares
 * only `cached_tokens`. `prompt_tokens_details.cache_miss_tokens` is not part
 * of that schema and is kept last as a legacy fallback for proxies that
 * forwarded a rewritten shape.
 *
 * https://api-docs.deepseek.com/api/create-chat-completion
 */
const CACHE_WRITE_ALIASES = [
	"prompt_cache_miss_tokens",
	"prompt_tokens_details.cache_miss_tokens",
	"prompt_tokens_details.cache_write_tokens",
] as const

/**
 * Aliases for cache-read (cache-hit) tokens, highest priority first.
 *
 * `prompt_tokens_details.cached_tokens` is the shape DeepSeek documents and
 * also the shape OpenAI documents, so it wins. `prompt_cache_hit_tokens` is
 * DeepSeek's required top-level counterpart and covers responses that omit the
 * nested object.
 *
 * https://api-docs.deepseek.com/api/create-chat-completion
 */
const CACHE_READ_ALIASES = [
	"prompt_tokens_details.cached_tokens",
	"prompt_cache_hit_tokens",
	"cache_read_input_tokens",
] as const

const readPath = (usage: ChatUsageLike, path: string): unknown => {
	let current: unknown = usage

	for (const segment of path.split(".")) {
		if (typeof current !== "object" || current === null) return undefined
		current = (current as Record<string, unknown>)[segment]
	}

	return current
}

/**
 * Counters are token counts: only non-negative integers are accepted. Anything
 * else (missing, null, a string, a float, a negative sentinel) is treated as
 * "not reported" so a malformed field falls through to the next alias instead
 * of poisoning the total.
 */
const asTokenCount = (value: unknown): number | undefined =>
	typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined

const resolveTokenCount = (usage: ChatUsageLike, aliases: readonly string[]): number | undefined => {
	for (const alias of aliases) {
		const resolved = asTokenCount(readPath(usage, alias))
		if (resolved !== undefined) return resolved
	}

	return undefined
}

/**
 * Normalizes an OpenAI-shaped chat-completions usage object.
 *
 * Returns `undefined` for a missing usage object so callers can skip emitting a
 * usage chunk entirely. Token counts that the provider did not report stay
 * `undefined` rather than defaulting to 0, which keeps "no cache counter" and
 * "zero cache hits" distinguishable for cost reporting.
 */
export function normalizeChatUsage(usage: ChatUsageLike | null | undefined): NormalizedChatUsage | undefined {
	if (!usage || typeof usage !== "object") return undefined

	const cacheReadTokens = resolveTokenCount(usage, CACHE_READ_ALIASES)
	const cacheWriteTokens = resolveTokenCount(usage, CACHE_WRITE_ALIASES)

	return {
		inputTokens: asTokenCount(usage.prompt_tokens) ?? 0,
		outputTokens: asTokenCount(usage.completion_tokens) ?? 0,
		...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
		...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
	}
}
