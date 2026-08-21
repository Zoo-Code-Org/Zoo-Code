import { composite, contrastRatio, parseCssColor, requiredTextContrast } from "../../../../playwright/contrast"

describe("contrast utilities", () => {
	it("parses opaque and translucent browser colors", () => {
		expect(parseCssColor("rgb(30, 30, 30)")).toEqual({ r: 30, g: 30, b: 30, a: 1 })
		expect(parseCssColor("rgba(255, 255, 255, 0.5)")).toEqual({ r: 255, g: 255, b: 255, a: 0.5 })
		const oklab = parseCssColor("oklab(1 0 0 / 60%)")
		expect(oklab.r).toBeCloseTo(255)
		expect(oklab.g).toBeCloseTo(255)
		expect(oklab.b).toBeCloseTo(255)
		expect(oklab.a).toBe(0.6)
	})

	it("composites translucent colors without rounding", () => {
		expect(composite(parseCssColor("rgba(255, 255, 255, 0.5)"), parseCssColor("rgb(0, 0, 0)"))).toEqual({
			r: 127.5,
			g: 127.5,
			b: 127.5,
			a: 1,
		})
	})

	it("calculates WCAG contrast ratios", () => {
		expect(contrastRatio(parseCssColor("rgb(255, 255, 255)"), parseCssColor("rgb(0, 0, 0)"))).toBe(21)
		expect(contrastRatio(parseCssColor("rgb(119, 119, 119)"), parseCssColor("rgb(255, 255, 255)"))).toBeCloseTo(
			4.48,
			2,
		)
	})

	it("uses exact WCAG large-text thresholds", () => {
		expect(requiredTextContrast(24, 400)).toBe(3)
		expect(requiredTextContrast(23.99, 400)).toBe(4.5)
		expect(requiredTextContrast(56 / 3, 700)).toBe(3)
		expect(requiredTextContrast(18.66, 700)).toBe(4.5)
	})

	it("rejects unsupported color formats", () => {
		expect(() => parseCssColor("transparent")).toThrow("Unsupported CSS color")
	})
})
