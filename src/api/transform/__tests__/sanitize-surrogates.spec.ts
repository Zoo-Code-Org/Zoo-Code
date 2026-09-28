// npx vitest run api/transform/__tests__/sanitize-surrogates.spec.ts

import { sanitizeIdentifierSurrogates, sanitizeSurrogates, sanitizeSurrogatesDeep } from "../sanitize-surrogates"

describe("sanitizeSurrogates", () => {
	it("leaves plain ASCII unchanged", () => {
		expect(sanitizeSurrogates("hello world")).toBe("hello world")
	})

	it("leaves valid surrogate pairs unchanged", () => {
		// 😀 U+1F600 and 𐀀 U+10000 are astral-plane code points encoded as surrogate pairs.
		expect(sanitizeSurrogates("a\uD83D\uDE00b\uD800\uDC00c")).toBe("a\uD83D\uDE00b\uD800\uDC00c")
	})

	it("replaces a lone high surrogate with U+FFFD", () => {
		expect(sanitizeSurrogates("a\uD800b")).toBe("a\uFFFDb")
	})

	it("replaces a lone low surrogate with U+FFFD", () => {
		expect(sanitizeSurrogates("a\uDC00b")).toBe("a\uFFFDb")
	})

	it("replaces a trailing lone high surrogate", () => {
		expect(sanitizeSurrogates("abc\uD800")).toBe("abc\uFFFD")
	})

	it("replaces a reversed (low-then-high) pair as two lone surrogates", () => {
		expect(sanitizeSurrogates("\uDC00\uD800")).toBe("\uFFFD\uFFFD")
	})

	it("returns empty input unchanged", () => {
		expect(sanitizeSurrogates("")).toBe("")
	})
})

describe("sanitizeIdentifierSurrogates", () => {
	it("leaves ordinary ids unchanged", () => {
		expect(sanitizeIdentifierSurrogates("toolu_01ABCDEF")).toBe("toolu_01ABCDEF")
	})

	it("leaves valid surrogate pairs unchanged", () => {
		expect(sanitizeIdentifierSurrogates("call-\uD83D\uDE00")).toBe("call-\uD83D\uDE00")
	})

	it("keeps ids differing only in a lone surrogate distinct (injective)", () => {
		const a = sanitizeIdentifierSurrogates("call-\uD800")
		const b = sanitizeIdentifierSurrogates("call-\uD801")
		const c = sanitizeIdentifierSurrogates("call-\uDC00")
		expect(a).not.toBe(b)
		expect(a).not.toBe(c)
		expect(b).not.toBe(c)
		// No lone surrogates remain, so the id is safe for a validated JSON body.
		expect(a).toBe("call-\uFFFD" + "D800")
	})

	it("escapes pre-existing U+FFFD so it cannot be mistaken for an encoded surrogate", () => {
		// A literal U+FFFD becomes U+FFFD + "FFFD"; an encoded lone surrogate is U+FFFD + hex.
		expect(sanitizeIdentifierSurrogates("a\uFFFDb")).toBe("a\uFFFD" + "FFFDb")
		expect(sanitizeIdentifierSurrogates("a\uFFFDb")).not.toBe(sanitizeIdentifierSurrogates("a\uD800b"))
	})

	it("is deterministic, so a tool_use id and its tool_result id stay paired", () => {
		const id = "toolu_01\uD800x"
		expect(sanitizeIdentifierSurrogates(id)).toBe(sanitizeIdentifierSurrogates(id))
	})
})

describe("sanitizeSurrogatesDeep", () => {
	const lone = "bad\uD800end"
	const sanitized = "bad\uFFFDend"

	it("sanitizes strings nested in objects and arrays", () => {
		expect(sanitizeSurrogatesDeep({ path: lone, nested: { list: [lone, 1, null] } })).toEqual({
			path: sanitized,
			nested: { list: [sanitized, 1, null] },
		})
	})

	it("sanitizes object keys", () => {
		expect(sanitizeSurrogatesDeep({ [`a\uD800`]: 1 })).toEqual({ "a\uFFFD": 1 })
	})

	it("passes through non-string primitives unchanged", () => {
		expect(sanitizeSurrogatesDeep(42)).toBe(42)
		expect(sanitizeSurrogatesDeep(null)).toBe(null)
		expect(sanitizeSurrogatesDeep(undefined)).toBe(undefined)
		expect(sanitizeSurrogatesDeep(true)).toBe(true)
	})
})
