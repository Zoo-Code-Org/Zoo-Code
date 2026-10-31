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

import { CompactLogger } from "../../utils/logging/CompactLogger"

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
	/**
	 * Tokens that were looked up in the prompt cache and not found. These are
	 * ordinary input tokens for every provider except DeepSeek, so they are
	 * reported separately and are never folded into `cacheWriteTokens`.
	 * `undefined` when the provider reported no such counter at all, which is
	 * distinct from a reported zero.
	 */
	cacheMissTokens?: number
}

/**
 * Aliases for true cache-write tokens, highest priority first.
 *
 * A cache write is a token the provider durably stored for reuse on a later
 * request. It is billed at the provider's cache-write price, which is often
 * zero (a write surcharge is not universal) but is a real, separate counter.
 *
 * `cache_creation_input_tokens` is the Anthropic-style top-level counter that
 * LiteLLM publishes for cached writes.
 *
 * https://api-docs.deepseek.com/api/create-chat-completion
 */
const CACHE_WRITE_ALIASES = ["prompt_tokens_details.cache_write_tokens", "cache_creation_input_tokens"] as const

/**
 * Aliases for cache-miss tokens, highest priority first.
 *
 * A cache miss is a token that was looked up in the prompt cache and not
 * found. Economically it is the opposite of a write: it is ordinary input
 * that the provider already charges for through `prompt_tokens`, and it must
 * not be moved onto the cache-write price line, because doing so removes it
 * from the input bucket (`cost.ts` subtracts cache writes from the input
 * total) and re-prices it at a cache-write rate that most catalogs leave
 * unset, billing it at zero.
 *
 * `openai-native.ts` already states this rule and applies it: "missFromDetails
 * is NOT used as fallback for cache writes". This module now agrees with it.
 *
 * DeepSeek is the one provider whose catalog prices misses through the
 * cache-write field: all four `deepSeekModels` rows set `inputPrice: 0` by
 * design ("the inputs are priced as cache read/write") and publish
 * `cacheWritesPrice`. Only `DeepSeekHandler` therefore opts in to reading
 * this list; see `processUsageMetrics` in `providers/deepseek.ts`.
 *
 * https://api-docs.deepseek.com/api/create-chat-completion
 */
const CACHE_MISS_ALIASES = ["prompt_cache_miss_tokens", "prompt_tokens_details.cache_miss_tokens"] as const

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
 *
 * `typeof value === "number"` is redundant for the check itself, because
 * `Number.isInteger` already rejects every non-number. It is kept so the type
 * predicate narrows to `number` and callers can return the value typed.
 */
const isTokenCount = (value: unknown): value is number =>
	typeof value === "number" && Number.isInteger(value) && value >= 0

/**
 * Diagnostics sink for malformed counters.
 *
 * The shared `logger` export in `utils/logging` is a no-op outside tests
 * (`utils/logging/index.ts:25` selects `CompactLogger` only when
 * `NODE_ENV === "test"`), so routing a production diagnostic through it would
 * discard the message in every real install. This module owns its own
 * `CompactLogger` instead, which is active regardless of `NODE_ENV`.
 *
 * `CompactLogger`'s constructor only assigns fields, so constructing it at
 * module scope has no side effects. Its `write()` can throw while creating the
 * log file, and this runs inside live usage accounting, so emission is
 * guarded: a logging failure must never break billing or abort a stream.
 */
const usageLogger = new CompactLogger()

/**
 * Longest string preview kept in a diagnostic. A provider can send an
 * arbitrarily large value, and the transport stringifies it and writes it
 * synchronously to stdout and to the log file, so the payload is capped.
 */
const MAX_PREVIEW_CHARS = 64

/**
 * Size-safe description of a discarded counter value.
 *
 * The raw value is never logged: it comes off the wire and is unbounded, while
 * `CompactTransport.write` serializes and writes it synchronously. A number is
 * at most a couple of dozen characters when stringified, so its value is both
 * safe and the most diagnosable thing to keep. A string keeps its length plus a
 * capped preview. Everything else keeps only its type.
 */
const describeMalformedCount = (value: unknown): { type: string; preview?: string | number; length?: number } => {
	if (typeof value === "number") {
		// JSON.stringify writes `null` for NaN and both infinities, which would make
		// the three indistinguishable in the persisted log. They are stringified so
		// the name survives serialization; finite numbers stay numeric.
		return { type: "number", preview: Number.isFinite(value) ? value : String(value) }
	}

	if (typeof value === "string") {
		return {
			type: "string",
			length: value.length,
			preview: value.length > MAX_PREVIEW_CHARS ? `${value.slice(0, MAX_PREVIEW_CHARS)}…` : value,
		}
	}

	if (Array.isArray(value)) return { type: "array" }

	return { type: value === null ? "null" : typeof value }
}

const emitMalformedCountWarning = (path: string, value: unknown): void => {
	try {
		usageLogger.warn("Discarded a malformed token counter while normalizing chat usage", {
			path,
			...describeMalformedCount(value),
		})
	} catch {
		// Diagnostics are best-effort; never let a sink failure escape into usage accounting.
	}
}

/**
 * A counter that is absent or null was simply not reported, which is a normal
 * shape and resolves to `undefined` silently. A counter that is present but
 * unusable is a provider or proxy defect: it is still discarded, but it is
 * reported so a billing regression cannot hide behind an otherwise valid
 * response. The warning is emitted once per alias per process, because usage
 * objects arrive on every streamed chunk and an unconditional warning would
 * flood the log.
 */
const warnMalformedCount = (path: string, value: unknown): void => {
	if (warnedMalformedCounters.has(path)) return
	warnedMalformedCounters.add(path)
	emitMalformedCountWarning(path, value)
}

const warnedMalformedCounters = new Set<string>()

const asTokenCount = (value: unknown, path: string): number | undefined => {
	if (isTokenCount(value)) return value
	if (value !== undefined && value !== null) warnMalformedCount(path, value)
	return undefined
}

const resolveTokenCount = (usage: ChatUsageLike, aliases: readonly string[]): number | undefined => {
	for (const alias of aliases) {
		const resolved = asTokenCount(readPath(usage, alias), alias)
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
 *
 * `cacheMissTokens` is reported but not merged into `cacheWriteTokens`: a miss
 * is ordinary input, and only DeepSeek's catalog prices it as a write. Callers
 * that bill misses as writes must opt in explicitly.
 */
export function normalizeChatUsage(usage: ChatUsageLike | null | undefined): NormalizedChatUsage | undefined {
	if (!usage || typeof usage !== "object") return undefined

	const cacheReadTokens = resolveTokenCount(usage, CACHE_READ_ALIASES)
	const cacheWriteTokens = resolveTokenCount(usage, CACHE_WRITE_ALIASES)
	const cacheMissTokens = resolveTokenCount(usage, CACHE_MISS_ALIASES)

	return {
		inputTokens: asTokenCount(usage.prompt_tokens, "prompt_tokens") ?? 0,
		outputTokens: asTokenCount(usage.completion_tokens, "completion_tokens") ?? 0,
		...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
		...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
		...(cacheMissTokens !== undefined ? { cacheMissTokens } : {}),
	}
}
