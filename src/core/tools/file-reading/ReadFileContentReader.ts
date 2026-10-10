import path from "path"
import { isBinaryFile } from "isbinaryfile"
import type { ReadFileParams } from "@roo-code/types"
import type { Task } from "../../task/Task"
import { isSupportedImageFormat } from "../helpers/imageHelpers"
import { ReadFileErrorReporter } from "./ReadFileErrorReporter"
import { ReadFileTextReader } from "./strategies/ReadFileTextReader"
import { ReadFileBinaryReader } from "./strategies/ReadFileBinaryReader"
import { ReadFileImageReader } from "./strategies/ReadFileImageReader"
import { ReadFileDocumentReader } from "./strategies/ReadFileDocumentReader"
import { ReadFileTarget } from "./ReadFileTarget"
import type { ReadFileStrategy } from "./strategies/ReadFileStrategy"
import { isReadFileCancelled, throwIfReadFileCancelled } from "./readFileCancellation"
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
		try {
			if (isReadFileCancelled(task, options)) return { path: params.path, status: "cancelled" }
			const resolved =
				target ??
				(await ReadFileTarget.resolve(path.resolve(task.cwd, params.path), () =>
					throwIfReadFileCancelled(task, options),
				))
			const result = await resolved.withHandle<FileResult>(
				async (file, stats) => {
					const fullPath = resolved.fullPath
					if (isReadFileCancelled(task, options)) return { path: params.path, status: "cancelled" }
					if (stats.isDirectory()) {
						return this.errorReporter.report(
							params.path,
							task,
							`Cannot read '${params.path}' because it is a directory. Use list_files tool instead.`,
							{ prefix: "" },
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
					const { bytesRead } = await file.read(sample, 0, sample.length, 0)
					if (isReadFileCancelled(task, options)) return { path: params.path, status: "cancelled" }
					const binary = await isBinaryFile(sample.subarray(0, bytesRead), bytesRead)
					if (isReadFileCancelled(task, options)) return { path: params.path, status: "cancelled" }
					const context: ReadFileContext = { params, task, fullPath, extension, binary, options, file }
					const strategy = this.strategies.find((candidate) => candidate.canRead(context))
					if (!strategy) throw new Error(`No file-reading strategy supports '${params.path}'.`)
					return await strategy.read(context)
				},
				() => throwIfReadFileCancelled(task, options),
			)
			// Cleanup may itself settle after cancellation; never deliver its late payload.
			return isReadFileCancelled(task, options) ? { path: params.path, status: "cancelled" } : result
		} catch (error) {
			if (isReadFileCancelled(task, options)) return { path: params.path, status: "cancelled" }
			return this.errorReporter.report(params.path, task, error)
		}
	}
}
