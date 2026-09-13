import { describe, expect, it } from "vitest"

import { verifyLcov } from "./verify-lcov.mjs"

describe("verifyLcov", () => {
	it("accepts complete records with covered lines", () => {
		expect(() => verifyLcov("SF:file.ts\nLF:1\nLH:1\nend_of_record\n")).not.toThrow()
	})

	it.each([
		["an empty source path", "SF:\nLF:1\nLH:1\nend_of_record\n"],
		["an unterminated record", "SF:file.ts\nLH:1\n"],
		["a zero-hit report", "SF:file.ts\nLF:1\nLH:0\nend_of_record\n"],
		["a hit count outside a record", "LH:1\n"],
		["a terminator outside a record", "end_of_record\n"],
		["consecutive source records", "SF:first.ts\nSF:second.ts\nLF:1\nLH:1\nend_of_record\n"],
		["a record without lines found", "SF:file.ts\nLH:1\nend_of_record\n"],
		["an infinite line count", "SF:file.ts\nLF:Infinity\nLH:1\nend_of_record\n"],
		["a fractional line count", "SF:file.ts\nLF:1.5\nLH:1\nend_of_record\n"],
		["an exponential line count", "SF:file.ts\nLF:1e3\nLH:1\nend_of_record\n"],
		["an infinite hit count", "SF:file.ts\nLH:Infinity\nend_of_record\n"],
		["a fractional hit count", "SF:file.ts\nLH:1.5\nend_of_record\n"],
		["an exponential hit count", "SF:file.ts\nLH:1e3\nend_of_record\n"],
		["duplicate line counts", "SF:file.ts\nLF:1\nLF:0\nLH:0\nend_of_record\n"],
		["duplicate hit counts", "SF:file.ts\nLF:1\nLH:1\nLH:0\nend_of_record\n"],
		["more hit lines than found lines", "SF:file.ts\nLF:0\nLH:1\nend_of_record\n"],
	])("rejects %s", (_, content) => {
		expect(() => verifyLcov(content)).toThrow()
	})
})
