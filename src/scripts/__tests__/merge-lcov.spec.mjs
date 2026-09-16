import { describe, expect, it } from "vitest"

import { mergeLcov } from "../merge-lcov.mjs"

const report = (coveredLines) => `SF:src/example.ts
FN:1,example
FNDA:${coveredLines.has(1) ? 1 : 0},example
FNF:1
FNH:${coveredLines.has(1) ? 1 : 0}
BRDA:2,0,0,${coveredLines.has(2) ? 1 : "-"}
BRF:1
BRH:${coveredLines.has(2) ? 1 : 0}
DA:1,${coveredLines.has(1) ? 1 : 0}
DA:2,${coveredLines.has(2) ? 1 : 0}
DA:3,${coveredLines.has(3) ? 1 : 0}
LF:3
LH:${coveredLines.size}
end_of_record
`

describe("mergeLcov", () => {
	it("counts a line as covered when any coverage lane executes it", () => {
		const merged = mergeLcov([
			["api", report(new Set([1]))],
			["core", report(new Set([2]))],
		])

		expect(merged).toContain("FNDA:1,example")
		expect(merged).toContain("BRDA:2,0,0,1")
		expect(merged).toContain("DA:1,1")
		expect(merged).toContain("DA:2,1")
		expect(merged).toContain("LH:2")
	})

	it("keeps lines uncovered when no coverage lane executes them", () => {
		const merged = mergeLcov([
			["api", report(new Set([1]))],
			["core", report(new Set([2]))],
		])

		expect(merged).toContain("DA:3,0")
		expect(merged).not.toContain("DA:3,1")
	})

	it("merges disjoint source records without changing their paths", () => {
		const merged = mergeLcov([
			["api", report(new Set([1])).replaceAll("src/example.ts", "src/api.ts")],
			["core", report(new Set([2])).replaceAll("src/example.ts", "src/core.ts")],
		])

		expect(merged.match(/^SF:/gm)).toHaveLength(2)
		expect(merged).toContain("SF:src/api.ts")
		expect(merged).toContain("SF:src/core.ts")
	})
})
