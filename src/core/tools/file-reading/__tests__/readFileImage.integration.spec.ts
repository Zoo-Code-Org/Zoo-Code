import * as fs from "fs/promises"
import os from "os"
import path from "path"
import type { Task } from "../../../task/Task"
import type { ToolCallbacks } from "../../BaseTool"
import { ReadFileTool } from "../ReadFileTool"
import { ReadFileResultFormatter } from "../ReadFileResultFormatter"
import * as imageHelpers from "../../helpers/imageHelpers"

const pngBytes = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aO1sAAAAASUVORK5CYII=",
	"base64",
)
// Minimal baseline grayscale JPEG: unit quantization, zero DC, end-of-block AC.
const jpegBytes = Buffer.concat([
	Buffer.from("ffd8ffdb004300", "hex"),
	Buffer.alloc(64, 1),
	Buffer.from("ffc0000b080001000101011100ffc4002600", "hex"),
	Buffer.from([1, ...Array<number>(15).fill(0), 0, 16, 1, ...Array<number>(15).fill(0), 0]),
	Buffer.from("ffda0008010100003f003fffd9", "hex"),
])
const supportedImages = [
	{ extension: ".png", mimeType: "image/png", bytes: pngBytes },
	{ extension: ".jpg", mimeType: "image/jpeg", bytes: jpegBytes },
	{ extension: ".jpeg", mimeType: "image/jpeg", bytes: jpegBytes },
	{
		extension: ".gif",
		mimeType: "image/gif",
		bytes: Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64"),
	},
	{
		extension: ".webp",
		mimeType: "image/webp",
		bytes: Buffer.from("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA", "base64"),
	},
]

// A complete synthetic 1x1, 24-bit BMP, including its padded pixel row.
function createBitmap(): Buffer {
	const bytes = Buffer.alloc(58)
	bytes.write("BM")
	bytes.writeUInt32LE(bytes.length, 2)
	bytes.writeUInt32LE(54, 10)
	bytes.writeUInt32LE(40, 14)
	bytes.writeInt32LE(1, 18)
	bytes.writeInt32LE(1, 22)
	bytes.writeUInt16LE(1, 26)
	bytes.writeUInt16LE(24, 28)
	bytes.writeUInt32LE(4, 34)
	bytes[54] = 255
	return bytes
}

