// npx vitest run src/services/ripgrep/__tests__/index.spec.ts

import path from "path"
import { vi, describe, it, expect, beforeEach } from "vitest"

import { truncateLine, getBinPath, bundledRgPath } from "../index"
import { fileExistsAtPath } from "../../../utils/fs"

vi.mock("../../../utils/fs", () => ({
	fileExistsAtPath: vi.fn(),
}))

const mockFileExists = vi.mocked(fileExistsAtPath)

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

describe("getBinPath bundled-ripgrep fallback", () => {
	beforeEach(() => {
		mockFileExists.mockReset()
	})

	it("falls back to the bundled ripgrep when ripgrep is absent under the VS Code app root", async () => {
		// VS Code Insiders' staged-install layout: nothing under appRoot.
		mockFileExists.mockImplementation(async (p: string) => p === bundledRgPath)

		const result = await getBinPath("/fake/vscode/app/root")

		expect(result).toBe(bundledRgPath)
	})

	it("prefers VS Code's own ripgrep over the bundled copy", async () => {
		const appRoot = "/fake/vscode/app/root"
		// Derive the binary name from bundledRgPath so this test tracks the
		// module's own platform logic instead of duplicating it.
		const vscodeRg = path.join(appRoot, "node_modules/@vscode/ripgrep/bin", path.basename(bundledRgPath))
		mockFileExists.mockImplementation(async (p: string) => p === vscodeRg || p === bundledRgPath)

		const result = await getBinPath(appRoot)

		expect(result).toBe(vscodeRg)
	})

	it("returns undefined when ripgrep exists nowhere", async () => {
		mockFileExists.mockResolvedValue(false)

		const result = await getBinPath("/fake/vscode/app/root")

		expect(result).toBeUndefined()
	})
})
