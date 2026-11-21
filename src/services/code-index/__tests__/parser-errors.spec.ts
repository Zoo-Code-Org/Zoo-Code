import { isParserAbort, ParserFatalError } from "../parser-errors"
import { PARSE_TIMEOUT_MS } from "../constants"

describe("parser errors", () => {
	it.each(["timeout", "crash", "exit"] as const)("keeps the %s category and file path", (category) => {
		const error = new ParserFatalError(category, "source.ts")
		expect(error).toBeInstanceOf(Error)
		expect(error).toMatchObject({ name: "ParserFatalError", category, filePath: "source.ts", message: category })
		expect(new ParserFatalError(category, "source.ts", "detail").message).toBe("detail")
	})

	it.each([
		["Aborted()", true],
		[new Error("Aborted(OOM)"), true],
		[new Error("MEMORY ACCESS OUT OF BOUNDS"), true],
		[new Error("ordinary parse failure"), false],
		["Aborted", false],
		[undefined, false],
	])("CI-PW-06: isParserAbort(%s) is %s", (error, expected) => {
		expect(isParserAbort(error)).toBe(expected)
	})

	it("CI-PW-06: the parse timeout is ten seconds", () => {
		expect(PARSE_TIMEOUT_MS).toBe(10_000)
	})
})
