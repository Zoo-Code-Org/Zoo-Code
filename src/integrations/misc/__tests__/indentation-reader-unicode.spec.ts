import { formatWithLineNumbers, parseLines } from "../indentation-reader"

describe("line formatting Unicode boundaries", () => {
	it("does not leave a dangling surrogate when clipping a long line", () => {
		const output = formatWithLineNumbers(parseLines("🔥".repeat(2000)))
		expect(output).toContain("...")
		expect(Buffer.from(output).toString("utf8")).not.toContain("�")
		expect(output.length).toBeLessThanOrEqual(2004)
	})
})
