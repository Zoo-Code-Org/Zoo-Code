/** Modern single-file reading, with a separate legacy conversation adapter. */
import path from "path"
import * as fs from "fs/promises"
import { isBinaryFile } from "isbinaryfile"
import type { ReadFileParams, ReadFileToolParams, ClineSayTool } from "@roo-code/types"
import { isLegacyReadFileParams } from "@roo-code/types"
import type { Task } from "../../task/Task"
import { formatResponse } from "../../prompts/responses"
import { isPathOutsideWorkspace } from "../../../utils/pathUtils"
import { getReadablePath } from "../../../utils/path"
import { extractTextFromFile, addLineNumbers, getSupportedBinaryFormats } from "../../../integrations/misc/extract-text"
import { DEFAULT_LINE_LIMIT } from "./readFileConstants"
import type { ToolUse } from "../../../shared/tools"
import {
	DEFAULT_MAX_IMAGE_FILE_SIZE_MB,
	DEFAULT_MAX_TOTAL_IMAGE_SIZE_MB,
	isSupportedImageFormat,
	validateImageForProcessing,
	processImageFile,
	ImageMemoryTracker,
} from "../helpers/imageHelpers"
import { processReadFileText, hasClippedReadFileLines } from "./readFileText"
import { formatReadFileResults } from "./readFileResults"
import { readLegacyFiles } from "./readLegacyFiles"
import { BaseTool, type ToolCallbacks } from "../BaseTool"

export interface FileResult {
	path: string
	status: "approved" | "denied" | "blocked" | "error" | "pending" | "cancelled" | "unsupported"
	content?: string
	error?: string
	notice?: string
	nativeContent?: string
	imageDataUrl?: string
	feedbackText?: string
	feedbackImages?: string[]
	longLinesTruncated?: boolean
	entry?: ReadFileParams
}

interface ReadEntryOptions {
	textOnly?: boolean
}

interface ReadErrorContext {
	prefix?: string
	action?: string
}

export class ReadFileTool extends BaseTool<"read_file"> {
	readonly name = "read_file" as const

	async execute(params: ReadFileToolParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		if (isLegacyReadFileParams(params)) {
			if (await this.reportMissingParameter(!params.files?.length, "files", task, callbacks)) return
			callbacks.pushToolResult(await readLegacyFiles(params.files, task))
			return
		}
		if (await this.reportMissingParameter(!params.path, "path", task, callbacks)) return
		const validationError = this.validateLineNumbers(params)
		if (validationError) {
			callbacks.pushToolResult(`Error: ${validationError}`)
			return
		}
		const result = await this.readEntry(params, task)
		if (result.status === "error" || result.status === "blocked") task.didToolFailInCurrentTurn = true
		callbacks.pushToolResult(
			formatReadFileResults([result], task.didRejectTool, task.api.getModel().info.supportsImages ?? false),
		)
	}

	private async reportMissingParameter(
		missing: boolean,
		parameter: "path" | "files",
		task: Task,
		callbacks: ToolCallbacks,
	): Promise<boolean> {
		if (!missing) return false
		task.consecutiveMistakeCount++
		task.recordToolError(this.name)
		callbacks.pushToolResult(`Error: ${await task.sayAndCreateMissingParamError(this.name, parameter)}`)
		return true
	}

	private validateLineNumbers(params: ReadFileParams): string | undefined {
		if (params.offset !== undefined && params.offset < 1) {
			return `offset must be a 1-indexed line number (got ${params.offset}). Line numbers start at 1.`
		}
		if (params.indentation?.anchor_line !== undefined && params.indentation.anchor_line < 1) {
			return `anchor_line must be a 1-indexed line number (got ${params.indentation.anchor_line}). Line numbers start at 1.`
		}
		return undefined
	}

	/** Shared modern reader. Approval belongs to each entry; callers own aggregation. */
	async readEntry(params: ReadFileParams, task: Task, options: ReadEntryOptions = {}): Promise<FileResult> {
		try {
			const blocked = await this.checkAccess(params.path, task)
			if (this.isCancelled(task, options)) return { path: params.path, status: "cancelled" }
			if (blocked) return blocked
			const approval = await this.requestEntryApproval(params, task, options)
			if (approval.status !== "approved") return approval
			if (this.isCancelled(task, options)) return { path: params.path, status: "cancelled" }
			return { ...approval, ...(await this.readApprovedEntry(params, task, options)) }
		} catch (error) {
			if (this.isCancelled(task, options)) return { path: params.path, status: "cancelled" }
			task.didToolFailInCurrentTurn = true
			return this.reportReadError(params.path || "unknown", task, error)
		}
	}

