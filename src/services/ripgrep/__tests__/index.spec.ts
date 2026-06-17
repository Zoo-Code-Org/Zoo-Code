// npx vitest run src/services/ripgrep/__tests__/index.spec.ts

import path from "path"
import { vi, describe, it, expect, beforeEach } from "vitest"

import { truncateLine, getBinPath } from "../index"
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

describe("getBinPath", () => {
	const appRoot = "/fake/vscode/appRoot"
	const binName = process.platform.startsWith("win") ? "rg.exe" : "rg"
	const platformDir = `${process.platform}-${process.arch}`

	beforeEach(() => {
		mockFileExists.mockReset()
		mockFileExists.mockResolvedValue(false)
	})

	it("resolves ripgrep from the classic @vscode/ripgrep layout", async () => {
		const rg = path.join(appRoot, "node_modules/@vscode/ripgrep/bin", binName)
		mockFileExists.mockImplementation(async (p: string) => p === rg)

		expect(await getBinPath(appRoot)).toBe(rg)
	})

	it("resolves ripgrep from the @vscode/ripgrep-universal layout (VS Code Insiders)", async () => {
		const rg = path.join(appRoot, "node_modules/@vscode/ripgrep-universal/bin", platformDir, binName)
		mockFileExists.mockImplementation(async (p: string) => p === rg)

		expect(await getBinPath(appRoot)).toBe(rg)
	})

	it("resolves ripgrep from the unpacked `@vscode/ripgrep-universal` layout", async () => {
		const rg = path.join(appRoot, "node_modules.asar.unpacked/@vscode/ripgrep-universal/bin", platformDir, binName)
		mockFileExists.mockImplementation(async (p: string) => p === rg)

		expect(await getBinPath(appRoot)).toBe(rg)
	})

	it("returns undefined when ripgrep cannot be found", async () => {
		mockFileExists.mockResolvedValue(false)

		expect(await getBinPath(appRoot)).toBeUndefined()
	})
})
