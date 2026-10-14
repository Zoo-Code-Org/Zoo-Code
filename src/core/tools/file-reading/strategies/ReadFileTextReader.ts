import * as fs from "fs/promises"
import { extractRawTextFromFile, getSupportedBinaryFormats } from "../../../../integrations/misc/extract-text"
import { ReadFileTextProcessor } from "../ReadFileTextProcessor"
import { ReadFileCancellation } from "../ReadFileCancellation"
import type { FileResult, ReadFileContext } from "../types"
import { ReadFileStrategy } from "./ReadFileStrategy"

export class ReadFileTextReader extends ReadFileStrategy {
	constructor(private readonly textProcessor: ReadFileTextProcessor = new ReadFileTextProcessor()) {
		super()
	}

	canRead({ binary, options }: ReadFileContext): boolean {
		return options.textOnly === true || !binary
	}

	async read({ params, task, fullPath, extension, binary, options, file }: ReadFileContext): Promise<FileResult> {
		const cancellation = new ReadFileCancellation(task)
		const extract = options.textOnly === true && getSupportedBinaryFormats().includes(extension)
		if (options.textOnly && binary && !extract) {
			return {
				path: params.path,
				status: "unsupported",
				error: "Unsupported batch binary format; use read_file.",
			}
		}
		// Buffer decoding deliberately tolerates non-UTF8 bytes, as before.
		let content: string
		if (extract) {
			const bytes = file ? await cancellation.run(() => file.readFile()) : undefined
			if (cancellation.isCancelled()) return { path: params.path, status: "cancelled" }
			content = await cancellation.run(() => extractRawTextFromFile(fullPath, bytes))
		} else {
			const bytes = await cancellation.run(() => (file ? file.readFile() : fs.readFile(fullPath)))
			if (cancellation.isCancelled()) return { path: params.path, status: "cancelled" }
			content = bytes.toString("utf-8")
		}
		if (cancellation.isCancelled()) return { path: params.path, status: "cancelled" }
		const text = this.textProcessor.process(content, params)
		if (text.startsWith("Error:")) {
			return { path: params.path, status: "error", error: text, nativeContent: `File: ${params.path}\n${text}` }
		}
		await cancellation.run(() => task.fileContextTracker.trackFileContext(params.path, "read_tool"))
		if (cancellation.isCancelled()) return { path: params.path, status: "cancelled" }
		return {
			path: params.path,
			status: "approved",
			nativeContent: `File: ${params.path}\n${text}`,
			longLinesTruncated: options.textOnly ? this.textProcessor.hasClippedLines(content, text) : undefined,
		}
	}
}
