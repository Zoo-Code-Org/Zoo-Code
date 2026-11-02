import * as path from "path"

import { resolveImageMentions } from "../resolveImageMentions"
import { formatResponse } from "../../prompts/responses"

vi.mock("../../tools/helpers/imageHelpers", () => ({
	isSupportedImageFormat: vi.fn((ext: string) =>
		[".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".ico", ".tiff", ".tif", ".avif"].includes(
			ext.toLowerCase(),
		),
	),
	readImageAsDataUrlWithBuffer: vi.fn(),
	validateImageForProcessing: vi.fn(),
	ImageMemoryTracker: vi.fn().mockImplementation(function () {
		let totalMemoryUsed = 0
		return {
			getTotalMemoryUsed: vi.fn(() => totalMemoryUsed),
			addMemoryUsage: vi.fn((sizeInMB: number) => {
				totalMemoryUsed += sizeInMB
			}),
		}
	}),
	DEFAULT_MAX_IMAGE_FILE_SIZE_MB: 5,
	DEFAULT_MAX_TOTAL_IMAGE_SIZE_MB: 20,
}))

import { validateImageForProcessing, readImageAsDataUrlWithBuffer } from "../../tools/helpers/imageHelpers"

const mockReadImageAsDataUrl = vi.mocked(readImageAsDataUrlWithBuffer)
const mockValidateImage = vi.mocked(validateImageForProcessing)

