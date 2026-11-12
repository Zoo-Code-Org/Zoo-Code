import { abortError, isParserAbort, ParserFatalError, throwIfAborted } from "../parser-errors"

describe("parser errors", () => {
	it.each(["parser-abort", "parse-timeout"] as const)("preserves the %s category and file", (category) => {
		const error = new ParserFatalError(category, "source.ts")
		expect(error).toBeInstanceOf(Error)
		expect(error).toMatchObject({ name: "ParserFatalError", category, filePath: "source.ts", message: category })
		expect(new ParserFatalError(category, "source.ts", "detail").message).toBe("detail")
	})

	it.each([
		["Aborted()", true],
		[new Error("MEMORY ACCESS OUT OF BOUNDS"), true],
		[new Error("ordinary parse failure"), false],
		[undefined, false],
	])("classifies %s without treating ordinary failures as fatal", (error, expected) => {
		expect(isParserAbort(error)).toBe(expected)
	})

	it("only throws a cancellation for an aborted signal", () => {
		expect(abortError()).toMatchObject({ name: "AbortError", message: "Indexing aborted" })
		expect(() => throwIfAborted()).not.toThrow()
		const controller = new AbortController()
		expect(() => throwIfAborted(controller.signal)).not.toThrow()
		controller.abort()
		expect(() => throwIfAborted(controller.signal)).toThrow("Indexing aborted")
	})
})
