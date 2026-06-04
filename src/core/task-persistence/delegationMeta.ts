import * as fs from "fs/promises"
import * as path from "path"
import { getTaskDirectoryPath } from "../../utils/storage"
import { fileExistsAtPath } from "../../utils/fs"
import { safeWriteJson } from "../../utils/safeWriteJson"

/**
 * Per-task delegation metadata file persistence.
 *
 * Resolves globalState eviction race condition where delegation metadata
 * stored only in globalState (via updateTaskHistory) can be overwritten
 * by concurrent task operations (child's saveClineMessages).
 *
 * ## Why file-based persistence?
 * - globalState is a single shared key-value store subject to "last writer wins" races
 * - Multi-process VS Code instances share globalState, creating cross-instance races
 * - Per-task files provide fine-grained locking and survive globalState eviction
 * - The file path is deterministic: <taskDir>/delegation_meta.json
 *
 * ## Usage
 * - Save delegation metadata immediately after persisting parent delegation
 * - Read on parent reopen/repair to restore any dropped delegation fields
 * - Clean up on task deletion
 */
export interface DelegationMeta {
	/**
	 * Delegation status of this task.
	 * - "active": Task is running normally (not currently delegated)
	 * - "delegated": Task has delegated to a child and is awaiting return
	 * - "completed": Task completed (delegation cycle finished)
	 */
	status: "active" | "delegated" | "completed"

	/** The child task ID this task is currently awaiting (if delegated) */
	awaitingChildId: string | null

	/** The child task ID this task delegated to (may differ from awaitingChildId in nested delegation) */
	delegatedToId: string | undefined

	/** All child task IDs created by this task (cumulative set) */
	childIds: string[] | undefined

	/** The child task ID that completed this task's delegation */
	completedByChildId: string | undefined

	/** Summary of the completion result from the child */
	completionResultSummary: string | undefined
}

/**
 * Save delegation metadata to per-task file.
 * Creates parent directories if they don't exist.
 * Uses atomic write to prevent corruption.
 */
export async function saveDelegationMeta(params: {
	taskId: string
	globalStoragePath: string
	meta: DelegationMeta
}): Promise<void> {
	const { taskId, globalStoragePath, meta } = params
	const taskDir = await getTaskDirectoryPath(globalStoragePath, taskId)
	const filePath = path.join(taskDir, "delegation_meta.json")
	await safeWriteJson(filePath, meta)
}

/**
 * Read delegation metadata from per-task file.
 * Returns null if the file doesn't exist or is corrupted.
 */
export async function readDelegationMeta(params: {
	taskId: string
	globalStoragePath: string
}): Promise<DelegationMeta | null> {
	const { taskId, globalStoragePath } = params
	const taskDir = await getTaskDirectoryPath(globalStoragePath, taskId)
	const filePath = path.join(taskDir, "delegation_meta.json")

	if (!(await fileExistsAtPath(filePath))) {
		return null
	}

	try {
		const raw = await fs.readFile(filePath, "utf8")
		const parsed = JSON.parse(raw) as DelegationMeta
		// Validate required fields
		if (!parsed.status) {
			return null
		}
		return parsed
	} catch {
		return null
	}
}

/**
 * Delete delegation metadata file for a task.
 * Best-effort; errors are silently ignored.
 */
export async function deleteDelegationMeta(params: { taskId: string; globalStoragePath: string }): Promise<void> {
	const { taskId, globalStoragePath } = params
	try {
		const taskDir = await getTaskDirectoryPath(globalStoragePath, taskId)
		const filePath = path.join(taskDir, "delegation_meta.json")
		await fs.unlink(filePath)
	} catch {
		// File may not exist; ignore
	}
}
