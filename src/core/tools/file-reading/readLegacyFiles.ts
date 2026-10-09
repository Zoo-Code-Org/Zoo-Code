import path from "path"
import * as fs from "fs/promises"
import { isBinaryFile } from "isbinaryfile"
import type { ClineSayTool, FileEntry, LineRange } from "@roo-code/types"
import type { Task } from "../../task/Task"
import { formatResponse } from "../../prompts/responses"
import { DEFAULT_LINE_LIMIT } from "./readFileConstants"
import { getReadablePath } from "../../../utils/path"
import { isPathOutsideWorkspace } from "../../../utils/pathUtils"
import { readWithSlice } from "../../../integrations/misc/indentation-reader"
import {
	DEFAULT_MAX_IMAGE_FILE_SIZE_MB,
	DEFAULT_MAX_TOTAL_IMAGE_SIZE_MB,
	isSupportedImageFormat,
	validateImageForProcessing,
	processImageFile,
} from "../helpers/imageHelpers"

function formatLegacyText(content: string, ranges?: LineRange[]): string {
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

async function approveLegacyFile(entry: FileEntry, task: Task): Promise<boolean> {
	const fullPath = path.resolve(task.cwd, entry.path)
	const reason = entry.lineRanges?.map((range) => `(lines ${range.start}-${range.end})`).join(", ")
	const message = JSON.stringify({
		tool: "readFile",
		path: getReadablePath(task.cwd, entry.path),
		isOutsideWorkspace: isPathOutsideWorkspace(fullPath),
		content: fullPath,
		reason: reason || undefined,
	} satisfies ClineSayTool)
	const { response, text, images } = await task.ask("tool", message, false)
	if (text) await task.say("user_feedback", text, images)
	if (response === "yesButtonClicked") return true
	task.didRejectTool = true
	return false
}

async function detectLegacyBinary(fullPath: string): Promise<boolean> {
	try {
		return await isBinaryFile(fullPath)
	} catch {
		return false
	}
}

async function readLegacyBinary(
	relPath: string,
	fullPath: string,
	task: Task,
	supportsImages: boolean,
): Promise<string | undefined> {
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
	)
	if (!validation.isValid) return `File: ${relPath}\nNotice: ${validation.notice ?? "Image validation failed"}`
	const image = await processImageFile(fullPath)
	return image ? `File: ${relPath}\n[Image file - content processed for vision model]` : undefined
}

async function reportLegacyReadError(relPath: string, task: Task, error: unknown): Promise<string> {
	const message = error instanceof Error ? error.message : String(error)
	await task.say("error", `Error reading file ${relPath}: ${message}`)
	task.didToolFailInCurrentTurn = true
	return `File: ${relPath}\nError: ${message}`
}

async function trackLegacyResult(relPath: string, content: string, task: Task): Promise<string> {
	try {
		await task.fileContextTracker.trackFileContext(relPath, "read_tool")
		return content
	} catch (error) {
		// Historically successful content was pushed before tracking, so retain it.
		return `${content}\n\n---\n\n${await reportLegacyReadError(relPath, task, error)}`
	}
}

async function readLegacyEntry(entry: FileEntry, task: Task, supportsImages: boolean): Promise<string | undefined> {
	const relPath = entry.path
	if (!task.rooIgnoreController?.validateAccess(relPath)) {
		await task.say("rooignore_error", relPath)
		task.didToolFailInCurrentTurn = true
		return `File: ${relPath}\nError: ${formatResponse.rooIgnoreError(relPath)}`
	}
	if (!(await approveLegacyFile(entry, task))) return `File: ${relPath}\nStatus: Denied by user`
	const fullPath = path.resolve(task.cwd, relPath)
	try {
		const stats = await fs.stat(fullPath)
		if (stats.isDirectory()) {
			return await reportLegacyReadError(relPath, task, `Cannot read '${relPath}' because it is a directory.`)
		}
		if (await detectLegacyBinary(fullPath)) return await readLegacyBinary(relPath, fullPath, task, supportsImages)
		const content = formatLegacyText(await fs.readFile(fullPath, "utf8"), entry.lineRanges)
		return await trackLegacyResult(relPath, `File: ${relPath}\n${content}`, task)
	} catch (error) {
		return reportLegacyReadError(relPath, task, error)
	}
}

/** Compatibility-only reader. Do not use it for advertised native batches. */
export async function readLegacyFiles(entries: FileEntry[], task: Task): Promise<string> {
	const supportsImages = task.api.getModel().info.supportsImages ?? false
	const results: string[] = []
	for (const entry of entries) {
		const result = await readLegacyEntry(entry, task, supportsImages)
		if (result !== undefined) results.push(result)
	}
	return results.join("\n\n---\n\n")
}
