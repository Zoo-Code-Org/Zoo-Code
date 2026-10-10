/**
 * Tests for ReadFileTool - Codex-inspired file reading with indentation mode support.
 *
 * These tests cover:
 * - Input validation (missing path parameter)
 * - RooIgnore blocking
 * - Directory read error handling
 * - Binary file handling (images, PDF, DOCX, unsupported)
 * - Image memory limits
 * - Approval flow (approve, deny, feedback)
 * - Text file processing (slice and indentation modes)
 * - Output structure formatting
 */

import path from "path"
import type { Task } from "../../../task/Task"
import { AskIgnoredError } from "../../../task/AskIgnoredError"
import type { ToolUse } from "../../../../shared/tools"

import { isBinaryFile } from "isbinaryfile"

import { ReadFileTool } from "../ReadFileTool"
import { ReadFileResultFormatter } from "../ReadFileResultFormatter"
import { ReadFileTextProcessor } from "../ReadFileTextProcessor"
import { LegacyFileReader } from "../LegacyFileReader"
import { ModernFileReader } from "../ModernFileReader"
import { ReadFileContentReader } from "../ReadFileContentReader"
import { ReadFileTextReader } from "../strategies/ReadFileTextReader"
import { ReadFileAccess } from "../ReadFileAccess"
import { ReadFileErrorReporter } from "../ReadFileErrorReporter"
import { ReadFileBinaryReader } from "../strategies/ReadFileBinaryReader"
import { ReadFileImageReader } from "../strategies/ReadFileImageReader"
import { ReadFileDocumentReader } from "../strategies/ReadFileDocumentReader"
import { ReadFileStrategy } from "../strategies/ReadFileStrategy"
import type { FileResult, ReadEntryOptions, ReadFileContext } from "../types"
import { formatResponse } from "../../../prompts/responses"
import {
	DEFAULT_MAX_IMAGE_FILE_SIZE_MB,
	DEFAULT_MAX_TOTAL_IMAGE_SIZE_MB,
	validateImageForProcessing,
	processImageFile,
	isSupportedImageFormat,
	ImageMemoryTracker,
} from "../../helpers/imageHelpers"
import {
	extractTextFromFile,
	extractRawTextFromFile,
	addLineNumbers,
	getSupportedBinaryFormats,
} from "../../../../integrations/misc/extract-text"
import { readWithIndentation, readWithSlice } from "../../../../integrations/misc/indentation-reader"

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("path", async () => {
	const originalPath = await vi.importActual<typeof import("path")>("path")
	const platformPath = process.env.READ_FILE_TEST_PATH_STYLE === "win32" ? originalPath.win32 : originalPath
	const mockedPath = { ...platformPath, resolve: vi.fn(platformPath.resolve) }
	return {
		...mockedPath,
		default: mockedPath,
	}
})

vi.mock("fs/promises", () => ({
	readFile: vi.fn(),
	stat: vi.fn(),
	realpath: vi.fn(async (file: string) => file),
	lstat: vi.fn(async () => ({ dev: 1n, ino: 1n, isSymbolicLink: () => false })),
	open: vi.fn(async (file: string) => {
		const fs = await import("fs/promises")
		return {
			stat: async () => ({ ...(await fs.stat(file)), dev: 1n, ino: 1n }),
			read: async () => ({ bytesRead: 0 }),
			readFile: async (encoding?: BufferEncoding) => (encoding ? fs.readFile(file, encoding) : fs.readFile(file)),
			close: vi.fn().mockResolvedValue(undefined),
		}
	}),
}))

vi.mock("isbinaryfile")

vi.mock("../../../../integrations/misc/extract-text", () => ({
	extractTextFromFile: vi.fn(),
	extractRawTextFromFile: vi.fn(),
	addLineNumbers: vi.fn().mockImplementation((text: string, startLine = 1) => {
		if (!text) return ""
		const lines = text.split("\n")
		return lines.map((line, i) => `${startLine + i} | ${line}`).join("\n")
	}),
	getSupportedBinaryFormats: vi.fn(() => [".pdf", ".docx", ".ipynb"]),
}))

vi.mock("../../../../integrations/misc/indentation-reader", () => ({
	readWithIndentation: vi.fn(),
	readWithSlice: vi.fn(),
}))

vi.mock("../../helpers/imageHelpers", async (importOriginal) => ({
	IMAGE_MIME_TYPES: (await importOriginal<typeof import("../../helpers/imageHelpers")>()).IMAGE_MIME_TYPES,
	DEFAULT_MAX_IMAGE_FILE_SIZE_MB: 5,
	DEFAULT_MAX_TOTAL_IMAGE_SIZE_MB: 20,
	isSupportedImageFormat: vi.fn(),
	validateImageForProcessing: vi.fn(),
	processImageFile: vi.fn(),
	ImageMemoryTracker: vi.fn().mockImplementation(function () {
		return {
			getTotalMemoryUsed: vi.fn().mockReturnValue(0),
			addMemoryUsage: vi.fn(),
		}
	}),
}))

vi.mock("../../../prompts/responses", () => ({
	formatResponse: {
		toolDenied: vi.fn(() => "The user denied this operation."),
		toolDeniedWithFeedback: vi.fn(
			(feedback?: string) =>
				`The user denied this operation and responded with the message:\n<user_message>\n${feedback}\n</user_message>`,
		),
		toolApprovedWithFeedback: vi.fn(
			(feedback?: string) =>
				`The user approved this operation and responded with the message:\n<user_message>\n${feedback}\n</user_message>`,
		),
		rooIgnoreError: vi.fn(
			(filePath: string) =>
				`Access to ${filePath} is blocked by the .rooignore file settings. You must try to continue in the task without using this file, or ask the user to update the .rooignore file.`,
		),
		toolResult: vi.fn((text: string, images?: string[]) => {
			if (images && images.length > 0) {
				return [
					{ type: "text", text },
					...images.map((img) => {
						const [header, data] = img.split(",")
						const media_type = header.match(/:(.*?);/)?.[1] || "image/png"
						return { type: "image", source: { type: "base64", media_type, data } }
					}),
				]
			}
			return text
		}),
		imageBlocks: vi.fn((images?: string[]) => {
			return images
				? images.map((img) => {
						const [header, data] = img.split(",")
						const media_type = header.match(/:(.*?);/)?.[1] || "image/png"
						return { type: "image", source: { type: "base64", media_type, data } }
					})
				: []
		}),
	},
}))

// Mock fs/promises
const fsPromises = await import("fs/promises")
const nativePath = await vi.importActual<typeof import("path")>("path")
const nativeTextReader = await vi.importActual<typeof import("../../../../integrations/misc/indentation-reader")>(
	"../../../../integrations/misc/indentation-reader",
)
const mockedFsReadFile = vi.mocked(fsPromises.readFile)
const mockedFsStat = vi.mocked(fsPromises.stat)

const mockedIsBinaryFile = vi.mocked(isBinaryFile)
const mockedExtractTextFromFile = vi.mocked(extractTextFromFile)
const mockedExtractRawTextFromFile = vi.mocked(extractRawTextFromFile)
const mockedReadWithSlice = vi.mocked(readWithSlice)
const mockedReadWithIndentation = vi.mocked(readWithIndentation)
const mockedIsSupportedImageFormat = vi.mocked(isSupportedImageFormat)
const mockedValidateImageForProcessing = vi.mocked(validateImageForProcessing)
const mockedProcessImageFile = vi.mocked(processImageFile)

// ─── Test Helpers ─────────────────────────────────────────────────────────────

interface MockTaskOptions {
	supportsImages?: boolean
	rooIgnoreAllowed?: boolean
	maxImageFileSize?: number
	maxTotalImageSize?: number
}

function createMockTask(options: MockTaskOptions = {}) {
	const { supportsImages = false, rooIgnoreAllowed = true, maxImageFileSize = 5, maxTotalImageSize = 20 } = options

	return {
		cwd: "/test/workspace",
		api: {
			getModel: vi.fn().mockReturnValue({
				info: { supportsImages },
			}),
		},
		consecutiveMistakeCount: 0,
		didToolFailInCurrentTurn: false,
		didRejectTool: false,
		ask: vi.fn().mockResolvedValue({ response: "yesButtonClicked", text: undefined, images: undefined }),
		say: vi.fn().mockResolvedValue(undefined),
		sayAndCreateMissingParamError: vi.fn().mockResolvedValue("Missing required parameter: path"),
		recordToolError: vi.fn(),
		rooIgnoreController: {
			validateAccess: vi.fn().mockReturnValue(rooIgnoreAllowed),
		},
		fileContextTracker: {
			trackFileContext: vi.fn().mockResolvedValue(undefined),
		},
		providerRef: {
			deref: vi.fn().mockReturnValue({
				getState: vi.fn().mockResolvedValue({
					maxImageFileSize,
					maxTotalImageSize,
				}),
			}),
		},
	}
}

function createMockCallbacks() {
	return {
		pushToolResult: vi.fn(),
		askApproval: vi.fn(),
		handleError: vi.fn(),
	}
}

function expectNoReadSideEffects(task: ReturnType<typeof createMockTask>) {
	expect(task.ask).not.toHaveBeenCalled()
	expect(task.rooIgnoreController.validateAccess).not.toHaveBeenCalled()
	expect(path.resolve).not.toHaveBeenCalled()
	expect(fsPromises.realpath).not.toHaveBeenCalled()
	expect(fsPromises.lstat).not.toHaveBeenCalled()
	expect(fsPromises.open).not.toHaveBeenCalled()
	expect(mockedFsStat).not.toHaveBeenCalled()
	expect(mockedFsReadFile).not.toHaveBeenCalled()
	expect(mockedExtractRawTextFromFile).not.toHaveBeenCalled()
	expect(task.fileContextTracker.trackFileContext).not.toHaveBeenCalled()
}

function textResultContaining(text: string) {
	return expect.arrayContaining([expect.objectContaining({ type: "text", text: expect.stringContaining(text) })])
}

class TestReadStrategy extends ReadFileStrategy {
	canRead = vi.fn<ReadFileStrategy["canRead"]>().mockReturnValue(false)
	read = vi.fn<ReadFileStrategy["read"]>()
}

