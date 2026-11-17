import { StringCache } from "../stringCache"

describe("StringCache", () => {
	it.each([
		{ entries: 2, characters: 1000, values: ["a", "b", "c"], retained: ["b", "c"] },
		{ entries: 2, characters: 3, values: ["abc"], retained: ["abc"] },
		{ entries: 0, characters: 1000, values: ["a"], retained: [] },
	])(
		"honors independent limits: $entries entries, $characters characters",
		({ entries, characters, values, retained }) => {
			const cache = new StringCache(undefined, entries, characters)
			cache.intern(values)
			expect([...cache["cache"].keys()]).toEqual(retained)
		},
	)

	it("does not refresh FIFO order on a cache hit", () => {
		const cache = new StringCache(undefined, 2)
		cache.intern(["first", "second"])
		cache.intern("first")
		cache.intern("third")
		expect([...cache["cache"].keys()]).toEqual(["second", "third"])
	})

	it("bounds entry count and retained characters, skipping oversized strings", () => {
		const cache = new StringCache(undefined, 2, 6)
		cache.intern(["aaa", "bbb", "ccc"])
		expect(cache.size).toBe(2)
		expect([...cache["cache"].keys()]).toEqual(["bbb", "ccc"])
		cache.intern("oversized")
		expect(cache.size).toBe(2)
		cache.intern("dddd")
		expect([...cache["cache"].keys()]).toEqual(["dddd"])
		cache.clear()
		cache.intern(["aaa", "bbb"])
		expect(cache.size).toBe(2)
	})

	it("interns strings recursively without retaining duplicate or empty values", () => {
		const cache = new StringCache()
		const value = {
			label: "shared",
			nested: [{ label: "shared" }, { label: "other" }],
			empty: "",
			count: 1,
			nullable: null,
			optional: undefined,
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
