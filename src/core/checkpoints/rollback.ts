/**
 * Per-file / per-step checkpoint rollback (B3c).
 *
 * "Rollback" means UNDOING the change-card step: every file the step touched
 * is restored to the state it had BEFORE the step ran. The restore target is
 * resolved from the B2 change journal (`changes.jsonl`), whose entries record
 * — in write order — the checkpoint commit each successful write produced:
 *
 * - a file written by an earlier step resolves to that earlier entry's
 *   checkpoint (the file's post-write state after the previous step, i.e. its
 *   pre-step state);
 * - a file no earlier step wrote resolves to the task-start baseline
 *   (`service.baseHash`): undoing the step that created a file removes it,
 *   and undoing the step that deleted one brings it back;
 * - `restoreLatestFile` is the forward direction: it brings a file back to
 *   the content of its most recent recorded write (a successful no-op when
 *   the task never wrote the file).
 *
 * A file is only rolled back from the card of its most recent step: undoing
 * an older step for a file that a later step wrote again would overwrite the
 * newer state, so such a rollback is rejected (a full checkpoint restore
 * still reaches any older state). A journal that cannot be located or read
 * fails the restore instead of masquerading as "the task wrote nothing".
 *
 * Restores reuse the existing shadow-git service (`getCheckpointService` →
 * `RepoPerTaskCheckpointService.restoreFile`, the same instance whose
 * `restoreCheckpoint` the checkpoints UI uses) — nothing is forked. Only the
 * named file's working-tree content is replaced; the shadow repo's HEAD and
 * the checkpoint list are untouched (unlike a full `restoreCheckpoint`).
 */
import type { Task } from "../task/Task"

import { getCheckpointService } from "./index"
import { loadChanges, type ChangeJournalEntry } from "./changeJournal"

export interface RollbackFileOutcome {
	filePath: string
	success: boolean
	error?: string
	/** True when `restoreLatestFile` found no recorded write: the working tree was left as-is. */
	noOp?: boolean
}

export interface RollbackStepOutcome {
	/** The step checkpoint the files were resolved against, when provided. */
	checkpointId?: string
	files: RollbackFileOutcome[]
}

const NOT_ENABLED_ERROR = "Checkpoints are not enabled for this task"
const NO_TARGET_ERROR = "No checkpoint available to restore"
const NOT_IN_STEP_ERROR = "File is not part of this step's checkpoint"
const NO_ENTRY_ERROR = "No change journal entry for this file"
const NO_JOURNAL_ERROR = "Change journal is unavailable for this task"
const NOT_LATEST_ERROR = "File was modified in a later step; roll back the latest change card first"

type CheckpointService = NonNullable<Awaited<ReturnType<typeof getCheckpointService>>>

/** A readable journal (possibly legitimately empty) or the reason it could not be loaded. */
type LoadedJournal = { entries: ChangeJournalEntry[] } | { error: string }

// `undefined` = the journal cannot be located (provider reference gone); read failures (permissions, I/O) propagate.
async function loadTaskEntries(task: Task): Promise<ChangeJournalEntry[] | undefined> {
	const globalStorageDir = task.providerRef.deref()?.context.globalStorageUri.fsPath

	return globalStorageDir ? loadChanges(globalStorageDir, task.taskId) : undefined
}

// Single discriminated result for callers: a readable journal (possibly empty) or a failure.
async function loadTaskJournal(task: Task): Promise<LoadedJournal> {
	try {
		const entries = await loadTaskEntries(task)

		if (entries === undefined) {
			return { error: NO_JOURNAL_ERROR }
		}

		return { entries }
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		return { error: `Change journal could not be read: ${message}` }
	}
}

/** The most recent journal entry recorded for `filePath`, if any. */
function latestEntry(entries: ChangeJournalEntry[], filePath: string): ChangeJournalEntry | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		if (entries[i].path === filePath) {
			return entries[i]
		}
	}
	return undefined
}

/**
 * Resolve the checkpoint a file must be restored from in order to undo the
 * step identified by `stepCheckpointId` (see the module docstring for the
 * resolution rules).
 */
