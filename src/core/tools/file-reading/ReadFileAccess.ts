import path from "path"
import type { ReadFileParams, ClineSayTool } from "@roo-code/types"
import type { Task } from "../../task/Task"
import { AskIgnoredError } from "../../task/AskIgnoredError"
import { formatResponse } from "../../prompts/responses"
import { getReadablePath } from "../../../utils/path"
import { DEFAULT_LINE_LIMIT } from "./readFileConstants"
import { isReadFileCancelled } from "./readFileCancellation"
import { ReadFileTarget } from "./ReadFileTarget"
import type { FileResult, ReadEntryOptions } from "./types"

export class ReadFileAccess {
	async check(relPath: string, task: Task): Promise<FileResult | undefined> {
		if (task.rooIgnoreController?.validateAccess(relPath)) return undefined
		await task.say("rooignore_error", relPath)
		const error = formatResponse.rooIgnoreError(relPath)
		return { path: relPath, status: "blocked", error, nativeContent: `File: ${relPath}\nError: ${error}` }
	}

	async requestApproval(
		params: ReadFileParams,
		task: Task,
		options: ReadEntryOptions,
		fullPath = path.resolve(task.cwd, params.path),
	): Promise<FileResult> {
		const message = JSON.stringify({
			tool: "readFile",
			path: getReadablePath(task.cwd, fullPath),
			content: fullPath,
			isOutsideWorkspace: await ReadFileTarget.isOutsideWorkspace(fullPath),
			reason: this.getLineSnippet(params),
			startLine: this.getStartLine(params),
		} satisfies ClineSayTool)
		if (isReadFileCancelled(task, options)) return { path: params.path, status: "cancelled" }
		let approval: Awaited<ReturnType<Task["ask"]>>
		try {
			approval = await task.ask("tool", message, false)
		} catch (error) {
			// Withdrawn approvals cancel batches even before task flags propagate.
			if (isReadFileCancelled(task, options) || (options.textOnly && error instanceof AskIgnoredError)) {
				return { path: params.path, status: "cancelled" }
			}
			throw error
		}
		const { response, text, images } = approval
		const approvalStatus: NonNullable<FileResult["approvalStatus"]> =
			response === "yesButtonClicked" ? "approved" : "denied"
		if (isReadFileCancelled(task, options))
			return {
				path: params.path,
				status: "cancelled",
				approvalStatus,
				feedbackText: text,
				feedbackImages: images,
			}
		try {
			if (text) await task.say("user_feedback", text, images)
		} catch (error) {
			if (isReadFileCancelled(task, options))
				return {
					path: params.path,
					status: "cancelled",
					approvalStatus,
					feedbackText: text,
					feedbackImages: images,
				}
			throw error
		}
		if (isReadFileCancelled(task, options))
			return {
				path: params.path,
				status: "cancelled",
				approvalStatus,
				feedbackText: text,
				feedbackImages: images,
			}
		const feedback = {
			path: params.path,
			entry: params,
			approvalStatus,
			feedbackText: text,
			feedbackImages: images,
		}
		if (response === "yesButtonClicked") return { ...feedback, status: "approved" }
		task.didRejectTool = true
		return { ...feedback, status: "denied", nativeContent: `File: ${params.path}\nStatus: Denied by user` }
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
}
