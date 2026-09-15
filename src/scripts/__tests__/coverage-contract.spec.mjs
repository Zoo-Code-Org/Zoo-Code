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

	it.each([
		["empty source paths", "SF:\nLF:0\nend_of_record", "empty source path"],
		["DA outside a record", "DA:1,1", "DA outside a source record"],
		["LF outside a record", "LF:0", "LF outside a source record"],
		["DA after LF", "SF:src/a.ts\nDA:1,1\nLF:1\nDA:2,1\nend_of_record", "DA after LF"],
		["missing DA counts", "SF:src/a.ts\nDA:1\nLF:1\nend_of_record", "invalid DA"],
		["nonnumeric DA counts", "SF:src/a.ts\nDA:1,nope\nLF:1\nend_of_record", "invalid DA"],
		[
			"unsafe DA line numbers",
			`SF:src/a.ts\nDA:${Number.MAX_SAFE_INTEGER + 1},0\nLF:1\nend_of_record`,
			"invalid DA",
		],
		["unsafe DA counts", `SF:src/a.ts\nDA:1,${Number.MAX_SAFE_INTEGER + 1}\nLF:1\nend_of_record`, "invalid DA"],
		["duplicate DA lines", "SF:src/a.ts\nDA:1,0\nDA:1,1\nLF:2\nend_of_record", "duplicate DA"],
		["empty LF values", "SF:src/a.ts\nLF:\nend_of_record", "invalid LF"],
		["nonnumeric LF values", "SF:src/a.ts\nLF:nope\nend_of_record", "invalid LF"],
		["invalid terminators", "end_of_record", "invalid record terminator"],
	])("rejects %s", (_name, lcov, error) => {
		expect(() => parseCoverageSourceLines(lcov, "api")).toThrow(error)
	})

	it("accepts DA and LF numeric boundaries", () => {
		expect(() =>
			parseCoverageSourceLines(
				`SF:src/a.ts\nDA:1,0\nDA:${Number.MAX_SAFE_INTEGER},0,checksum\nLF:2\nend_of_record`,
				"api",
			),
		).not.toThrow()
	})

	it("rejects empty and unexpected lane coverage", () => {
		expect(() => mergeCoverageSources(["api"], [["api", new Map()]])).toThrow(
			"Coverage lane has no instrumented lines: api",
		)
		expect(() =>
			mergeCoverageSources(
				["api"],
				[
					["api", parse([["src/a.ts", [1]]], "api")],
					["core", parse([["src/a.ts", [1]]], "core")],
				],
			),
		).toThrow("Unexpected coverage lane: core")
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
