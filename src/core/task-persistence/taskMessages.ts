import { safeWriteJson } from "../../utils/safeWriteJson"
import * as path from "path"
import * as fs from "fs/promises"

import type { ClineMessage } from "@roo-code/types"

import { GlobalFileNames } from "../../shared/globalFileNames"
import { getTaskDirectoryPath } from "../../utils/storage"
import { mergeClineMessageSnapshots } from "./mergeMessageSnapshots"

export type TaskMessagesReadErrorKind = "not_found" | "invalid" | "io_error"

export class TaskMessagesReadError extends Error {
	constructor(
		public readonly kind: TaskMessagesReadErrorKind,
		message: string,
		public readonly originalError?: unknown,
	) {
		super(message)
		this.name = "TaskMessagesReadError"
	}
}

export type ReadTaskMessagesOptions = {
	taskId: string
	globalStoragePath: string
}

const READ_RETRY_MIN_MS = 10
const READ_RETRY_RANGE_MS = 291

function getErrorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
		? error.code
		: undefined
}

async function readFileWithMissingRetry(filePath: string): Promise<string> {
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

export async function readTaskMessages({
	taskId,
	globalStoragePath,
}: ReadTaskMessagesOptions): Promise<ClineMessage[]> {
	const taskDir = await getTaskDirectoryPath(globalStoragePath, taskId)
	const filePath = path.join(taskDir, GlobalFileNames.uiMessages)

	let fileContent: string
	try {
		fileContent = await readFileWithMissingRetry(filePath)
	} catch (error) {
		const kind = getErrorCode(error) === "ENOENT" ? "not_found" : "io_error"
		throw new TaskMessagesReadError(kind, `Failed to read task messages for ${taskId} at ${filePath}`, error)
	}

	let parsedData: unknown
	try {
		parsedData = JSON.parse(fileContent)
	} catch (error) {
		throw new TaskMessagesReadError("invalid", `Failed to parse task messages for ${taskId} at ${filePath}`, error)
	}

	if (!Array.isArray(parsedData)) {
		throw new TaskMessagesReadError(
			"invalid",
			`Task messages for ${taskId} at ${filePath} must be an array, got ${typeof parsedData}`,
		)
	}

	return parsedData
}

export type SaveTaskMessagesOptions = {
	messages: ClineMessage[]
	taskId: string
	globalStoragePath: string
	merge?: boolean
}

export async function saveTaskMessages({
	messages,
	taskId,
	globalStoragePath,
	merge = false,
}: SaveTaskMessagesOptions) {
	const taskDir = await getTaskDirectoryPath(globalStoragePath, taskId)
	const filePath = path.join(taskDir, GlobalFileNames.uiMessages)
	await safeWriteJson(filePath, messages, merge ? { merge: mergeClineMessageSnapshots } : undefined)
}
