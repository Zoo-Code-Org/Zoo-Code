import * as fs from "fs/promises"

// A file that is about to be written by a still-running writer (for example
// the final task-messages save racing an extension-host shutdown) can be
// missing for longer than a single 1-10ms retry window. Retry a bounded
// number of times with a jittered delay so reads cover late writes, while
// keeping genuinely-missing files fast enough (worst case ~4 x 100ms).
const READ_RETRY_ATTEMPTS = 4
const READ_RETRY_MIN_MS = 10
const READ_RETRY_MAX_MS = 100
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
	let retriesLeft = READ_RETRY_ATTEMPTS

	while (true) {
		try {
			return await fs.readFile(filePath, "utf8")
		} catch (error) {
			if (getErrorCode(error) !== "ENOENT" || retriesLeft <= 0) {
				throw error
			}

			retriesLeft -= 1
			const retryDelay = READ_RETRY_MIN_MS + Math.floor(Math.random() * READ_RETRY_RANGE_MS)
			await new Promise((resolve) => setTimeout(resolve, retryDelay))
		}
	}
}
