/**
 * Per-file / per-step checkpoint rollback (B3a).
 *
 * Restores reuse the existing shadow-git service (`getCheckpointService` →
 * `RepoPerTaskCheckpointService.restoreFile`, the same instance whose
 * `restoreCheckpoint` the checkpoints UI uses) — nothing is forked.
 *
 * - `rollbackFile` restores one file to the content it had at an explicit
 *   checkpoint commit (the "restore to any checkpoint" primitive).
 * - `rollbackStep` restores every file a step touched to that step's
 *   checkpoint. The step's checkpoint is resolved from the B2 change
 *   journal (`changes.jsonl`), whose entries key each written file by the
 *   checkpoint commit it produced. When the caller already knows the step's
 *   checkpoint id (the change-card payload carries it), pass it so the
 *   journal is filtered to exactly that step's writes.
 */
import type { Task } from "../task/Task"

import { getCheckpointService } from "./index"
import { loadChanges, type ChangeJournalEntry } from "./changeJournal"

export interface RollbackFileOutcome {
	filePath: string
	success: boolean
	error?: string
}

export interface RollbackStepOutcome {
	/** The step checkpoint the files were restored from, when resolvable. */
	checkpointId?: string
	files: RollbackFileOutcome[]
}

const NOT_ENABLED_ERROR = "Checkpoints are not enabled for this task"

/**
 * Restore a single file to its state at `checkpointId`.
 *
 * Only the named file's working-tree content is replaced; the shadow repo's
 * HEAD and the checkpoint list are untouched (unlike a full
 * `restoreCheckpoint`).
 */
export async function rollbackFile(task: Task, checkpointId: string, filePath: string): Promise<RollbackFileOutcome> {
	const service = await getCheckpointService(task)

	if (!service) {
		return { filePath, success: false, error: NOT_ENABLED_ERROR }
	}

	try {
		await service.restoreFile(checkpointId, filePath)
		return { filePath, success: true }
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		console.error(`[rollbackFile] failed to restore ${filePath} from checkpoint ${checkpointId}: ${message}`)
		return { filePath, success: false, error: message }
	}
}

/**
 * Restore every file of a step to the step's checkpoint.
 *
 * `stepFiles` comes from the B2 journal entries for the step's checkpoint id
 * (which the change-card payload also carries). Each file is resolved to its
 * step checkpoint through the journal:
 * - with `stepCheckpointId`, only entries for that checkpoint are considered
 *   (exactly the step's writes), and every listed file is restored from it;
 * - without it, the latest journal entry per file is used as a fallback.
 */
export async function rollbackStep(
	task: Task,
	stepFiles: string[],
	stepCheckpointId?: string,
): Promise<RollbackStepOutcome> {
	const service = await getCheckpointService(task)

	if (!service) {
		return {
			checkpointId: stepCheckpointId,
			files: stepFiles.map((filePath) => ({ filePath, success: false, error: NOT_ENABLED_ERROR })),
		}
	}

	// loadChanges never throws: an absent or torn journal resolves to its
	// readable prefix (or []), so no error handling is needed here.
	const globalStorageDir = task.providerRef.deref()?.context.globalStorageUri.fsPath
	const entries = globalStorageDir ? await loadChanges(globalStorageDir, task.taskId) : []

	// Latest journal entry per file (journal lines preserve write order).
	const latestByPath = new Map<string, ChangeJournalEntry>()
	for (const entry of entries) {
		latestByPath.set(entry.path, entry)
	}

	const checkpointId =
		stepCheckpointId ?? stepFiles.map((filePath) => latestByPath.get(filePath)?.checkpointId).find(Boolean)

	const files: RollbackFileOutcome[] = []
	for (const filePath of stepFiles) {
		const entry = stepCheckpointId
			? entries.find((e) => e.path === filePath && e.checkpointId === stepCheckpointId)
			: latestByPath.get(filePath)

		if (!entry) {
			files.push({
				filePath,
				success: false,
				error: stepCheckpointId
					? "File is not part of this step's checkpoint"
					: "No change journal entry for this file",
			})
			continue
		}

		files.push(await rollbackFile(task, entry.checkpointId, filePath))
	}

	return { checkpointId, files }
}
