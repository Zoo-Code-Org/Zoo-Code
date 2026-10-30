export type StringCacheFilter = (value: object) => boolean

/**
 * Rebinds strings in deserialized values to canonical instances held by this cache.
 * FIFO eviction bounds both entry overhead and retained UTF-16 characters.
 * Values are mutated in place to avoid allocating another object tree per message.
 */
export class StringCache {
	private readonly cache = new Map<string, string>()

	private retainedCharacters = 0

	constructor(
		private readonly shouldIntern?: StringCacheFilter,
		private readonly maxEntries = 10_000,
		private readonly maxCharacters = 2_000_000,
	) {}

	intern<T>(value: T): T {
		if (value !== null && typeof value === "object" && this.shouldIntern?.(value) === false) {
			return value
		}

		return this.internValue(value) as T
	}

	clear(): void {
		this.cache.clear()
		this.retainedCharacters = 0
	}

	get size(): number {
		return this.cache.size
	}

	private internValue(value: unknown): unknown {
		if (typeof value === "string") {
			if (value.length === 0) {
				return value
			}

			const existing = this.cache.get(value)
			if (existing !== undefined) {
				return existing
			}

			if (this.maxEntries <= 0 || value.length > this.maxCharacters) {
				return value
			}
			while (this.cache.size >= this.maxEntries || this.retainedCharacters + value.length > this.maxCharacters) {
				const oldest = this.cache.keys().next().value
				if (oldest === undefined) break
				this.cache.delete(oldest)
				this.retainedCharacters -= oldest.length
			}
			this.cache.set(value, value)
			this.retainedCharacters += value.length
			return value
		}

		if (Array.isArray(value)) {
			for (let index = 0; index < value.length; index++) {
				value[index] = this.internValue(value[index])
			}
			return value
		}

		if (value === null || typeof value !== "object") {
			return value
		}

		const record = value as Record<string, unknown>
		for (const key of Object.keys(record)) {
			record[key] = this.internValue(record[key])
		}

		return value
	}
}
