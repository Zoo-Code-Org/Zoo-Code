import { getSupportedBinaryFormats } from "../../../../integrations/misc/extract-text"
import { isSupportedImageFormat } from "../../helpers/imageHelpers"
import type { FileResult, ReadFileContext } from "../types"
import { ReadFileStrategy } from "./ReadFileStrategy"

export class ReadFileBinaryReader extends ReadFileStrategy {
	canRead({ binary, extension, options }: ReadFileContext): boolean {
		return (
			binary &&
			options.textOnly !== true &&
			!isSupportedImageFormat(extension) &&
			!getSupportedBinaryFormats().includes(extension)
		)
	}

	async read({ params, extension }: ReadFileContext): Promise<FileResult> {
		const relPath = params.path
		const format = extension.slice(1) || "bin"
		return {
			path: relPath,
			status: "approved",
			notice: `Binary file format: ${format}`,
			nativeContent: `File: ${relPath}\nBinary file (${format}) - content not displayed`,
		}
	}
}
