import { createTimeoutError, getRequestTimeoutMs } from "../request-timeout"

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

	it("rounds fractional values up and rejects non-finite values", () => {
		// AbortSignal.timeout validates its delay as uint32: fractions must
		// round up (never down to 0), and Infinity must mean "no timeout".
		expect(getRequestTimeoutMs(1500.5)).toBe(1501)
		expect(getRequestTimeoutMs(0.5)).toBe(1)
		expect(getRequestTimeoutMs(Infinity)).toBeUndefined()
	})

	it("guards against non-number input at the runtime boundary", () => {
		expect(getRequestTimeoutMs(NaN)).toBeUndefined()
		// Non-number values can only reach this helper through untyped callers
		// (e.g. user settings); the double cast exercises the typeof guard.
		expect(getRequestTimeoutMs("5000" as unknown as number)).toBeUndefined()
	})
})

describe("createTimeoutError", () => {
	it("names the error TimeoutError and includes provider and phase", () => {
		const error = createTimeoutError("Gemini", "completion request")
		expect(error).toBeInstanceOf(Error)
		expect(error.name).toBe("TimeoutError")
		expect(error.message).toBe("The Gemini completion request timed out")
	})

	it("names the phase that the phase-less build dropped", () => {
		// A catalog wait is model discovery. Collapsing the duplicate definition into
		// this one is what lets a caller report the phase that actually stalled.
		const error = createTimeoutError("Friendli", "model discovery")
		expect(error.name).toBe("TimeoutError")
		expect(error.message).toBe("The Friendli model discovery timed out")
	})

	it("carries the failure the deadline was detected through", () => {
		// A stalled response body or a late SDK rejection is not the deadline itself;
		// cause keeps both facts in one report.
		const cause = new Error("Response body stalled")
		const error = createTimeoutError("Unbound", "completion request", cause)
		expect(error.message).toBe("The Unbound completion request timed out")
		expect(error.cause).toBe(cause)
	})

	it("leaves cause unset when the caller has no underlying failure", () => {
		// A timer that elapsed on its own has nothing to attribute. Passing an
		// undefined cause would make the error look attributed when it is not.
		const error = createTimeoutError("Vercel AI Gateway", "model discovery")
		expect("cause" in error).toBe(false)
	})
})
