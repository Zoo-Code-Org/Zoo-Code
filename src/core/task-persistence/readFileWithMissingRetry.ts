import * as fs from "fs/promises"

const READ_RETRY_MIN_MS = 1
const READ_RETRY_MAX_MS = 10
const READ_RETRY_RANGE_MS = READ_RETRY_MAX_MS - READ_RETRY_MIN_MS + 1

export function getErrorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
		? error.code
		: undefined
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
