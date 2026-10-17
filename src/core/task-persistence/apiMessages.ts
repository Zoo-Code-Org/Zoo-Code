import * as path from "path"
import * as fs from "fs/promises"
import crypto from "crypto"

import { Anthropic } from "@anthropic-ai/sdk"

import { safeWriteJson } from "../../utils/safeWriteJson"
import { GlobalFileNames } from "../../shared/globalFileNames"
import { withFileLock } from "../../utils/fileLock"
import { getTaskDirectoryPath } from "../../utils/storage"
import { ensureMessageIdentifiers, mergeApiMessageSnapshots } from "./mergeMessageSnapshots"
import { getErrorCode, readFileWithMissingRetry } from "./readFileWithMissingRetry"

export type ApiMessage = Anthropic.MessageParam & {
	messageId?: string
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

export async function getApiConversationHistoryFilePath({
	taskId,
	globalStoragePath,
}: {
	taskId: string
	globalStoragePath: string
}): Promise<string> {
	const taskDir = await getTaskDirectoryPath(globalStoragePath, taskId)
	return path.join(taskDir, GlobalFileNames.apiConversationHistory)
}

export async function readApiMessages({
	taskId,
	globalStoragePath,
}: {
	taskId: string
	globalStoragePath: string
}): Promise<ApiMessage[]> {
	const filePath = await getApiConversationHistoryFilePath({ taskId, globalStoragePath })

	const currentMessages = await readApiMessagesFile(taskId, filePath)
	if (currentMessages !== undefined) {
		return currentMessages
	}

	const oldPath = path.join(path.dirname(filePath), "claude_messages.json")
	const legacyMessages = await readApiMessagesFile(taskId, oldPath)
	if (legacyMessages === undefined) {
		return []
	}

	// Persist the successfully parsed legacy history before deleting its source.
	// The next ordinary task-history save may not happen until after user input,
	// so returning the in-memory data alone would leave a data-loss window.
	console.warn(
		`[readApiMessages] Migrating legacy API conversation history for task ${taskId} from claude_messages.json to api_conversation_history.json.`,
	)
	await safeWriteJson(filePath, legacyMessages, { merge: mergeApiMessageSnapshots })

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
}): Promise<ApiMessage[]> {
	ensureMessageIdentifiers(messages)
	const filePath = await getApiConversationHistoryFilePath({ taskId, globalStoragePath })
	let savedMessages = messages
	await safeWriteJson(
		filePath,
		messages,
		merge
			? {
					merge: (existing, incoming) => {
						savedMessages = mergeApiMessageSnapshots(existing, incoming) as ApiMessage[]
						return savedMessages
					},
				}
			: undefined,
	)
	return savedMessages
}

/**
 * Writes one durable copy of the pre-resume API conversation history into the
 * task directory before a resume prepares its slice. The name embeds a random
 * UUID, so concurrent resumes on different hosts never overwrite each other's
 * copies. Callers keep the returned path and remove the file only after the
 * resume outcome makes the copy obsolete.
 *
 * @throws When the copy cannot be written, so the caller can stop the resume
 * before its destructive preparation write.
 */
export async function createResumeHistoryRecoveryCopy({
	taskId,
	globalStoragePath,
	messages,
}: {
	taskId: string
	globalStoragePath: string
	messages: ApiMessage[]
}): Promise<string> {
	const historyPath = await getApiConversationHistoryFilePath({ taskId, globalStoragePath })
	const recoveryCopyPath = `${historyPath}.pre-resume-${crypto.randomUUID()}`
	await safeWriteJson(recoveryCopyPath, ensureMessageIdentifiers(structuredClone(messages)))
	return recoveryCopyPath
}

/**
 * Removes one pre-resume recovery copy. A missing file is already the target
 * state, so only unexpected removal failures are logged. The copy stays on
 * disk on failure, which keeps the original history recoverable.
 */
export async function removeResumeHistoryRecoveryCopy(recoveryCopyPath: string): Promise<void> {
	try {
		await fs.unlink(recoveryCopyPath)
	} catch (error) {
		if (getErrorCode(error) !== "ENOENT") {
			console.warn(
				`[resume-history] Failed to remove the pre-resume recovery copy at ${recoveryCopyPath}:`,
				error,
			)
		}
	}
}