	private isCancelled(task: Task, options: ReadEntryOptions): boolean {
		return options.textOnly === true && (task.abort || task.abandoned)
	}

	private async checkAccess(relPath: string, task: Task): Promise<FileResult | undefined> {
		if (task.rooIgnoreController?.validateAccess(relPath)) return undefined
		await task.say("rooignore_error", relPath)
		const error = formatResponse.rooIgnoreError(relPath)
		return { path: relPath, status: "blocked", error, nativeContent: `File: ${relPath}\nError: ${error}` }
	}

	private async requestEntryApproval(
		params: ReadFileParams,
		task: Task,
		options: ReadEntryOptions,
	): Promise<FileResult> {
		const fullPath = path.resolve(task.cwd, params.path)
		const message = JSON.stringify({
			tool: "readFile",
			path: getReadablePath(task.cwd, params.path),
			content: fullPath,
			isOutsideWorkspace: isPathOutsideWorkspace(fullPath),
			reason: this.getLineSnippet(params),
			startLine: this.getStartLine(params),
		} satisfies ClineSayTool)
		try {
			const { response, text, images } = await task.ask("tool", message, false)
			if (text) await task.say("user_feedback", text, images)
			const feedback = { path: params.path, entry: params, feedbackText: text, feedbackImages: images }
			if (response === "yesButtonClicked") return { ...feedback, status: "approved" }
			task.didRejectTool = true
			return { ...feedback, status: "denied", nativeContent: `File: ${params.path}\nStatus: Denied by user` }
		} catch (error) {
			// Withdrawn approvals cancel batches even before task flags propagate.
			if (options.textOnly) return { path: params.path, status: "cancelled" }
			throw error
		}
	}

	private async readApprovedEntry(
		params: ReadFileParams,
		task: Task,
		options: ReadEntryOptions,
	): Promise<FileResult> {
		try {
			const fullPath = path.resolve(task.cwd, params.path)
			const stats = await fs.stat(fullPath)
			if (stats.isDirectory()) {
				return this.reportReadError(
					params.path,
					task,
					`Cannot read '${params.path}' because it is a directory. Use list_files tool instead.`,
					{ prefix: "" },
				)
			}
			if (this.isCancelled(task, options)) return { path: params.path, status: "cancelled" }
			const extension = path.extname(params.path).toLowerCase()
			if (options.textOnly && isSupportedImageFormat(extension)) {
				return {
					path: params.path,
					status: "unsupported",
					error: "Batch images are not supported; use read_file.",
				}
			}
			const binary = await isBinaryFile(fullPath)
			if (this.isCancelled(task, options)) return { path: params.path, status: "cancelled" }
			if (options.textOnly) return await this.readTextOnlyEntry(params, task, fullPath, binary, options)
			if (binary) return await this.readBinaryEntry(params.path, task, fullPath, extension)
			return await this.readTextEntry(params, task, fullPath, false, options)
		} catch (error) {
			return this.reportReadError(params.path, task, error)
		}
	}

	private async readTextOnlyEntry(
		params: ReadFileParams,
		task: Task,
		fullPath: string,
		binary: boolean,
		options: ReadEntryOptions,
	): Promise<FileResult> {
		const extract = getSupportedBinaryFormats().includes(path.extname(params.path).toLowerCase())
		if (binary && !extract) {
			return {
				path: params.path,
				status: "unsupported",
				error: "Unsupported batch binary format; use read_file.",
			}
		}
		return this.readTextEntry(params, task, fullPath, extract, options)
	}

	private async readTextEntry(
		params: ReadFileParams,
		task: Task,
		fullPath: string,
		extract: boolean,
		options: ReadEntryOptions,
	): Promise<FileResult> {
		// Buffer decoding deliberately tolerates non-UTF8 bytes, as before.
		const content = extract ? await extractTextFromFile(fullPath) : (await fs.readFile(fullPath)).toString("utf-8")
		if (this.isCancelled(task, options)) return { path: params.path, status: "cancelled" }
		const text = processReadFileText(content, params)
		if (text.startsWith("Error:")) {
			return { path: params.path, status: "error", error: text, nativeContent: `File: ${params.path}\n${text}` }
		}
		await task.fileContextTracker.trackFileContext(params.path, "read_tool")
		return {
			path: params.path,
			status: "approved",
			nativeContent: `File: ${params.path}\n${text}`,
			longLinesTruncated: options.textOnly ? hasClippedReadFileLines(content, text) : undefined,
		}
	}

