import { CodeParser } from "../parser"
import { scannerExtensions, shouldUseFallbackChunking } from "../../shared/supported-extensions"

vi.mock("../../../../../packages/telemetry/src/TelemetryService", () => ({
	TelemetryService: {
		instance: {
			captureEvent: vi.fn(),
		},
	},
}))

describe("CodeParser - plain text support", () => {
	it("supports .txt files through fallback chunking", async () => {
		expect(scannerExtensions).toContain(".txt")
		expect(shouldUseFallbackChunking(".txt")).toBe(true)

		const content = [
			"Zoo Code plain text indexing regression test.",
			"This sentence contains searchable content that only exists in the text file.",
			"The fallback parser should preserve every line while creating an indexable chunk.",
		].join("\n")

		const blocks = await new CodeParser().parseFile("manual.txt", {
			content,
			fileHash: "txt-file-hash",
		})

		expect(blocks).toHaveLength(1)
		expect(blocks[0]).toMatchObject({
			file_path: "manual.txt",
			type: "fallback_chunk",
			start_line: 1,
			end_line: 3,
			content,
			fileHash: "txt-file-hash",
			segmentHash: expect.any(String),
		})
	})

	it("parses uppercase .TXT extensions", async () => {
		expect(shouldUseFallbackChunking(".TXT")).toBe(true)

		const content = "Uppercase plain-text extension content long enough to produce a fallback chunk."
		const blocks = await new CodeParser().parseFile("manual.TXT", {
			content,
			fileHash: "uppercase-txt-file-hash",
		})

		expect(blocks).toHaveLength(1)
		expect(blocks[0]).toMatchObject({
			file_path: "manual.TXT",
			type: "fallback_chunk",
			content,
			fileHash: "uppercase-txt-file-hash",
			segmentHash: expect.any(String),
		})
	})
})
