import path from "path"
import { isBinaryFile } from "isbinaryfile"
import type { ReadFileParams } from "@roo-code/types"
import type { Task } from "../../task/Task"
import {
	DEFAULT_MAX_IMAGE_FILE_SIZE_MB,
	DEFAULT_MAX_TOTAL_IMAGE_SIZE_MB,
	isSupportedImageFormat,
} from "../helpers/imageHelpers"
import { ReadFileErrorReporter } from "./ReadFileErrorReporter"
import { ReadFileTextReader } from "./strategies/ReadFileTextReader"
import { ReadFileBinaryReader } from "./strategies/ReadFileBinaryReader"
import { ReadFileImageReader } from "./strategies/ReadFileImageReader"
import { ReadFileDocumentReader } from "./strategies/ReadFileDocumentReader"
import { ReadFileTarget } from "./ReadFileTarget"
import type { ReadFileStrategy } from "./strategies/ReadFileStrategy"
import { ReadFileCancellation } from "./ReadFileCancellation"
import { ReadFileCancelledError } from "./ReadFileCancelledError"
import type { FileResult, ReadEntryOptions, ReadFileContext } from "./types"

export class ReadFileContentReader {
	constructor(
		private readonly errorReporter: ReadFileErrorReporter = new ReadFileErrorReporter(),
		private readonly strategies: readonly ReadFileStrategy[] = [
			new ReadFileTextReader(),
			new ReadFileImageReader(errorReporter),
			new ReadFileDocumentReader(errorReporter),
			new ReadFileBinaryReader(),
		],
	) {}

	async read(
		params: ReadFileParams,
		task: Task,
		options: ReadEntryOptions,
		target?: ReadFileTarget,
	): Promise<FileResult> {
		const cancellation = new ReadFileCancellation(task)
		try {
			if (cancellation.isCancelled()) return { path: params.path, status: "cancelled" }
			const state = await cancellation.run(async () => task.providerRef.deref()?.getState())
			const imageLimits = {
				maxImageFileSize: state?.maxImageFileSize ?? DEFAULT_MAX_IMAGE_FILE_SIZE_MB,
				maxTotalImageSize: state?.maxTotalImageSize ?? DEFAULT_MAX_TOTAL_IMAGE_SIZE_MB,
			}
			const resolved = target ?? (await ReadFileTarget.resolve(path.resolve(task.cwd, params.path), cancellation))
			const result = await resolved.withHandle<FileResult>(async (file, stats) => {
				const fullPath = resolved.fullPath
				cancellation.throwIfCancelled()
				if (stats.isDirectory()) {
					return cancellation.run(() =>
						this.errorReporter.report(
							params.path,
							task,
							`Cannot read '${params.path}' because it is a directory. Use list_files tool instead.`,
							{ prefix: "" },
						),
					)
				}
				const extension = path.extname(params.path).toLowerCase()
				if (options.textOnly && isSupportedImageFormat(extension)) {
					return {
						path: params.path,
						status: "unsupported",
						error: "Batch images are not supported; use read_file.",
					}
				}
				const sample = Buffer.alloc(512)
				const { bytesRead } = await cancellation.run(() => file.read(sample, 0, sample.length, 0))
				const binary = await cancellation.run(() => isBinaryFile(sample.subarray(0, bytesRead), bytesRead))
				const context: ReadFileContext = {
					params,
					task,
					fullPath,
					extension,
					binary,
					options,
					file,
					imageLimits,
				}
				const strategy = this.strategies.find((candidate) => candidate.canRead(context))
				if (!strategy) throw new Error(`No file-reading strategy supports '${params.path}'.`)
				return await cancellation.run(() => strategy.read(context))
			})
			// Cleanup may itself settle after cancellation; never deliver its late payload.
			return cancellation.isCancelled() ? { path: params.path, status: "cancelled" } : result
		} catch (error) {
			if (cancellation.isCancelled() || error instanceof ReadFileCancelledError)
				return { path: params.path, status: "cancelled" }
			return cancellation.run(() => this.errorReporter.report(params.path, task, error))
		}
	}
}
