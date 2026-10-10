import path from "path"
import type { ReadFileParams } from "@roo-code/types"
import type { Task } from "../../task/Task"
import { ReadFileAccess } from "./ReadFileAccess"
import { ReadFileContentReader } from "./ReadFileContentReader"
import { ReadFileErrorReporter } from "./ReadFileErrorReporter"
import { ReadFileTarget } from "./ReadFileTarget"
import { isReadFileCancelled, throwIfReadFileCancelled } from "./readFileCancellation"
import { validateReadFileNumbers } from "./readFileValidation"
import type { FileResult, ReadEntryOptions } from "./types"

/** Shared modern reader. Approval belongs to each entry; callers own aggregation. */
export class ModernFileReader {
	constructor(
		private readonly errorReporter: ReadFileErrorReporter = new ReadFileErrorReporter(),
		private readonly access: ReadFileAccess = new ReadFileAccess(),
		private readonly contentReader: ReadFileContentReader = new ReadFileContentReader(errorReporter),
	) {}

	async read(params: ReadFileParams, task: Task, options: ReadEntryOptions = {}): Promise<FileResult> {
		let approval: FileResult | undefined
		const cancelled = (): FileResult => ({
			path: params.path,
			status: "cancelled",
			...(approval
				? {
						feedbackText: approval.feedbackText,
						feedbackImages: approval.feedbackImages,
						...(approval.approvalStatus ? { approvalStatus: approval.approvalStatus } : {}),
					}
				: {}),
		})
		try {
			if (isReadFileCancelled(task, options)) return cancelled()
			const validationError = validateReadFileNumbers(params)
			if (validationError) throw new Error(validationError)
			const blocked = await this.access.check(params.path, task)
			if (isReadFileCancelled(task, options)) return cancelled()
			if (blocked) return blocked
			const lexicalPath = path.resolve(task.cwd, params.path)
			const target = await ReadFileTarget.resolve(lexicalPath, () => throwIfReadFileCancelled(task, options))
			if (isReadFileCancelled(task, options)) return cancelled()
			const fullPath = target.fullPath
			const targetBlocked = await this.access.check(fullPath, task)
			if (isReadFileCancelled(task, options)) return cancelled()
			if (targetBlocked) return { ...targetBlocked, path: params.path }
			approval = await this.access.requestApproval(params, task, options, fullPath)
			if (approval.status === "approved") {
				approval = { ...approval, approvalStatus: approval.status }
			}
			if (isReadFileCancelled(task, options)) return cancelled()
			if (approval.status !== "approved") return approval
			const result = await this.contentReader.read(params, task, options, target)
			return {
				...approval,
				...(isReadFileCancelled(task, options) ? cancelled() : result),
			}
		} catch (error) {
			if (isReadFileCancelled(task, options)) return cancelled()
			task.didToolFailInCurrentTurn = true
			const result = await this.errorReporter.report(params.path || "unknown", task, error)
			if (isReadFileCancelled(task, options)) return cancelled()
			return approval ? { ...approval, ...result } : result
		}
	}
}