function preStepRestoreTarget(
	entries: ChangeJournalEntry[],
	filePath: string,
	stepCheckpointId: string,
): { target?: string; baseline?: boolean; error?: string } {
	const fileEntries = entries.filter((entry) => entry.path === filePath)
	const stepIndex = fileEntries.findIndex((entry) => entry.checkpointId === stepCheckpointId)

	if (stepIndex === -1) {
		return { error: NOT_IN_STEP_ERROR }
	}

	// Only the file's most recent step may be rolled back: restoring an older
	// state would overwrite the file's newer writes. A multi-write step shares
	// one checkpoint id, so compare on the latest entry's checkpoint id.
	const latest = fileEntries[fileEntries.length - 1]

	if (latest.checkpointId !== stepCheckpointId) {
		return { error: NOT_LATEST_ERROR }
	}

	if (stepIndex === 0) {
		return { baseline: true }
	}
	return { target: fileEntries[stepIndex - 1].checkpointId }
}

/**
 * Run one `restoreFile` and shape the outcome. A failed restore never throws
 * out of the rollback API; it is reported on the per-file outcome instead.
 */
async function performRestore(
	service: CheckpointService,
	target: string,
	filePath: string,
): Promise<RollbackFileOutcome> {
	try {
		await service.restoreFile(target, filePath)
		return { filePath, success: true }
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		console.error(`[checkpointRollback] failed to restore ${filePath} from checkpoint ${target}: ${message}`)
		return { filePath, success: false, error: message }
	}
}

/**
 * Restore a single file to the state it had BEFORE the change-card step
 * identified by `stepCheckpointId` — undoing that step's write to the file.
 */
export async function rollbackFile(
	task: Task,
	stepCheckpointId: string,
	filePath: string,
): Promise<RollbackFileOutcome> {
	const service = await getCheckpointService(task)

	if (!service) {
		return { filePath, success: false, error: NOT_ENABLED_ERROR }
	}

	const journal = await loadTaskJournal(task)

	if ("error" in journal) {
		return { filePath, success: false, error: journal.error }
	}

	const resolved = preStepRestoreTarget(journal.entries, filePath, stepCheckpointId)

	if (resolved.error) {
		return { filePath, success: false, error: resolved.error }
	}

	const target = resolved.baseline ? service.baseHash : resolved.target

	if (!target) {
		return { filePath, success: false, error: NO_TARGET_ERROR }
	}

	return performRestore(service, target, filePath)
}

/**
 * Restore every file of a step to the state it had before the step ran.
 *
 * `stepFiles` comes from the change-card payload (the B2 journal entries for
 * the step's checkpoint id). Each file is resolved to its pre-step checkpoint
 * through the journal (see the module docstring); without a step checkpoint id
 * the latest journal entry per file is used instead (restoring to the file's
 * last recorded state, the same direction as `restoreLatestFile`).
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

	const journal = await loadTaskJournal(task)
	const files: RollbackFileOutcome[] = []

	if ("error" in journal) {
		const journalError = journal.error
		return {
			checkpointId: stepCheckpointId,
			files: stepFiles.map((filePath) => ({ filePath, success: false, error: journalError })),
		}
	}

	const entries = journal.entries

	for (const filePath of stepFiles) {
		if (stepCheckpointId) {
			const resolved = preStepRestoreTarget(entries, filePath, stepCheckpointId)

			if (resolved.error) {
				files.push({ filePath, success: false, error: resolved.error })
				continue
			}

			const target = resolved.baseline ? service.baseHash : resolved.target

			if (!target) {
				files.push({ filePath, success: false, error: NO_TARGET_ERROR })
				continue
			}

			files.push(await performRestore(service, target, filePath))
			continue
		}

		const latest = latestEntry(entries, filePath)

		if (!latest) {
			files.push({ filePath, success: false, error: NO_ENTRY_ERROR })
			continue
		}

		files.push(await performRestore(service, latest.checkpointId, filePath))
	}

	return { checkpointId: stepCheckpointId, files }
}

/**
 * Restore one file to the latest recorded version: the content of its most
 * recent successful write checkpoint (the forward direction to a rollback).
 * A file the task never wrote has no recorded version — the working tree is
 * left as-is and the outcome is a successful no-op.
 */
export async function restoreLatestFile(task: Task, filePath: string): Promise<RollbackFileOutcome> {
	const service = await getCheckpointService(task)

	if (!service) {
		return { filePath, success: false, error: NOT_ENABLED_ERROR }
	}

	const journal = await loadTaskJournal(task)

	if ("error" in journal) {
		return { filePath, success: false, error: journal.error }
	}

	const latest = latestEntry(journal.entries, filePath)

	if (!latest) {
		return { filePath, success: true, noOp: true }
	}

	return performRestore(service, latest.checkpointId, filePath)
}