describe("resolveImageMentions", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockReadImageAsDataUrl.mockReset()
		mockValidateImage.mockReset()
		// Default: validation passes
		mockValidateImage.mockResolvedValue({ isValid: true, sizeInMB: 0.1 })
	})

	it.each([
		["png", "image/png"],
		["PNG", "image/png"],
		["jpg", "image/jpeg"],
		["jpeg", "image/jpeg"],
		["gif", "image/gif"],
		["webp", "image/webp"],
	])("should append a supported %s image mention", async (extension, mimeType) => {
		const buffer = Buffer.from("image-bytes")
		const dataUrl = `data:${mimeType};base64,${buffer.toString("base64")}`
		mockReadImageAsDataUrl.mockResolvedValue({ dataUrl, buffer })
		const text = `Please look at @/assets/cat.${extension}`

		const result = await resolveImageMentions({
			text,
			images: [],
			cwd: "/workspace",
		})

		expect(mockValidateImage).toHaveBeenCalled()
		expect(mockReadImageAsDataUrl).toHaveBeenCalledWith(path.resolve("/workspace", `assets/cat.${extension}`))
		expect(result.text).toBe(text)
		expect(result.images).toEqual([dataUrl])
		expect(formatResponse.imageBlocks(result.images)).toEqual([
			{
				type: "image",
				source: { type: "base64", media_type: mimeType, data: buffer.toString("base64") },
			},
		])
	})

	it.each([
		["svg", "image/svg+xml"],
		["bmp", "image/bmp"],
		["ico", "image/x-icon"],
		["tiff", "image/tiff"],
		["tif", "image/tiff"],
		["avif", "image/avif"],
	])("should skip %s mentions with unsupported MIME types", async (extension, mimeType) => {
		const buffer = Buffer.from("unsupported-image-bytes")
		const dataUrl = `data:${mimeType};base64,${buffer.toString("base64")}`
		mockReadImageAsDataUrl.mockResolvedValue({ dataUrl, buffer })
		const text = `See @/image.${extension}`

		const result = await resolveImageMentions({
			text,
			images: [],
			cwd: "/workspace",
		})

		expect(result.text).toBe(text)
		expect(result.images).toEqual([])
		expect(formatResponse.imageBlocks(result.images)).toEqual([])
	})

	it.each(["not-a-data-url", "data:;base64,aW1hZ2U="])(
		"should skip image data URLs without a recognized MIME type: %s",
		async (dataUrl) => {
			mockReadImageAsDataUrl.mockResolvedValue({ dataUrl, buffer: Buffer.from("image-bytes") })

			const result = await resolveImageMentions({
				text: "See @/image.png",
				images: [],
				cwd: "/workspace",
			})

			expect(result.images).toEqual([])
		},
	)

	it("should preserve existing images and supported mentions when unsupported mentions are mixed in", async () => {
		const buffer = Buffer.from("image-bytes")
		const base64 = buffer.toString("base64")
		const existingImage = `data:image/png;base64,${base64}`
		const supportedImage = `data:image/webp;base64,${base64}`
		mockReadImageAsDataUrl
			.mockResolvedValueOnce({ dataUrl: `data:image/svg+xml;base64,${base64}`, buffer })
			.mockResolvedValueOnce({ dataUrl: supportedImage, buffer })
			.mockResolvedValueOnce({ dataUrl: `data:image/bmp;base64,${base64}`, buffer })
		const text = "Compare @/icon.svg, @/photo.webp and @/bitmap.bmp"

		const result = await resolveImageMentions({
			text,
			images: [existingImage],
			cwd: "/workspace",
		})

		expect(mockReadImageAsDataUrl).toHaveBeenCalledTimes(3)
		expect(result.text).toBe(text)
		expect(result.images).toEqual([existingImage, supportedImage])
		expect(formatResponse.imageBlocks(result.images)).toHaveLength(2)
	})

	it("should not count unsupported image mentions toward the total memory limit", async () => {
		mockValidateImage.mockImplementation(
			async (_filePath, _supportsImages, _maxImageFileSize, maxTotalImageSize, currentTotalMemoryUsed) => ({
				isValid: currentTotalMemoryUsed + 10 <= maxTotalImageSize,
				sizeInMB: 10,
			}),
		)
		const buffer = Buffer.from("image-bytes")
		const base64 = buffer.toString("base64")
		const firstSupportedImage = `data:image/png;base64,${base64}`
		const secondSupportedImage = `data:image/jpeg;base64,${base64}`
		mockReadImageAsDataUrl
			.mockResolvedValueOnce({ dataUrl: `data:image/svg+xml;base64,${base64}`, buffer })
			.mockResolvedValueOnce({ dataUrl: firstSupportedImage, buffer })
			.mockResolvedValueOnce({ dataUrl: secondSupportedImage, buffer })

		const result = await resolveImageMentions({
			text: "See @/icon.svg, @/first.png and @/second.jpg",
			images: [],
			cwd: "/workspace",
			maxImageFileSize: 10,
			maxTotalImageSize: 20,
		})

		expect(result.images).toEqual([firstSupportedImage, secondSupportedImage])
		expect(mockValidateImage).toHaveBeenNthCalledWith(2, path.resolve("/workspace", "first.png"), true, 10, 20, 0)
		expect(mockValidateImage).toHaveBeenNthCalledWith(3, path.resolve("/workspace", "second.jpg"), true, 10, 20, 10)
	})

	it("should not count unsupported image mentions toward the image count limit", async () => {
		const existingImages = Array.from(
			{ length: 19 },
			(_, index) => `data:image/png;base64,${Buffer.from(`existing-${index}`).toString("base64")}`,
		)
		const buffer = Buffer.from("new-image-bytes")
		const base64 = buffer.toString("base64")
		const supportedImage = `data:image/png;base64,${base64}`
		mockReadImageAsDataUrl
			.mockResolvedValueOnce({ dataUrl: `data:image/svg+xml;base64,${base64}`, buffer })
			.mockResolvedValueOnce({ dataUrl: supportedImage, buffer })

		const result = await resolveImageMentions({
			text: "See @/icon.svg, @/last.png and @/over-limit.jpg",
			images: existingImages,
			cwd: "/workspace",
		})

		expect(result.images).toEqual([...existingImages, supportedImage])
		expect(mockReadImageAsDataUrl).toHaveBeenCalledTimes(2)
	})

	it("should ignore non-image mentions", async () => {
		const result = await resolveImageMentions({
			text: "See @/src/index.ts",
			images: [],
			cwd: "/workspace",
		})

		expect(mockReadImageAsDataUrl).not.toHaveBeenCalled()
		expect(result.images).toEqual([])
	})

	it("should skip unreadable files (fail-soft)", async () => {
		mockReadImageAsDataUrl.mockRejectedValue(new Error("ENOENT"))

		const result = await resolveImageMentions({
			text: "See @/missing.webp",
			images: [],
			cwd: "/workspace",
		})

		expect(result.images).toEqual([])
	})

	it("should respect rooIgnoreController", async () => {
		const dataUrl = `data:image/jpeg;base64,${Buffer.from("jpg-bytes").toString("base64")}`
		mockReadImageAsDataUrl.mockResolvedValue({ dataUrl, buffer: Buffer.from("jpg-bytes") })
		const rooIgnoreController = {
			validateAccess: vi.fn().mockReturnValue(false),
		}

		const result = await resolveImageMentions({
			text: "See @/secret.jpg",
			images: [],
			cwd: "/workspace",
			rooIgnoreController,
		})

		expect(rooIgnoreController.validateAccess).toHaveBeenCalledWith("secret.jpg")
		expect(mockReadImageAsDataUrl).not.toHaveBeenCalled()
		expect(result.images).toEqual([])
	})

	it("should dedupe when mention repeats", async () => {
		const dataUrl = `data:image/png;base64,${Buffer.from("png-bytes").toString("base64")}`
		mockReadImageAsDataUrl.mockResolvedValue({ dataUrl, buffer: Buffer.from("png-bytes") })

		const result = await resolveImageMentions({
			text: "@/a.png and again @/a.png",
			images: [],
			cwd: "/workspace",
		})

		expect(result.images).toHaveLength(1)
	})

	it("should skip images when supportsImages is false", async () => {
		const dataUrl = `data:image/png;base64,${Buffer.from("png-bytes").toString("base64")}`
		mockReadImageAsDataUrl.mockResolvedValue({ dataUrl, buffer: Buffer.from("png-bytes") })

		const result = await resolveImageMentions({
			text: "See @/cat.png",
			images: [],
			cwd: "/workspace",
			supportsImages: false,
		})

		expect(mockReadImageAsDataUrl).not.toHaveBeenCalled()
		expect(result.images).toEqual([])
	})

	it("should skip images that exceed size limits", async () => {
		mockValidateImage.mockResolvedValue({
			isValid: false,
			reason: "size_limit",
			notice: "Image too large",
		})

		const result = await resolveImageMentions({
			text: "See @/huge.png",
			images: [],
			cwd: "/workspace",
		})

		expect(mockValidateImage).toHaveBeenCalled()
		expect(mockReadImageAsDataUrl).not.toHaveBeenCalled()
		expect(result.images).toEqual([])
	})

	it("should skip images that would exceed memory limit", async () => {
		mockValidateImage.mockResolvedValue({
			isValid: false,
			reason: "memory_limit",
			notice: "Would exceed memory limit",
		})

		const result = await resolveImageMentions({
			text: "See @/large.png",
			images: [],
			cwd: "/workspace",
		})

		expect(result.images).toEqual([])
	})

	it("should pass custom size limits to validation", async () => {
		const dataUrl = `data:image/png;base64,${Buffer.from("png-bytes").toString("base64")}`
		mockReadImageAsDataUrl.mockResolvedValue({ dataUrl, buffer: Buffer.from("png-bytes") })

		await resolveImageMentions({
			text: "See @/cat.png",
			images: [],
			cwd: "/workspace",
			maxImageFileSize: 10,
			maxTotalImageSize: 50,
		})

		expect(mockValidateImage).toHaveBeenCalledWith(expect.any(String), true, 10, 50, 0)
	})
})
