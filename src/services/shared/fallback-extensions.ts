/**
 * Extensions that should not be parsed for structural definitions and should
 * instead use line-based fallback chunking where indexing is supported.
 */
export const fallbackExtensions = [".txt", ".vb", ".scala", ".swift"] as const

/**
 * Fallback extensions that do not have a structural parser. Scala and Swift
 * still support structural parsing outside code indexing.
 */
export const nonStructuralExtensions = [".txt", ".vb"] as const

/**
 * Check whether a file extension should bypass structural parsing.
 *
 * @param extension File extension, including the leading dot
 */
export function isFallbackExtension(extension: string): boolean {
	return (fallbackExtensions as readonly string[]).includes(extension.toLowerCase())
}

/**
 * Check whether a file extension should bypass structural parsing entirely.
 *
 * @param extension File extension, including the leading dot
 */
export function isNonStructuralExtension(extension: string): boolean {
	return (nonStructuralExtensions as readonly string[]).includes(extension.toLowerCase())
}
