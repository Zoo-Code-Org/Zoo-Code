import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { canonicalJson, digestValue, sha256Hex } from "./coding-digest.ts"

describe("coding digest", () => {
	it("produces stable digests independent of key order", () => {
		const a = { b: 1, a: { d: 2, c: [1, 2] } }
		const b = { a: { c: [1, 2], d: 2 }, b: 1 }
		assert.equal(canonicalJson(a), canonicalJson(b))
		assert.equal(digestValue(a), digestValue(b))
	})

	it("changes the digest when content changes", () => {
		assert.notEqual(digestValue({ a: 1 }), digestValue({ a: 2 }))
	})

	it("keeps array order significant", () => {
		assert.notEqual(digestValue([1, 2]), digestValue([2, 1]))
	})

	it("matches sha256 over the canonical form", () => {
		assert.equal(digestValue({ x: "y" }), sha256Hex(canonicalJson({ x: "y" })))
	})
})
