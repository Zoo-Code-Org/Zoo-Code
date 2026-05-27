// npx vitest run packages/core/src/message-utils/__tests__/safeJsonParse.spec.ts

import { safeJsonParse } from "../safeJsonParse.js"

describe("safeJsonParse", () => {
	let consoleErrorSpy: ReturnType<typeof vi.spyOn>

	beforeEach(() => {
		consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
	})

	afterEach(() => {
		consoleErrorSpy.mockRestore()
	})

	it("returns the parsed value for valid JSON", () => {
		expect(safeJsonParse<{ a: number }>('{"a":1}')).toEqual({ a: 1 })
		expect(consoleErrorSpy).not.toHaveBeenCalled()
	})

	it("returns the default value for null, undefined, or empty input", () => {
		expect(safeJsonParse<string>(null, "fallback")).toBe("fallback")
		expect(safeJsonParse<string>(undefined, "fallback")).toBe("fallback")
		expect(safeJsonParse<string>("", "fallback")).toBe("fallback")
		expect(consoleErrorSpy).not.toHaveBeenCalled()
	})

	it("returns the default value and logs the generic message when no context is given (backward compatible)", () => {
		const result = safeJsonParse<{ a: number }>("not json", undefined)
		expect(result).toBeUndefined()
		expect(consoleErrorSpy).toHaveBeenCalledTimes(1)
		const message = consoleErrorSpy.mock.calls[0]?.[0]
		expect(message).toBe("Error parsing JSON:")
	})

	it("includes the context label in the error log when provided", () => {
		const result = safeJsonParse<{ a: number }>("not json", undefined, "foo")
		expect(result).toBeUndefined()
		expect(consoleErrorSpy).toHaveBeenCalledTimes(1)
		const message = consoleErrorSpy.mock.calls[0]?.[0]
		expect(message).toBe("Error parsing JSON (foo):")
	})
})
