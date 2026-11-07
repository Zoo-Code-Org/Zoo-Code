import { describe, expect, it } from "vitest"

import {
	QuotaHttpError,
	asRecord,
	clampPercent,
	formatCredits,
	formatMoney,
	roundToTenth,
	safeErrorMessage,
	toEpochMs,
	toNumber,
} from "../quotaUtils"

describe("toEpochMs", () => {
	it("treats numbers below 1e12 as epoch seconds and larger ones as milliseconds", () => {
		expect(toEpochMs(1_800_000_000)).toBe(1_800_000_000_000)
		expect(toEpochMs(1_800_000_000_000)).toBe(1_800_000_000_000)
	})

	it("parses date strings", () => {
		expect(toEpochMs("2026-01-02T03:04:05Z")).toBe(Date.parse("2026-01-02T03:04:05Z"))
	})

	it("rejects zero, negatives, non-finite numbers, blank and unparseable strings, and other types", () => {
		expect(toEpochMs(0)).toBeUndefined()
		expect(toEpochMs(-5)).toBeUndefined()
		expect(toEpochMs(Number.NaN)).toBeUndefined()
		expect(toEpochMs(Number.POSITIVE_INFINITY)).toBeUndefined()
		expect(toEpochMs("   ")).toBeUndefined()
		expect(toEpochMs("not a date")).toBeUndefined()
		expect(toEpochMs(null)).toBeUndefined()
		expect(toEpochMs({})).toBeUndefined()
	})
})

describe("toNumber", () => {
	it.each([
		[5, 5],
		[0, 0],
		["12.5", 12.5],
		[" 7 ", 7],
	])("accepts %j", (input, expected) => expect(toNumber(input)).toBe(expected))

	it.each([[NaN], [Infinity], [""], ["   "], ["abc"], [null], [undefined], [{}], [[]]])("rejects %j", (input) =>
		expect(toNumber(input)).toBeUndefined(),
	)
})

describe("asRecord", () => {
	it("returns plain objects only", () => {
		expect(asRecord({ a: 1 })).toEqual({ a: 1 })
		for (const bad of [null, undefined, [], "x", 1]) expect(asRecord(bad)).toBeUndefined()
	})
})

describe("clampPercent", () => {
	it.each([
		[-5, 0],
		[0, 0],
		[42.5, 42.5],
		[100, 100],
		[250, 100],
	])("%j → %j", (input, expected) => expect(clampPercent(input)).toBe(expected))
})

describe("formatMoney", () => {
	it("formats with two decimals and a sign before the symbol", () => {
		expect(formatMoney(12.4)).toBe("$12.40")
		expect(formatMoney(-0.5)).toBe("-$0.50")
		expect(formatMoney(8, "¥")).toBe("¥8.00")
	})
})

describe("formatCredits", () => {
	it("keeps whole numbers whole and fractions to one decimal", () => {
		expect(formatCredits(140000)).toBe("140,000")
		expect(formatCredits(39389.34)).toBe("39,389.3")
	})
})

describe("roundToTenth", () => {
	it("rounds to one decimal", () => {
		expect(roundToTenth(39389.26)).toBe(39389.3)
		expect(roundToTenth(5)).toBe(5)
	})
})

describe("safeErrorMessage", () => {
	it("keeps the status for HTTP errors", () => {
		expect(safeErrorMessage(new QuotaHttpError(503))).toBe("HTTP 503")
	})

	it("normalises timeouts and aborts", () => {
		const timeout = Object.assign(new Error("x"), { name: "TimeoutError" })
		const abort = Object.assign(new Error("x"), { name: "AbortError" })
		expect(safeErrorMessage(timeout)).toBe("Request timed out")
		expect(safeErrorMessage(abort)).toBe("Request timed out")
	})

	it("never leaks the text of arbitrary errors (could embed URLs, headers or keys)", () => {
		const leaky = new Error(
			"fetch failed: https://api.example.com/v1?key=sk-secret Authorization: Bearer sk-secret",
		)
		expect(safeErrorMessage(leaky)).toBe("Request failed")
		expect(safeErrorMessage("sk-secret")).toBe("Request failed")
		expect(safeErrorMessage(undefined)).toBe("Request failed")
	})
})