	private async readBinaryEntry(
		relPath: string,
		task: Task,
		fullPath: string,
		extension: string,
	): Promise<FileResult> {
		if (isSupportedImageFormat(extension)) return this.readImageEntry(relPath, task, fullPath)
		if (getSupportedBinaryFormats().includes(extension)) return this.readDocumentEntry(relPath, task, fullPath)
		const format = extension.slice(1) || "bin"
		return {
			path: relPath,
			status: "approved",
			notice: `Binary file format: ${format}`,
			nativeContent: `File: ${relPath}\nBinary file (${format}) - content not displayed`,
		}
	}

	private async readImageEntry(relPath: string, task: Task, fullPath: string): Promise<FileResult> {
		try {
			const state = await task.providerRef.deref()?.getState()
			const tracker = new ImageMemoryTracker()
			const validation = await validateImageForProcessing(
				fullPath,
				task.api.getModel().info.supportsImages ?? false,
				state?.maxImageFileSize ?? DEFAULT_MAX_IMAGE_FILE_SIZE_MB,
				state?.maxTotalImageSize ?? DEFAULT_MAX_TOTAL_IMAGE_SIZE_MB,
				tracker.getTotalMemoryUsed(),
			)
			if (!validation.isValid) {
				await task.fileContextTracker.trackFileContext(relPath, "read_tool")
				return {
					path: relPath,
					status: "approved",
					nativeContent: `File: ${relPath}\nNote: ${validation.notice}`,
				}
			}
			const image = await processImageFile(fullPath)
			tracker.addMemoryUsage(image.sizeInMB)
			await task.fileContextTracker.trackFileContext(relPath, "read_tool")
			return {
				path: relPath,
				status: "approved",
				nativeContent: `File: ${relPath}\nNote: ${image.notice}`,
				imageDataUrl: image.dataUrl,
			}
		} catch (error) {
			return this.reportReadError(relPath, task, error, {
				prefix: "Error reading image file: ",
				action: "Error reading image file",
			})
		}
	}

	private async readDocumentEntry(relPath: string, task: Task, fullPath: string): Promise<FileResult> {
		try {
			const content = await extractTextFromFile(fullPath)
			const numbered = addLineNumbers(content)
			const lineCount = content.split("\n").length
			await task.fileContextTracker.trackFileContext(relPath, "read_tool")
			return {
				path: relPath,
				status: "approved",
				nativeContent:
					lineCount > 0
						? `File: ${relPath}\nLines 1-${lineCount}:\n${numbered}`
						: `File: ${relPath}\nNote: File is empty`,
			}
		} catch (error) {
			return this.reportReadError(relPath, task, error, {
				prefix: "Error extracting text: ",
				action: "Error extracting text from",
			})
		}
	}

	private async reportReadError(
		relPath: string,
		task: Task,
		error: unknown,
		context: ReadErrorContext = {},
	): Promise<FileResult> {
		const message = error instanceof Error ? error.message : String(error)
		const { prefix = "Error reading file: ", action = "Error reading file" } = context
		await task.say("error", `${action} ${relPath}: ${message}`)
		return {
			path: relPath,
			status: "error",
			error: prefix + message,
			nativeContent: `File: ${relPath}\nError: ${message}`,
		}
	}

	private getStartLine(params: ReadFileParams): number | undefined {
		if (params.mode === "indentation") return params.indentation?.anchor_line ?? params.offset ?? 1
		const offset = params.offset ?? 1
		return offset > 1 ? offset : undefined
	}

	private getLineSnippet(params: ReadFileParams): string {
		if (params.mode === "indentation") return `(indentation mode at line ${this.getStartLine(params)})`
		const offset = params.offset ?? 1
		const limit = params.limit ?? DEFAULT_LINE_LIMIT
		return offset > 1 ? `(lines ${offset}-${offset + limit - 1})` : `(up to ${limit} lines)`
	}

	getReadFileToolDescription(blockName: string, params: { path?: string }): string
	getReadFileToolDescription(blockName: string, params: ReadFileToolParams): string
	getReadFileToolDescription(blockName: string, params: unknown): string {
		if (params && typeof params === "object" && "path" in params && params.path)
			return `[${blockName} for '${String(params.path)}']`
		return `[${blockName} with missing path]`
	}

	override async handlePartial(task: Task, block: ToolUse<"read_file">): Promise<void> {
		const args = block.nativeArgs
		const filePath = args ? (isLegacyReadFileParams(args) ? (args.files[0]?.path ?? "") : (args.path ?? "")) : ""
		const fullPath = filePath ? path.resolve(task.cwd, filePath) : ""
		const message = JSON.stringify({
			tool: "readFile",
			path: getReadablePath(task.cwd, filePath),
			isOutsideWorkspace: filePath ? isPathOutsideWorkspace(fullPath) : false,
		} satisfies ClineSayTool)
		try {
			await task.ask("tool", message, block.partial)
		} catch {
			/* Streaming asks may be replaced by a newer update. */
		}
	}
}
