import { formatResponse } from "../responses"
import { IMAGE_MIME_TYPES } from "../../tools/helpers/imageHelpers"
import { getImageMimeType, isSupportedImageMimeType } from "../../../utils/imageMime"

const supportedMimeTypes = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const
const supportedMimeTypeSet = new Set<string>(supportedMimeTypes)
const unsupportedMimeTypes = [
	...new Set([...Object.values(IMAGE_MIME_TYPES), "image/heic", "application/octet-stream", "image/svg+xml"]),
].filter((mimeType) => !supportedMimeTypeSet.has(mimeType))
const payload = "c3ludGhldGlj"

describe("image MIME utilities", () => {
	it.each(supportedMimeTypes)("extracts and accepts the SDK MIME type %s", (mimeType) => {
		expect(getImageMimeType(`data:${mimeType};base64,${payload}`)).toBe(mimeType)
		expect(isSupportedImageMimeType(mimeType)).toBe(true)
	})

	it.each(unsupportedMimeTypes)("extracts but rejects the unsupported MIME type %s", (mimeType) => {
		expect(getImageMimeType(`data:${mimeType};base64,${payload}`)).toBe(mimeType)
		expect(isSupportedImageMimeType(mimeType)).toBe(false)
	})

	it("returns no MIME for a missing header and rejects absent or empty MIME values", () => {
		expect(getImageMimeType("")).toBeUndefined()
		expect(isSupportedImageMimeType(undefined)).toBe(false)
		expect(isSupportedImageMimeType("")).toBe(false)
	})
})

describe("shared image-block MIME contract", () => {
	it.each(supportedMimeTypes)("preserves the complete image block for %s through both entry points", (mimeType) => {
		const dataUrl = `data:${mimeType};base64,${payload}`
		const image = { type: "image", source: { type: "base64", media_type: mimeType, data: payload } }
		expect(formatResponse.imageBlocks([dataUrl])).toEqual([image])
		expect(formatResponse.toolResult("read result", [dataUrl])).toEqual([
			{ type: "text", text: "read result" },
			image,
		])
	})

	it.each(unsupportedMimeTypes)("rejects %s through both entry points before returning a payload", (mimeType) => {
		const dataUrl = `data:${mimeType};base64,${payload}`
		const error = new Error(`Unsupported image MIME type: ${mimeType}. Use JPEG, PNG, GIF, or WebP.`)
		expect(() => formatResponse.imageBlocks([dataUrl])).toThrowError(error)
		expect(() => formatResponse.toolResult("read result", [dataUrl])).toThrowError(error)
	})

	it.each([
		"",
		"not a data URL",
		"data:;base64,c3ludGhldGlj",
		"data:image/png,c3ludGhldGlj",
		"data:image/png;base64",
		"data:image/png;base64;c3ludGhldGlj",
		"data:image/png;charset=utf-8;base64,c3ludGhldGlj",
		"DATA:image/png;base64,c3ludGhldGlj",
		"data:image/png;BASE64,c3ludGhldGlj",
		"prefix data:image/png;base64,c3ludGhldGlj",
		" data:image/png;base64,c3ludGhldGlj",
		"\uFEFFdata:image/png;base64,c3ludGhldGlj",
		"data\uFF1Aimage/png;base64,c3ludGhldGlj",
		"data:image/png;base64\uFF0Cc3ludGhldGlj",
	])("rejects a malformed or noncanonical header: %j", (dataUrl) => {
		const error = new Error("Unsupported image MIME type: unknown. Use JPEG, PNG, GIF, or WebP.")
		expect(() => formatResponse.imageBlocks([dataUrl])).toThrowError(error)
		expect(() => formatResponse.toolResult("read result", [dataUrl])).toThrowError(error)
	})

	it.each(["image/PNG", "image/jpg", "image/png ", "image/p\u200Bng", "image/\u0440ng", "image\uFF0Fpng"])(
		"does not normalize unsupported MIME spelling %j into an allowed type",
		(mimeType) => {
			const dataUrl = `data:${mimeType};base64,${payload}`
			const error = new Error(`Unsupported image MIME type: ${mimeType}. Use JPEG, PNG, GIF, or WebP.`)
			expect(() => formatResponse.imageBlocks([dataUrl])).toThrowError(error)
			expect(() => formatResponse.toolResult("read result", [dataUrl])).toThrowError(error)
		},
	)

	it.each([{ images: undefined }, { images: [] }])("preserves the no-image response for $images", ({ images }) => {
		expect(formatResponse.imageBlocks(images)).toEqual([])
		expect(formatResponse.toolResult("read result", images)).toBe("read result")
		expect(formatResponse.toolResult("", images)).toBe("")
	})

	it("preserves image order, duplicate images, Unicode feedback, and the input array", () => {
		const images = [
			"data:image/png;base64,Zmlyc3Q=",
			"data:image/jpeg;base64,c2Vjb25k",
			"data:image/png;base64,Zmlyc3Q=",
		]
		const originalImages = [...images]
		const expected = [
			{ type: "image", source: { type: "base64", media_type: "image/png", data: "Zmlyc3Q=" } },
			{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "c2Vjb25k" } },
			{ type: "image", source: { type: "base64", media_type: "image/png", data: "Zmlyc3Q=" } },
		]
		const text = "\u041E\u0442\u0432\u0435\u0442 \uD83D\uDDBC\uFE0F e\u0301"
		expect(formatResponse.imageBlocks(images)).toEqual(expected)
		expect(formatResponse.toolResult(text, images)).toEqual([{ type: "text", text }, ...expected])
		expect(images).toEqual(originalImages)
	})

	it.each([0, 1, 2])("rejects an unsupported image at index %i without changing the input", (index) => {
		const images = Array<string>(3).fill(`data:image/png;base64,${payload}`)
		images[index] = `data:image/bmp;base64,${payload}`
		const originalImages = [...images]
		const error = new Error("Unsupported image MIME type: image/bmp. Use JPEG, PNG, GIF, or WebP.")
		expect(() => formatResponse.imageBlocks(images)).toThrowError(error)
		expect(() => formatResponse.toolResult("read result", images)).toThrowError(error)
		expect(images).toEqual(originalImages)
	})

	it.each(["", "not decoded here", "first,second", "\uD83D\uDE00e\u0301"])(
		"preserves the opaque payload %j without adding byte or base64 validation",
		(data) => {
			const dataUrl = `data:image/png;base64,${data}`
			const image = { type: "image", source: { type: "base64", media_type: "image/png", data } }
			expect(formatResponse.imageBlocks([dataUrl])).toEqual([image])
			expect(formatResponse.toolResult("", [dataUrl])).toEqual([{ type: "text", text: "" }, image])
		},
	)
})
