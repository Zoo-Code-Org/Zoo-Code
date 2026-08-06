/**
 * Hand-rolled LRU cache for inline completions, with typed-prefix continuation.
 *
 * - LRU via `Map` insertion order (most-recently-used last); eviction drops the
 *   oldest entry when capacity is exceeded.
 * - Continuation: when the user types more characters, the new prefix extends
 *   the cached one; if the cached completion starts with the newly-typed chars,
 *   we reuse it by trimming the typed prefix, avoiding a model round-trip.
 *
 * ~40 lines of code, no external dependency.
 */

export interface CompletionCacheEntry {
	readonly prefix: string
	readonly suffix: string
	readonly text: string
	readonly modelId: string
	readonly timestamp: number
}

export interface CompletionCacheOptions {
	readonly maxEntries?: number
}

const DEFAULT_MAX_ENTRIES = 500

export class CompletionCache {
	private readonly maxEntries: number
	private readonly entries = new Map<string, CompletionCacheEntry>()

	constructor(options: CompletionCacheOptions = {}) {
		this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES
	}

	/** Looks up a cached completion by its exact key; touches the LRU on hit. */
	get(key: string): CompletionCacheEntry | undefined {
		const entry = this.entries.get(key)

		if (entry) {
			// Refresh recency: re-insert moves the key to the end of the Map.
			this.entries.delete(key)
			this.entries.set(key, entry)
		}

		return entry
	}

	/**
	 * Continuation lookup: finds a cached completion whose prefix the new prefix
	 * extends, and whose text continues with the newly-typed characters. Returns
	 * the trimmed completion (without the already-typed chars) on a hit.
	 */
	getContinuation(prefix: string, suffix: string, modelId: string): string | undefined {
		for (const entry of [...this.entries.values()].reverse()) {
			if (entry.modelId !== modelId) {
				continue
			}

			if (!prefix.startsWith(entry.prefix)) {
				continue
			}

			const typed = prefix.slice(entry.prefix.length)

			if (typed.length === 0) {
				continue
			}

			// The suffix must still align: the cached suffix, minus the typed chars
			// consumed from its head, should match the current suffix.
			if (!entry.suffix.startsWith(suffix)) {
				continue
			}

			if (!entry.text.startsWith(typed)) {
				continue
			}

			const remaining = entry.text.slice(typed.length)

			if (remaining.length > 0) {
				return remaining
			}
		}

		return undefined
	}

	/** Stores a completion; evicts the oldest entry if capacity is exceeded. */
	set(key: string, entry: Omit<CompletionCacheEntry, "timestamp">): void {
		if (this.entries.has(key)) {
			this.entries.delete(key)
		}

		this.entries.set(key, { ...entry, timestamp: Date.now() })

		while (this.entries.size > this.maxEntries) {
			const oldestKey = this.entries.keys().next().value

			if (oldestKey === undefined) {
				break
			}

			this.entries.delete(oldestKey)
		}
	}

	clear(): void {
		this.entries.clear()
	}

	get size(): number {
		return this.entries.size
	}
}

/** Builds a cache key from the values that define a unique completion. */
export function makeCacheKey(prefix: string, suffix: string, modelId: string): string {
	return `${modelId}::${hash(prefix)}::${hash(suffix)}`
}

/** Cheap, deterministic string hash (djb2 variant). */
function hash(text: string): string {
	let hashValue = 5381

	for (let i = 0; i < text.length; i++) {
		hashValue = ((hashValue << 5) + hashValue + text.charCodeAt(i)) >>> 0
	}

	return hashValue.toString(36)
}
