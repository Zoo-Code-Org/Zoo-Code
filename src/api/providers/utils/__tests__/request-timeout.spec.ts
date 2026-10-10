import { getRequestTimeoutMs } from "../request-timeout"

describe("getRequestTimeoutMs", () => {
	it("forwards positive timeout values unchanged", () => {
		expect(getRequestTimeoutMs(5000)).toBe(5000)
		expect(getRequestTimeoutMs(1)).toBe(1)
		expect(getRequestTimeoutMs(1234)).toBe(1234)
	})

	it("returns undefined for zero (timeout disabled, not an immediate abort)", () => {
		expect(getRequestTimeoutMs(0)).toBeUndefined()
	})

	it("returns undefined for negative values", () => {
		expect(getRequestTimeoutMs(-1)).toBeUndefined()
		expect(getRequestTimeoutMs(-5000)).toBeUndefined()
	})

	it("returns undefined when no value is provided", () => {
		expect(getRequestTimeoutMs()).toBeUndefined()
		expect(getRequestTimeoutMs(undefined)).toBeUndefined()
	})

	it("guards against non-number input at the runtime boundary", () => {
		expect(getRequestTimeoutMs(NaN)).toBeUndefined()
		// Non-number values can only reach this helper through untyped callers
		// (e.g. user settings); the double cast exercises the typeof guard.
		expect(getRequestTimeoutMs("5000" as unknown as number)).toBeUndefined()
	})
})
