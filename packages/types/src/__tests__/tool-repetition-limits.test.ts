// npx vitest run src/__tests__/tool-repetition-limits.test.ts

import { normalizeToolRepetitionSoftLimit } from "../provider-settings.js"

describe("normalizeToolRepetitionSoftLimit", () => {
	it("keeps a soft limit that is already below the hard limit", () => {
		expect(normalizeToolRepetitionSoftLimit(2, 5)).toBe(2)
	})

	it("clamps a soft limit equal to the hard limit down to hardLimit - 1", () => {
		expect(normalizeToolRepetitionSoftLimit(5, 5)).toBe(4)
	})

	it("clamps a soft limit above the hard limit down to hardLimit - 1", () => {
		expect(normalizeToolRepetitionSoftLimit(8, 3)).toBe(2)
	})

	it("allows soft limit 0 regardless of hard limit", () => {
		expect(normalizeToolRepetitionSoftLimit(0, 5)).toBe(0)
	})

	it("clamps soft to 0 when the hard limit is 1", () => {
		expect(normalizeToolRepetitionSoftLimit(3, 1)).toBe(0)
	})

	it("disables the soft tier when the hard limit is 0", () => {
		expect(normalizeToolRepetitionSoftLimit(9, 0)).toBe(0)
		expect(normalizeToolRepetitionSoftLimit(2, 0)).toBe(0)
		expect(normalizeToolRepetitionSoftLimit(2, -1)).toBe(0)
	})

	it("disables the soft tier when the hard limit is effectively unreachable", () => {
		expect(normalizeToolRepetitionSoftLimit(2, Number.MAX_SAFE_INTEGER)).toBe(0)
		expect(normalizeToolRepetitionSoftLimit(2, Number.POSITIVE_INFINITY)).toBe(0)
	})

	it("clamps negative soft values to 0", () => {
		expect(normalizeToolRepetitionSoftLimit(-3, 5)).toBe(0)
		expect(normalizeToolRepetitionSoftLimit(-3, 0)).toBe(0)
	})

	it("never returns a negative value for a fractional hard limit", () => {
		expect(normalizeToolRepetitionSoftLimit(3, 0.5)).toBe(0)
		expect(normalizeToolRepetitionSoftLimit(0, 0.5)).toBe(0)
	})

	it("always stays strictly below an enabled hard limit", () => {
		for (let hard = 1; hard <= 20; hard++) {
			for (let requested = 0; requested <= 30; requested++) {
				const result = normalizeToolRepetitionSoftLimit(requested, hard)
				expect(result).toBeGreaterThanOrEqual(0)
				expect(result).toBeLessThan(hard)
			}
		}
	})
})