/**
 * What the status gate decided while the API-history file lock was held.
 * `proceed` allows the restore, `committed_elsewhere` means the record is
 * active and another writer owns the resumed attempt, and `abort` means the
 * persisted record no longer shows the status the resume started from.
 */
export type ResumeRestoreStatusGate = "proceed" | "committed_elsewhere" | "abort"

export type ResumeHistoryRestoreOutcome =
	| "restored"
	| "committed_elsewhere"
	| "record_state_unknown"
	| "record_state_conflict"
	| "foreign_write"
	| "unreadable"

export interface ResumeHistoryRestoreResult {
	outcome: ResumeHistoryRestoreOutcome
	error?: unknown
}

export interface RestoreApiMessagesIfUnchangedOptions {
	taskId: string
	globalStoragePath: string
	/**
	 * The prepared resume slice. The restore commits only when the disk file
	 * still holds exactly this content.
	 */
	expected: ApiMessage[]
	/** The pre-resume history written back when the disk still holds `expected`. */
	replacement: ApiMessage[]
	/**
	 * Status gate, called inside the API-history file advisory lock before the
	 * write. It must read the authoritative task record under the record
	 * file's own advisory lock, which gives the locked order API-history file
	 * before record file. No existing writer takes the reverse order, so the
	 * nesting cannot deadlock. Throw to fail closed on an unreadable record.
	 */
	verifyCanRestore: () => Promise<ResumeRestoreStatusGate>
}

/**
 * Conditionally restores the pre-resume API conversation history in one
 * advisory-lock scope. The status gate, the content compare, and the write
 * commit run under the API-history file lock, and the compare itself runs in
 * the write's merge callback, so a lock-honoring writer cannot slip a newer
 * history between the compare and the commit. The restore writes only when
 * the disk still holds the prepared slice; any other content, including a
 * newer history from a competing host, is left untouched. Callers keep the
 * pre-resume recovery copy for every outcome except `restored`.
 *
 * The guarantee covers writers that honor the shared advisory lock, which is
 * every in-repo writer of this file. A process that edits the file without
 * the lock can still race the commit window; no file-level fix covers that.
 *
 * @throws Only on an unexpected write failure, for example a full disk. The
 * caller must then treat the original history as not yet restored.
 */
export async function restoreApiMessagesIfUnchanged({
	taskId,
	globalStoragePath,
	expected,
	replacement,
	verifyCanRestore,
}: RestoreApiMessagesIfUnchangedOptions): Promise<ResumeHistoryRestoreResult> {
	const filePath = await getApiConversationHistoryFilePath({ taskId, globalStoragePath })
	// ensureMessageIdentifiers mutates its input, so both sides work on clones.
	const expectedContent = ensureMessageIdentifiers(structuredClone(expected))
	const replacementContent = ensureMessageIdentifiers(structuredClone(replacement))
	const expectedText = JSON.stringify(expectedContent)

	return withFileLock(filePath, async () => {
		try {
			const gate = await verifyCanRestore()
			if (gate === "committed_elsewhere") {
				return { outcome: "committed_elsewhere" }
			}
			if (gate === "abort") {
				return { outcome: "record_state_conflict" }
			}
		} catch (error) {
			return { outcome: "record_state_unknown", error }
		}

		let diskState: "unreadable" | "mismatched" | undefined
		try {
			await safeWriteJson(filePath, replacementContent, {
				assumeLockHeld: true,
				merge: (existing) => {
					if (existing === null) {
						diskState = "unreadable"
						throw new Error(`the disk API conversation history for task ${taskId} is missing or unreadable`)
					}
					if (JSON.stringify(existing) !== expectedText) {
						diskState = "mismatched"
						throw new Error(
							`the disk API conversation history for task ${taskId} changed after preparation`,
						)
					}
					return replacementContent
				},
			})
		} catch (error) {
			if (diskState === "unreadable") {
				return { outcome: "unreadable", error }
			}
			if (diskState === "mismatched") {
				return { outcome: "foreign_write", error }
			}
			throw error
		}
		return { outcome: "restored" }
	})
}
