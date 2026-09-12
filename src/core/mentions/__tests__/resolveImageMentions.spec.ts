import * as path from "path"

import { normalizeSuppliedImages, resolveImageMentions } from "../resolveImageMentions"

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
		// Default: validation passes
		mockValidateImage.mockResolvedValue({ isValid: true, sizeInMB: 0.1 })
	})

	it("should append a data URL when a local png mention is present", async () => {
		const dataUrl = `data:image/png;base64,${Buffer.from("png-bytes").toString("base64")}`
		mockReadImageAsDataUrl.mockResolvedValue({ dataUrl, buffer: Buffer.from("png-bytes") })

		const result = await resolveImageMentions({
			text: "Please look at @/assets/cat.png",
			images: [],
			cwd: "/workspace",
		})

		expect(mockValidateImage).toHaveBeenCalled()
		expect(mockReadImageAsDataUrl).toHaveBeenCalledWith(path.resolve("/workspace", "assets/cat.png"))
		expect(result.text).toBe("Please look at @/assets/cat.png")
		expect(result.images).toEqual([dataUrl])
	})

	it("should support gif images (matching read_file)", async () => {
		const dataUrl = `data:image/gif;base64,${Buffer.from("gif-bytes").toString("base64")}`
		mockReadImageAsDataUrl.mockResolvedValue({ dataUrl, buffer: Buffer.from("gif-bytes") })

		const result = await resolveImageMentions({
			text: "See @/animation.gif",
			images: [],
			cwd: "/workspace",
		})

		expect(result.images).toEqual([dataUrl])
	})

	it("should support svg images (matching read_file)", async () => {
		const dataUrl = `data:image/svg+xml;base64,${Buffer.from("svg-bytes").toString("base64")}`
		mockReadImageAsDataUrl.mockResolvedValue({ dataUrl, buffer: Buffer.from("svg-bytes") })

		const result = await resolveImageMentions({
			text: "See @/icon.svg",
			images: [],
			cwd: "/workspace",
		})

		expect(result.images).toEqual([dataUrl])
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

	it("should count supplied images against the local mention size budget", async () => {
		const suppliedBytes = Buffer.from("supplied-image")
		const suppliedImage = `data:image/png;base64,${suppliedBytes.toString("base64")}`
		mockValidateImage.mockResolvedValue({ isValid: false, reason: "memory_limit" })

		const result = await resolveImageMentions({
			text: "See @/local.png",
			images: [suppliedImage],
			cwd: "/workspace",
		})

		expect(mockValidateImage).toHaveBeenCalledWith(
			expect.any(String),
			true,
			5,
			20,
			suppliedBytes.byteLength / (1024 * 1024),
		)
		expect(result.images).toEqual([suppliedImage])
	})

	it("should not charge duplicate local images against later unique mentions", async () => {
		const firstBytes = Buffer.from("first")
		const secondBytes = Buffer.from("other")
		const thirdBytes = Buffer.from("third")
		const first = `data:image/png;base64,${firstBytes.toString("base64")}`
		const second = `data:image/png;base64,${secondBytes.toString("base64")}`
		const third = `data:image/png;base64,${thirdBytes.toString("base64")}`
		const imageSizeInMB = firstBytes.byteLength / (1024 * 1024)
		const maxTotalImageSize = imageSizeInMB * 3
		mockValidateImage.mockImplementation(async (_path, _supportsImages, _maxFileSize, maxTotal, current) => ({
			isValid: current + imageSizeInMB <= maxTotal,
			sizeInMB: imageSizeInMB,
		}))
		mockReadImageAsDataUrl
			.mockResolvedValueOnce({ dataUrl: first, buffer: firstBytes })
			.mockResolvedValueOnce({ dataUrl: second, buffer: secondBytes })
			.mockResolvedValueOnce({ dataUrl: second, buffer: secondBytes })
			.mockResolvedValueOnce({ dataUrl: third, buffer: thirdBytes })

		const result = await resolveImageMentions({
			text: "See @/supplied-duplicate.png, @/local.png, @/local-duplicate.png, and @/unique.png",
			images: [first],
			cwd: "/workspace",
			maxTotalImageSize,
		})

		expect(result.images).toEqual([first, second, third])
	})
})

describe("normalizeSuppliedImages", () => {
	it("should accept supported image data URIs and reject malformed or unsupported values", () => {
		const payload = Buffer.from("image").toString("base64")

		expect(normalizeSuppliedImages()).toEqual([])
		expect(
			normalizeSuppliedImages([
				`data:image/svg+xml;base64,${payload}`,
				`data:image/x-icon;base64,${payload}`,
				`data:image/png;base64,${payload}`,
				`prefix-data:image/png;base64,${payload}`,
				`data:image/png;base64,${payload}-suffix`,
				"data:image/png;base64,YQ=",
				`data:image/unsupported;base64,${payload}`,
			]),
		).toEqual([
			`data:image/svg+xml;base64,${payload}`,
			`data:image/x-icon;base64,${payload}`,
			`data:image/png;base64,${payload}`,
		])
	})

	it("should enforce per-image and total decoded size limits", () => {
		const image = `data:image/png;base64,${Buffer.from("four bytes").toString("base64")}`
		const secondImage = `data:image/png;base64,${Buffer.from("nine bytes").toString("base64")}`
		const sizeInMB = Buffer.byteLength("four bytes") / (1024 * 1024)

		expect(normalizeSuppliedImages([image], { maxImageFileSize: sizeInMB / 2 })).toEqual([])
		expect(normalizeSuppliedImages([image], { maxImageFileSize: sizeInMB })).toEqual([image])
		expect(normalizeSuppliedImages([image, secondImage], { maxTotalImageSize: sizeInMB * 1.5 })).toEqual([image])
		expect(normalizeSuppliedImages([image], { maxTotalImageSize: sizeInMB })).toEqual([image])
	})

	it("should apply supplied-image limits through resolveImageMentions", async () => {
		const image = `data:image/png;base64,${Buffer.from("image").toString("base64")}`

		const result = await resolveImageMentions({
			text: "No mentions",
			images: [image],
			cwd: "/workspace",
			maxImageFileSize: 0,
		})

		expect(result.images).toEqual([])
	})

	it("should not let duplicates consume the image count or size budgets", () => {
		const first = `data:image/png;base64,${Buffer.from("first").toString("base64")}`
		const second = `data:image/png;base64,${Buffer.from("second").toString("base64")}`
		const maxTotalImageSize = Buffer.byteLength("firstsecond") / (1024 * 1024)

		expect(normalizeSuppliedImages([...Array(20).fill(first), second], { maxTotalImageSize })).toEqual([
			first,
			second,
		])
	})
})
