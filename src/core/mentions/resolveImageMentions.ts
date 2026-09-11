import * as path from "path"

import { mentionRegexGlobal, unescapeSpaces } from "../../shared/context-mentions"
import {
	isSupportedImageFormat,
	readImageAsDataUrlWithBuffer,
	validateImageForProcessing,
	ImageMemoryTracker,
	DEFAULT_MAX_IMAGE_FILE_SIZE_MB,
	DEFAULT_MAX_TOTAL_IMAGE_SIZE_MB,
} from "../tools/helpers/imageHelpers"

const MAX_IMAGES_PER_MESSAGE = 20

interface NormalizeSuppliedImagesOptions {
	maxImageFileSize?: number
	maxTotalImageSize?: number
}

export interface ResolveImageMentionsOptions {
	text: string
	images?: string[]
	cwd: string
	rooIgnoreController?: { validateAccess: (filePath: string) => boolean }
	/** Whether the current model supports images. Defaults to true. */
	supportsImages?: boolean
	/** Maximum size per image file in MB. Defaults to 5MB. */
	maxImageFileSize?: number
	/** Maximum total size of all images in MB. Defaults to 20MB. */
	maxTotalImageSize?: number
}

export interface ResolveImageMentionsResult {
	text: string
	images: string[]
}

function isPathWithinCwd(absPath: string, cwd: string): boolean {
	const rel = path.relative(cwd, absPath)
	return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)
}

function dedupePreserveOrder(values: string[]): string[] {
	const seen = new Set<string>()
	const result: string[] = []
	for (const v of values) {
		if (seen.has(v)) continue
		seen.add(v)
		result.push(v)
	}
	return result
}

function getDataUrlSizeInMB(dataUrl: string): number {
	return Buffer.byteLength(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64") / (1024 * 1024)
}

export function normalizeSuppliedImages(
	images?: string[],
	{
		maxImageFileSize = DEFAULT_MAX_IMAGE_FILE_SIZE_MB,
		maxTotalImageSize = DEFAULT_MAX_TOTAL_IMAGE_SIZE_MB,
	}: NormalizeSuppliedImagesOptions = {},
): string[] {
	if (!images?.length) return []

	const normalized: string[] = []
	const accepted = new Set<string>()
	let totalSize = 0

	for (const image of images) {
		if (accepted.has(image)) continue
		if (normalized.length >= MAX_IMAGES_PER_MESSAGE) break

		const match = image.match(/^data:image\/([a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/]+={0,2})$/)
		if (!match || match[2].length % 4 !== 0) continue

		const extension = match[1] === "svg+xml" ? ".svg" : match[1] === "x-icon" ? ".ico" : `.${match[1]}`
		if (!isSupportedImageFormat(extension)) continue

		const sizeInMB = getDataUrlSizeInMB(image)
		if (sizeInMB > maxImageFileSize || totalSize + sizeInMB > maxTotalImageSize) continue

		totalSize += sizeInMB
		accepted.add(image)
		normalized.push(image)
	}

	return normalized
}

/**
 * Resolves local image file mentions like `@/path/to/image.png` found in `text` into `data:image/...;base64,...`
 * and appends them to the outgoing `images` array.
 *
 * Behavior matches the read_file tool:
 * - Supports the same image formats: png, jpg, jpeg, gif, webp, svg, bmp, ico, tiff, avif
 * - Respects per-file size limits (default 5MB)
 * - Respects total memory limits (default 20MB)
 * - Skips images if model doesn't support them
 * - Respects `.rooignore` via `rooIgnoreController.validateAccess` when provided
 */
export async function resolveImageMentions({
	text,
	images,
	cwd,
	rooIgnoreController,
	supportsImages = true,
	maxImageFileSize = DEFAULT_MAX_IMAGE_FILE_SIZE_MB,
	maxTotalImageSize = DEFAULT_MAX_TOTAL_IMAGE_SIZE_MB,
}: ResolveImageMentionsOptions): Promise<ResolveImageMentionsResult> {
	const existingImages = normalizeSuppliedImages(images, { maxImageFileSize, maxTotalImageSize })
	if (existingImages.length >= MAX_IMAGES_PER_MESSAGE) {
		return { text, images: existingImages.slice(0, MAX_IMAGES_PER_MESSAGE) }
	}

	// If model doesn't support images, skip image processing entirely
	if (!supportsImages) {
		return { text, images: existingImages }
	}

	const mentions = Array.from(text.matchAll(mentionRegexGlobal))
		.map((m) => m[1])
		.filter(Boolean)
	if (mentions.length === 0) {
		return { text, images: existingImages }
	}

	const imageMentions = mentions.filter((mention) => {
		if (!mention.startsWith("/")) return false
		const relPath = unescapeSpaces(mention.slice(1))
		const ext = path.extname(relPath).toLowerCase()
		return isSupportedImageFormat(ext)
	})

	if (imageMentions.length === 0) {
		return { text, images: existingImages }
	}

	const imageMemoryTracker = new ImageMemoryTracker()
	for (const image of existingImages) {
		imageMemoryTracker.addMemoryUsage(getDataUrlSizeInMB(image))
	}
	const newImages: string[] = []

	for (const mention of imageMentions) {
		if (existingImages.length + newImages.length >= MAX_IMAGES_PER_MESSAGE) {
			break
		}

		const relPath = unescapeSpaces(mention.slice(1))
		const absPath = path.resolve(cwd, relPath)
		if (!isPathWithinCwd(absPath, cwd)) {
			continue
		}

		if (rooIgnoreController && !rooIgnoreController.validateAccess(relPath)) {
			continue
		}

		// Validate image size limits (matches read_file behavior)
		try {
			const validationResult = await validateImageForProcessing(
				absPath,
				supportsImages,
				maxImageFileSize,
				maxTotalImageSize,
				imageMemoryTracker.getTotalMemoryUsed(),
			)

			if (!validationResult.isValid) {
				// Skip this image due to size/memory limits, but continue processing others
				continue
			}

			const { dataUrl } = await readImageAsDataUrlWithBuffer(absPath)
			newImages.push(dataUrl)

			// Track memory usage
			if (validationResult.sizeInMB) {
				imageMemoryTracker.addMemoryUsage(validationResult.sizeInMB)
			}
		} catch {
			// Fail-soft: skip unreadable/missing files.
			continue
		}
	}

	const merged = dedupePreserveOrder([...existingImages, ...newImages]).slice(0, MAX_IMAGES_PER_MESSAGE)
	return { text, images: merged }
}
