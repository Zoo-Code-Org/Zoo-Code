import { safeWriteJson } from "../../utils/safeWriteJson"
import * as path from "path"
import * as fs from "fs/promises"

import { Anthropic } from "@anthropic-ai/sdk"

import { GlobalFileNames } from "../../shared/globalFileNames"
import { getTaskDirectoryPath } from "../../utils/storage"
import { mergeApiMessageSnapshots } from "./mergeMessageSnapshots"
import { getErrorCode, readFileWithMissingRetry } from "./readFileWithMissingRetry"

export type ApiMessage = Anthropic.MessageParam & {
	ts?: number
	isSummary?: boolean
	id?: string
	// For reasoning items stored in API history
	type?: "reasoning"
	summary?: any[]
	encrypted_content?: string
	text?: string
	// For OpenRouter reasoning_details array format (used by Gemini 3, etc.)
	reasoning_details?: any[]
	// For DeepSeek/Z.ai interleaved thinking: reasoning_content that must be preserved during tool call sequences
	// See: https://api-docs.deepseek.com/guides/thinking_mode#tool-calls
	reasoning_content?: string
	// For non-destructive condense: unique identifier for summary messages
	condenseId?: string
	// For non-destructive condense: points to the condenseId of the summary that replaces this message
	// Messages with condenseParent are filtered out when sending to API if the summary exists
	condenseParent?: string
	// For non-destructive truncation: unique identifier for truncation marker messages
	truncationId?: string
	// For non-destructive truncation: points to the truncationId of the marker that hides this message
	// Messages with truncationParent are filtered out when sending to API if the marker exists
	truncationParent?: string
	// Identifies a message as a truncation boundary marker
	isTruncationMarker?: boolean
}

export type ApiMessagesReadErrorKind = "invalid" | "io_error"

export class ApiMessagesReadError extends Error {
	constructor(
		public readonly kind: ApiMessagesReadErrorKind,
		message: string,
		public readonly originalError?: unknown,
	) {
		super(message)
		this.name = "ApiMessagesReadError"
	}
}

function parseApiMessages(fileContent: string, taskId: string, filePath: string): ApiMessage[] {
	let parsedData: unknown
	try {
		parsedData = JSON.parse(fileContent)
	} catch (error) {
		throw new ApiMessagesReadError(
			"invalid",
			`Failed to parse API conversation history for ${taskId} at ${filePath}`,
			error,
		)
	}

	if (!Array.isArray(parsedData)) {
		throw new ApiMessagesReadError(
			"invalid",
			`API conversation history for ${taskId} at ${filePath} must be an array, got ${typeof parsedData}`,
		)
	}

	return parsedData
}

async function readApiMessagesFile(taskId: string, filePath: string): Promise<ApiMessage[] | undefined> {
	let fileContent: string
	try {
		fileContent = await readFileWithMissingRetry(filePath)
	} catch (error) {
		if (getErrorCode(error) === "ENOENT") {
			return undefined
		}
		throw new ApiMessagesReadError(
			"io_error",
			`Failed to read API conversation history for ${taskId} at ${filePath}`,
			error,
		)
	}

	return parseApiMessages(fileContent, taskId, filePath)
}

export async function readApiMessages({
	taskId,
	globalStoragePath,
}: {
	taskId: string
	globalStoragePath: string
}): Promise<ApiMessage[]> {
	const taskDir = await getTaskDirectoryPath(globalStoragePath, taskId)
	const filePath = path.join(taskDir, GlobalFileNames.apiConversationHistory)

	const currentMessages = await readApiMessagesFile(taskId, filePath)
	if (currentMessages !== undefined) {
		return currentMessages
	}

	const oldPath = path.join(taskDir, "claude_messages.json")
	const legacyMessages = await readApiMessagesFile(taskId, oldPath)
	if (legacyMessages === undefined) {
		return []
	}

	try {
		await fs.unlink(oldPath)
	} catch (error) {
		throw new ApiMessagesReadError(
			"io_error",
			`Failed to remove migrated API conversation history for ${taskId} at ${oldPath}`,
			error,
		)
	}
	return legacyMessages
}

export async function saveApiMessages({
	messages,
	taskId,
	globalStoragePath,
	merge = false,
}: {
	messages: ApiMessage[]
	taskId: string
	globalStoragePath: string
	merge?: boolean
}) {
	const taskDir = await getTaskDirectoryPath(globalStoragePath, taskId)
	const filePath = path.join(taskDir, GlobalFileNames.apiConversationHistory)
	await safeWriteJson(filePath, messages, merge ? { merge: mergeApiMessageSnapshots } : undefined)
}
