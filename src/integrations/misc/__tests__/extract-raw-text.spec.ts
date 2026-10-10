import fs from "fs/promises"
import { extractRawTextFromFile, extractTextFromFile } from "../extract-text"

const { parsePdf, parseDocx } = vi.hoisted(() => ({
	parsePdf: vi.fn<(buffer: Buffer) => Promise<{ text: string }>>(),
	parseDocx: vi.fn<typeof import("mammoth").extractRawText>(),
}))

vi.mock("pdf-parse/lib/pdf-parse", () => ({ default: parsePdf }))
vi.mock("mammoth", () => ({ default: { extractRawText: parseDocx } }))
vi.mock("fs/promises", () => ({ default: { access: vi.fn(), readFile: vi.fn() } }))

describe("raw document extraction compatibility", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.mocked(fs.access).mockResolvedValue(undefined)
		vi.mocked(fs.readFile).mockResolvedValue(Buffer.from("document bytes"))
	})

	it("returns raw PDF text while preserving the existing formatted PDF API", async () => {
		parsePdf.mockResolvedValue({ text: "12 | genuine text\n    indented text" })

		expect(await extractRawTextFromFile("document.pdf")).toBe("12 | genuine text\n    indented text")
		expect(await extractTextFromFile("document.pdf")).toBe("1 | 12 | genuine text\n2 |     indented text\n")
	})

	it("preserves raw DOCX whitespace and trailing newlines without changing formatted DOCX output", async () => {
		parseDocx.mockResolvedValue({ value: "12 | genuine text\n    indented text\n\n", messages: [] })

		expect(await extractRawTextFromFile("document.docx")).toBe("12 | genuine text\n    indented text\n\n")
		expect(await extractTextFromFile("document.docx")).toBe("1 | 12 | genuine text\n2 |     indented text\n3 | \n")
	})

	it("does not replace a document parser failure with a missing-file or formatting error", async () => {
		const failure = new Error("Corrupt DOCX archive")
		parseDocx.mockRejectedValueOnce(failure)

		await expect(extractRawTextFromFile("document.docx")).rejects.toBe(failure)
	})

	it("reports a missing document before invoking its parser", async () => {
		vi.mocked(fs.access).mockRejectedValueOnce(new Error("ENOENT"))

		await expect(extractRawTextFromFile("missing.pdf")).rejects.toThrow("File not found: missing.pdf")
		expect(parsePdf).not.toHaveBeenCalled()
		expect(fs.readFile).not.toHaveBeenCalled()
	})

	it("rejects unsupported document formats without trying to interpret their bytes", async () => {
		await expect(extractRawTextFromFile("archive.bin")).rejects.toThrow(
			"Cannot extract document text for file type: .bin",
		)
		expect(fs.readFile).not.toHaveBeenCalled()
		expect(parsePdf).not.toHaveBeenCalled()
		expect(parseDocx).not.toHaveBeenCalled()
	})
})
