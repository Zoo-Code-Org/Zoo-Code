// npx vitest run src/services/ripgrep/__tests__/index.spec.ts

import { vi, describe, it, expect, beforeEach } from "vitest"

import { truncateLine, getBinPath } from "../index"

const ripgrepMock = vi.hoisted(() => ({ value: undefined as string | undefined, throws: false }))

vi.mock("@vscode/ripgrep", () => ({
	get rgPath() {
		if (ripgrepMock.throws) {
			throw new Error("simulated @vscode/ripgrep failure")
		}
		return ripgrepMock.value
	},
}))

describe("Ripgrep line truncation", () => {
	// The default MAX_LINE_LENGTH is 500 in the implementation
	const MAX_LINE_LENGTH = 500

	it("should truncate lines longer than MAX_LINE_LENGTH", () => {
		const longLine = "a".repeat(600) // Line longer than MAX_LINE_LENGTH
		const truncated = truncateLine(longLine)

		expect(truncated).toContain("[truncated...]")
		expect(truncated.length).toBeLessThan(longLine.length)
		expect(truncated.length).toEqual(MAX_LINE_LENGTH + " [truncated...]".length)
	})

	it("should not truncate lines shorter than MAX_LINE_LENGTH", () => {
		const shortLine = "Short line of text"
		const truncated = truncateLine(shortLine)

		expect(truncated).toEqual(shortLine)
		expect(truncated).not.toContain("[truncated...]")
	})

	it("should correctly truncate a line at exactly MAX_LINE_LENGTH characters", () => {
		const exactLine = "a".repeat(MAX_LINE_LENGTH)
		const exactPlusOne = exactLine + "x"

		// Should not truncate when exactly MAX_LINE_LENGTH
		expect(truncateLine(exactLine)).toEqual(exactLine)

		// Should truncate when exceeding MAX_LINE_LENGTH by even 1 character
		expect(truncateLine(exactPlusOne)).toContain("[truncated...]")
	})

	it("should handle empty lines without errors", () => {
		expect(truncateLine("")).toEqual("")
	})

	it("should allow custom maximum length", () => {
		const customLength = 100
		const line = "a".repeat(customLength + 50)

		const truncated = truncateLine(line, customLength)

		expect(truncated.length).toEqual(customLength + " [truncated...]".length)
		expect(truncated).toContain("[truncated...]")
	})
})

describe("getBinPath", () => {
	beforeEach(() => {
		ripgrepMock.value = undefined
		ripgrepMock.throws = false
	})

	it("returns the rgPath exported by @vscode/ripgrep", async () => {
		ripgrepMock.value = "/path/to/rg"

		expect(await getBinPath("/ignored")).toBe("/path/to/rg")
	})

	it("rewrites node_modules.asar to node_modules.asar.unpacked", async () => {
		ripgrepMock.value = "/app/node_modules.asar/@vscode/ripgrep-universal/bin/win32-x64/rg.exe"

		expect(await getBinPath("/ignored")).toBe(
			"/app/node_modules.asar.unpacked/@vscode/ripgrep-universal/bin/win32-x64/rg.exe",
		)
	})

	it("returns undefined when rgPath is not exported", async () => {
		ripgrepMock.value = undefined

		expect(await getBinPath("/ignored")).toBeUndefined()
	})

	it("returns undefined when rgPath resolution throws", async () => {
		ripgrepMock.throws = true

		expect(await getBinPath("/ignored")).toBeUndefined()
	})
})
