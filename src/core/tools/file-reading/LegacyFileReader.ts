import path from "path"
import type { FileHandle } from "fs/promises"
import { isBinaryFile } from "isbinaryfile"
import type { ClineSayTool, FileEntry, LineRange } from "@roo-code/types"
import type { Task } from "../../task/Task"
import { formatResponse } from "../../prompts/responses"
import { DEFAULT_LINE_LIMIT } from "./readFileConstants"
import { getReadablePath } from "../../../utils/path"
import { readWithSlice } from "../../../integrations/misc/indentation-reader"
import { ReadFileTarget } from "./ReadFileTarget"
import {
	DEFAULT_MAX_IMAGE_FILE_SIZE_MB,
	DEFAULT_MAX_TOTAL_IMAGE_SIZE_MB,
	isSupportedImageFormat,
	validateImageForProcessing,
	processImageFile,
} from "../helpers/imageHelpers"

/** Compatibility-only reader. Do not use it for advertised native batches. */
export class LegacyFileReader {
	async read(entries: FileEntry[], task: Task): Promise<string> {
		const supportsImages = task.api.getModel().info.supportsImages ?? false
		const results: string[] = []
		for (const entry of entries) {
			const result = await this.readLegacyEntry(entry, task, supportsImages)
			results.push(result)
		}
		return results.join("\n\n---\n\n")
	}

	private async readLegacyEntry(entry: FileEntry, task: Task, supportsImages: boolean): Promise<string> {
		const relPath = entry.path
		if (!task.rooIgnoreController?.validateAccess(relPath)) {
			await task.say("rooignore_error", relPath)
			task.didToolFailInCurrentTurn = true
			return `File: ${relPath}\nError: ${formatResponse.rooIgnoreError(relPath)}`
		}
		let target: ReadFileTarget
		try {
			target = await ReadFileTarget.resolve(path.resolve(task.cwd, relPath))
		} catch (error) {
			return this.reportLegacyReadError(relPath, task, error)
		}
		if (!task.rooIgnoreController?.validateAccess(target.fullPath)) {
			await task.say("rooignore_error", relPath)
			task.didToolFailInCurrentTurn = true
			return `File: ${relPath}\nError: ${formatResponse.rooIgnoreError(relPath)}`
		}
		if (!(await this.approveLegacyFile(entry, task, target.fullPath)))
			return `File: ${relPath}\nStatus: Denied by user`
		try {
			return await target.withHandle(async (file, stats) => {
				if (stats.isDirectory()) {
					return await this.reportLegacyReadError(
						relPath,
						task,
						`Cannot read '${relPath}' because it is a directory.`,
					)
				}
				if (await this.detectLegacyBinary(file)) {
					return await this.readLegacyBinary(relPath, target.fullPath, task, supportsImages, file)
				}
				const content = this.formatLegacyText(await file.readFile("utf8"), entry.lineRanges)
				return await this.trackLegacyResult(relPath, `File: ${relPath}\n${content}`, task)
			})
		} catch (error) {
			return this.reportLegacyReadError(relPath, task, error)
		}
	}

	private async approveLegacyFile(entry: FileEntry, task: Task, fullPath: string): Promise<boolean> {
		const reason = entry.lineRanges?.map((range) => `(lines ${range.start}-${range.end})`).join(", ")
		const message = JSON.stringify({
			tool: "readFile",
			path: getReadablePath(task.cwd, fullPath),
			isOutsideWorkspace: await ReadFileTarget.isOutsideWorkspace(fullPath),
			content: fullPath,
			reason: reason || undefined,
		} satisfies ClineSayTool)
		const { response, text, images } = await task.ask("tool", message, false)
		if (text) await task.say("user_feedback", text, images)
		if (response === "yesButtonClicked") return true
		task.didRejectTool = true
		return false
	}

	private async detectLegacyBinary(file: FileHandle): Promise<boolean> {
		try {
			const sample = Buffer.alloc(512)
			const { bytesRead } = await file.read(sample, 0, sample.length, 0)
			return await isBinaryFile(sample.subarray(0, bytesRead), bytesRead)
		} catch {
			return false
		}
	}

	private async readLegacyBinary(
		relPath: string,
		fullPath: string,
		task: Task,
		supportsImages: boolean,
		file: FileHandle,
	): Promise<string> {
		if (!supportsImages || !isSupportedImageFormat(path.extname(relPath).toLowerCase())) {
			return `File: ${relPath}\nError: Cannot read binary file`
		}
		const state = await task.providerRef.deref()?.getState()
		const validation = await validateImageForProcessing(
			fullPath,
			supportsImages,
			state?.maxImageFileSize ?? DEFAULT_MAX_IMAGE_FILE_SIZE_MB,
			state?.maxTotalImageSize ?? DEFAULT_MAX_TOTAL_IMAGE_SIZE_MB,
			0, // Preserve the historical non-cumulative image validation contract.
			file,
		)
		if (!validation.isValid) return `File: ${relPath}\nNotice: ${validation.notice ?? "Image validation failed"}`
		await processImageFile(relPath, file)
		return `File: ${relPath}\n[Image file - content processed for vision model]`
	}

	private async reportLegacyReadError(relPath: string, task: Task, error: unknown): Promise<string> {
		const message = error instanceof Error ? error.message : String(error)
		await task.say("error", `Error reading file ${relPath}: ${message}`)
		task.didToolFailInCurrentTurn = true
		return `File: ${relPath}\nError: ${message}`
	}

	private async trackLegacyResult(relPath: string, content: string, task: Task): Promise<string> {
		try {
			await task.fileContextTracker.trackFileContext(relPath, "read_tool")
			return content
		} catch (error) {
			// Historically successful content was pushed before tracking, so retain it.
			return `${content}\n\n---\n\n${await this.reportLegacyReadError(relPath, task, error)}`
		}
	}

	private formatLegacyText(content: string, ranges?: LineRange[]): string {
		if (!ranges?.length) {
			const result = readWithSlice(content, 0, DEFAULT_LINE_LIMIT)
			const notice = result.wasTruncated
				? `\n\n[File truncated: showing ${result.returnedLines} of ${result.totalLines} total lines]`
				: ""
			return result.content + notice
		}
		const lines = content.split("\n")
		return ranges
			.flatMap((range) => {
				const selected: string[] = []
				const start = Math.max(0, range.start - 1)
				const end = Math.min(lines.length - 1, range.end - 1)
				for (let index = start; index <= end; index++) selected.push(`${index + 1} | ${lines[index]}`)
				return selected
			})
			.join("\n")
	}
}
