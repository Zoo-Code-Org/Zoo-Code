// npx vitest src/components/settings/__tests__/toolRepetitionLimits.spec.ts

import { clampToolRepetitionSoftLimit } from "../toolRepetitionLimits"

describe("clampToolRepetitionSoftLimit", () => {
	it("keeps a soft limit that is already below the hard limit", () => {
		expect(clampToolRepetitionSoftLimit(2, 5)).toBe(2)
	})

	it("clamps a soft limit equal to the hard limit down to hardLimit - 1 (invalid combination)", () => {
		// Soft == hard would make the soft-block path unreachable.
		expect(clampToolRepetitionSoftLimit(5, 5)).toBe(4)
	})

	it("clamps a soft limit above the hard limit down to hardLimit - 1 (invalid combination)", () => {
		expect(clampToolRepetitionSoftLimit(8, 3)).toBe(2)
	})

	it("allows soft limit 0 (soft warnings disabled) regardless of hard limit", () => {
		expect(clampToolRepetitionSoftLimit(0, 5)).toBe(0)
	})

	it("clamps soft to 0 when the hard limit is 1 (no room below it)", () => {
		expect(clampToolRepetitionSoftLimit(3, 1)).toBe(0)
	})

	it("does not impose an upper bound when the hard stop is disabled (hard limit 0)", () => {
		expect(clampToolRepetitionSoftLimit(9, 0)).toBe(9)
	})

	it("clamps negative soft values to 0", () => {
		expect(clampToolRepetitionSoftLimit(-3, 5)).toBe(0)
		expect(clampToolRepetitionSoftLimit(-3, 0)).toBe(0)
	})

	it("never returns a negative value for a fractional positive hard limit", () => {
		// hardLimit - 1 would be negative (e.g. 0.5 - 1 = -0.5); must be clamped to 0.
		expect(clampToolRepetitionSoftLimit(3, 0.5)).toBe(0)
		expect(clampToolRepetitionSoftLimit(0, 0.5)).toBe(0)
	})

	it("guarantees the saved value is always strictly below an enabled hard limit", () => {
		for (let hard = 1; hard <= 20; hard++) {
			for (let requested = 0; requested <= 30; requested++) {
				const result = clampToolRepetitionSoftLimit(requested, hard)
				expect(result).toBeGreaterThanOrEqual(0)
				expect(result).toBeLessThan(hard)
			}
		}
	})
})
