// npx vitest core/mentions/__tests__/import-isolation.spec.ts

import { describe, expect, it, vi } from "vitest"

vi.mock("vscode", () => ({
	window: {
		showErrorMessage: vi.fn(),
	},
}))

vi.mock("../../../i18n", () => ({
	t: vi.fn((key: string) => key),
}))

/**
 * Import-isolation regression (CI platform-unit-test, PR 2680): the five
 * ClineProvider specs stub extract-text with partial factories that define
 * only the extractor they use. Importing mentions/index.ts must therefore
 * not touch any extract-text export at module load; the supported binary
 * formats are read lazily on first use instead.
 */
vi.mock("../../../integrations/misc/extract-text", () => ({
	// Deliberately partial: mirrors the ClineProvider spec mocks, which do
	// not define getSupportedBinaryFormats.
	extractTextFromFile: vi.fn().mockResolvedValue("file content"),
}))

describe("mentions module import isolation", () => {
	it("imports cleanly when extract-text is mocked without getSupportedBinaryFormats", async () => {
		const mentions = await import("../index")

		expect(typeof mentions.parseMentions).toBe("function")
		expect(typeof mentions.openMention).toBe("function")
	})
})
