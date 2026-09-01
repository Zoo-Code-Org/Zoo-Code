import { isPositive, smokeLabel } from "./smoke"

describe("Stryker integration smoke", () => {
	it("kills a changed comparison while leaving the intentional label mutant alive", () => {
		expect(isPositive(1)).toBe(true)
		expect(isPositive(0)).toBe(false)
		expect(typeof smokeLabel()).toBe("string")
	})
})
