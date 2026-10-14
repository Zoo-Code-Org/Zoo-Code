import path from "path"
import type { ReadFileParams } from "@roo-code/types"
import type { Task } from "../../task/Task"
import { ReadFileAccess } from "./ReadFileAccess"
import { ReadFileContentReader } from "./ReadFileContentReader"
import { ReadFileErrorReporter } from "./ReadFileErrorReporter"
import { ReadFileTarget } from "./ReadFileTarget"
import { ReadFileCancellation } from "./ReadFileCancellation"
import { ReadFileCancelledError } from "./ReadFileCancelledError"
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
		const cancellation = new ReadFileCancellation(task)
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
			if (cancellation.isCancelled()) return cancelled()
			const validationError = validateReadFileNumbers(params)
			if (validationError) throw new Error(validationError)
			const blocked = await cancellation.run(() => this.access.check(params.path, task))
			if (blocked) return blocked
			const lexicalPath = path.resolve(task.cwd, params.path)
			const target = await ReadFileTarget.resolve(lexicalPath, cancellation)
			const fullPath = target.fullPath
			const targetBlocked = await cancellation.run(() => this.access.check(fullPath, task, params.path))
			if (targetBlocked) return targetBlocked
			approval = await this.access.requestApproval(params, task, options, fullPath)
			if (approval.status === "approved") {
				approval = { ...approval, approvalStatus: approval.status }
			}
			if (cancellation.isCancelled()) return cancelled()
			if (approval.status !== "approved") return approval
			const result = await this.contentReader.read(params, task, options, target)
			return {
				...approval,
				...(cancellation.isCancelled() ? cancelled() : result),
			}
		} catch (error) {
			if (cancellation.isCancelled() || error instanceof ReadFileCancelledError) return cancelled()
			let result: FileResult
			try {
				result = await cancellation.run(() => this.errorReporter.report(params.path || "unknown", task, error))
			} catch (diagnosticError) {
				if (cancellation.isCancelled() || diagnosticError instanceof ReadFileCancelledError) return cancelled()
				throw diagnosticError
			}
			task.didToolFailInCurrentTurn = true
			return approval ? { ...approval, ...result } : result
		}
	}
}
