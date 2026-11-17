// npx vitest run test-utils/__tests__/surrogates.spec.ts

import { expectNoLoneSurrogates } from "../surrogates"

describe("expectNoLoneSurrogates", () => {
	it("passes values without strings and values with only valid content", () => {
		expect(() => expectNoLoneSurrogates({ a: 1, b: null, c: [true, undefined] })).not.toThrow()
		expect(() => expectNoLoneSurrogates("plain text")).not.toThrow()
	})

	it("passes valid surrogate pairs and astral-plane text nested anywhere", () => {
		expect(() => expectNoLoneSurrogates("emoji \uD83D\uDE00 done")).not.toThrow()
		expect(() => expectNoLoneSurrogates({ nested: { list: ["ok", { deep: "\uD800\uDC00" }] } })).not.toThrow()
	})

	it("fails on a lone high surrogate in a nested string", () => {
		expect(() => expectNoLoneSurrogates({ messages: [{ content: "bad\uD800end" }] })).toThrow(
			/lone UTF-16 surrogate.*\$\.messages\[0\]\.content/s,
		)
	})

	it("fails on a lone low surrogate and on a reversed pair", () => {
		expect(() => expectNoLoneSurrogates(["ok", "bad\uDC00end"])).toThrow(/lone UTF-16 surrogate/)
		expect(() => expectNoLoneSurrogates("\uDC00\uD800")).toThrow(/lone UTF-16 surrogate/)
	})

	it("fails on a trailing lone surrogate", () => {
		expect(() => expectNoLoneSurrogates("abc\uD800")).toThrow(/lone UTF-16 surrogate/)
	})

	it("fails on a lone surrogate in an object key", () => {
		expect(() => expectNoLoneSurrogates({ [`a\uD800`]: 1 })).toThrow(/lone UTF-16 surrogate/)
	})

	it("inspects the raw value, so JSON.stringify escaping cannot hide a lone surrogate", () => {
		// JSON.stringify escapes the code unit as `\udXXX` text; only a raw walk can see it.
		const value = { body: "bad\uD800end" }
		expect(JSON.stringify(value)).not.toMatch(
			/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
		)
		expect(() => expectNoLoneSurrogates(value)).toThrow(/lone UTF-16 surrogate/)
	})
})
