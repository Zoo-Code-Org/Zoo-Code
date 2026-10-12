import type { Anthropic } from "@anthropic-ai/sdk"

export function getImageMimeType(dataUrl: string): string | undefined {
	return /^data:([^;]+);base64,/.exec(dataUrl)?.[1]
}

/**
 * All providers consume the shared Anthropic image-block contract. Since model
 * capabilities expose only supportsImages, conservatively use its four MIME
 * types rather than assuming provider-specific support for other encodings.
 */
export function isSupportedImageMimeType(
	mimeType: string | undefined,
): mimeType is Anthropic.Base64ImageSource["media_type"] {
	return (
		mimeType === "image/jpeg" || mimeType === "image/png" || mimeType === "image/gif" || mimeType === "image/webp"
	)
}