function createDeferred<T>() {
	let resolve!: (value: T) => void
	let reject!: (error: Error) => void
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise
		reject = rejectPromise
	})
	return { promise, resolve, reject }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("ReadFileTool", () => {
	let readFileTool: ReadFileTool
	beforeEach(() => {
		readFileTool = new ReadFileTool()
		vi.clearAllMocks()
		vi.mocked(path.resolve).mockImplementation(
			process.env.READ_FILE_TEST_PATH_STYLE === "win32" ? path.win32.resolve : nativePath.resolve,
		)

		// Default mock implementations
		mockedFsStat.mockResolvedValue({ isDirectory: () => false } as any)
		mockedIsBinaryFile.mockResolvedValue(false)
		mockedFsReadFile.mockResolvedValue(Buffer.from("test content"))
		mockedReadWithSlice.mockReturnValue({
			content: "1 | test content",
			returnedLines: 1,
			totalLines: 1,
			wasTruncated: false,
			includedRanges: [[1, 1]],
		})
	})

	it("reuses the injected formatter for successive reads", async () => {
		const formatter = new ReadFileResultFormatter()
		const formatted = [{ type: "text" as const, text: "formatted file response" }]
		const format = vi.spyOn(formatter, "format").mockReturnValue(formatted)
		const tool = new ReadFileTool(formatter)
		const mockTask = createMockTask({ supportsImages: true })
		const callbacks = createMockCallbacks()

		// This reader-boundary double omits Task fields unrelated to file reading.
		const task = mockTask as unknown as Task
		await tool.execute({ path: "first.ts" }, task, callbacks)
		await tool.execute({ path: "second.ts" }, task, callbacks)

		expect(format).toHaveBeenCalledTimes(2)
		expect(format).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({ path: "first.ts", status: "approved" }),
			true,
		)
		expect(format).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({ path: "second.ts", status: "approved" }),
			true,
		)
		expect(callbacks.pushToolResult).toHaveBeenNthCalledWith(1, formatted)
		expect(callbacks.pushToolResult).toHaveBeenNthCalledWith(2, formatted)
	})

	it("reuses the injected text processor for successive reads", async () => {
		const processor = new ReadFileTextProcessor()
		const process = vi.spyOn(processor, "process").mockReturnValue("1 | processed content")
		const contentReader = new ReadFileContentReader(undefined, [new ReadFileTextReader(processor)])
		const tool = new ReadFileTool(undefined, new ModernFileReader(undefined, undefined, contentReader))
		const mockTask = createMockTask()
		const callbacks = createMockCallbacks()

		// This reader-boundary double omits Task fields unrelated to file reading.
		const task = mockTask as unknown as Task
		await tool.execute({ path: "first.ts" }, task, callbacks)
		await tool.execute({ path: "second.ts" }, task, callbacks)

		expect(process).toHaveBeenCalledTimes(2)
		expect(process).toHaveBeenNthCalledWith(1, "test content", { path: "first.ts" })
		expect(process).toHaveBeenNthCalledWith(2, "test content", { path: "second.ts" })
		expect(callbacks.pushToolResult).toHaveBeenNthCalledWith(1, [
			{ type: "text", text: "File: first.ts\n1 | processed content" },
		])
		expect(callbacks.pushToolResult).toHaveBeenNthCalledWith(2, [
			{ type: "text", text: "File: second.ts\n1 | processed content" },
		])
	})

	it("uses the injected text processor to detect clipped lines in text-only reads", async () => {
		const processor = new ReadFileTextProcessor()
		vi.spyOn(processor, "process").mockReturnValue("1 | clipped content")
		const hasClippedLines = vi.spyOn(processor, "hasClippedLines").mockReturnValue(true)
		const contentReader = new ReadFileContentReader(undefined, [new ReadFileTextReader(processor)])
		const tool = new ReadFileTool(undefined, new ModernFileReader(undefined, undefined, contentReader))
		const mockTask = createMockTask()

		// This reader-boundary double omits Task fields unrelated to file reading.
		const result = await tool.readEntry({ path: "test.ts" }, mockTask as unknown as Task, { textOnly: true })

		expect(hasClippedLines).toHaveBeenCalledExactlyOnceWith("test content", "1 | clipped content")
		expect(result).toMatchObject({ status: "approved", longLinesTruncated: true })
	})

	it("delegates readEntry parameters and options without changing the result", async () => {
		const reader = new ModernFileReader()
		const result: FileResult = { path: "test.ts", status: "approved", longLinesTruncated: true }
		const read = vi.spyOn(reader, "read").mockResolvedValue(result)
		const tool = new ReadFileTool(undefined, reader)
		const params = { path: "test.ts", offset: 2, limit: 1 }
		const options: ReadEntryOptions = { textOnly: true }
		const mockTask = createMockTask()

		// This reader-boundary double omits Task fields unrelated to file reading.
		const task = mockTask as unknown as Task
		expect(await tool.readEntry(params, task, options)).toBe(result)
		expect(read).toHaveBeenCalledExactlyOnceWith(params, task, options)
		expect(mockTask.ask).not.toHaveBeenCalled()
	})

	it("rejects a zero limit at readEntry before approval or filesystem access", async () => {
		const mockTask = createMockTask()
		mockedFsReadFile.mockResolvedValue(Buffer.from("one\ntwo\nthree\nfour"))
		mockedReadWithSlice.mockImplementation(nativeTextReader.readWithSlice)

		// This reader-boundary double omits Task fields unrelated to file reading.
		const result = await readFileTool.readEntry({ path: "test.ts", limit: 0 }, mockTask as unknown as Task, {
			textOnly: true,
		})

		expect(result).toMatchObject({ path: "test.ts", status: "error", error: expect.stringContaining("limit") })
		expect(result.approvalStatus).toBeUndefined()
		expectNoReadSideEffects(mockTask)
	})

	it.each([-1, 1.5, NaN, Infinity, -Infinity, "1", true, [], {}])(
		"rejects invalid runtime limit %j at readEntry",
		async (limit) => {
			const mockTask = createMockTask()
			const params = { path: "test.ts" }
			// Deliberately inject values that untyped runtime callers can supply.
			Object.defineProperty(params, "limit", { value: limit })

			// This reader-boundary double omits Task fields unrelated to file reading.
			const result = await readFileTool.readEntry(params, mockTask as unknown as Task)

			expect(result).toMatchObject({
				status: "error",
				error: expect.stringContaining("limit must be a positive integer"),
			})
			expect(result.approvalStatus).toBeUndefined()
			expectNoReadSideEffects(mockTask)
		},
	)

	it("rejects an unused indentation max_lines of zero in slice-mode document reads", async () => {
		const mockTask = createMockTask()

		// This reader-boundary double omits Task fields unrelated to file reading.
		const result = await readFileTool.readEntry(
			{ path: "test.ipynb", mode: "slice", indentation: { max_lines: 0 } },
			mockTask as unknown as Task,
		)

		expect(result).toMatchObject({ status: "error", error: expect.stringContaining("max_lines") })
		expect(result.approvalStatus).toBeUndefined()
		expectNoReadSideEffects(mockTask)
	})

	it("rejects a fractional offset at readEntry without clamping it", async () => {
		const mockTask = createMockTask()

		// This reader-boundary double omits Task fields unrelated to file reading.
		const result = await readFileTool.readEntry({ path: "test.ts", offset: 1.5 }, mockTask as unknown as Task)

		expect(result).toMatchObject({ status: "error", error: expect.stringContaining("offset must be a 1-indexed") })
		expect(result.approvalStatus).toBeUndefined()
		expectNoReadSideEffects(mockTask)
	})

	it.each([
		{ indentation: { anchor_line: 0 }, diagnostic: "anchor_line must be a 1-indexed" },
		{ indentation: { max_levels: -1 }, diagnostic: "max_levels must be a nonnegative integer" },
	])("rejects malformed unused indentation knobs: $diagnostic", async ({ indentation, diagnostic }) => {
		const mockTask = createMockTask()

		// This reader-boundary double omits Task fields unrelated to file reading.
		const result = await readFileTool.readEntry({ path: "test.ts", indentation }, mockTask as unknown as Task)

		expect(result).toMatchObject({ status: "error", error: expect.stringContaining(diagnostic) })
		expect(result.approvalStatus).toBeUndefined()
		expectNoReadSideEffects(mockTask)
	})

	it.each(
		["offset", "anchor_line", "max_levels", "max_lines"].flatMap((name) =>
			[-1, 1.5, NaN, Infinity, "1", true, [], {}].map((value) => ({ name, value })),
		),
	)("validates supplied $name=$value independently of reading mode", async ({ name, value }) => {
		const mockTask = createMockTask()
		const indentation = {}
		const params = { path: "test.ipynb", indentation }
		// Deliberately inject values that untyped runtime callers can supply.
		Object.defineProperty(name === "offset" ? params : indentation, name, { value })

		// This reader-boundary double omits Task fields unrelated to file reading.
		const result = await readFileTool.readEntry(params, mockTask as unknown as Task, { textOnly: true })

		expect(result).toMatchObject({ status: "error", error: expect.stringContaining(name) })
		expect(result.approvalStatus).toBeUndefined()
		expectNoReadSideEffects(mockTask)
	})

	it.each([false, true])("retains defaults/nulls and one-line slice reads (textOnly=%s)", async (textOnly) => {
		const mockTask = createMockTask()
		mockedFsReadFile.mockResolvedValue(Buffer.from("one\ntwo"))
		mockedReadWithSlice.mockImplementation(nativeTextReader.readWithSlice)
		const params = { path: "test.ts" }
		Object.defineProperties(params, {
			offset: { value: null },
			limit: { value: null },
			indentation: { value: { anchor_line: null, max_levels: null, max_lines: null } },
		})

		// This reader-boundary double omits Task fields unrelated to file reading.
		const task = mockTask as unknown as Task
		const defaults = await readFileTool.readEntry({ path: "test.ts" }, task, { textOnly })
		const nulls = await readFileTool.readEntry(params, task, { textOnly })
		const singleLine = await readFileTool.readEntry({ path: "test.ts", offset: 1, limit: 1 }, task, { textOnly })

		expect(defaults).toMatchObject({
			status: "approved",
			approvalStatus: "approved",
			nativeContent: "File: test.ts\n1 | one\n2 | two",
		})
		expect(nulls.nativeContent).toBe(defaults.nativeContent)
		expect(singleLine).toMatchObject({ status: "approved", approvalStatus: "approved" })
		expect(singleLine.nativeContent).toContain("1 | one")
		expect(singleLine.nativeContent).not.toContain("2 | two")
	})

	it("allows one-line indentation limits and zero unlimited depth", async () => {
		const mockTask = createMockTask()
		mockedFsReadFile.mockResolvedValue(Buffer.from("function example() {\n  return true\n}"))
		mockedReadWithIndentation.mockImplementation(nativeTextReader.readWithIndentation)

		// This reader-boundary double omits Task fields unrelated to file reading.
		const result = await readFileTool.readEntry(
			{
				path: "test.ts",
				mode: "indentation",
				limit: 1,
				indentation: { anchor_line: 2, max_levels: 0, max_lines: 1 },
			},
			mockTask as unknown as Task,
			{ textOnly: true },
		)

		expect(result).toMatchObject({ status: "approved", approvalStatus: "approved" })
		expect(result.nativeContent).toContain("2 |   return true")
		expect(result.nativeContent).not.toContain("1 | function example()")
	})

	it.each(["slice", "indentation"] as const)(
		"rejects a top-level zero limit despite a valid hard cap in %s mode",
		async (mode) => {
			const mockTask = createMockTask()

			// This reader-boundary double omits Task fields unrelated to file reading.
			const result = await readFileTool.readEntry(
				{ path: "test.ipynb", mode, limit: 0, indentation: { anchor_line: 1, max_lines: 1 } },
				mockTask as unknown as Task,
			)

			expect(result).toMatchObject({ status: "error", error: expect.stringContaining("limit") })
			expect(result.approvalStatus).toBeUndefined()
			expectNoReadSideEffects(mockTask)
		},
	)

	it("keeps missing-path adapter diagnostics ahead of numeric validation", async () => {
		const mockTask = createMockTask()
		const callbacks = createMockCallbacks()

		// This reader-boundary double omits Task fields unrelated to file reading.
		await readFileTool.execute({ path: "", limit: 0 }, mockTask as unknown as Task, callbacks)

		expect(callbacks.pushToolResult).toHaveBeenCalledExactlyOnceWith("Error: Missing required parameter: path")
		expect(mockTask.sayAndCreateMissingParamError).toHaveBeenCalledExactlyOnceWith("read_file", "path")
		expect(mockTask.recordToolError).toHaveBeenCalledExactlyOnceWith("read_file")
		expect(mockTask.consecutiveMistakeCount).toBe(1)
		expectNoReadSideEffects(mockTask)
	})

	it("reuses the injected modern reader for successive tool calls", async () => {
		const reader = new ModernFileReader()
		const firstResult: FileResult = { path: "first.ts", status: "approved", nativeContent: "first content" }
		const secondResult: FileResult = { path: "second.ts", status: "approved", nativeContent: "second content" }
		const read = vi.spyOn(reader, "read").mockResolvedValueOnce(firstResult).mockResolvedValueOnce(secondResult)
		const tool = new ReadFileTool(undefined, reader)
		const mockTask = createMockTask()
		const callbacks = createMockCallbacks()

		// This reader-boundary double omits Task fields unrelated to file reading.
		const task = mockTask as unknown as Task
		await tool.execute({ path: "first.ts" }, task, callbacks)
		await tool.execute({ path: "second.ts" }, task, callbacks)

		expect(read).toHaveBeenCalledTimes(2)
		expect(read).toHaveBeenNthCalledWith(1, { path: "first.ts" }, task, {})
		expect(read).toHaveBeenNthCalledWith(2, { path: "second.ts" }, task, {})
		expect(callbacks.pushToolResult).toHaveBeenNthCalledWith(1, [{ type: "text", text: "first content" }])
		expect(callbacks.pushToolResult).toHaveBeenNthCalledWith(2, [{ type: "text", text: "second content" }])
	})

	it.each([
		{ status: "approved", failed: false },
		{ status: "denied", failed: false },
		{ status: "blocked", failed: true },
		{ status: "error", failed: true },
		{ status: "pending", failed: false },
		{ status: "cancelled", failed: false },
		{ status: "unsupported", failed: false },
	] as const)(
		"formats the delegated $status result and preserves the tool failure flag",
		async ({ status, failed }) => {
			const result: FileResult = { path: "test.ts", status, nativeContent: "reader result" }
			const reader = new ModernFileReader()
			vi.spyOn(reader, "read").mockResolvedValue(result)
			const formatter = new ReadFileResultFormatter()
			const formatted = [{ type: "text" as const, text: "formatted result" }]
			const format = vi.spyOn(formatter, "format").mockReturnValue(formatted)
			const tool = new ReadFileTool(formatter, reader)
			const mockTask = createMockTask({ supportsImages: true })
			const callbacks = createMockCallbacks()

			// This reader-boundary double omits Task fields unrelated to file reading.
			await tool.execute({ path: "test.ts" }, mockTask as unknown as Task, callbacks)

			expect(mockTask.didToolFailInCurrentTurn).toBe(failed)
			expect(format).toHaveBeenCalledExactlyOnceWith(result, true)
			expect(callbacks.pushToolResult).toHaveBeenCalledExactlyOnceWith(formatted)
		},
	)

	describe("ModernFileReader composition", () => {
		it("reports pre-read failures with an unknown path when no usable path is available", async () => {
			const access = new ReadFileAccess()
			vi.spyOn(access, "check").mockRejectedValue(new Error("Access check failed"))
			const reader = new ModernFileReader(undefined, access)
			const mockTask = createMockTask()

			// This reader-boundary double omits Task fields unrelated to file reading.
			const result = await reader.read({ path: "" }, mockTask as unknown as Task)

			expect(result).toEqual({
				path: "unknown",
				status: "error",
				error: "Error reading file: Access check failed",
				nativeContent: "File: unknown\nError: Access check failed",
			})
			expect(mockTask.say).toHaveBeenCalledExactlyOnceWith(
				"error",
				"Error reading file unknown: Access check failed",
			)
			expect(mockTask.didToolFailInCurrentTurn).toBe(true)
		})

		it("reports ordinary approval failures as errors rather than silently cancelling", async () => {
			const mockTask = createMockTask()
			mockTask.ask.mockRejectedValue(new Error("Approval ask failed"))

			// This reader-boundary double omits Task fields unrelated to file reading.
			const result = await readFileTool.readEntry({ path: "test.ts" }, mockTask as unknown as Task)

			expect(result).toEqual({
				path: "test.ts",
				status: "error",
				error: "Error reading file: Approval ask failed",
				nativeContent: "File: test.ts\nError: Approval ask failed",
			})
			expect(mockTask.didToolFailInCurrentTurn).toBe(true)
			expect(mockTask.say).toHaveBeenCalledExactlyOnceWith(
				"error",
				"Error reading file test.ts: Approval ask failed",
			)
			expect(mockedFsStat).not.toHaveBeenCalled()
			expect(mockedFsReadFile).not.toHaveBeenCalled()
			expect(mockTask.fileContextTracker.trackFileContext).not.toHaveBeenCalled()
		})

		it("treats an access failure after cancellation as cancellation rather than a tool error", async () => {
			const access = new ReadFileAccess()
			const mockTask = { ...createMockTask(), abort: false, abandoned: false }
			vi.spyOn(access, "check").mockImplementationOnce(async () => {
				mockTask.abort = true
				throw new Error("Access check interrupted")
			})
			const errorReporter = new ReadFileErrorReporter()
			const report = vi.spyOn(errorReporter, "report")
			const reader = new ModernFileReader(errorReporter, access)

			// This reader-boundary double omits Task fields unrelated to file reading.
			const result = await reader.read({ path: "test.ts" }, mockTask as unknown as Task, { textOnly: true })

			expect(result).toEqual({ path: "test.ts", status: "cancelled" })
			expect(mockTask.didToolFailInCurrentTurn).toBe(false)
			expect(report).not.toHaveBeenCalled()
			expect(mockTask.say).not.toHaveBeenCalled()
		})

		it.each(["blocked", "denied"] as const)("does not read content after %s", async (status) => {
			const access = new ReadFileAccess()
			const stopped: FileResult = { path: "test.ts", status }
			const check = vi.spyOn(access, "check").mockResolvedValue(status === "blocked" ? stopped : undefined)
			const approval = vi.spyOn(access, "requestApproval").mockResolvedValue(stopped)
			const contentReader = new ReadFileContentReader()
			const readContent = vi.spyOn(contentReader, "read")
			const reader = new ModernFileReader(undefined, access, contentReader)
			const mockTask = createMockTask()

			// This reader-boundary double omits Task fields unrelated to file reading.
			const task = mockTask as unknown as Task
			expect(await reader.read({ path: "test.ts" }, task)).toBe(stopped)
			expect(check).toHaveBeenNthCalledWith(1, "test.ts", task)
			if (status !== "blocked") {
				expect(check).toHaveBeenNthCalledWith(2, path.resolve(task.cwd, "test.ts"), task)
			}
			expect(approval).toHaveBeenCalledTimes(status === "blocked" ? 0 : 1)
			expect(readContent).not.toHaveBeenCalled()
		})

		it.each(["approved", "error", "cancelled"] as const)(
			"preserves approval feedback when content reading returns %s",
			async (status) => {
				const params = { path: "test.ts" }
				const options: ReadEntryOptions = { textOnly: true }
				const access = new ReadFileAccess()
				vi.spyOn(access, "check").mockResolvedValue(undefined)
				vi.spyOn(access, "requestApproval").mockResolvedValue({
					path: params.path,
					status: "approved",
					entry: params,
					feedbackText: "inspect carefully",
					feedbackImages: ["data:image/png;base64,aW1hZ2U="],
				})
				const contentReader = new ReadFileContentReader()
				const readContent = vi.spyOn(contentReader, "read").mockResolvedValue({
					path: params.path,
					status,
					nativeContent: "content result",
				})
				const reader = new ModernFileReader(undefined, access, contentReader)
				const mockTask = createMockTask()

				// This reader-boundary double omits Task fields unrelated to file reading.
				const task = mockTask as unknown as Task
				expect(await reader.read(params, task, options)).toEqual({
					path: params.path,
					status,
					approvalStatus: "approved",
					entry: params,
					feedbackText: "inspect carefully",
					feedbackImages: ["data:image/png;base64,aW1hZ2U="],
					nativeContent: "content result",
				})
				expect(readContent).toHaveBeenCalledExactlyOnceWith(
					params,
					task,
					options,
					expect.objectContaining({ fullPath: path.resolve(task.cwd, params.path) }),
				)
			},
		)

		it("retains approval feedback when the content-reader boundary rejects rather than returning a result", async () => {
			const instruction = "Inspect without changing files"
			const mockTask = createMockTask()
			mockTask.ask.mockResolvedValueOnce({ response: "yesButtonClicked", text: instruction, images: undefined })
			const contentReader = new ReadFileContentReader()
			vi.spyOn(contentReader, "read").mockRejectedValueOnce(new Error("Reader operation failed"))
			const reader = new ModernFileReader(undefined, undefined, contentReader)

			// This reader-boundary double omits Task fields unrelated to file reading.
			const result = await reader.read({ path: "source.ts" }, mockTask as unknown as Task)

			expect(result).toMatchObject({
				status: "error",
				approvalStatus: "approved",
				feedbackText: instruction,
			})
			expect(new ReadFileResultFormatter().format(result, false)).toEqual([
				{ type: "text", text: formatResponse.toolApprovedWithFeedback(instruction) },
				{ type: "text", text: "File: source.ts\nError: Reader operation failed" },
			])
			expect(mockTask.didToolFailInCurrentTurn).toBe(true)
		})

		it("uses the injected error reporter when access checking fails", async () => {
			const error = new Error("Access check failed")
			const access = new ReadFileAccess()
			vi.spyOn(access, "check").mockRejectedValue(error)
			const errorReporter = new ReadFileErrorReporter()
			const result: FileResult = { path: "test.ts", status: "error", error: error.message }
			const report = vi.spyOn(errorReporter, "report").mockResolvedValue(result)
			const reader = new ModernFileReader(errorReporter, access)
			const mockTask = createMockTask()

			// This reader-boundary double omits Task fields unrelated to file reading.
			const task = mockTask as unknown as Task
			expect(await reader.read({ path: "test.ts" }, task)).toBe(result)
			expect(report).toHaveBeenCalledExactlyOnceWith("test.ts", task, error)
			expect(mockTask.didToolFailInCurrentTurn).toBe(true)
		})
	})

	describe("ReadFileContentReader routing", () => {
		it("describes extensionless binary files without loading their payload", async () => {
			const mockTask = createMockTask()
			mockedIsBinaryFile.mockResolvedValue(true)
			mockedIsSupportedImageFormat.mockReturnValue(false)

			// This reader-boundary double omits Task fields unrelated to file reading.
			const result = await readFileTool.readEntry({ path: "binary" }, mockTask as unknown as Task)

			expect(result).toMatchObject({
				path: "binary",
				status: "approved",
				notice: "Binary file format: bin",
				nativeContent: "File: binary\nBinary file (bin) - content not displayed",
			})
			expect(mockedFsReadFile).not.toHaveBeenCalled()
			expect(mockedExtractTextFromFile).not.toHaveBeenCalled()
		})

		it("reports empty extracted documents without inventing a line range", async () => {
			const mockTask = createMockTask()
			const callbacks = createMockCallbacks()
			mockedIsBinaryFile.mockResolvedValue(true)
			mockedIsSupportedImageFormat.mockReturnValue(false)
			mockedExtractRawTextFromFile.mockResolvedValueOnce("")

			// This reader-boundary double omits Task fields unrelated to file reading.
			await readFileTool.execute({ path: "document.pdf" }, mockTask as unknown as Task, callbacks)

			expect(callbacks.pushToolResult).toHaveBeenCalledExactlyOnceWith([
				{ type: "text", text: "File: document.pdf\nNote: File is empty" },
			])
			expect(mockTask.fileContextTracker.trackFileContext).toHaveBeenCalledExactlyOnceWith(
				"document.pdf",
				"read_tool",
			)
		})

		it.each([
			{ path: "source.ts", binary: false, textOnly: false, expected: "text" },
			{ path: "image.png", binary: true, textOnly: false, expected: "image" },
			{ path: "document.pdf", binary: true, textOnly: false, expected: "document" },
			{ path: "document.docx", binary: true, textOnly: false, expected: "document" },
			{ path: "notebook.ipynb", binary: true, textOnly: false, expected: "document" },
			{ path: "archive.bin", binary: true, textOnly: false, expected: "binary" },
			{ path: "binary", binary: true, textOnly: false, expected: "binary" },
			{ path: "document.pdf", binary: true, textOnly: true, expected: "text" },
			{ path: "archive.bin", binary: true, textOnly: true, expected: "text" },
		] as const)(
			"selects only the $expected strategy for $path, textOnly=$textOnly",
			async ({ path: relPath, binary, textOnly, expected }) => {
				mockedIsBinaryFile.mockResolvedValue(binary)
				mockedIsSupportedImageFormat.mockImplementation((extension) => extension === ".png")
				const strategies = {
					text: new ReadFileTextReader(),
					image: new ReadFileImageReader(),
					document: new ReadFileDocumentReader(),
					binary: new ReadFileBinaryReader(),
				}
				const result: FileResult = { path: relPath, status: "approved", nativeContent: "strategy result" }
				const readText = vi.spyOn(strategies.text, "read").mockResolvedValue(result)
				const readImage = vi.spyOn(strategies.image, "read").mockResolvedValue(result)
				const readDocument = vi.spyOn(strategies.document, "read").mockResolvedValue(result)
				const readBinary = vi.spyOn(strategies.binary, "read").mockResolvedValue(result)
				const readers = { text: readText, image: readImage, document: readDocument, binary: readBinary }
				const reader = new ReadFileContentReader(undefined, Object.values(strategies))
				const params = { path: relPath }
				const options: ReadEntryOptions = { textOnly }
				const mockTask = createMockTask()

				// This reader-boundary double omits Task fields unrelated to file reading.
				const task = mockTask as unknown as Task
				const context: ReadFileContext = {
					params,
					task,
					fullPath: path.resolve(mockTask.cwd, relPath),
					extension: path.extname(relPath),
					binary,
					options,
				}
				expect(
					Object.entries(strategies)
						.filter(([, strategy]) => strategy.canRead(context))
						.map(([name]) => name),
				).toEqual([expected])
				expect(await reader.read(params, task, options)).toBe(result)
				expect(readers[expected]).toHaveBeenCalledExactlyOnceWith({ ...context, file: expect.any(Object) })
				for (const [name, read] of Object.entries(readers)) {
					if (name !== expected) expect(read).not.toHaveBeenCalled()
				}
			},
		)

		it.each([
			{ binary: false, textOnly: false },
			{ binary: false, textOnly: true },
			{ binary: true, textOnly: false },
			{ binary: true, textOnly: true },
		] as const)("routes binary=$binary, textOnly=$textOnly to the correct reader", async ({ binary, textOnly }) => {
			mockedIsBinaryFile.mockResolvedValue(binary)
			mockedIsSupportedImageFormat.mockReturnValue(false)
			const result: FileResult = { path: "test.ts", status: "approved", nativeContent: "delegated content" }
			const textReader = new ReadFileTextReader()
			const readText = vi.spyOn(textReader, "read").mockResolvedValue(result)
			const binaryReader = new ReadFileBinaryReader()
			const readBinary = vi.spyOn(binaryReader, "read").mockResolvedValue(result)
			const reader = new ReadFileContentReader(undefined, [textReader, binaryReader])
			const mockTask = createMockTask()
			const params = { path: "test.ts" }
			const options: ReadEntryOptions = { textOnly }

			// This reader-boundary double omits Task fields unrelated to file reading.
			const task = mockTask as unknown as Task
			expect(await reader.read(params, task, options)).toBe(result)
			const context: ReadFileContext = {
				params,
				task,
				fullPath: path.resolve(mockTask.cwd, params.path),
				extension: ".ts",
				binary,
				options,
			}
			if (binary && !textOnly) {
				expect(readBinary).toHaveBeenCalledExactlyOnceWith({ ...context, file: expect.any(Object) })
				expect(readText).not.toHaveBeenCalled()
			} else {
				expect(readText).toHaveBeenCalledExactlyOnceWith({ ...context, file: expect.any(Object) })
				expect(readBinary).not.toHaveBeenCalled()
			}
		})

		it("routes text-only documents through text extraction instead of binary rendering", async () => {
			mockedIsBinaryFile.mockResolvedValue(true)
			mockedIsSupportedImageFormat.mockReturnValue(false)
			const result: FileResult = { path: "document.pdf", status: "approved" }
			const textReader = new ReadFileTextReader()
			const readText = vi.spyOn(textReader, "read").mockResolvedValue(result)
			const binaryReader = new ReadFileBinaryReader()
			const readBinary = vi.spyOn(binaryReader, "read")
			const reader = new ReadFileContentReader(undefined, [textReader, binaryReader])
			const mockTask = createMockTask()
			const params = { path: "document.pdf" }
			const options: ReadEntryOptions = { textOnly: true }

			// This reader-boundary double omits Task fields unrelated to file reading.
			const task = mockTask as unknown as Task
			expect(await reader.read(params, task, options)).toBe(result)
			expect(readText).toHaveBeenCalledExactlyOnceWith({
				params,
				task,
				fullPath: path.resolve(mockTask.cwd, params.path),
				file: expect.any(Object),
				extension: ".pdf",
				binary: true,
				options,
			})
			expect(readBinary).not.toHaveBeenCalled()
		})

		it("rejects unsupported text-only binaries without reading their contents", async () => {
			mockedIsBinaryFile.mockResolvedValue(true)
			mockedIsSupportedImageFormat.mockReturnValue(false)
			const textReader = new ReadFileTextReader()
			const readText = vi.spyOn(textReader, "read")
			const binaryReader = new ReadFileBinaryReader()
			const readBinary = vi.spyOn(binaryReader, "read")
			const reader = new ReadFileContentReader(undefined, [textReader, binaryReader])
			const tool = new ReadFileTool(undefined, new ModernFileReader(undefined, undefined, reader))
			const mockTask = createMockTask()

			// This reader-boundary double omits Task fields unrelated to file reading.
			const result = await tool.readEntry({ path: "program.exe" }, mockTask as unknown as Task, {
				textOnly: true,
			})

			expect(result).toEqual({
				path: "program.exe",
				status: "unsupported",
				approvalStatus: "approved",
				error: "Unsupported batch binary format; use read_file.",
				entry: { path: "program.exe" },
				feedbackText: undefined,
				feedbackImages: undefined,
			})
			expect(readText).toHaveBeenCalledTimes(1)
			expect(readBinary).not.toHaveBeenCalled()
			expect(mockedFsReadFile).not.toHaveBeenCalled()
			expect(mockTask.fileContextTracker.trackFileContext).not.toHaveBeenCalled()
		})

		it("selects the first applicable injected strategy through the common contract", async () => {
			const skipped = new TestReadStrategy()
			const selected = new TestReadStrategy()
			selected.canRead.mockReturnValue(true)
			const result: FileResult = { path: "test.ts", status: "approved", nativeContent: "custom content" }
			selected.read.mockResolvedValue(result)
			const unused = new TestReadStrategy()
			unused.canRead.mockReturnValue(true)
			const reader = new ReadFileContentReader(undefined, [skipped, selected, unused])
			const params = { path: "test.ts" }
			const options: ReadEntryOptions = {}
			const mockTask = createMockTask()

			// This reader-boundary double omits Task fields unrelated to file reading.
			const task = mockTask as unknown as Task
			const context: ReadFileContext = {
				params,
				task,
				fullPath: path.resolve(mockTask.cwd, params.path),
				extension: ".ts",
				binary: false,
				options,
			}
			expect(await reader.read(params, task, options)).toBe(result)
			expect(skipped.canRead).toHaveBeenCalledExactlyOnceWith({ ...context, file: expect.any(Object) })
			expect(selected.canRead).toHaveBeenCalledExactlyOnceWith({ ...context, file: expect.any(Object) })
			expect(selected.read).toHaveBeenCalledExactlyOnceWith({ ...context, file: expect.any(Object) })
			expect(skipped.read).not.toHaveBeenCalled()
			expect(unused.canRead).not.toHaveBeenCalled()
			expect(unused.read).not.toHaveBeenCalled()
		})

		it("reports an error when no injected strategy can read the file", async () => {
			const strategy = new TestReadStrategy()
			const reader = new ReadFileContentReader(undefined, [strategy])
			const mockTask = createMockTask()

			// This reader-boundary double omits Task fields unrelated to file reading.
			const result = await reader.read({ path: "test.ts" }, mockTask as unknown as Task, {})

			expect(result).toMatchObject({
				status: "error",
				error: "Error reading file: No file-reading strategy supports 'test.ts'.",
			})
			expect(strategy.read).not.toHaveBeenCalled()
		})

		it("reports errors thrown by the selected strategy", async () => {
			const strategy = new TestReadStrategy()
			strategy.canRead.mockReturnValue(true)
			strategy.read.mockRejectedValue(new Error("Strategy read failed"))
			const reader = new ReadFileContentReader(undefined, [strategy])
			const mockTask = createMockTask()

			// This reader-boundary double omits Task fields unrelated to file reading.
			const result = await reader.read({ path: "test.ts" }, mockTask as unknown as Task, {})

			expect(result).toMatchObject({ status: "error", error: "Error reading file: Strategy read failed" })
		})

		it("shares the injected error reporter with binary image handling", async () => {
			mockedIsBinaryFile.mockResolvedValue(true)
			mockedIsSupportedImageFormat.mockReturnValue(true)
			const error = new Error("Image validation failed")
			mockedValidateImageForProcessing.mockRejectedValue(error)
			const errorReporter = new ReadFileErrorReporter()
			const result: FileResult = { path: "image.png", status: "error", error: error.message }
			const report = vi.spyOn(errorReporter, "report").mockResolvedValue(result)
			const reader = new ReadFileContentReader(errorReporter)
			const mockTask = createMockTask({ supportsImages: true })

			// This reader-boundary double omits Task fields unrelated to file reading.
			const task = mockTask as unknown as Task
			expect(await reader.read({ path: "image.png" }, task, {})).toBe(result)
			expect(report).toHaveBeenCalledExactlyOnceWith("image.png", task, error, {
				prefix: "Error reading image file: ",
				action: "Error reading image file",
			})
		})
	})

	describe("ModernFileReader ordinary cancellation", () => {
		it("does not load content or register context when cancellation occurs during descriptor inspection", async () => {
			const mockTask = { ...createMockTask(), abort: false, abandoned: false }
			const stats = await mockedFsStat("fixture")
			mockedFsStat.mockClear()
			const inspection = createDeferred<typeof stats>()
			const started = createDeferred<void>()
			mockedFsStat.mockImplementationOnce(() => {
				started.resolve()
				return inspection.promise
			})

			// This reader-boundary double omits Task fields unrelated to file reading.
			const pending = readFileTool.readEntry({ path: "source.ts" }, mockTask as unknown as Task)
			await started.promise
			expect(mockedFsReadFile).not.toHaveBeenCalled()
			mockTask.abort = true
			inspection.resolve(stats)

			expect(await pending).toMatchObject({ path: "source.ts", status: "cancelled" })
			expect(mockedFsReadFile).not.toHaveBeenCalled()
			expect(mockTask.fileContextTracker.trackFileContext).not.toHaveBeenCalled()
			expect(mockTask.didToolFailInCurrentTurn).toBe(false)
		})

		it("does not process an image when cancellation occurs while validation is pending", async () => {
			const mockTask = { ...createMockTask({ supportsImages: true }), abort: false, abandoned: false }
			mockedIsBinaryFile.mockResolvedValueOnce(true)
			mockedIsSupportedImageFormat.mockReturnValue(true)
			const validation = createDeferred<Awaited<ReturnType<typeof validateImageForProcessing>>>()
			const started = createDeferred<void>()
			mockedValidateImageForProcessing.mockImplementationOnce(() => {
				started.resolve()
				return validation.promise
			})
			mockedProcessImageFile.mockResolvedValue({
				dataUrl: "data:image/png;base64,aW1hZ2U=",
				buffer: Buffer.from("image"),
				sizeInKB: 1,
				sizeInMB: 0.001,
				notice: "Image",
			})

			// This reader-boundary double omits Task fields unrelated to file reading.
			const pending = readFileTool.readEntry({ path: "image.png" }, mockTask as unknown as Task)
			await started.promise
			mockTask.abandoned = true
			validation.resolve({ isValid: true })

			expect(await pending).toMatchObject({ path: "image.png", status: "cancelled" })
			expect(mockedProcessImageFile).not.toHaveBeenCalled()
			expect(mockTask.fileContextTracker.trackFileContext).not.toHaveBeenCalled()
		})

		it("discards ordinary document extraction completed after cancellation without formatting or tracking", async () => {
			const mockTask = { ...createMockTask(), abort: false, abandoned: false }
			mockedIsBinaryFile.mockResolvedValueOnce(true)
			mockedIsSupportedImageFormat.mockReturnValue(false)
			const extraction = createDeferred<string>()
			const started = createDeferred<void>()
			mockedExtractRawTextFromFile.mockImplementationOnce(() => {
				started.resolve()
				return extraction.promise
			})

			// This reader-boundary double omits Task fields unrelated to file reading.
			const pending = readFileTool.readEntry({ path: "document.pdf" }, mockTask as unknown as Task)
			await started.promise
			mockTask.abort = true
			extraction.resolve("Late document content")

			expect(await pending).toMatchObject({ path: "document.pdf", status: "cancelled" })
			expect(mockedReadWithSlice).not.toHaveBeenCalled()
			expect(mockTask.fileContextTracker.trackFileContext).not.toHaveBeenCalled()
			expect(mockTask.say).not.toHaveBeenCalled()
		})
	})

	describe("ModernFileReader text-only reads", () => {
		it("reports technical approval failures in text-only mode instead of falsely cancelling", async () => {
			const mockTask = { ...createMockTask(), abort: false, abandoned: false }
			mockTask.ask.mockRejectedValueOnce(new Error("Provider state unavailable"))

			// This reader-boundary double omits Task fields unrelated to file reading.
			const result = await readFileTool.readEntry({ path: "source.ts" }, mockTask as unknown as Task, {
				textOnly: true,
			})

			expect(result).toMatchObject({
				path: "source.ts",
				status: "error",
				error: "Error reading file: Provider state unavailable",
				nativeContent: "File: source.ts\nError: Provider state unavailable",
			})
			expect(mockTask.didToolFailInCurrentTurn).toBe(true)
			expect(mockTask.say).toHaveBeenCalledExactlyOnceWith(
				"error",
				"Error reading file source.ts: Provider state unavailable",
			)
			expect(mockedFsStat).not.toHaveBeenCalled()
			expect(mockedFsReadFile).not.toHaveBeenCalled()
			expect(mockedExtractRawTextFromFile).not.toHaveBeenCalled()
			expect(mockTask.fileContextTracker.trackFileContext).not.toHaveBeenCalled()
		})

		it("reports feedback-publication failures after approval instead of treating them as cancellation", async () => {
			const mockTask = { ...createMockTask(), abort: false, abandoned: false }
			mockTask.ask.mockResolvedValueOnce({ response: "yesButtonClicked", text: "Read only", images: undefined })
			mockTask.say.mockRejectedValueOnce(new Error("Feedback publication failed"))

			// This reader-boundary double omits Task fields unrelated to file reading.
			const result = await readFileTool.readEntry({ path: "source.ts" }, mockTask as unknown as Task, {
				textOnly: true,
			})

			expect(result).toMatchObject({ status: "error", error: "Error reading file: Feedback publication failed" })
			expect(mockTask.didToolFailInCurrentTurn).toBe(true)
			expect(mockTask.say).toHaveBeenNthCalledWith(1, "user_feedback", "Read only", undefined)
			expect(mockTask.say).toHaveBeenNthCalledWith(
				2,
				"error",
				"Error reading file source.ts: Feedback publication failed",
			)
			expect(mockedFsStat).not.toHaveBeenCalled()
			expect(mockedFsReadFile).not.toHaveBeenCalled()
			expect(mockedExtractRawTextFromFile).not.toHaveBeenCalled()
			expect(mockTask.fileContextTracker.trackFileContext).not.toHaveBeenCalled()
		})

		it.each(["abort", "abandoned"] as const)(
			"preserves genuine cancellation when approval rejects after %s",
			async (flag) => {
				const mockTask = { ...createMockTask(), abort: false, abandoned: false }
				mockTask.ask.mockImplementationOnce(async () => {
					mockTask[flag] = true
					throw new Error("Task is ending")
				})

				// This reader-boundary double omits Task fields unrelated to file reading.
				const result = await readFileTool.readEntry({ path: "source.ts" }, mockTask as unknown as Task, {
					textOnly: true,
				})

				expect(result).toEqual({ path: "source.ts", status: "cancelled" })
				expect(mockTask.didToolFailInCurrentTurn).toBe(false)
				expect(mockTask.say).not.toHaveBeenCalled()
				expect(mockedFsStat).not.toHaveBeenCalled()
				expect(mockedFsReadFile).not.toHaveBeenCalled()
				expect(mockTask.fileContextTracker.trackFileContext).not.toHaveBeenCalled()
			},
		)

		it("does not report a directory error when inspection finishes after cancellation", async () => {
			const mockTask = { ...createMockTask(), abort: false, abandoned: false }
			const stats = await mockedFsStat("fixture")
			stats.isDirectory = () => true
			mockedFsStat.mockClear()
			mockedFsStat.mockImplementationOnce(async () => {
				mockTask.abort = true
				return stats
			})

			// This reader-boundary double omits Task fields unrelated to file reading.
			const result = await readFileTool.readEntry({ path: "folder" }, mockTask as unknown as Task, {
				textOnly: true,
			})

			expect(result).toMatchObject({ path: "folder", status: "cancelled" })
			expect(mockTask.say).not.toHaveBeenCalled()
			expect(mockedIsBinaryFile).not.toHaveBeenCalled()
			expect(mockedFsReadFile).not.toHaveBeenCalled()
		})

		it("keeps pending extraction failures visible when the task is not cancelled", async () => {
			const mockTask = { ...createMockTask(), abort: false, abandoned: false }
			const extraction = createDeferred<string>()
			const started = createDeferred<void>()
			mockedIsBinaryFile.mockResolvedValue(true)
			mockedIsSupportedImageFormat.mockReturnValue(false)
			mockedExtractRawTextFromFile.mockImplementationOnce(() => {
				started.resolve()
				return extraction.promise
			})
			const params = { path: "document.pdf" }

			// This reader-boundary double omits Task fields unrelated to file reading.
			const pendingRead = readFileTool.readEntry(params, mockTask as unknown as Task, { textOnly: true })
			await started.promise
			expect(mockTask.say).not.toHaveBeenCalled()
			extraction.reject(new Error("Document extraction failed"))

			expect(await pendingRead).toEqual({
				path: "document.pdf",
				status: "error",
				approvalStatus: "approved",
				entry: params,
				feedbackText: undefined,
				feedbackImages: undefined,
				error: "Error reading file: Document extraction failed",
				nativeContent: "File: document.pdf\nError: Document extraction failed",
			})
			expect(mockTask.say).toHaveBeenCalledExactlyOnceWith(
				"error",
				"Error reading file document.pdf: Document extraction failed",
			)
			expect(mockedFsReadFile).toHaveBeenCalledOnce()
			expect(mockTask.fileContextTracker.trackFileContext).not.toHaveBeenCalled()
		})

		it.each(["abort", "abandoned"] as const)(
			"preserves cancellation when pending document extraction rejects after %s",
			async (flag) => {
				const mockTask = { ...createMockTask(), abort: false, abandoned: false }
				const extraction = createDeferred<string>()
				const started = createDeferred<void>()
				mockedIsBinaryFile.mockResolvedValue(true)
				mockedIsSupportedImageFormat.mockReturnValue(false)
				mockedExtractRawTextFromFile.mockImplementationOnce(() => {
					started.resolve()
					return extraction.promise
				})

				// This reader-boundary double omits Task fields unrelated to file reading.
				const pendingRead = readFileTool.readEntry({ path: "document.pdf" }, mockTask as unknown as Task, {
					textOnly: true,
				})
				await started.promise
				expect(mockTask.say).not.toHaveBeenCalled()
				expect(mockTask.fileContextTracker.trackFileContext).not.toHaveBeenCalled()
				mockTask[flag] = true
				extraction.reject(new Error("Extractor interrupted"))

				expect(await pendingRead).toMatchObject({ path: "document.pdf", status: "cancelled" })
				expect(mockTask.didToolFailInCurrentTurn).toBe(false)
				expect(mockTask.say).not.toHaveBeenCalled()
				expect(mockedFsReadFile).toHaveBeenCalledOnce()
				expect(mockTask.fileContextTracker.trackFileContext).not.toHaveBeenCalled()
			},
		)

		it("extracts and slices document text from pinned bytes in text-only mode", async () => {
			const mockTask = createMockTask()
			mockedIsSupportedImageFormat.mockReturnValue(false)
			mockedIsBinaryFile.mockResolvedValue(true)
			mockedExtractRawTextFromFile.mockResolvedValue("first\nsecond\nthird")
			mockedReadWithSlice.mockReturnValue({
				content: "2 | second",
				returnedLines: 1,
				totalLines: 3,
				wasTruncated: false,
				includedRanges: [[2, 2]],
			})

			// This reader-boundary double omits Task fields unrelated to file reading.
			const result = await readFileTool.readEntry(
				{ path: "document.pdf", offset: 2, limit: 1 },
				mockTask as unknown as Task,
				{ textOnly: true },
			)

			expect(result).toMatchObject({
				path: "document.pdf",
				status: "approved",
				nativeContent: "File: document.pdf\n2 | second",
				longLinesTruncated: false,
			})
			expect(mockedExtractRawTextFromFile).toHaveBeenCalledExactlyOnceWith(
				"document.pdf",
				Buffer.from("test content"),
			)
			expect(mockedReadWithSlice).toHaveBeenCalledExactlyOnceWith("first\nsecond\nthird", 1, 1)
			expect(mockedFsReadFile).toHaveBeenCalledOnce()
			expect(mockTask.fileContextTracker.trackFileContext).toHaveBeenCalledExactlyOnceWith(
				"document.pdf",
				"read_tool",
			)
		})

		it("discards late file content after cancellation without processing or tracking it", async () => {
			const mockTask = { ...createMockTask(), abort: false, abandoned: false }
			mockedIsSupportedImageFormat.mockReturnValue(false)
			mockedFsReadFile.mockImplementationOnce(async () => {
				mockTask.abort = true
				return Buffer.from("late content")
			})

			// This reader-boundary double omits Task fields unrelated to file reading.
			const result = await readFileTool.readEntry({ path: "test.ts" }, mockTask as unknown as Task, {
				textOnly: true,
			})

			expect(result).toMatchObject({ path: "test.ts", status: "cancelled" })
			expect(mockedFsReadFile).toHaveBeenCalledExactlyOnceWith(path.resolve(mockTask.cwd, "test.ts"))
			expect(mockedReadWithSlice).not.toHaveBeenCalled()
			expect(mockTask.fileContextTracker.trackFileContext).not.toHaveBeenCalled()
		})

		it("stops before content reading when cancellation arrives during binary detection", async () => {
			const mockTask = { ...createMockTask(), abort: false, abandoned: false }
			mockedIsSupportedImageFormat.mockReturnValue(false)
			mockedIsBinaryFile.mockImplementationOnce(async () => {
				mockTask.abandoned = true
				return false
			})

			// This reader-boundary double omits Task fields unrelated to file reading.
			const result = await readFileTool.readEntry({ path: "test.ts" }, mockTask as unknown as Task, {
				textOnly: true,
			})

			expect(result).toMatchObject({ path: "test.ts", status: "cancelled" })
			expect(mockedFsReadFile).not.toHaveBeenCalled()
			expect(mockedExtractRawTextFromFile).not.toHaveBeenCalled()
			expect(mockedExtractTextFromFile).not.toHaveBeenCalled()
			expect(mockTask.fileContextTracker.trackFileContext).not.toHaveBeenCalled()
		})

		it("stops before binary detection when cancellation arrives during file inspection", async () => {
			const mockTask = { ...createMockTask(), abort: false, abandoned: false }
			const stats = await mockedFsStat("fixture")
			mockedFsStat.mockClear()
			mockedFsStat.mockImplementationOnce(async () => {
				mockTask.abort = true
				return stats
			})

			// This reader-boundary double omits Task fields unrelated to file reading.
			const result = await readFileTool.readEntry({ path: "test.ts" }, mockTask as unknown as Task, {
				textOnly: true,
			})

			expect(result).toMatchObject({ path: "test.ts", status: "cancelled" })
			expect(mockedIsBinaryFile).not.toHaveBeenCalled()
			expect(mockedFsReadFile).not.toHaveBeenCalled()
			expect(mockTask.fileContextTracker.trackFileContext).not.toHaveBeenCalled()
		})

		it("rejects images in text-only reads before inspecting or reading their contents", async () => {
			const mockTask = createMockTask({ supportsImages: true })
			mockedIsSupportedImageFormat.mockImplementation((extension) => extension === ".png")

			// This reader-boundary double omits Task fields unrelated to file reading.
			const result = await readFileTool.readEntry({ path: "image.png" }, mockTask as unknown as Task, {
				textOnly: true,
			})

			expect(result).toMatchObject({
				path: "image.png",
				status: "unsupported",
				error: "Batch images are not supported; use read_file.",
			})
			expect(mockedIsBinaryFile).not.toHaveBeenCalled()
			expect(mockedFsReadFile).not.toHaveBeenCalled()
			expect(mockedExtractTextFromFile).not.toHaveBeenCalled()
			expect(mockedProcessImageFile).not.toHaveBeenCalled()
			expect(mockTask.fileContextTracker.trackFileContext).not.toHaveBeenCalled()
		})

		it.each(["abort", "abandoned"] as const)(
			"does not request approval for a text-only read after %s",
			async (flag) => {
				const reader = new ModernFileReader()
				const mockTask = { ...createMockTask(), abort: false, abandoned: false }
				mockTask[flag] = true

				// This reader-boundary double omits Task fields unrelated to file reading.
				const result = await reader.read({ path: "test.ts" }, mockTask as unknown as Task, { textOnly: true })

				expect(result).toEqual({ path: "test.ts", status: "cancelled" })
				expect(mockTask.ask).not.toHaveBeenCalled()
				expect(mockedFsStat).not.toHaveBeenCalled()
				expect(mockedFsReadFile).not.toHaveBeenCalled()
			},
		)

		it("cancels a text-only read when its approval is withdrawn", async () => {
			const reader = new ModernFileReader()
			const mockTask = { ...createMockTask(), abort: false, abandoned: false }
			mockTask.ask.mockRejectedValueOnce(new AskIgnoredError("superseded"))

			// This reader-boundary double omits Task fields unrelated to file reading.
			const result = await reader.read({ path: "test.ts" }, mockTask as unknown as Task, { textOnly: true })

			expect(result).toEqual({ path: "test.ts", status: "cancelled" })
			expect(mockTask.didToolFailInCurrentTurn).toBe(false)
			expect(mockTask.say).not.toHaveBeenCalled()
			expect(mockedFsStat).not.toHaveBeenCalled()
			expect(mockedFsReadFile).not.toHaveBeenCalled()
			expect(mockedExtractRawTextFromFile).not.toHaveBeenCalled()
			expect(mockTask.fileContextTracker.trackFileContext).not.toHaveBeenCalled()
		})

		it("does not read a file when cancellation arrives during approval", async () => {
			const reader = new ModernFileReader()
			const mockTask = { ...createMockTask(), abort: false, abandoned: false }
			mockTask.ask.mockImplementation(async () => {
				mockTask.abort = true
				return { response: "yesButtonClicked", text: undefined, images: undefined }
			})

			// This reader-boundary double omits Task fields unrelated to file reading.
			const result = await reader.read({ path: "test.ts" }, mockTask as unknown as Task, { textOnly: true })

			expect(result).toEqual({
				path: "test.ts",
				status: "cancelled",
				approvalStatus: "approved",
				feedbackText: undefined,
				feedbackImages: undefined,
			})
			expect(mockedFsStat).not.toHaveBeenCalled()
			expect(mockedFsReadFile).not.toHaveBeenCalled()
		})
	})

	describe("input validation", () => {
		it("should return error when path is missing", async () => {
			const mockTask = createMockTask()
			const callbacks = createMockCallbacks()

			await readFileTool.execute({ path: "" } as any, mockTask as any, callbacks)

			expect(mockTask.consecutiveMistakeCount).toBe(1)
			expect(mockTask.recordToolError).toHaveBeenCalledWith("read_file")
			expect(mockTask.sayAndCreateMissingParamError).toHaveBeenCalledWith("read_file", "path")
			expect(callbacks.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("Error:"))
		})

		it("should return error when path is undefined", async () => {
			const mockTask = createMockTask()
			const callbacks = createMockCallbacks()

			await readFileTool.execute({} as any, mockTask as any, callbacks)

			expect(mockTask.consecutiveMistakeCount).toBe(1)
			expect(callbacks.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("Error:"))
		})

		it("should return error when offset is 0 or negative", async () => {
			const mockTask = createMockTask()
			const callbacks = createMockCallbacks()

			await readFileTool.execute({ path: "test.txt", offset: 0 }, mockTask as any, callbacks)

			expect(callbacks.pushToolResult).toHaveBeenCalledWith(
				expect.stringContaining("offset must be a 1-indexed line number"),
			)
		})

		it("should return error when offset is negative", async () => {
			const mockTask = createMockTask()
			const callbacks = createMockCallbacks()

			await readFileTool.execute({ path: "test.txt", offset: -5 }, mockTask as any, callbacks)

			expect(callbacks.pushToolResult).toHaveBeenCalledWith(
				expect.stringContaining("offset must be a 1-indexed line number"),
			)
		})

		it("should return error when anchor_line is 0 or negative", async () => {
			const mockTask = createMockTask()
			const callbacks = createMockCallbacks()

			await readFileTool.execute(
				{
					path: "test.txt",
					mode: "indentation",
					indentation: { anchor_line: 0 },
				},
				mockTask as any,
				callbacks,
			)

			expect(callbacks.pushToolResult).toHaveBeenCalledWith(
				expect.stringContaining("anchor_line must be a 1-indexed line number"),
			)
		})

		it("should return error when anchor_line is negative", async () => {
			const mockTask = createMockTask()
			const callbacks = createMockCallbacks()

			await readFileTool.execute(
				{
					path: "test.txt",
					mode: "indentation",
					indentation: { anchor_line: -10 },
				},
				mockTask as any,
				callbacks,
			)

			expect(callbacks.pushToolResult).toHaveBeenCalledWith(
				expect.stringContaining("anchor_line must be a 1-indexed line number"),
			)
		})
	})

	describe("RooIgnore handling", () => {
		it("blocks access before approval or file inspection when the ignore controller is unavailable", async () => {
			const mockTask = { ...createMockTask(), rooIgnoreController: undefined }
			const error =
				"Access to secret.env is blocked by the .rooignore file settings. You must try to continue in the task without using this file, or ask the user to update the .rooignore file."

			// This reader-boundary double omits Task fields unrelated to file reading.
			const result = await readFileTool.readEntry({ path: "secret.env" }, mockTask as unknown as Task)

			expect(result).toEqual({
				path: "secret.env",
				status: "blocked",
				error,
				nativeContent: `File: secret.env\nError: ${error}`,
			})
			expect(mockTask.say).toHaveBeenCalledExactlyOnceWith("rooignore_error", "secret.env")
			expect(mockTask.ask).not.toHaveBeenCalled()
			expect(mockedFsStat).not.toHaveBeenCalled()
			expect(mockedIsBinaryFile).not.toHaveBeenCalled()
			expect(mockedFsReadFile).not.toHaveBeenCalled()
			expect(mockedExtractTextFromFile).not.toHaveBeenCalled()
			expect(mockedProcessImageFile).not.toHaveBeenCalled()
			expect(mockTask.fileContextTracker.trackFileContext).not.toHaveBeenCalled()
		})

		it("should block access to rooignore-protected files", async () => {
			const mockTask = createMockTask({ rooIgnoreAllowed: false })
			const callbacks = createMockCallbacks()

			await readFileTool.execute({ path: "secret.env" }, mockTask as any, callbacks)

			expect(mockTask.say).toHaveBeenCalledWith("rooignore_error", "secret.env")
			expect(formatResponse.rooIgnoreError).toHaveBeenCalledWith("secret.env")
			expect(callbacks.pushToolResult).toHaveBeenCalledWith(textResultContaining("blocked by the .rooignore"))
		})
	})

	describe("directory handling", () => {
		it("should return error when trying to read a directory", async () => {
			const mockTask = createMockTask()
			const callbacks = createMockCallbacks()

			mockedFsStat.mockResolvedValue({ isDirectory: () => true } as any)

			await readFileTool.execute({ path: "src/utils" }, mockTask as any, callbacks)

			expect(mockTask.say).toHaveBeenCalledWith(
				"error",
				expect.stringContaining("Cannot read 'src/utils' because it is a directory"),
			)
			expect(callbacks.pushToolResult).toHaveBeenCalledWith(textResultContaining("it is a directory"))
			expect(mockTask.didToolFailInCurrentTurn).toBe(true)
		})
	})

	describe("image handling", () => {
		beforeEach(() => {
			mockedIsBinaryFile.mockResolvedValue(true)
			mockedIsSupportedImageFormat.mockReturnValue(true)
		})

		it("should process image file when model supports images", async () => {
			const mockTask = createMockTask({ supportsImages: true })
			const callbacks = createMockCallbacks()

			mockedValidateImageForProcessing.mockResolvedValue({
				isValid: true,
				sizeInMB: 0.5,
			})
			mockedProcessImageFile.mockResolvedValue({
				dataUrl: "data:image/png;base64,abc123",
				buffer: Buffer.from("test"),
				sizeInKB: 512,
				sizeInMB: 0.5,
				notice: "Image processed successfully",
			})

			await readFileTool.execute({ path: "image.png" }, mockTask as any, callbacks)

			expect(mockedValidateImageForProcessing).toHaveBeenCalled()
			expect(mockedProcessImageFile).toHaveBeenCalled()
			expect(callbacks.pushToolResult).toHaveBeenCalled()
		})

		it("should skip image when model does not support images", async () => {
			const mockTask = createMockTask({ supportsImages: false })
			const callbacks = createMockCallbacks()

			mockedValidateImageForProcessing.mockResolvedValue({
				isValid: false,
				reason: "unsupported_model",
				notice: "Model does not support image processing",
			})

			await readFileTool.execute({ path: "image.png" }, mockTask as any, callbacks)

			expect(mockedValidateImageForProcessing).toHaveBeenCalled()
			expect(mockedProcessImageFile).not.toHaveBeenCalled()
			expect(callbacks.pushToolResult).toHaveBeenCalledWith(
				textResultContaining("Model does not support image processing"),
			)
		})

		it("should skip image when file exceeds size limit", async () => {
			const mockTask = createMockTask({ supportsImages: true, maxImageFileSize: 1 })
			const callbacks = createMockCallbacks()

			mockedValidateImageForProcessing.mockResolvedValue({
				isValid: false,
				reason: "size_limit",
				notice: "Image file size (10 MB) exceeds the maximum allowed size (1 MB)",
			})

			await readFileTool.execute({ path: "large-image.png" }, mockTask as any, callbacks)

			expect(mockedProcessImageFile).not.toHaveBeenCalled()
			expect(callbacks.pushToolResult).toHaveBeenCalledWith(textResultContaining("exceeds the maximum allowed"))
		})

		it("should skip image when total memory limit exceeded", async () => {
			const mockTask = createMockTask({ supportsImages: true, maxTotalImageSize: 5 })
			const callbacks = createMockCallbacks()

			mockedValidateImageForProcessing.mockResolvedValue({
				isValid: false,
				reason: "memory_limit",
				notice: "Skipping image: would exceed total memory limit",
			})

			await readFileTool.execute({ path: "another-image.png" }, mockTask as any, callbacks)

			expect(mockedProcessImageFile).not.toHaveBeenCalled()
			expect(callbacks.pushToolResult).toHaveBeenCalledWith(textResultContaining("would exceed total memory"))
		})

		it("should handle image read errors gracefully", async () => {
			const mockTask = createMockTask({ supportsImages: true })
			const callbacks = createMockCallbacks()

			mockedValidateImageForProcessing.mockResolvedValue({
				isValid: true,
				sizeInMB: 0.5,
			})
			mockedProcessImageFile.mockRejectedValue(new Error("Failed to read image"))

			await readFileTool.execute({ path: "corrupt.png" }, mockTask as any, callbacks)

			expect(mockTask.say).toHaveBeenCalledWith("error", expect.stringContaining("Error reading image file"))
			expect(callbacks.pushToolResult).toHaveBeenCalledWith(textResultContaining("Error"))
		})
	})

	describe("binary file handling", () => {
		beforeEach(() => {
			mockedIsBinaryFile.mockResolvedValue(true)
			mockedIsSupportedImageFormat.mockReturnValue(false)
			mockedReadWithSlice.mockImplementation(nativeTextReader.readWithSlice)
		})

		it("should extract text from PDF files", async () => {
			const mockTask = createMockTask()
			const callbacks = createMockCallbacks()

			mockedExtractRawTextFromFile.mockResolvedValueOnce("PDF content here")

			await readFileTool.execute({ path: "document.pdf" }, mockTask as any, callbacks)

			expect(mockedExtractRawTextFromFile).toHaveBeenCalled()
			expect(callbacks.pushToolResult).toHaveBeenCalledWith(textResultContaining("PDF content here"))
		})

		it("should extract text from DOCX files", async () => {
			const mockTask = createMockTask()
			const callbacks = createMockCallbacks()

			mockedExtractRawTextFromFile.mockResolvedValueOnce("DOCX content here")

			await readFileTool.execute({ path: "document.docx" }, mockTask as any, callbacks)

			expect(mockedExtractRawTextFromFile).toHaveBeenCalled()
			expect(callbacks.pushToolResult).toHaveBeenCalledWith(textResultContaining("DOCX content here"))
		})

		it("rejects an out-of-range empty document instead of bypassing range processing", async () => {
			const mockTask = createMockTask()
			const callbacks = createMockCallbacks()
			mockedExtractRawTextFromFile.mockResolvedValueOnce("")

			// This reader-boundary double omits Task fields unrelated to file reading.
			await readFileTool.execute({ path: "empty.pdf", offset: 2 }, mockTask as unknown as Task, callbacks)

			expect(callbacks.pushToolResult).toHaveBeenCalledExactlyOnceWith([
				{ type: "text", text: "File: empty.pdf\nError: offset 1 is beyond file end (1 lines)" },
			])
			expect(mockTask.fileContextTracker.trackFileContext).not.toHaveBeenCalled()
			expect(mockTask.didToolFailInCurrentTurn).toBe(true)
		})

		it("should handle unsupported binary formats", async () => {
			const mockTask = createMockTask()
			const callbacks = createMockCallbacks()

			// Return empty array to indicate .exe is not supported
			vi.mocked(getSupportedBinaryFormats).mockReturnValue([".pdf", ".docx"])

			await readFileTool.execute({ path: "program.exe" }, mockTask as any, callbacks)

			expect(callbacks.pushToolResult).toHaveBeenCalledWith(textResultContaining("Binary file"))
		})

		it("should handle extraction errors gracefully", async () => {
			const mockTask = createMockTask()
			const callbacks = createMockCallbacks()

			mockedExtractRawTextFromFile.mockRejectedValueOnce(new Error("Extraction failed"))

			await readFileTool.execute({ path: "corrupt.pdf" }, mockTask as any, callbacks)

			expect(mockTask.say).toHaveBeenCalledWith("error", expect.stringContaining("Error extracting text"))
			expect(mockTask.didToolFailInCurrentTurn).toBe(true)
		})
	})

	describe("text file processing", () => {
		beforeEach(() => {
			mockedIsBinaryFile.mockResolvedValue(false)
		})

		it("should read text file with slice mode (default)", async () => {
			const mockTask = createMockTask()
			const callbacks = createMockCallbacks()

			const content = "line 1\nline 2\nline 3"
			mockedFsReadFile.mockResolvedValue(Buffer.from(content))
			mockedReadWithSlice.mockReturnValue({
				content: "1 | line 1\n2 | line 2\n3 | line 3",
				returnedLines: 3,
				totalLines: 3,
				wasTruncated: false,
				includedRanges: [[1, 3]],
			})

			await readFileTool.execute({ path: "test.ts" }, mockTask as any, callbacks)

			expect(mockedReadWithSlice).toHaveBeenCalled()
			expect(callbacks.pushToolResult).toHaveBeenCalledWith(textResultContaining("line 1"))
		})

		it("should read text file with offset and limit", async () => {
			const mockTask = createMockTask()
			const callbacks = createMockCallbacks()

			mockedFsReadFile.mockResolvedValue(Buffer.from("line 1\nline 2\nline 3\nline 4\nline 5"))
			mockedReadWithSlice.mockReturnValue({
				content: "2 | line 2\n3 | line 3",
				returnedLines: 2,
				totalLines: 5,
				wasTruncated: true,
				includedRanges: [[2, 3]],
			})

			await readFileTool.execute(
				{ path: "test.ts", mode: "slice", offset: 2, limit: 2 },
				mockTask as any,
				callbacks,
			)

			expect(mockedReadWithSlice).toHaveBeenCalledWith(expect.any(String), 1, 2) // offset converted to 0-based
		})

		it("should read text file with indentation mode", async () => {
			const mockTask = createMockTask()
			const callbacks = createMockCallbacks()

			const content = "class Foo {\n  method() {\n    return 42\n  }\n}"
			mockedFsReadFile.mockResolvedValue(Buffer.from(content))
			mockedReadWithIndentation.mockReturnValue({
				content: "1 | class Foo {\n2 |   method() {\n3 |     return 42\n4 |   }\n5 | }",
				returnedLines: 5,
				totalLines: 5,
				wasTruncated: false,
				includedRanges: [[1, 5]],
			})

			await readFileTool.execute(
				{
					path: "test.ts",
					mode: "indentation",
					indentation: { anchor_line: 3 },
				},
				mockTask as any,
				callbacks,
			)

			expect(mockedReadWithIndentation).toHaveBeenCalledWith(
				content,
				expect.objectContaining({
					anchorLine: 3,
				}),
			)
		})

		it("should show truncation notice when content is truncated", async () => {
			const mockTask = createMockTask()
			const callbacks = createMockCallbacks()

			mockedFsReadFile.mockResolvedValue(Buffer.from("lots of content..."))
			mockedReadWithSlice.mockReturnValue({
				content: "1 | truncated content",
				returnedLines: 100,
				totalLines: 5000,
				wasTruncated: true,
				includedRanges: [[1, 100]],
			})

			await readFileTool.execute({ path: "large.ts" }, mockTask as any, callbacks)

			expect(callbacks.pushToolResult).toHaveBeenCalledWith(textResultContaining("truncated"))
			expect(callbacks.pushToolResult).toHaveBeenCalledWith(textResultContaining("To read more"))
		})

		it("should handle empty files", async () => {
			const mockTask = createMockTask()
			const callbacks = createMockCallbacks()

			mockedFsReadFile.mockResolvedValue(Buffer.from(""))
			mockedReadWithSlice.mockReturnValue({
				content: "",
				returnedLines: 0,
				totalLines: 0,
				wasTruncated: false,
				includedRanges: [],
			})

			await readFileTool.execute({ path: "empty.ts" }, mockTask as any, callbacks)

			expect(callbacks.pushToolResult).toHaveBeenCalledWith(textResultContaining("empty"))
		})
	})

	describe("approval flow", () => {
		it("preserves received approval instructions when cancellation wins immediately after the response", async () => {
			const instruction = "Do not modify any files; only inspect"
			const mockTask = { ...createMockTask(), abort: false, abandoned: false }
			mockTask.ask.mockImplementationOnce(async () => {
				mockTask.abort = true
				return { response: "yesButtonClicked", text: instruction, images: undefined }
			})

			// This reader-boundary double omits Task fields unrelated to file reading.
			const result = await readFileTool.readEntry({ path: "source.ts" }, mockTask as unknown as Task)

			expect(result.status).toBe("cancelled")
			expect(new ReadFileResultFormatter().format(result, false)).toEqual([
				{ type: "text", text: formatResponse.toolApprovedWithFeedback(instruction) },
			])
			expect(mockedFsReadFile).not.toHaveBeenCalled()
			expect(mockTask.fileContextTracker.trackFileContext).not.toHaveBeenCalled()
		})

		it("keeps approval instructions in the final model-facing blocks when file reading fails", async () => {
			const instruction = "Do not modify any files; only inspect"
			const mockTask = createMockTask()
			mockTask.ask.mockResolvedValueOnce({ response: "yesButtonClicked", text: instruction, images: undefined })
			mockedFsReadFile.mockRejectedValueOnce(new Error("Missing source file"))
			const formatter = new ReadFileResultFormatter()
			const format = vi.spyOn(formatter, "format")
			const tool = new ReadFileTool(formatter)
			const callbacks = createMockCallbacks()

			// This reader-boundary double omits Task fields unrelated to file reading.
			await tool.execute({ path: "source.ts" }, mockTask as unknown as Task, callbacks)

			expect(callbacks.pushToolResult).toHaveBeenCalledExactlyOnceWith([
				{ type: "text", text: formatResponse.toolApprovedWithFeedback(instruction) },
				{ type: "text", text: "File: source.ts\nError: Missing source file" },
			])
			expect(format).toHaveBeenCalledWith(
				expect.objectContaining({ status: "error", feedbackText: instruction }),
				false,
			)
			expect(mockTask.didToolFailInCurrentTurn).toBe(true)
			expect(mockTask.fileContextTracker.trackFileContext).not.toHaveBeenCalled()
		})

		it("should approve file read when user clicks yes", async () => {
			const mockTask = createMockTask()
			const callbacks = createMockCallbacks()

			mockTask.ask.mockResolvedValue({ response: "yesButtonClicked", text: undefined, images: undefined })

			await readFileTool.execute({ path: "test.ts" }, mockTask as any, callbacks)

			expect(mockTask.ask).toHaveBeenCalledWith("tool", expect.any(String), false)
			expect(mockTask.didRejectTool).toBe(false)
		})

		it("should deny file read when user clicks no", async () => {
			const mockTask = createMockTask()
			const callbacks = createMockCallbacks()

			mockTask.ask.mockResolvedValue({ response: "noButtonClicked", text: undefined, images: undefined })

			await readFileTool.execute({ path: "test.ts" }, mockTask as any, callbacks)

			expect(mockTask.didRejectTool).toBe(true)
			expect(callbacks.pushToolResult).toHaveBeenCalledWith(textResultContaining("Denied by user"))
		})

		it("should include user feedback when provided with approval", async () => {
			const mockTask = createMockTask()
			const callbacks = createMockCallbacks()

			mockTask.ask.mockResolvedValue({
				response: "yesButtonClicked",
				text: "Please be careful with this file",
				images: undefined,
			})
			mockedFsReadFile.mockResolvedValue(Buffer.from("content"))
			mockedReadWithSlice.mockReturnValue({
				content: "1 | content",
				returnedLines: 1,
				totalLines: 1,
				wasTruncated: false,
				includedRanges: [[1, 1]],
			})

			await readFileTool.execute({ path: "test.ts" }, mockTask as any, callbacks)

			expect(mockTask.say).toHaveBeenCalledWith("user_feedback", "Please be careful with this file", undefined)
			expect(formatResponse.toolApprovedWithFeedback).toHaveBeenCalledWith("Please be careful with this file")
		})

		it("should include user feedback when provided with denial", async () => {
			const mockTask = createMockTask()
			const callbacks = createMockCallbacks()

			mockTask.ask.mockResolvedValue({
				response: "noButtonClicked",
				text: "This file contains secrets",
				images: undefined,
			})

			await readFileTool.execute({ path: "secrets.env" }, mockTask as any, callbacks)

			expect(mockTask.say).toHaveBeenCalledWith("user_feedback", "This file contains secrets", undefined)
			expect(formatResponse.toolDeniedWithFeedback).toHaveBeenCalledWith("This file contains secrets")
		})
	})

	describe("output structure", () => {
		it("should include file path in output", async () => {
			const mockTask = createMockTask()
			const callbacks = createMockCallbacks()

			mockedFsReadFile.mockResolvedValue(Buffer.from("content"))
			mockedReadWithSlice.mockReturnValue({
				content: "1 | content",
				returnedLines: 1,
				totalLines: 1,
				wasTruncated: false,
				includedRanges: [[1, 1]],
			})

			await readFileTool.execute({ path: "src/app.ts" }, mockTask as any, callbacks)

			expect(callbacks.pushToolResult).toHaveBeenCalledWith(textResultContaining("File: src/app.ts"))
		})

		it("should track file context after successful read", async () => {
			const mockTask = createMockTask()
			const callbacks = createMockCallbacks()

			mockedFsReadFile.mockResolvedValue(Buffer.from("content"))
			mockedReadWithSlice.mockReturnValue({
				content: "1 | content",
				returnedLines: 1,
				totalLines: 1,
				wasTruncated: false,
				includedRanges: [[1, 1]],
			})

			await readFileTool.execute({ path: "test.ts" }, mockTask as any, callbacks)

			expect(mockTask.fileContextTracker.trackFileContext).toHaveBeenCalledWith("test.ts", "read_tool")
		})
	})

	describe("error handling", () => {
		it("should handle file read errors gracefully", async () => {
			const mockTask = createMockTask()
			const callbacks = createMockCallbacks()

			mockedFsReadFile.mockRejectedValue(new Error("ENOENT: no such file or directory"))

			await readFileTool.execute({ path: "nonexistent.ts" }, mockTask as any, callbacks)

			expect(mockTask.say).toHaveBeenCalledWith("error", expect.stringContaining("Error reading file"))
			expect(mockTask.didToolFailInCurrentTurn).toBe(true)
		})

		it("should handle stat errors gracefully", async () => {
			const mockTask = createMockTask()
			const callbacks = createMockCallbacks()

			mockedFsStat.mockRejectedValue(new Error("Permission denied"))

			await readFileTool.execute({ path: "protected.ts" }, mockTask as any, callbacks)

			expect(mockTask.say).toHaveBeenCalledWith("error", expect.stringContaining("Error reading file"))
			expect(mockTask.didToolFailInCurrentTurn).toBe(true)
		})
	})

	describe("getReadFileToolDescription", () => {
		it("should return description with path when nativeArgs provided", () => {
			const description = readFileTool.getReadFileToolDescription("read_file", { path: "src/app.ts" })

			expect(description).toBe("[read_file for 'src/app.ts']")
		})

		it("should return description with path when params provided", () => {
			const description = readFileTool.getReadFileToolDescription("read_file", { path: "src/app.ts" })

			expect(description).toBe("[read_file for 'src/app.ts']")
		})

		it("should return description indicating missing path", () => {
			const description = readFileTool.getReadFileToolDescription("read_file", {})

			expect(description).toBe("[read_file with missing path]")
		})
	})

	describe("legacy format handling", () => {
		it("reports failed legacy image processing without dropping the file or stopping subsequent reads", async () => {
			const mockTask = createMockTask({ supportsImages: true })
			const callbacks = createMockCallbacks()
			mockedIsBinaryFile.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
			mockedIsSupportedImageFormat.mockReturnValue(true)
			mockedValidateImageForProcessing.mockResolvedValueOnce({ isValid: true })
			mockedProcessImageFile.mockRejectedValueOnce(new Error("Image decoding failed"))
			mockedFsReadFile.mockResolvedValueOnce("legacy content")
			mockedReadWithSlice.mockReturnValueOnce({
				content: "1 | legacy content",
				returnedLines: 1,
				totalLines: 1,
				wasTruncated: false,
				includedRanges: [[1, 1]],
			})

			// This reader-boundary double omits Task fields unrelated to file reading.
			await readFileTool.execute(
				{ files: [{ path: "image.png" }, { path: "legacy.ts" }], _legacyFormat: true },
				mockTask as unknown as Task,
				callbacks,
			)

			expect(callbacks.pushToolResult).toHaveBeenCalledExactlyOnceWith(
				"File: image.png\nError: Image decoding failed\n\n---\n\nFile: legacy.ts\n1 | legacy content",
			)
			expect(mockTask.say).toHaveBeenCalledExactlyOnceWith(
				"error",
				"Error reading file image.png: Image decoding failed",
			)
			expect(mockTask.didToolFailInCurrentTurn).toBe(true)
			expect(mockedProcessImageFile).toHaveBeenCalledExactlyOnceWith("image.png", expect.any(Object))
			expect(mockedFsReadFile).toHaveBeenCalledExactlyOnceWith(path.resolve(mockTask.cwd, "legacy.ts"), "utf8")
			expect(mockTask.fileContextTracker.trackFileContext).toHaveBeenCalledExactlyOnceWith(
				"legacy.ts",
				"read_tool",
			)
		})

		it("does not process legacy images when the model does not declare image support", async () => {
			const mockTask = createMockTask()
			const callbacks = createMockCallbacks()
			mockTask.api.getModel.mockReturnValue({ info: {} })
			mockedIsBinaryFile.mockResolvedValue(true)
			mockedIsSupportedImageFormat.mockReturnValue(true)

			// This reader-boundary double omits Task fields unrelated to file reading.
			await readFileTool.execute(
				{ files: [{ path: "image.png" }], _legacyFormat: true },
				mockTask as unknown as Task,
				callbacks,
			)

			expect(callbacks.pushToolResult).toHaveBeenCalledExactlyOnceWith(
				"File: image.png\nError: Cannot read binary file",
			)
			expect(mockedValidateImageForProcessing).not.toHaveBeenCalled()
			expect(mockedProcessImageFile).not.toHaveBeenCalled()
		})

		it("uses legacy image limits and a useful notice when provider config and validation notice are absent", async () => {
			const mockTask = createMockTask({ supportsImages: true })
			const callbacks = createMockCallbacks()
			mockTask.providerRef.deref.mockReturnValue(undefined)
			mockedIsBinaryFile.mockResolvedValue(true)
			mockedIsSupportedImageFormat.mockReturnValue(true)
			mockedValidateImageForProcessing.mockResolvedValue({ isValid: false })

			// This reader-boundary double omits Task fields unrelated to file reading.
			await readFileTool.execute(
				{ files: [{ path: "image.png" }], _legacyFormat: true },
				mockTask as unknown as Task,
				callbacks,
			)

			expect(callbacks.pushToolResult).toHaveBeenCalledExactlyOnceWith(
				"File: image.png\nNotice: Image validation failed",
			)
			expect(mockedValidateImageForProcessing).toHaveBeenCalledExactlyOnceWith(
				path.resolve(mockTask.cwd, "image.png"),
				true,
				DEFAULT_MAX_IMAGE_FILE_SIZE_MB,
				DEFAULT_MAX_TOTAL_IMAGE_SIZE_MB,
				0,
				expect.any(Object),
			)
			expect(mockedProcessImageFile).not.toHaveBeenCalled()
		})

		it("retains legacy file content when context tracking fails afterward", async () => {
			const mockTask = createMockTask()
			const callbacks = createMockCallbacks()
			mockTask.fileContextTracker.trackFileContext.mockRejectedValue(new Error("Context tracking failed"))
			mockedFsReadFile.mockResolvedValue("legacy content")
			mockedReadWithSlice.mockReturnValue({
				content: "1 | legacy content",
				returnedLines: 1,
				totalLines: 1,
				wasTruncated: false,
				includedRanges: [[1, 1]],
			})

			// This reader-boundary double omits Task fields unrelated to file reading.
			await readFileTool.execute(
				{ files: [{ path: "legacy.ts" }], _legacyFormat: true },
				mockTask as unknown as Task,
				callbacks,
			)

			expect(callbacks.pushToolResult).toHaveBeenCalledExactlyOnceWith(
				"File: legacy.ts\n1 | legacy content\n\n---\n\nFile: legacy.ts\nError: Context tracking failed",
			)
			expect(mockTask.say).toHaveBeenCalledExactlyOnceWith(
				"error",
				"Error reading file legacy.ts: Context tracking failed",
			)
			expect(mockTask.didToolFailInCurrentTurn).toBe(true)
		})

		it("falls back to legacy text reading when binary detection fails", async () => {
			const mockTask = createMockTask()
			const callbacks = createMockCallbacks()
			mockedIsBinaryFile.mockRejectedValueOnce(new Error("Binary detection unavailable"))
			mockedFsReadFile.mockResolvedValue("legacy content")
			mockedReadWithSlice.mockReturnValue({
				content: "1 | legacy content",
				returnedLines: 1,
				totalLines: 1,
				wasTruncated: false,
				includedRanges: [[1, 1]],
			})

			// This reader-boundary double omits Task fields unrelated to file reading.
			await readFileTool.execute(
				{ files: [{ path: "legacy.ts" }], _legacyFormat: true },
				mockTask as unknown as Task,
				callbacks,
			)

			expect(callbacks.pushToolResult).toHaveBeenCalledExactlyOnceWith("File: legacy.ts\n1 | legacy content")
			expect(mockedFsReadFile).toHaveBeenCalledExactlyOnceWith(path.resolve(mockTask.cwd, "legacy.ts"), "utf8")
			expect(mockTask.fileContextTracker.trackFileContext).toHaveBeenCalledExactlyOnceWith(
				"legacy.ts",
				"read_tool",
			)
			expect(mockTask.didToolFailInCurrentTurn).toBe(false)
		})

		it("reuses the injected legacy reader for successive calls", async () => {
			const legacyReader = new LegacyFileReader()
			const read = vi.spyOn(legacyReader, "read").mockResolvedValue("legacy file response")
			const tool = new ReadFileTool(undefined, undefined, legacyReader)
			const mockTask = createMockTask()
			const callbacks = createMockCallbacks()
			const firstFiles = [{ path: "first.ts" }]
			const secondFiles = [{ path: "second.ts" }]

			// This reader-boundary double omits Task fields unrelated to file reading.
			const task = mockTask as unknown as Task
			await tool.execute({ files: firstFiles, _legacyFormat: true }, task, callbacks)
			await tool.execute({ files: secondFiles, _legacyFormat: true }, task, callbacks)

			expect(read).toHaveBeenCalledTimes(2)
			expect(read).toHaveBeenNthCalledWith(1, firstFiles, task)
			expect(read).toHaveBeenNthCalledWith(2, secondFiles, task)
			expect(callbacks.pushToolResult).toHaveBeenNthCalledWith(1, "legacy file response")
			expect(callbacks.pushToolResult).toHaveBeenNthCalledWith(2, "legacy file response")
		})

		it("should detect legacy format and use backward compatibility path", async () => {
			const mockTask = createMockTask()
			const callbacks = createMockCallbacks()

			mockTask.ask.mockResolvedValue({ response: "yesButtonClicked", text: undefined, images: undefined })
			mockedFsReadFile.mockResolvedValue(Buffer.from("legacy content"))

			await readFileTool.execute({ files: [{ path: "legacy.ts" }] } as any, mockTask as any, callbacks)

			// The legacy path emits "File: <path>" entries — proof the backward-compat branch ran.
			expect(callbacks.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("File: legacy.ts"))
		})

		it("should return error when legacy files array is empty", async () => {
			const mockTask = createMockTask()
			const callbacks = createMockCallbacks()

			await readFileTool.execute({ files: [] } as any, mockTask as any, callbacks)

			expect(mockTask.consecutiveMistakeCount).toBe(1)
			expect(mockTask.recordToolError).toHaveBeenCalledWith("read_file")
			expect(callbacks.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("Error:"))
		})

		it("should handle multiple files in legacy format", async () => {
			const mockTask = createMockTask()
			const callbacks = createMockCallbacks()

			mockTask.ask.mockResolvedValue({ response: "yesButtonClicked", text: undefined, images: undefined })
			mockedFsReadFile.mockResolvedValueOnce(Buffer.from("file1 content"))
			mockedFsReadFile.mockResolvedValueOnce(Buffer.from("file2 content"))

			// Override readWithSlice to return content that reflects the actual file data
			mockedReadWithSlice
				.mockReturnValueOnce({
					content: "1 | file1 content",
					returnedLines: 1,
					totalLines: 1,
					wasTruncated: false,
					includedRanges: [[1, 1]],
				})
				.mockReturnValueOnce({
					content: "1 | file2 content",
					returnedLines: 1,
					totalLines: 1,
					wasTruncated: false,
					includedRanges: [[1, 1]],
				})

			await readFileTool.execute(
				{ files: [{ path: "file1.ts" }, { path: "file2.ts" }] } as any,
				mockTask as any,
				callbacks,
			)

			expect(callbacks.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("file1 content"))
			expect(callbacks.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("file2 content"))
		})

		it("should block rooignore-protected files in legacy format", async () => {
			const mockTask = createMockTask({ rooIgnoreAllowed: false })
			const callbacks = createMockCallbacks()

			await readFileTool.execute({ files: [{ path: "secret.env" }] } as any, mockTask as any, callbacks)

			expect(mockTask.say).toHaveBeenCalledWith("rooignore_error", "secret.env")
			expect(callbacks.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("blocked by the .rooignore"))
			// Consistent with the native path: a blocked file fails the tool turn.
			expect(mockTask.didToolFailInCurrentTurn).toBe(true)
		})

		it("should deny legacy file read when user clicks no", async () => {
			const mockTask = createMockTask()
			const callbacks = createMockCallbacks()

			mockTask.ask.mockResolvedValue({ response: "noButtonClicked", text: undefined, images: undefined })

			await readFileTool.execute({ files: [{ path: "protected.ts" }] } as any, mockTask as any, callbacks)

			expect(mockTask.didRejectTool).toBe(true)
			expect(callbacks.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("Denied by user"))
		})

		it("should handle directory path in legacy format", async () => {
			const mockTask = createMockTask()
			const callbacks = createMockCallbacks()

			mockTask.ask.mockResolvedValue({ response: "yesButtonClicked", text: undefined, images: undefined })
			mockedFsStat.mockResolvedValue({ isDirectory: () => true } as any)

			await readFileTool.execute({ files: [{ path: "src/utils" }] } as any, mockTask as any, callbacks)

			expect(callbacks.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("it is a directory"))
			// Consistent with the native path: a failed read fails the tool turn.
			expect(mockTask.didToolFailInCurrentTurn).toBe(true)
		})

		it("should handle line ranges in legacy format", async () => {
			const mockTask = createMockTask()
			const callbacks = createMockCallbacks()

			mockTask.ask.mockResolvedValue({ response: "yesButtonClicked", text: undefined, images: undefined })
			// fs.readFile with "utf8" encoding returns a string, not a Buffer
			mockedFsReadFile.mockResolvedValue("line1\nline2\nline3\nline4\nline5" as any)

			await readFileTool.execute(
				{ files: [{ path: "test.ts", lineRanges: [{ start: 2, end: 4 }] }] } as any,
				mockTask as any,
				callbacks,
			)

			expect(callbacks.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("2 | line2"))
			expect(callbacks.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("4 | line4"))
		})

		it("should handle binary image files in legacy format with image support", async () => {
			const mockTask = createMockTask({ supportsImages: true })
			const callbacks = createMockCallbacks()

			mockTask.ask.mockResolvedValue({ response: "yesButtonClicked", text: undefined, images: undefined })
			mockedIsBinaryFile.mockResolvedValue(true)
			mockedIsSupportedImageFormat.mockReturnValue(true)
			mockedValidateImageForProcessing.mockResolvedValue({
				isValid: true,
				sizeInMB: 0.5,
			})
			mockedProcessImageFile.mockResolvedValue({
				dataUrl: "data:image/png;base64,abc123",
				buffer: Buffer.from("test"),
				sizeInKB: 512,
				sizeInMB: 0.5,
				notice: "Image processed successfully",
			})

			await readFileTool.execute({ files: [{ path: "image.png" }] } as any, mockTask as any, callbacks)

			expect(callbacks.pushToolResult).toHaveBeenCalledWith(
				expect.stringContaining("Image file - content processed"),
			)
		})

		it("should handle binary image validation failure in legacy format", async () => {
			const mockTask = createMockTask({ supportsImages: true })
			const callbacks = createMockCallbacks()

			mockTask.ask.mockResolvedValue({ response: "yesButtonClicked", text: undefined, images: undefined })
			mockedIsBinaryFile.mockResolvedValue(true)
			mockedIsSupportedImageFormat.mockReturnValue(true)
			mockedValidateImageForProcessing.mockResolvedValue({
				isValid: false,
				reason: "size_limit",
				notice: "Image too large",
			})

			await readFileTool.execute({ files: [{ path: "large.png" }] } as any, mockTask as any, callbacks)

			expect(callbacks.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("Image too large"))
		})

		it("should handle unsupported binary files in legacy format", async () => {
			const mockTask = createMockTask()
			const callbacks = createMockCallbacks()

			mockTask.ask.mockResolvedValue({ response: "yesButtonClicked", text: undefined, images: undefined })
			mockedIsBinaryFile.mockResolvedValue(true)
			mockedIsSupportedImageFormat.mockReturnValue(false)

			await readFileTool.execute({ files: [{ path: "program.exe" }] } as any, mockTask as any, callbacks)

			expect(callbacks.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("Cannot read binary file"))
		})

		it("should handle file read errors in legacy format", async () => {
			const mockTask = createMockTask()
			const callbacks = createMockCallbacks()

			mockTask.ask.mockResolvedValue({ response: "yesButtonClicked", text: undefined, images: undefined })
			mockedFsReadFile.mockRejectedValue(new Error("ENOENT"))

			await readFileTool.execute({ files: [{ path: "missing.ts" }] } as any, mockTask as any, callbacks)

			expect(mockTask.say).toHaveBeenCalledWith("error", expect.stringContaining("Error reading file"))
			expect(callbacks.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("ENOENT"))
			// Consistent with the native path: a failed read fails the tool turn.
			expect(mockTask.didToolFailInCurrentTurn).toBe(true)
		})

		it("should handle user feedback on approval in legacy format", async () => {
			const mockTask = createMockTask()
			const callbacks = createMockCallbacks()

			mockTask.ask.mockResolvedValue({
				response: "yesButtonClicked",
				text: "Read carefully",
				images: undefined,
			})
			mockedFsReadFile.mockResolvedValue(Buffer.from("content"))

			await readFileTool.execute({ files: [{ path: "test.ts" }] } as any, mockTask as any, callbacks)

			expect(mockTask.say).toHaveBeenCalledWith("user_feedback", "Read carefully", undefined)
		})

		it("should handle user feedback on denial in legacy format", async () => {
			const mockTask = createMockTask()
			const callbacks = createMockCallbacks()

			mockTask.ask.mockResolvedValue({
				response: "noButtonClicked",
				text: "Not allowed",
				images: undefined,
			})

			await readFileTool.execute({ files: [{ path: "secret.ts" }] } as any, mockTask as any, callbacks)

			expect(mockTask.say).toHaveBeenCalledWith("user_feedback", "Not allowed", undefined)
		})

		it("should handle truncation in legacy format when no line ranges", async () => {
			const mockTask = createMockTask()
			const callbacks = createMockCallbacks()

			mockTask.ask.mockResolvedValue({ response: "yesButtonClicked", text: undefined, images: undefined })
			mockedFsReadFile.mockResolvedValue(Buffer.from("content"))
			mockedReadWithSlice.mockReturnValue({
				content: "1 | content",
				returnedLines: 100,
				totalLines: 5000,
				wasTruncated: true,
				includedRanges: [[1, 100]],
			})

			await readFileTool.execute({ files: [{ path: "large.ts" }] } as any, mockTask as any, callbacks)

			expect(callbacks.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("File truncated"))
		})

		it("should track file context in legacy format", async () => {
			const mockTask = createMockTask()
			const callbacks = createMockCallbacks()

			mockTask.ask.mockResolvedValue({ response: "yesButtonClicked", text: undefined, images: undefined })
			mockedFsReadFile.mockResolvedValue(Buffer.from("content"))

			await readFileTool.execute({ files: [{ path: "tracked.ts" }] } as any, mockTask as any, callbacks)

			expect(mockTask.fileContextTracker.trackFileContext).toHaveBeenCalledWith("tracked.ts", "read_tool")
		})
	})

	describe("handlePartial", () => {
		it.each([{}, { path: "" }, undefined])(
			"renders streamed native arguments before their path arrives: %j",
			async (nativeArgs) => {
				const mockTask = createMockTask()
				mockTask.cwd = path.resolve(mockTask.cwd)
				const streamedBlock = {
					type: "tool_use",
					name: "read_file",
					params: {},
					nativeArgs,
					partial: true,
				}

				// Streaming JSON is incomplete even though finalized native arguments require a path.
				await Reflect.apply(readFileTool.handlePartial, readFileTool, [mockTask, streamedBlock])

				expect(mockTask.ask).toHaveBeenCalledExactlyOnceWith(
					"tool",
					JSON.stringify({ tool: "readFile", path: "", isOutsideWorkspace: false }),
					true,
				)
				expect(mockedFsReadFile).not.toHaveBeenCalled()
				expect(mockedFsStat).not.toHaveBeenCalled()
				expect(mockedExtractTextFromFile).not.toHaveBeenCalled()
			},
		)

		it("renders incomplete legacy arguments without a file entry or outside-workspace warning", async () => {
			const mockTask = createMockTask()
			mockTask.cwd = path.resolve(mockTask.cwd)
			const block: ToolUse<"read_file"> = {
				type: "tool_use",
				name: "read_file",
				params: {},
				nativeArgs: { files: [], _legacyFormat: true },
				partial: true,
			}

			// This reader-boundary double omits Task fields unrelated to file reading.
			await readFileTool.handlePartial(mockTask as unknown as Task, block)

			expect(mockTask.ask).toHaveBeenCalledExactlyOnceWith(
				"tool",
				JSON.stringify({ tool: "readFile", path: "", isOutsideWorkspace: false }),
				true,
			)
			expect(mockedFsReadFile).not.toHaveBeenCalled()
			expect(mockedFsStat).not.toHaveBeenCalled()
			expect(mockedExtractTextFromFile).not.toHaveBeenCalled()
		})

		it.each(["src/app.ts", "src/файл.ts", "src/e\u0301-📚.ts"])(
			"should preserve partial display for %s",
			async (filePath) => {
				const mockTask = createMockTask()
				mockTask.cwd = path.resolve(mockTask.cwd)
				mockTask.ask.mockResolvedValue({ response: "yesButtonClicked", text: undefined, images: undefined })

				const block: ToolUse<"read_file"> = {
					type: "tool_use",
					name: "read_file",
					params: {},
					nativeArgs: { path: filePath },
					partial: true,
				}

				// This reader-boundary double omits Task fields unrelated to file reading.
				await readFileTool.handlePartial(mockTask as unknown as Task, block)

				expect(mockTask.ask).toHaveBeenCalledExactlyOnceWith(
					"tool",
					JSON.stringify({ tool: "readFile", path: filePath, isOutsideWorkspace: true }),
					true,
				)
			},
		)

		it("should handle partial display for legacy format", async () => {
			const mockTask = createMockTask()
			mockTask.ask.mockResolvedValue({ response: "yesButtonClicked", text: undefined, images: undefined })

			const block = {
				nativeArgs: { files: [{ path: "legacy.ts" }] },
				partial: false,
			}

			await readFileTool.handlePartial(mockTask as any, block as any)

			expect(mockTask.ask).toHaveBeenCalledWith("tool", expect.stringContaining("legacy.ts"), false)
		})

		it("should handle partial display with empty path", async () => {
			const mockTask = createMockTask()
			mockTask.ask.mockResolvedValue({ response: "yesButtonClicked", text: undefined, images: undefined })

			const block = {
				nativeArgs: { path: "" },
				partial: true,
			}

			await readFileTool.handlePartial(mockTask as any, block as any)

			expect(mockTask.ask).toHaveBeenCalled()
		})

		it("should handle partial display with no nativeArgs", async () => {
			const mockTask = createMockTask()
			mockTask.ask.mockResolvedValue({ response: "yesButtonClicked", text: undefined, images: undefined })

			const block = {
				nativeArgs: undefined,
				partial: true,
			}

			await readFileTool.handlePartial(mockTask as any, block as any)

			expect(mockTask.ask).toHaveBeenCalled()
		})

		it.each(["Cancelled", "superseded"])("should gracefully handle %s ask rejection in partial", async (reason) => {
			const mockTask = createMockTask()
			mockTask.ask.mockRejectedValue(new Error(reason))

			const block = {
				nativeArgs: { path: "test.ts" },
				partial: true,
			}

			// Should not throw
			await readFileTool.handlePartial(mockTask as any, block as any)

			expect(mockTask.ask).toHaveBeenCalled()
		})
	})

	describe("processTextFile indentation mode edge cases", () => {
		beforeEach(() => {
			mockedIsBinaryFile.mockResolvedValue(false)
		})

		it("should use offset as fallback when anchor_line is not provided in indentation mode", async () => {
			const mockTask = createMockTask()
			const callbacks = createMockCallbacks()

			mockedFsReadFile.mockResolvedValue(Buffer.from("content"))
			mockedReadWithIndentation.mockReturnValue({
				content: "5 | line 5 content",
				returnedLines: 1,
				totalLines: 10,
				wasTruncated: false,
				includedRanges: [[5, 5]],
			})

			await readFileTool.execute(
				{
					path: "test.ts",
					mode: "indentation",
					offset: 5,
				} as any,
				mockTask as any,
				callbacks,
			)

			expect(mockedReadWithIndentation).toHaveBeenCalledWith(
				expect.any(String),
				expect.objectContaining({ anchorLine: 5 }),
			)
		})

		it("should default anchorLine to 1 when neither anchor_line nor offset in indentation mode", async () => {
			const mockTask = createMockTask()
			const callbacks = createMockCallbacks()

			mockedFsReadFile.mockResolvedValue(Buffer.from("content"))
			mockedReadWithIndentation.mockReturnValue({
				content: "1 | first line",
				returnedLines: 1,
				totalLines: 10,
				wasTruncated: false,
				includedRanges: [[1, 1]],
			})

			await readFileTool.execute(
				{
					path: "test.ts",
					mode: "indentation",
				} as any,
				mockTask as any,
				callbacks,
			)

			expect(mockedReadWithIndentation).toHaveBeenCalledWith(
				expect.any(String),
				expect.objectContaining({ anchorLine: 1 }),
			)
		})

		it("should show truncation notice in indentation mode", async () => {
			const mockTask = createMockTask()
			const callbacks = createMockCallbacks()

			mockedFsReadFile.mockResolvedValue(Buffer.from("content"))
			mockedReadWithIndentation.mockReturnValue({
				content: "1 | truncated block",
				returnedLines: 50,
				totalLines: 200,
				wasTruncated: true,
				includedRanges: [[1, 50]],
			})

			await readFileTool.execute(
				{
					path: "test.ts",
					mode: "indentation",
					indentation: { anchor_line: 1 },
				},
				mockTask as any,
				callbacks,
			)

			expect(callbacks.pushToolResult).toHaveBeenCalledWith(textResultContaining("File content truncated"))
			expect(callbacks.pushToolResult).toHaveBeenCalledWith(textResultContaining("To read more"))
		})

		it("should include range information in indentation mode when not truncated", async () => {
			const mockTask = createMockTask()
			const callbacks = createMockCallbacks()

			mockedFsReadFile.mockResolvedValue(Buffer.from("content"))
			mockedReadWithIndentation.mockReturnValue({
				content: "5 | function foo() { ... }",
				returnedLines: 10,
				totalLines: 100,
				wasTruncated: false,
				includedRanges: [[5, 14]],
			})

			await readFileTool.execute(
				{
					path: "test.ts",
					mode: "indentation",
					indentation: { anchor_line: 5 },
				},
				mockTask as any,
				callbacks,
			)

			expect(callbacks.pushToolResult).toHaveBeenCalledWith(textResultContaining("Included ranges: 5-14"))
		})

		it("should pass all indentation options to readWithIndentation", async () => {
			const mockTask = createMockTask()
			const callbacks = createMockCallbacks()

			mockedFsReadFile.mockResolvedValue(Buffer.from("content"))
			mockedReadWithIndentation.mockReturnValue({
				content: "result",
				returnedLines: 1,
				totalLines: 1,
				wasTruncated: false,
				includedRanges: [[1, 1]],
			})

			await readFileTool.execute(
				{
					path: "test.ts",
					mode: "indentation",
					indentation: {
						anchor_line: 10,
						max_levels: 2,
						include_siblings: true,
						include_header: false,
						max_lines: 200,
					},
					limit: 500,
				},
				mockTask as any,
				callbacks,
			)

			expect(mockedReadWithIndentation).toHaveBeenCalledWith(
				expect.any(String),
				expect.objectContaining({
					anchorLine: 10,
					maxLevels: 2,
					includeSiblings: true,
					includeHeader: false,
					limit: 500,
					maxLines: 200,
				}),
			)
		})
	})

	describe("slice mode edge cases", () => {
		beforeEach(() => {
			mockedIsBinaryFile.mockResolvedValue(false)
		})

		it("should convert 1-based offset to 0-based for readWithSlice", async () => {
			const mockTask = createMockTask()
			const callbacks = createMockCallbacks()

			mockedFsReadFile.mockResolvedValue(Buffer.from("line1\nline2\nline3"))
			mockedReadWithSlice.mockReturnValue({
				content: "4 | line4",
				returnedLines: 1,
				totalLines: 10,
				wasTruncated: false,
				includedRanges: [[4, 4]],
			})

			await readFileTool.execute(
				{ path: "test.ts", mode: "slice", offset: 4, limit: 1 },
				mockTask as any,
				callbacks,
			)

			// offset=4 (1-based) should become 3 (0-based) passed to readWithSlice
			expect(mockedReadWithSlice).toHaveBeenCalledWith(expect.any(String), 3, 1)
		})

		it("should use default offset of 1 when not specified", async () => {
			const mockTask = createMockTask()
			const callbacks = createMockCallbacks()

			mockedFsReadFile.mockResolvedValue(Buffer.from("content"))
			mockedReadWithSlice.mockReturnValue({
				content: "1 | content",
				returnedLines: 1,
				totalLines: 1,
				wasTruncated: false,
				includedRanges: [[1, 1]],
			})

			await readFileTool.execute({ path: "test.ts" }, mockTask as any, callbacks)

			// Default offset=1 -> 0-based = 0
			expect(mockedReadWithSlice).toHaveBeenCalledWith(expect.any(String), 0, expect.any(Number))
		})

		it("should use default limit when not specified", async () => {
			const mockTask = createMockTask()
			const callbacks = createMockCallbacks()

			mockedFsReadFile.mockResolvedValue(Buffer.from("content"))
			mockedReadWithSlice.mockReturnValue({
				content: "1 | content",
				returnedLines: 1,
				totalLines: 1,
				wasTruncated: false,
				includedRanges: [[1, 1]],
			})

			await readFileTool.execute({ path: "test.ts" }, mockTask as any, callbacks)

			// Should use DEFAULT_LINE_LIMIT (which is typically 2000)
			expect(mockedReadWithSlice).toHaveBeenCalledWith(expect.any(String), expect.any(Number), expect.any(Number))
		})

		it("should show correct line range in truncation notice", async () => {
			const mockTask = createMockTask()
			const callbacks = createMockCallbacks()

			mockedFsReadFile.mockResolvedValue(Buffer.from("lots of content"))
			mockedReadWithSlice.mockReturnValue({
				content: "5 | partial",
				returnedLines: 100,
				totalLines: 500,
				wasTruncated: true,
				includedRanges: [[5, 104]],
			})

			await readFileTool.execute({ path: "test.ts", offset: 5, limit: 100 }, mockTask as any, callbacks)

			expect(callbacks.pushToolResult).toHaveBeenCalledWith(textResultContaining("Showing lines 5-104"))
		})
	})

	describe("getLineSnippet and getStartLine", () => {
		beforeEach(() => {
			mockedIsBinaryFile.mockResolvedValue(false)
		})

		it("should show indentation mode snippet in approval message", async () => {
			const mockTask = createMockTask()
			const callbacks = createMockCallbacks()

			mockedFsReadFile.mockResolvedValue(Buffer.from("content"))
			mockedReadWithIndentation.mockReturnValue({
				content: "result",
				returnedLines: 1,
				totalLines: 1,
				wasTruncated: false,
				includedRanges: [[1, 1]],
			})

			await readFileTool.execute(
				{
					path: "test.ts",
					mode: "indentation",
					indentation: { anchor_line: 42 },
				},
				mockTask as any,
				callbacks,
			)

			// The approval message should contain the indentation mode info
			const askCall = mockTask.ask.mock.calls[0]
			const message = JSON.parse(askCall[1])
			expect(message.reason).toContain("indentation mode at line 42")
		})

		it("should show line range in approval when offset > 1", async () => {
			const mockTask = createMockTask()
			const callbacks = createMockCallbacks()

			mockedFsReadFile.mockResolvedValue(Buffer.from("content"))
			mockedReadWithSlice.mockReturnValue({
				content: "result",
				returnedLines: 1,
				totalLines: 1,
				wasTruncated: false,
				includedRanges: [[1, 1]],
			})

			await readFileTool.execute({ path: "test.ts", offset: 10, limit: 50 }, mockTask as any, callbacks)

			const askCall = mockTask.ask.mock.calls[0]
			const message = JSON.parse(askCall[1])
			expect(message.reason).toContain("lines 10-59")
			expect(message.startLine).toBe(10)
		})

		it("should show up to N lines in approval when offset is default", async () => {
			const mockTask = createMockTask()
			const callbacks = createMockCallbacks()

			mockedFsReadFile.mockResolvedValue(Buffer.from("content"))
			mockedReadWithSlice.mockReturnValue({
				content: "result",
				returnedLines: 1,
				totalLines: 1,
				wasTruncated: false,
				includedRanges: [[1, 1]],
			})

			await readFileTool.execute({ path: "test.ts" }, mockTask as any, callbacks)

			const askCall = mockTask.ask.mock.calls[0]
			const message = JSON.parse(askCall[1])
			expect(message.reason).toContain("up to")
			expect(message.reason).toContain("lines")
			expect(message.startLine).toBeUndefined()
		})

		it("should show indentation mode snippet with offset fallback", async () => {
			const mockTask = createMockTask()
			const callbacks = createMockCallbacks()

			mockedFsReadFile.mockResolvedValue(Buffer.from("content"))
			mockedReadWithIndentation.mockReturnValue({
				content: "result",
				returnedLines: 1,
				totalLines: 1,
				wasTruncated: false,
				includedRanges: [[1, 1]],
			})

			await readFileTool.execute(
				{
					path: "test.ts",
					mode: "indentation",
					offset: 7,
				} as any,
				mockTask as any,
				callbacks,
			)

			const askCall = mockTask.ask.mock.calls[0]
			const message = JSON.parse(askCall[1])
			expect(message.reason).toContain("indentation mode at line 7")
		})
	})

	describe("provider state handling", () => {
		it("should use default image limits when state is null", async () => {
			const mockTask = createMockTask({ supportsImages: true })
			const callbacks = createMockCallbacks()
			mockTask.providerRef.deref.mockReturnValue(null)
			mockedIsBinaryFile.mockResolvedValue(true)
			mockedIsSupportedImageFormat.mockReturnValue(true)
			mockedValidateImageForProcessing.mockResolvedValue({
				isValid: false,
				notice: "Default image limits applied",
			})

			// This reader-boundary double omits Task fields unrelated to file reading.
			await readFileTool.execute({ path: "image.png" }, mockTask as unknown as Task, callbacks)

			expect(mockedValidateImageForProcessing).toHaveBeenCalledExactlyOnceWith(
				path.resolve(mockTask.cwd, "image.png"),
				true,
				DEFAULT_MAX_IMAGE_FILE_SIZE_MB,
				DEFAULT_MAX_TOTAL_IMAGE_SIZE_MB,
				0,
				expect.any(Object),
			)
			expect(callbacks.pushToolResult).toHaveBeenCalledExactlyOnceWith([
				{ type: "text", text: "File: image.png\nNote: Default image limits applied" },
			])
			expect(mockedProcessImageFile).not.toHaveBeenCalled()
		})

		it("uses safe image defaults when provider config and model capability are unset", async () => {
			const mockTask = createMockTask()
			const callbacks = createMockCallbacks()
			mockTask.api.getModel.mockReturnValue({ info: {} })
			mockTask.providerRef.deref.mockReturnValue({
				getState: vi.fn().mockResolvedValue({}),
			})
			mockedIsBinaryFile.mockResolvedValue(true)
			mockedIsSupportedImageFormat.mockReturnValue(true)
			mockedValidateImageForProcessing.mockResolvedValue({
				isValid: false,
				notice: "Model lacks image capability",
			})

			// This reader-boundary double omits Task fields unrelated to file reading.
			await readFileTool.execute({ path: "image.png" }, mockTask as unknown as Task, callbacks)

			expect(mockedValidateImageForProcessing).toHaveBeenCalledExactlyOnceWith(
				path.resolve(mockTask.cwd, "image.png"),
				false,
				DEFAULT_MAX_IMAGE_FILE_SIZE_MB,
				DEFAULT_MAX_TOTAL_IMAGE_SIZE_MB,
				0,
				expect.any(Object),
			)
			expect(callbacks.pushToolResult).toHaveBeenCalledExactlyOnceWith([
				{ type: "text", text: "File: image.png\nNote: Model lacks image capability" },
			])
			expect(mockedProcessImageFile).not.toHaveBeenCalled()
		})
	})

	describe("error handling edge cases", () => {
		it("returns structured range errors and marks the tool turn as failed", async () => {
			const mockTask = createMockTask()
			const callbacks = createMockCallbacks()
			mockedReadWithSlice.mockReturnValue({
				content: "Error: offset 99 is beyond file end (2 lines)",
				returnedLines: 0,
				totalLines: 2,
				wasTruncated: false,
				includedRanges: [],
			})
			// Task lifecycle fields are irrelevant to this reader-boundary double.
			await readFileTool.execute({ path: "test.ts", offset: 100 }, mockTask as unknown as Task, callbacks)
			expect(mockTask.didToolFailInCurrentTurn).toBe(true)
			expect(callbacks.pushToolResult).toHaveBeenCalledWith([
				{ type: "text", text: "File: test.ts\nError: offset 99 is beyond file end (2 lines)" },
			])
			expect(mockTask.fileContextTracker.trackFileContext).not.toHaveBeenCalled()
		})

		it("should handle unknown error types (non-Error)", async () => {
			const mockTask = createMockTask()
			const callbacks = createMockCallbacks()

			mockedFsStat.mockRejectedValue("string error")

			await readFileTool.execute({ path: "test.ts" }, mockTask as any, callbacks)

			expect(mockTask.didToolFailInCurrentTurn).toBe(true)
			expect(callbacks.pushToolResult).toHaveBeenCalledWith(textResultContaining("Error"))
		})

		it("should set didToolFailInCurrentTurn on rooignore block", async () => {
			const mockTask = createMockTask({ rooIgnoreAllowed: false })
			const callbacks = createMockCallbacks()

			await readFileTool.execute({ path: "blocked.ts" }, mockTask as any, callbacks)

			expect(mockTask.didToolFailInCurrentTurn).toBe(true)
		})

		it("should set didToolFailInCurrentTurn on directory read", async () => {
			const mockTask = createMockTask()
			const callbacks = createMockCallbacks()

			mockedFsStat.mockResolvedValue({ isDirectory: () => true } as any)

			await readFileTool.execute({ path: "src/" }, mockTask as any, callbacks)

			expect(mockTask.didToolFailInCurrentTurn).toBe(true)
		})
	})
})
