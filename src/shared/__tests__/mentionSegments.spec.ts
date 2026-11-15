import type { MentionSegment } from "@roo-code/types"

import {
	applyEdit,
	generatedSegments,
	joinSegments,
	normalizeSegments,
	trimSegments,
	userSegments,
	userText,
} from "../mentionSegments"

const user = (text: string): MentionSegment => ({ text, source: "user" })
const gen = (text: string): MentionSegment => ({ text, source: "generated" })

describe("mentionSegments", () => {
	describe("normalizeSegments", () => {
		it("keeps valid segments that match the text", () => {
			expect(normalizeSegments("ab", [gen("a"), user("b")])).toEqual([gen("a"), user("b")])
		})

		it.each([
			{ label: "omitted", segments: undefined },
			{ label: "not a list", segments: "user" },
			{ label: "bad source", segments: [{ text: "ab", source: "system" }] },
			{ label: "text mismatch", segments: [user("abc")] },
		])("fails closed when segments are $label", ({ segments }) => {
			expect(normalizeSegments("ab", segments)).toEqual([gen("ab")])
		})

		it("returns no segments for empty text", () => {
			expect(normalizeSegments("", undefined)).toEqual([])
		})
	})

	it("joins text and selects only user text", () => {
		const segments = [gen("a @/x "), user("b @/y"), gen(" c"), user("d")]
		expect(joinSegments(segments)).toBe("a @/x b @/y cd")
		expect(userText(segments)).toBe("b @/y\nd")
	})

	it("trims both ends across segments", () => {
		expect(trimSegments([gen("  "), user("  a "), gen(" b  ")])).toEqual([user("a "), gen(" b")])
	})

	describe("applyEdit", () => {
		it("marks inserted text as user and keeps the rest", () => {
			expect(applyEdit([gen("context @/s")], "context @/s", "context @/s mine")).toEqual([
				gen("context @/s"),
				user(" mine"),
			])
		})

		it("marks text inserted in the middle as user and keeps both sides generated", () => {
			expect(applyEdit([gen("ab")], "ab", "aXb")).toEqual([gen("a"), user("X"), gen("b")])
		})

		it("removes deleted text and keeps its neighbors", () => {
			expect(applyEdit([user("ab"), gen("cd")], "abcd", "acd")).toEqual([user("a"), gen("cd")])
		})

		it("marks replaced generated text as user", () => {
			expect(applyEdit([gen("abc")], "abc", "aZc")).toEqual([gen("a"), user("Z"), gen("c")])
		})

		it("keeps all user text user", () => {
			expect(applyEdit(userSegments("ab"), "ab", "abc")).toEqual([user("abc")])
		})

		it("fails closed when the segments do not match the old value", () => {
			expect(applyEdit([gen("x")], "ab", "abc")).toEqual(generatedSegments("abc"))
		})

		it("does not authorize a generated mention after an unrelated edit", () => {
			const result = applyEdit([gen("see @/secret")], "see @/secret", "see @/secret now")
			expect(userText(result)).toBe(" now")
		})
	})
})
