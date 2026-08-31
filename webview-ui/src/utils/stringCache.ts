export type StringCacheFilter = (value: object) => boolean

/**
 * Rebinds strings in deserialized values to canonical instances held by this cache.
 * Values are mutated in place to avoid allocating another object tree per message.
 */
export class StringCache {
	private readonly cache = new Map<string, string>()

	constructor(private readonly shouldIntern?: StringCacheFilter) {}

	intern<T>(value: T): T {
		if (value !== null && typeof value === "object" && this.shouldIntern?.(value) === false) {
			return value
		}

		return this.internValue(value) as T
	}

	clear(): void {
		this.cache.clear()
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

			this.cache.set(value, value)
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
