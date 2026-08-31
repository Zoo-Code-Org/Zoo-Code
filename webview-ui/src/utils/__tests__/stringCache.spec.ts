import { StringCache } from "../stringCache"

describe("StringCache", () => {
	it("interns strings recursively without retaining duplicate or empty values", () => {
		const cache = new StringCache()
		const value = {
			label: "shared",
			nested: [{ label: "shared" }, { label: "other" }],
			empty: "",
			count: 1,
		}

		expect(cache.intern(value)).toBe(value)
		expect(cache.size).toBe(2)

		cache.intern({ label: "shared", another: "other" })
		expect(cache.size).toBe(2)
	})

	it("skips values rejected by its filter while interning accepted siblings", () => {
		const cache = new StringCache((value) => !("partial" in value) || value.partial !== true)
		const partial = { partial: true, text: "streaming", nested: { text: "transient" } }
		const complete = { partial: false, text: "complete", nested: { partial: true, text: "still-complete" } }

		cache.intern(partial)
		expect(cache.size).toBe(0)

		cache.intern(complete)
		expect(cache.size).toBe(2)
	})

	it("clears interned values and can be reused", () => {
		const cache = new StringCache()
		cache.intern({ text: "first" })

		cache.clear()
		expect(cache.size).toBe(0)

		cache.intern({ text: "second" })
		expect(cache.size).toBe(1)
	})
})
