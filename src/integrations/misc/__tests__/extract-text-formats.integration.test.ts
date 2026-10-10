import fs from "fs/promises"
import path from "path"
import { extractTextFromBuffer } from "../extract-text"

// Keep real parser fixtures separate from the mocked parser unit suite.
describe("real document buffer decoding", () => {
	afterEach(() => vi.restoreAllMocks())

	it("extracts numbered PDF text from fixture bytes without reopening the metadata pathname", async () => {
		const source = await fs.readFile(path.join(__dirname, "fixtures", "approved.pdf"))
		const access = vi.spyOn(fs, "access").mockRejectedValue(new Error("Unexpected pathname access"))
		const readFile = vi.spyOn(fs, "readFile").mockRejectedValue(new Error("Unexpected pathname read"))

		// pdf-parse prefixes each page with two newlines, which retain their line numbers.
		expect(await extractTextFromBuffer(source, "metadata-only.PDF")).toBe(
			"1 | \n2 | \n3 | Approved PDF first line\n4 | Approved PDF second line\n",
		)
		expect(access).not.toHaveBeenCalled()
		expect(readFile).not.toHaveBeenCalled()
	})

	it("extracts numbered DOCX paragraphs from fixture bytes without reopening the metadata pathname", async () => {
		const source = await fs.readFile(path.join(__dirname, "fixtures", "approved.docx"))
		const access = vi.spyOn(fs, "access").mockRejectedValue(new Error("Unexpected pathname access"))
		const readFile = vi.spyOn(fs, "readFile").mockRejectedValue(new Error("Unexpected pathname read"))

		// Mammoth separates paragraphs with two newlines and decodes XML entities across runs.
		expect(await extractTextFromBuffer(source, "metadata-only.DOCX")).toBe(
			"1 | Approved DOCX first paragraph\n2 | \n3 | Approved DOCX second & final paragraph\n4 | \n",
		)
		expect(access).not.toHaveBeenCalled()
		expect(readFile).not.toHaveBeenCalled()
	})
})
