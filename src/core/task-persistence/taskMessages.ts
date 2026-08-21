import { safeWriteJson } from "../../utils/safeWriteJson"
import * as path from "path"
import * as fs from "fs/promises"

import type { ClineMessage } from "@roo-code/types"

import { GlobalFileNames } from "../../shared/globalFileNames"
import { getTaskDirectoryPath } from "../../utils/storage"

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

export async function readTaskMessages({
	taskId,
	globalStoragePath,
}: ReadTaskMessagesOptions): Promise<ClineMessage[]> {
	const taskDir = await getTaskDirectoryPath(globalStoragePath, taskId)
	const filePath = path.join(taskDir, GlobalFileNames.uiMessages)

	let fileContent: string
	try {
		fileContent = await fs.readFile(filePath, "utf8")
	} catch (error) {
		const kind =
			typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
				? "not_found"
				: "io_error"
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
}

export async function saveTaskMessages({ messages, taskId, globalStoragePath }: SaveTaskMessagesOptions) {
	const taskDir = await getTaskDirectoryPath(globalStoragePath, taskId)
	const filePath = path.join(taskDir, GlobalFileNames.uiMessages)
	await safeWriteJson(filePath, messages)
}
