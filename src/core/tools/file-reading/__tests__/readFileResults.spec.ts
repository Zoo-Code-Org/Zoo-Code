import { formatReadFileResults } from "../readFileResults"
import type { FileResult } from "../ReadFileTool"

const image = "data:image/png;base64,aW1hZ2U="

describe("single-file response formatting", () => {
	it("keeps text results separated in input order", () => {
		expect(
			formatReadFileResults(
				[
					{ path: "a", status: "approved", nativeContent: "File: a\n1 | first" },
					{ path: "b", status: "error", nativeContent: "File: b\nError: missing" },
				],
				false,
				false,
			),
		).toBe("File: a\n1 | first\n\n---\n\nFile: b\nError: missing")
	})

	it("places feedback and images before the file text without losing content", () => {
		const result = formatReadFileResults(
			[
				{
					path: "a",
					status: "approved",
					nativeContent: "File: a\n1 | content",
					feedbackText: "inspect carefully",
					feedbackImages: [image],
					imageDataUrl: image,
				},
			],
			false,
			true,
		)
		if (typeof result === "string") throw new Error("Expected multimodal response")
		expect(result.map((block) => block.type)).toEqual(["text", "image", "image", "text"])
		expect(result[0]).toMatchObject({ type: "text", text: expect.stringContaining("inspect carefully") })
		expect(result.at(-1)).toEqual({ type: "text", text: "File: a\n1 | content" })
	})

	it("retains denial feedback and omits images for text-only models", () => {
		const result = formatReadFileResults(
			[
				{
					path: "a",
					status: "denied",
					nativeContent: "File: a\nStatus: Denied by user",
					feedbackText: "private file",
					feedbackImages: [image],
				},
			],
			true,
			false,
		)
		expect(typeof result).toBe("string")
		expect(result).toContain("private file")
		expect(result).toContain("File: a\nStatus: Denied by user")
	})

	it("gives denial precedence over approved feedback", () => {
		const files: FileResult[] = [
			{ path: "a", status: "approved", feedbackText: "approved feedback", nativeContent: "File: a" },
		]
		const result = formatReadFileResults(files, true, false)
		expect(result).not.toContain("approved feedback")
		expect(result).toContain("File: a")
	})
})
