import { extractRawTextFromFile, getSupportedBinaryFormats } from "../../../../integrations/misc/extract-text"
import { isSupportedImageFormat } from "../../helpers/imageHelpers"
import { ReadFileErrorReporter } from "../ReadFileErrorReporter"
import { ReadFileTextProcessor } from "../ReadFileTextProcessor"
import { isReadFileCancelled } from "../readFileCancellation"
import type { FileResult, ReadFileContext } from "../types"
import { ReadFileStrategy } from "./ReadFileStrategy"

export class ReadFileDocumentReader extends ReadFileStrategy {
	constructor(
		private readonly errorReporter: ReadFileErrorReporter = new ReadFileErrorReporter(),
		private readonly textProcessor: ReadFileTextProcessor = new ReadFileTextProcessor(),
	) {
		super()
	}

	canRead({ binary, extension, options }: ReadFileContext): boolean {
		return (
			binary &&
			options.textOnly !== true &&
			!isSupportedImageFormat(extension) &&
			getSupportedBinaryFormats().includes(extension)
		)
	}

	async read({ params, task, fullPath, file, options }: ReadFileContext): Promise<FileResult> {
		const relPath = params.path
		try {
			const bytes = file ? await file.readFile() : undefined
			if (isReadFileCancelled(task, options)) return { path: relPath, status: "cancelled" }
			const content = file
				? await extractRawTextFromFile(params.path, bytes)
				: await extractRawTextFromFile(fullPath)
			if (isReadFileCancelled(task, options)) return { path: relPath, status: "cancelled" }
			const text = this.textProcessor.process(content, params)
			if (text.startsWith("Error:")) {
				return { path: relPath, status: "error", error: text, nativeContent: `File: ${relPath}\n${text}` }
			}
			await task.fileContextTracker.trackFileContext(relPath, "read_tool")
			return {
				path: relPath,
				status: "approved",
				nativeContent: `File: ${relPath}\n${content.length === 0 ? "Note: File is empty" : text}`,
			}
		} catch (error) {
			if (isReadFileCancelled(task, options)) return { path: relPath, status: "cancelled" }
			return this.errorReporter.report(relPath, task, error, {
				prefix: "Error extracting text: ",
				action: "Error extracting text from",
			})
		}
	}
}