describe("public file-read image payload contract", () => {
	let directory: string

	function createTask(supportsImages = true, maxImageFileSize?: number) {
		return {
			cwd: directory,
			abort: false,
			abandoned: false,
			didToolFailInCurrentTurn: false,
			didRejectTool: false,
			rooIgnoreController: { validateAccess: vi.fn().mockReturnValue(true) },
			ask: vi.fn<Task["ask"]>().mockResolvedValue({ response: "yesButtonClicked" }),
			say: vi.fn().mockResolvedValue(undefined),
			fileContextTracker: { trackFileContext: vi.fn().mockResolvedValue(undefined) },
			api: { getModel: () => ({ info: { supportsImages } }) },
			providerRef: { deref: () => ({ getState: async () => ({ maxImageFileSize }) }) },
		}
	}

	async function read(file: string, task = createTask()) {
		const tool = new ReadFileTool()
		const entry = vi.spyOn(tool, "readEntry")
		const callbacks = {
			pushToolResult: vi.fn<ToolCallbacks["pushToolResult"]>(),
			askApproval: vi.fn<ToolCallbacks["askApproval"]>(),
			handleError: vi.fn<ToolCallbacks["handleError"]>(),
		}
		// The host double omits Task members unrelated to reading; all readers and formatters are real.
		await tool.execute({ path: file }, task as unknown as Task, callbacks)
		return { result: await entry.mock.results[0].value, blocks: callbacks.pushToolResult.mock.calls[0][0], task }
	}

	beforeEach(async () => {
		directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "zoo-image-reading-")))
	})

	afterEach(async () => {
		vi.restoreAllMocks()
		await fs.rm(directory, { recursive: true, force: true })
	})

	it("rejects a real BMP without adding unsupported image blocks or file context", async () => {
		const bytes = createBitmap()
		await fs.writeFile(path.join(directory, "image.bmp"), bytes)

		const { result, blocks, task } = await read("image.bmp")

		expect(blocks).not.toEqual(expect.arrayContaining([expect.objectContaining({ type: "image" })]))
		expect(result.status).toBe("unsupported")
		expect(result.imageDataUrl).toBeUndefined()
		expect(result.nativeContent).toContain("Unsupported image MIME type: image/bmp")
		expect(JSON.stringify(blocks)).not.toContain(bytes.toString("base64"))
		expect(task.fileContextTracker.trackFileContext).not.toHaveBeenCalled()
		expect(task.didRejectTool).toBe(false)
		expect(task.didToolFailInCurrentTurn).toBe(false)
	})

	it("does not let a PNG-named alias hide an unsupported canonical BMP target", async () => {
		const bytes = createBitmap()
		await fs.writeFile(path.join(directory, "target.bmp"), bytes)
		await fs.symlink(path.join(directory, "target.bmp"), path.join(directory, "alias.png"))

		const { result, blocks, task } = await read("alias.png")

		expect(result.status).toBe("unsupported")
		expect(result.nativeContent).toContain("Unsupported image MIME type: image/bmp")
		expect(result.imageDataUrl).toBeUndefined()
		expect(blocks).not.toEqual(expect.arrayContaining([expect.objectContaining({ type: "image" })]))
		expect(JSON.stringify(blocks)).not.toContain(bytes.toString("base64"))
		expect(task.fileContextTracker.trackFileContext).not.toHaveBeenCalled()
	})

	it("does not label an unknown canonical image format as PNG through an alias", async () => {
		const bytes = Buffer.from("00000018667479706865696300000000686569636d696631", "hex")
		await fs.writeFile(path.join(directory, "target.heic"), bytes)
		await fs.symlink(path.join(directory, "target.heic"), path.join(directory, "alias.png"))

		const { result, blocks, task } = await read("alias.png")

		expect(result.status).toBe("unsupported")
		expect(result.nativeContent).toContain("Unsupported image MIME type: unknown")
		expect(result.imageDataUrl).toBeUndefined()
		expect(blocks).not.toEqual(expect.arrayContaining([expect.objectContaining({ type: "image" })]))
		expect(JSON.stringify(blocks)).not.toContain(bytes.toString("base64"))
		expect(task.fileContextTracker.trackFileContext).not.toHaveBeenCalled()
	})

	it("checks the actual processed data URL even when both filename and target are PNG", async () => {
		await fs.writeFile(path.join(directory, "image.png"), pngBytes)
		const processImage = imageHelpers.processImageFile
		// Simulate a processor returning an encoding different from its requested filename.
		vi.spyOn(imageHelpers, "processImageFile").mockImplementation(async (...args) => {
			const image = await processImage(...args)
			return { ...image, dataUrl: image.dataUrl.replace("image/png", "image/tiff") }
		})

		const { result, blocks, task } = await read("image.png")

		expect(result.status).toBe("unsupported")
		expect(result.nativeContent).toContain("Unsupported image MIME type: image/tiff")
		expect(result.imageDataUrl).toBeUndefined()
		expect(blocks).not.toEqual(expect.arrayContaining([expect.objectContaining({ type: "image" })]))
		expect(JSON.stringify(blocks)).not.toContain(pngBytes.toString("base64"))
		expect(task.fileContextTracker.trackFileContext).not.toHaveBeenCalled()
	})

	it.each(supportedImages)(
		"preserves $extension bytes in final $mimeType blocks",
		async ({ extension, mimeType, bytes }) => {
			const file = `image${extension}`
			await fs.writeFile(path.join(directory, file), bytes)

			const { result, blocks, task } = await read(file)

			expect(result.status).toBe("approved")
			expect(blocks).toEqual([
				{ type: "image", source: { type: "base64", media_type: mimeType, data: bytes.toString("base64") } },
				{ type: "text", text: result.nativeContent },
			])
			expect(task.fileContextTracker.trackFileContext).toHaveBeenCalledWith(file, "read_tool")
		},
	)

	// Binary signature fixtures suffice: unsupported formats must be rejected before decoding.
	it.each([
		{ extension: ".ico", mimeType: "image/x-icon", bytes: Buffer.from("000001000000", "hex") },
		{ extension: ".tiff", mimeType: "image/tiff", bytes: Buffer.from("49492a0008000000000000000000", "hex") },
		{ extension: ".tif", mimeType: "image/tiff", bytes: Buffer.from("4d4d002a00000008000000000000", "hex") },
		{
			extension: ".avif",
			mimeType: "image/avif",
			bytes: Buffer.from("0000001466747970617669660000000061766966", "hex"),
		},
	])("rejects $extension without returning bytes or registering context", async ({ extension, mimeType, bytes }) => {
		await fs.writeFile(path.join(directory, `image${extension}`), bytes)

		const { result, blocks, task } = await read(`image${extension}`)

		expect(result.status).toBe("unsupported")
		expect(result.nativeContent).toContain(`Unsupported image MIME type: ${mimeType}`)
		expect(result.imageDataUrl).toBeUndefined()
		expect(blocks).toEqual([{ type: "text", text: result.nativeContent }])
		expect(JSON.stringify(blocks)).not.toContain(bytes.toString("base64"))
		expect(task.fileContextTracker.trackFileContext).not.toHaveBeenCalled()
	})

	it.each([
		{ file: "image.png", bytes: pngBytes },
		{ file: "image.bmp", bytes: createBitmap() },
	])("preserves the non-image-capable model notice for $file", async ({ file, bytes }) => {
		await fs.writeFile(path.join(directory, file), bytes)

		const { result, blocks, task } = await read(file, createTask(false))

		expect(result.status).toBe("approved")
		expect(result.imageDataUrl).toBeUndefined()
		expect(result.nativeContent).toContain("current model does not support images")
		expect(blocks).toEqual([{ type: "text", text: result.nativeContent }])
		expect(JSON.stringify(blocks)).not.toContain(bytes.toString("base64"))
		expect(task.fileContextTracker.trackFileContext).toHaveBeenCalledWith(file, "read_tool")
		expect(task.didToolFailInCurrentTurn).toBe(false)
	})

	it.each([
		{ file: "image.png", bytes: pngBytes },
		{ file: "image.bmp", bytes: createBitmap() },
	])("keeps text-only entry reads of $file unsupported and content-free", async ({ file, bytes }) => {
		await fs.writeFile(path.join(directory, file), bytes)
		const task = createTask()
		// The host double intentionally omits Task members unrelated to file reading.
		const result = await new ReadFileTool().readEntry({ path: file }, task as unknown as Task, { textOnly: true })

		expect(result.status).toBe("unsupported")
		expect(result.error).toBe("Batch images are not supported; use read_file.")
		expect(result.imageDataUrl).toBeUndefined()
		expect(new ReadFileResultFormatter().format(result, true)).toEqual([])
		expect(task.fileContextTracker.trackFileContext).not.toHaveBeenCalled()
	})

	it("keeps legacy BMP reads string-only without creating an image block", async () => {
		const bytes = createBitmap()
		await fs.writeFile(path.join(directory, "image.bmp"), bytes)
		const task = createTask()
		const pushToolResult = vi.fn<ToolCallbacks["pushToolResult"]>()
		// Legacy reads use the same intentionally partial host double as modern reads.
		await new ReadFileTool().execute(
			{ files: [{ path: "image.bmp" }], _legacyFormat: true },
			task as unknown as Task,
			{
				pushToolResult,
				askApproval: vi.fn<ToolCallbacks["askApproval"]>(),
				handleError: vi.fn<ToolCallbacks["handleError"]>(),
			},
		)

		expect(pushToolResult).toHaveBeenCalledWith(
			"File: image.bmp\n[Image file - content processed for vision model]",
		)
		expect(JSON.stringify(pushToolResult.mock.calls)).not.toContain(bytes.toString("base64"))
		expect(task.fileContextTracker.trackFileContext).not.toHaveBeenCalled()
	})

	it("labels supported alias reads with the canonical encoding rather than the alias extension", async () => {
		await fs.writeFile(path.join(directory, "target.png"), pngBytes)
		await fs.symlink(path.join(directory, "target.png"), path.join(directory, "alias.jpg"))

		const { result, blocks } = await read("alias.jpg")

		expect(result.status).toBe("approved")
		expect(blocks).toEqual([
			{ type: "image", source: { type: "base64", media_type: "image/png", data: pngBytes.toString("base64") } },
			{ type: "text", text: result.nativeContent },
		])
	})

	it("rejects unsupported BMP before size validation can register it as a successful notice", async () => {
		await fs.writeFile(path.join(directory, "image.bmp"), createBitmap())

		const { result, blocks, task } = await read("image.bmp", createTask(true, 0))

		expect(result.status).toBe("unsupported")
		expect(result.nativeContent).toContain("Unsupported image MIME type: image/bmp")
		expect(blocks).toEqual([{ type: "text", text: result.nativeContent }])
		expect(task.fileContextTracker.trackFileContext).not.toHaveBeenCalled()
	})

	it("preserves approval feedback and supported feedback images for a supported file read", async () => {
		await fs.writeFile(path.join(directory, "image.png"), pngBytes)
		const task = createTask()
		const imageDataUrl = `data:image/png;base64,${pngBytes.toString("base64")}`
		task.ask.mockResolvedValue({ response: "yesButtonClicked", text: "Inspect only", images: [imageDataUrl] })

		const { result, blocks } = await read("image.png", task)

		expect(result.feedbackText).toBe("Inspect only")
		expect(task.say).toHaveBeenCalledWith("user_feedback", "Inspect only", [imageDataUrl])
		const image = {
			type: "image",
			source: { type: "base64", media_type: "image/png", data: pngBytes.toString("base64") },
		}
		expect(blocks).toEqual([
			{ type: "text", text: JSON.stringify({ status: "approved", feedback: "Inspect only" }) },
			image,
			image,
			{ type: "text", text: result.nativeContent },
		])
		expect(task.didRejectTool).toBe(false)
		expect(task.didToolFailInCurrentTurn).toBe(false)
	})

	it("keeps ordinary SVG source readable as text rather than creating an unsupported image block", async () => {
		const source = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1" />'
		await fs.writeFile(path.join(directory, "image.svg"), source)

		const { result, blocks } = await read("image.svg")

		expect(result.status).toBe("approved")
		expect(result.imageDataUrl).toBeUndefined()
		expect(blocks).toEqual([{ type: "text", text: `File: image.svg\n1 | ${source}` }])
	})
})
