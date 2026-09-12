import { describe, expect, it } from "vitest"

import { verifyLcov } from "./verify-lcov.mjs"

describe("verifyLcov", () => {
	it("accepts complete records with covered lines", () => {
		expect(() => verifyLcov("SF:file.ts\nLF:1\nLH:1\nend_of_record\n")).not.toThrow()
	})

	it.each([
		["an unterminated record", "SF:file.ts\nLH:1\n"],
		["a zero-hit report", "SF:file.ts\nLF:1\nLH:0\nend_of_record\n"],
		["a hit count outside a record", "LH:1\n"],
		["a terminator outside a record", "end_of_record\n"],
		["an infinite hit count", "SF:file.ts\nLH:Infinity\nend_of_record\n"],
		["a fractional hit count", "SF:file.ts\nLH:1.5\nend_of_record\n"],
		["an exponential hit count", "SF:file.ts\nLH:1e3\nend_of_record\n"],
	])("rejects %s", (_, content) => {
		expect(() => verifyLcov(content)).toThrow()
	})
})
