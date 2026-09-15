import { describe, expect, it } from "vitest"

import { mergeCoverageSources, parseCoverageSourceLines } from "../coverage-contract.mjs"

const coverage = (records) =>
	records
		.map(
			([source, lines]) =>
				`SF:${source}\n${lines.map((line) => `DA:${line},1`).join("\n")}\nLF:${lines.length}\nend_of_record`,
		)
		.join("\n")

const parse = (records, lane) => parseCoverageSourceLines(coverage(records), lane)

describe("coverage source equivalence", () => {
	it("accepts legitimate changes to the instrumented source population", () => {
		const before = [
			["src/a.ts", [1]],
			["src/b.ts", [1]],
		]
		const after = [
			["src/a.ts", [1, 2]],
			["src/b.ts", [1]],
		]

		expect(() =>
			mergeCoverageSources(
				["api", "core"],
				[
					["api", parse(after, "api")],
					["core", parse([["src/a.ts", [1, 2]]], "core")],
				],
			),
		).not.toThrow()
		expect([...parse(after, "api").values()].reduce((sum, lines) => sum + lines.size, 0)).toBe(
			[...parse(before, "api").values()].reduce((sum, lines) => sum + lines.size, 0) + 1,
		)
	})

	it("rejects omitted lane coverage", () => {
		expect(() => mergeCoverageSources(["api", "core"], [["api", parse([["src/a.ts", [1]]], "api")]])).toThrow(
			"Coverage lane is missing: core",
		)
	})

	it("rejects duplicated lane coverage", () => {
		expect(() =>
			mergeCoverageSources(
				["api"],
				[
					["api", parse([["src/a.ts", [1]]], "api")],
					["api", parse([["src/a.ts", [1]]], "api")],
				],
			),
		).toThrow("Coverage lane is duplicated: api")
	})

	it("rejects duplicate source records within a lane", () => {
		expect(() =>
			parse(
				[
					["src/a.ts", [1]],
					["src/a.ts", [1]],
				],
				"api",
			),
		).toThrow("api coverage contains duplicate source record: src/a.ts")
	})

	it("rejects unfinished source records", () => {
		expect(() => parseCoverageSourceLines("SF:src/a.ts\nDA:1,1\nSF:src/b.ts\nLF:1", "api")).toThrow(
			"api coverage contains an unfinished source record: src/a.ts",
		)
		expect(() => parseCoverageSourceLines("SF:src/a.ts\nDA:1,1\n", "api")).toThrow(
			"api coverage contains an unfinished source record: src/a.ts",
		)
		expect(() => parseCoverageSourceLines("SF:src/a.ts\nDA:1,1\nLF:1\n", "api")).toThrow(
			"api coverage contains an unfinished source record: src/a.ts",
		)
	})

	it("rejects conflicting instrumented line counts", () => {
		expect(() =>
			mergeCoverageSources(
				["api", "core"],
				[
					["api", parse([["src/a.ts", [1, 3]]], "api")],
					["core", parse([["src/a.ts", [1, 2]]], "core")],
				],
			),
		).toThrow("core coverage has conflicting instrumented lines for src/a.ts")
	})
})
