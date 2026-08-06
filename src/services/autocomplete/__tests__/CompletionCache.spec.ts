import { CompletionCache, makeCacheKey } from "../cache/CompletionCache"

describe("CompletionCache", () => {
	describe("get / set", () => {
		it("returns undefined for a miss", () => {
			const cache = new CompletionCache()
			expect(cache.get("missing")).toBeUndefined()
		})

		it("returns the stored entry on a hit", () => {
			const cache = new CompletionCache()
			cache.set("key", { prefix: "p", suffix: "s", text: "completion", modelId: "model" })
			expect(cache.get("key")?.text).toBe("completion")
		})
	})

	describe("LRU eviction", () => {
		it("evicts the oldest entry when capacity is exceeded", () => {
			const cache = new CompletionCache({ maxEntries: 2 })
			cache.set("a", { prefix: "", suffix: "", text: "A", modelId: "m" })
			cache.set("b", { prefix: "", suffix: "", text: "B", modelId: "m" })
			cache.set("c", { prefix: "", suffix: "", text: "C", modelId: "m" })

			expect(cache.get("a")).toBeUndefined()
			expect(cache.get("b")?.text).toBe("B")
			expect(cache.get("c")?.text).toBe("C")
		})

		it("refreshes recency on get (LRU touch)", () => {
			const cache = new CompletionCache({ maxEntries: 2 })
			cache.set("a", { prefix: "", suffix: "", text: "A", modelId: "m" })
			cache.set("b", { prefix: "", suffix: "", text: "B", modelId: "m" })
			// Touch "a" so it's more recently used than "b"
			void cache.get("a")
			cache.set("c", { prefix: "", suffix: "", text: "C", modelId: "m" })

			expect(cache.get("a")?.text).toBe("A")
			expect(cache.get("b")).toBeUndefined()
		})
	})

	describe("getContinuation", () => {
		it("returns the trimmed completion when the prefix extends a cached one", () => {
			const cache = new CompletionCache()
			cache.set("key", { prefix: "function fi", suffix: ") { return", text: "b() { return", modelId: "model" })

			// User typed "b" after "function fi", new prefix is "function fib"
			const result = cache.getContinuation("function fib", ") { return", "model")
			expect(result).toBe("() { return")
		})

		it("returns undefined when the typed chars don't match the cached completion", () => {
			const cache = new CompletionCache()
			cache.set("key", { prefix: "function fi", suffix: ") { return", text: "b() { return", modelId: "model" })

			// User typed "x" — doesn't match "b..."
			expect(cache.getContinuation("function fix", ") { return", "model")).toBeUndefined()
		})

		it("returns undefined when the suffix doesn't align", () => {
			const cache = new CompletionCache()
			cache.set("key", { prefix: "function fi", suffix: ") { return", text: "b() { return", modelId: "model" })

			expect(cache.getContinuation("function fib", "different suffix", "model")).toBeUndefined()
		})

		it("returns undefined when the model differs", () => {
			const cache = new CompletionCache()
			cache.set("key", { prefix: "function fi", suffix: ") { return", text: "b() { return", modelId: "model-a" })

			expect(cache.getContinuation("function fib", ") { return", "model-b")).toBeUndefined()
		})

		it("returns undefined when the typed prefix equals the cached prefix (no extension)", () => {
			const cache = new CompletionCache()
			cache.set("key", { prefix: "function fi", suffix: ") { return", text: "b() { return", modelId: "model" })

			expect(cache.getContinuation("function fi", ") { return", "model")).toBeUndefined()
		})
	})

	describe("clear", () => {
		it("removes all entries", () => {
			const cache = new CompletionCache()
			cache.set("a", { prefix: "", suffix: "", text: "A", modelId: "m" })
			cache.clear()
			expect(cache.size).toBe(0)
		})
	})

	describe("makeCacheKey", () => {
		it("produces a stable key for the same inputs", () => {
			expect(makeCacheKey("prefix", "suffix", "model")).toBe(makeCacheKey("prefix", "suffix", "model"))
		})

		it("produces different keys for different inputs", () => {
			expect(makeCacheKey("prefix1", "suffix", "model")).not.toBe(makeCacheKey("prefix2", "suffix", "model"))
		})
	})
})
