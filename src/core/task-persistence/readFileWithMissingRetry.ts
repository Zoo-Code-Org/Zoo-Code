import * as fs from "fs/promises"

// safeWriteJson replaces a file in two renames (target to backup, new file to
// target) because a single rename over an open file fails with EPERM on
// Windows. A reader can see ENOENT between the two renames, so retry once.
const READ_RETRY_MIN_MS = 1
const READ_RETRY_MAX_MS = 10
const READ_RETRY_RANGE_MS = READ_RETRY_MAX_MS - READ_RETRY_MIN_MS + 1

export function getErrorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
		? error.code
		: undefined
}

/**
 * Formats the actionable detail of an underlying error for inclusion in
 * wrapping error messages: the filesystem error code when present (e.g.
 * ENOENT vs EACCES), otherwise the error name and message (e.g. SyntaxError
 * for a torn/half-written JSON file). Keeps wrappers such as
 * TaskMessagesReadError diagnosable without logging the full cause chain.
 */
export function formatErrorDetail(error: unknown): string {
	const code = getErrorCode(error)
	if (code) {
		return ` (code: ${code})`
	}
	if (error instanceof Error) {
		return ` (${error.name}: ${error.message})`
	}
	return ` (${String(error)})`
}

export async function readFileWithMissingRetry(filePath: string): Promise<string> {
	try {
		return await fs.readFile(filePath, "utf8")
	} catch (error) {
		if (getErrorCode(error) !== "ENOENT") {
			throw error
		}

		const retryDelay = READ_RETRY_MIN_MS + Math.floor(Math.random() * READ_RETRY_RANGE_MS)
		await new Promise((resolve) => setTimeout(resolve, retryDelay))
		return fs.readFile(filePath, "utf8")
	}
}
