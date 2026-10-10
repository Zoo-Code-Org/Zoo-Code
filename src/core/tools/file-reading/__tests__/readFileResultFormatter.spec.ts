import { ReadFileResultFormatter } from "../ReadFileResultFormatter"
import type { FileResult } from "../types"
import { formatResponse } from "../../../prompts/responses"

const image = "data:image/png;base64,aW1hZ2U="

describe("ReadFileResultFormatter", () => {
	let formatter: ReadFileResultFormatter

	beforeEach(() => {
		formatter = new ReadFileResultFormatter()
	})

	it.each([
		{ path: "a", status: "approved", nativeContent: "File: a\n1 | content" },
		{ path: "a", status: "error", nativeContent: "File: a\nError: missing" },
		{ path: "a", status: "blocked", nativeContent: "File: a\nError: blocked" },
	] satisfies FileResult[])("returns $status file text unchanged", (file) => {
		expect(formatter.format(file, false)).toEqual([{ type: "text", text: file.nativeContent }])
	})

	it("returns an empty array when the file has no content or feedback", () => {
		expect(formatter.format({ path: "a", status: "cancelled" }, false)).toEqual([])
	})

	it("places feedback and images before the file text without losing content", () => {
		const result = formatter.format(
			{
				path: "a",
				status: "approved",
				nativeContent: "File: a\n1 | content",
				feedbackText: "inspect carefully",
				feedbackImages: [image],
				imageDataUrl: image,
			},
			true,
		)
		expect(result.map((block) => block.type)).toEqual(["text", "image", "image", "text"])
		expect(result[0]).toMatchObject({ type: "text", text: expect.stringContaining("inspect carefully") })
		expect(result.at(-1)).toEqual({ type: "text", text: "File: a\n1 | content" })
	})

	it("keeps user feedback images before the image read from the file", () => {
		const result = formatter.format(
			{
				path: "a",
				status: "approved",
				nativeContent: "File: a",
				feedbackImages: [image],
				imageDataUrl: "data:image/jpeg;base64,ZmlsZQ==",
			},
			true,
		)
		expect(result.filter((block) => block.type === "image")).toMatchObject([
			{ source: { type: "base64", media_type: "image/png", data: "aW1hZ2U=" } },
			{ source: { type: "base64", media_type: "image/jpeg", data: "ZmlsZQ==" } },
		])
	})

	it("includes a file image without duplicating its text when there is no feedback", () => {
		const result = formatter.format(
			{ path: "a", status: "approved", nativeContent: "File: a", imageDataUrl: image },
			true,
		)
		expect(result.map((block) => block.type)).toEqual(["image", "text"])
		expect(result.at(-1)).toEqual({ type: "text", text: "File: a" })
	})

	it("omits file images for text-only models", () => {
		expect(
			formatter.format({ path: "a", status: "approved", nativeContent: "File: a", imageDataUrl: image }, false),
		).toEqual([{ type: "text", text: "File: a" }])
	})

	it("does not format image blocks for text-only models", () => {
		const imageBlocks = vi.spyOn(formatResponse, "imageBlocks")
		try {
			expect(
				formatter.format(
					{
						path: "a",
						status: "approved",
						nativeContent: "File: a",
						feedbackImages: [image],
						imageDataUrl: image,
					},
					false,
				),
			).toEqual([{ type: "text", text: "File: a" }])
			expect(imageBlocks).not.toHaveBeenCalled()
		} finally {
			imageBlocks.mockRestore()
		}
	})

	it("retains approval feedback as text when there are no images", () => {
		const result = formatter.format(
			{ path: "a", status: "approved", nativeContent: "File: a", feedbackText: "inspect carefully" },
			false,
		)
		expect(result).toEqual([
			{ type: "text", text: formatResponse.toolApprovedWithFeedback("inspect carefully") },
			{ type: "text", text: "File: a" },
		])
	})

	it("retains denial feedback and omits images for text-only models", () => {
		const result = formatter.format(
			{
				path: "a",
				status: "denied",
				nativeContent: "File: a\nStatus: Denied by user",
				feedbackText: "private file",
				feedbackImages: [image],
			},
			false,
		)
		expect(result).toEqual([
			{ type: "text", text: formatResponse.toolDeniedWithFeedback("private file") },
			{ type: "text", text: "File: a\nStatus: Denied by user" },
		])
	})

	it.each(["error", "blocked", "cancelled", "unsupported", "pending"] as const)(
		"does not label a %s result as approval or denial",
		(status) => {
			const file: FileResult = { path: "a", status, nativeContent: "File: a", feedbackText: "inspect carefully" }
			expect(formatter.format(file, false)).toEqual([{ type: "text", text: "File: a" }])
		},
	)

	it.each(["error", "blocked", "cancelled", "unsupported", "pending"] as const)(
		"does not invent feedback for a %s result without content",
		(status) => {
			expect(formatter.format({ path: "a", status, feedbackText: "inspect carefully" }, false)).toEqual([])
		},
	)

	it.each(["denied", "error", "blocked", "cancelled", "unsupported", "pending"] as const)(
		"returns the %s response without including file images",
		(status) => {
			const file: FileResult = {
				path: "a",
				status,
				nativeContent: `File: a\nStatus: ${status}`,
				feedbackImages: [image],
				imageDataUrl: "data:image/jpeg;base64,ZmlsZQ==",
			}
			const result = formatter.format(file, true)
			expect(result.filter((block) => block.type === "image")).toMatchObject([
				{ source: { type: "base64", media_type: "image/png", data: "aW1hZ2U=" } },
			])
			expect(result.filter((block) => block.type === "text").map((block) => block.text)).toContain(
				file.nativeContent,
			)
		},
	)

	it.each(["approved", "denied"] as const)("retains image-only user feedback for %s results", (status) => {
		const result = formatter.format({ path: "a", status, nativeContent: "File: a", feedbackImages: [image] }, true)
		expect(result.filter((block) => block.type === "image")).toHaveLength(1)
		if (status === "denied") {
			expect(result[0]).toEqual({ type: "text", text: formatResponse.toolDenied() })
			expect(result.at(-1)).toEqual({ type: "text", text: "File: a" })
		} else {
			expect(result.map((block) => block.type)).toEqual(["image", "text"])
			expect(result.at(-1)).toEqual({ type: "text", text: "File: a" })
		}
	})

	it("omits image-only user feedback for text-only models", () => {
		expect(
			formatter.format(
				{ path: "a", status: "approved", nativeContent: "File: a", feedbackImages: [image] },
				false,
			),
		).toEqual([{ type: "text", text: "File: a" }])
	})

	it("includes a generic denial when the user rejects without feedback", () => {
		expect(formatter.format({ path: "a", status: "denied", nativeContent: "File: a" }, false)).toEqual([
			{ type: "text", text: formatResponse.toolDenied() },
			{ type: "text", text: "File: a" },
		])
	})

	it("formats denial feedback from the file result alone", () => {
		expect(
			formatter.format(
				{ path: "a", status: "denied", nativeContent: "File: a", feedbackText: "private file" },
				false,
			),
		).toEqual([
			{ type: "text", text: formatResponse.toolDeniedWithFeedback("private file") },
			{ type: "text", text: "File: a" },
		])
	})

	it("returns feedback without an empty content block", () => {
		expect(formatter.format({ path: "a", status: "approved", feedbackText: "inspect carefully" }, false)).toEqual([
			{ type: "text", text: formatResponse.toolApprovedWithFeedback("inspect carefully") },
		])
	})

	it("returns image-only content without an empty text block", () => {
		const result = formatter.format({ path: "a", status: "approved", imageDataUrl: image }, true)
		expect(result).toMatchObject([
			{ type: "image", source: { type: "base64", media_type: "image/png", data: "aW1hZ2U=" } },
		])
	})

	it("rejects an unrecognized runtime status instead of silently formatting a successful response", () => {
		const malformedResult: unknown = { path: "a", status: "unrecognized", nativeContent: "File: a" }
		// An injected JavaScript implementation can violate the TypeScript discriminator contract.
		expect(() => Reflect.apply(formatter.format, formatter, [malformedResult, false])).toThrow(
			"Unhandled read file status: unrecognized",
		)
	})
})
