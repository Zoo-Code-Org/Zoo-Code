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

		it.each([
			["aa", "aaa"],
			["aaa", "aa"],
			["abab", "ab"],
			["ab", "abab"],
		])("keeps the joined text equal to the new value for %s -> %s", (oldValue, newValue) => {
			const result = applyEdit([gen(oldValue)], oldValue, newValue)
			expect(joinSegments(result)).toBe(newValue)
		})

		it("keeps generated text generated after a repeated edit next to an equal letter", () => {
			const once = applyEdit([gen("@/x")], "@/x", "@/x@/x")
			const twice = applyEdit(once, "@/x@/x", "x/x@/x")
			expect(twice.filter((s) => s.source === "user").map((s) => s.text)).toEqual(["x"])
		})

		// Mirrors docs/architecture/tla/MentionOrigin.tla: a letter tagged user is a letter the user typed.
		it("never tags a generated letter user, for every single edit of up to two steps", () => {
			type Cell = { c: string; o: "user" | "generated" }
			const letters = ["a", "b"]
			const words = (n: number): string[] =>
				n === 0
					? [""]
					: words(n - 1)
							.flatMap((w) => [w, ...letters.map((l) => w + l)])
							.filter((w, i, all) => all.indexOf(w) === i)
			const small = words(2)
			const edits = (cells: Cell[]) =>
				Array.from({ length: cells.length + 1 }, (_, i) => i).flatMap((i) =>
					Array.from({ length: cells.length - i + 1 }, (_, k) => i + k).flatMap((j) =>
						small.map((r) => [
							...cells.slice(0, i),
							...Array.from(r, (c): Cell => ({ c, o: "user" })),
							...cells.slice(j),
						]),
					),
				)
			const toText = (cells: Cell[]) => cells.map((x) => x.c).join("")
			const check = (cells: Cell[], segments: MentionSegment[], depth: number) => {
				const sources = segments.flatMap((s) => Array.from(s.text, () => s.source))
				expect(sources).toHaveLength(cells.length)
				sources.forEach((source, i) => {
					if (source === "user") expect(cells[i]!.o).toBe("user")
				})
				if (depth === 0) return
				for (const next of edits(cells).filter((c) => c.length <= 5)) {
					check(next, applyEdit(segments, toText(cells), toText(next)), depth - 1)
				}
			}
			for (const start of words(3)) {
				check(
					Array.from(start, (c): Cell => ({ c, o: "generated" })),
					generatedSegments(start),
					2,
				)
			}
		})

		it("does not authorize a generated mention after an unrelated edit", () => {
			const result = applyEdit([gen("see @/secret")], "see @/secret", "see @/secret now")
			expect(userText(result)).toBe(" now")
		})
	})
})
