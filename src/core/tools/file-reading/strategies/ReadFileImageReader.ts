import path from "path"
import {
	DEFAULT_MAX_IMAGE_FILE_SIZE_MB,
	DEFAULT_MAX_TOTAL_IMAGE_SIZE_MB,
	IMAGE_MIME_TYPES,
	isSupportedImageFormat,
	validateImageForProcessing,
	processImageFile,
	ImageMemoryTracker,
} from "../../helpers/imageHelpers"
import { getImageMimeType, isSupportedImageMimeType } from "../../../../utils/imageMime"
import { ReadFileErrorReporter } from "../ReadFileErrorReporter"
import { isReadFileCancelled, throwIfReadFileCancelled } from "../readFileCancellation"
import type { FileResult, ReadFileContext } from "../types"
import { ReadFileStrategy } from "./ReadFileStrategy"

export class ReadFileImageReader extends ReadFileStrategy {
	constructor(private readonly errorReporter: ReadFileErrorReporter = new ReadFileErrorReporter()) {
		super()
	}

	canRead({ binary, extension, options }: ReadFileContext): boolean {
		return binary && options.textOnly !== true && isSupportedImageFormat(extension)
	}

	async read({ params, task, fullPath, file, options }: ReadFileContext): Promise<FileResult> {
		const relPath = params.path
		try {
			const state = await task.providerRef.deref()?.getState()
			if (isReadFileCancelled(task, options)) return { path: relPath, status: "cancelled" }
			const tracker = new ImageMemoryTracker()
			const supportsImages = task.api.getModel().info.supportsImages ?? false
			const targetMimeType = IMAGE_MIME_TYPES[path.extname(fullPath).toLowerCase()]
			if (supportsImages && !isSupportedImageMimeType(targetMimeType))
				return this.unsupported(relPath, targetMimeType)
			const validation = await validateImageForProcessing(
				fullPath,
				supportsImages,
				state?.maxImageFileSize ?? DEFAULT_MAX_IMAGE_FILE_SIZE_MB,
				state?.maxTotalImageSize ?? DEFAULT_MAX_TOTAL_IMAGE_SIZE_MB,
				tracker.getTotalMemoryUsed(),
				file,
			)
			if (isReadFileCancelled(task, options)) return { path: relPath, status: "cancelled" }
			if (!validation.isValid) {
				await task.fileContextTracker.trackFileContext(relPath, "read_tool")
				return {
					path: relPath,
					status: "approved",
					nativeContent: `File: ${relPath}\nNote: ${validation.notice}`,
				}
			}
			// Label the verified target, not a symlink alias with a different extension.
			const image = await processImageFile(fullPath, file, () => throwIfReadFileCancelled(task, options))
			if (isReadFileCancelled(task, options)) return { path: relPath, status: "cancelled" }
			const mimeType = getImageMimeType(image.dataUrl)
			if (!isSupportedImageMimeType(mimeType)) return this.unsupported(relPath, mimeType)
			tracker.addMemoryUsage(image.sizeInMB)
			await task.fileContextTracker.trackFileContext(relPath, "read_tool")
			return {
				path: relPath,
				status: "approved",
				nativeContent: `File: ${relPath}\nNote: ${image.notice}`,
				imageDataUrl: image.dataUrl,
			}
		} catch (error) {
			if (isReadFileCancelled(task, options)) return { path: relPath, status: "cancelled" }
			return this.errorReporter.report(relPath, task, error, {
				prefix: "Error reading image file: ",
				action: "Error reading image file",
			})
		}
	}

	private unsupported(relPath: string, mimeType: string | undefined): FileResult {
		const notice = `Unsupported image MIME type: ${mimeType ?? "unknown"}. Use JPEG, PNG, GIF, or WebP.`
		return {
			path: relPath,
			status: "unsupported",
			error: notice,
			nativeContent: `File: ${relPath}\nNote: ${notice}`,
		}
	}
}
