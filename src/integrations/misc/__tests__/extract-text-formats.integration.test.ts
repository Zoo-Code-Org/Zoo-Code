import fs from "fs/promises"
import path from "path"
import { createHash } from "node:crypto"
import { extractTextFromBuffer } from "../extract-text"

// Keep real parser fixtures separate from the mocked parser unit suite.
describe("real document buffer decoding", () => {
	afterEach(() => vi.restoreAllMocks())

	it.each([
		{
			filename: "approved.pdf",
			sha256: "11b19aed8bc2e40b9eda9d18b7bfe36e0bbc41c4383d7e30141927992790f411",
		},
		{
			filename: "approved.docx",
			sha256: "732d827ad38ff51c24983c773bcb964ba53ca29bb055ea73aa9fbed820ae3a9b",
		},
	])("matches the documented SHA-256 for $filename", async ({ filename, sha256 }) => {
		const source = await fs.readFile(path.join(__dirname, "fixtures", filename))
		expect(createHash("sha256").update(source).digest("hex")).toBe(sha256)
	})

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
