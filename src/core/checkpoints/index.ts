import pWaitFor from "p-wait-for"
import * as vscode from "vscode"

import type { ClineApiReqInfo } from "@roo-code/types"
import { TelemetryService } from "@roo-code/telemetry"

import { Task } from "../task/Task"

import { getWorkspacePath } from "../../utils/path"
import { checkGitInstalled } from "../../utils/git"
import { t } from "../../i18n"

import { getApiMetrics } from "../../shared/getApiMetrics"

import { DIFF_VIEW_URI_SCHEME } from "../../integrations/editor/DiffViewProvider"

import { CheckpointServiceOptions, RepoPerTaskCheckpointService } from "../../services/checkpoints"

import { appendChanges } from "./changeJournal"
import { buildChangeCardPayload } from "./changeCard"

const WARNING_THRESHOLD_MS = 5000

function sendCheckpointInitWarn(task: Task, type?: "WAIT_TIMEOUT" | "INIT_TIMEOUT", timeout?: number) {
	task.providerRef.deref()?.postMessageToWebview({
		type: "checkpointInitWarning",
		checkpointWarning: type && timeout ? { type, timeout } : undefined,
	})
}

export async function getCheckpointService(task: Task, { interval = 250 }: { interval?: number } = {}) {
	if (!task.enableCheckpoints) {
		return undefined
	}

	if (task.checkpointService) {
		return task.checkpointService
	}

	const provider = task.providerRef.deref()

	// Get checkpoint timeout from task settings (converted to milliseconds)
	const checkpointTimeoutMs = task.checkpointTimeout * 1000

	const log = (message: string) => {
		console.log(message)

		try {
			provider?.log(message)
		} catch {
			// NO-OP
		}
	}

	console.log("[Task#getCheckpointService] initializing checkpoints service")

	try {
		const workspaceDir = task.cwd || getWorkspacePath()

		if (!workspaceDir) {
			log("[Task#getCheckpointService] workspace folder not found, disabling checkpoints")
			task.enableCheckpoints = false
			return undefined
		}

		const globalStorageDir = provider?.context.globalStorageUri.fsPath

		if (!globalStorageDir) {
			log("[Task#getCheckpointService] globalStorageDir not found, disabling checkpoints")
			task.enableCheckpoints = false
			return undefined
		}

		const options: CheckpointServiceOptions = {
			taskId: task.taskId,
			workspaceDir,
			shadowDir: globalStorageDir,
			log,
		}

		if (task.checkpointServiceInitializing) {
			const checkpointInitStartTime = Date.now()
			let warningShown = false

			await pWaitFor(
				() => {
					const elapsed = Date.now() - checkpointInitStartTime

					// Show warning if we're past the threshold and haven't shown it yet
					if (!warningShown && elapsed >= WARNING_THRESHOLD_MS) {
						warningShown = true
						sendCheckpointInitWarn(task, "WAIT_TIMEOUT", WARNING_THRESHOLD_MS / 1000)
					}

					console.log(
						`[Task#getCheckpointService] waiting for service to initialize (${Math.round(elapsed / 1000)}s)`,
					)
					return !!task.checkpointService && !!task?.checkpointService?.isInitialized
				},
				{ interval, timeout: checkpointTimeoutMs },
			)
			if (!task?.checkpointService) {
				sendCheckpointInitWarn(task, "INIT_TIMEOUT", task.checkpointTimeout)
				task.enableCheckpoints = false
				return undefined
			} else {
				sendCheckpointInitWarn(task)
			}
			return task.checkpointService
		}

		if (!task.enableCheckpoints) {
			return undefined
		}

		const service = RepoPerTaskCheckpointService.create(options)
		task.checkpointServiceInitializing = true
		await checkGitInstallation(task, service, log, provider)
		task.checkpointService = service
		if (task.enableCheckpoints) {
			sendCheckpointInitWarn(task)
		}
		return service
	} catch (err) {
		if (err.name === "TimeoutError" && task.enableCheckpoints) {
			sendCheckpointInitWarn(task, "INIT_TIMEOUT", task.checkpointTimeout)
		}
		log(`[Task#getCheckpointService] ${err.message}`)
		task.enableCheckpoints = false
		task.checkpointServiceInitializing = false
		return undefined
	}
}

async function checkGitInstallation(
	task: Task,
	service: RepoPerTaskCheckpointService,
	log: (message: string) => void,
	provider: any,
) {
	try {
		const gitInstalled = await checkGitInstalled()

		if (!gitInstalled) {
			log("[Task#getCheckpointService] Git is not installed, disabling checkpoints")
			task.enableCheckpoints = false
			task.checkpointServiceInitializing = false

			// Show user-friendly notification
			const selection = await vscode.window.showWarningMessage(
				t("common:errors.git_not_installed"),
				t("common:buttons.learn_more"),
			)

			if (selection === t("common:buttons.learn_more")) {
				await vscode.env.openExternal(vscode.Uri.parse("https://git-scm.com/downloads"))
			}

			return
		}

		// Git is installed, proceed with initialization
		service.on("initialize", () => {
			log("[Task#getCheckpointService] service initialized")
			task.checkpointServiceInitializing = false
		})

		service.on("checkpoint", ({ fromHash: from, toHash: to, suppressMessage }) => {
			try {
				sendCheckpointInitWarn(task)
				// Always update the current checkpoint hash in the webview, including the suppress flag
				provider?.postMessageToWebview({
					type: "currentCheckpointUpdated",
					text: to,
					suppressMessage: !!suppressMessage,
				})

				// Always create the chat message but include the suppress flag in the payload
				// so the chatview can choose not to render it while keeping it in history.
				task.say(
					"checkpoint_saved",
					to,
					undefined,
					undefined,
					{ from, to, suppressMessage: !!suppressMessage },
					undefined,
					{ isNonInteractive: true },
				).catch((err) => {
					log("[Task#getCheckpointService] caught unexpected error in say('checkpoint_saved')")
					console.error(err)
				})
			} catch (err) {
				log("[Task#getCheckpointService] caught unexpected error in on('checkpoint'), disabling checkpoints")
				console.error(err)
				task.enableCheckpoints = false
			}
		})

		log("[Task#getCheckpointService] initializing shadow git")

		try {
			await service.initShadowGit()
		} catch (err) {
			log(`[Task#getCheckpointService] initShadowGit -> ${err.message}`)
			task.enableCheckpoints = false
		}
	} catch (err) {
		log(`[Task#getCheckpointService] Unexpected error during Git check: ${err.message}`)
		console.error("Git check error:", err)
		task.enableCheckpoints = false
		task.checkpointServiceInitializing = false
	}
}

/**
 * Write metadata for the per-task change journal (B2).
 *
 * `path` is the file path as the tool knows it (relative to the task cwd),
 * consistent with what the B1 per-write checkpoint hooks see. `diffStats` is
 * the { additions, deletions } pair from the approval diff when it was
 * computable; omitted otherwise. ApplyPatchTool passes one entry per file
 * change of a fully successful patch (an array), all sharing the single
 * checkpoint the patch's post-loop hook saves.
 */
export type CheckpointWriteInfo = {
	path: string
	operation: "create" | "update" | "delete"
	diffStats?: { additions: number; deletions: number }
	/**
	 * The unified approval diff for this write, reused verbatim by the B3a
	 * change card (never recomputed).
	 */
	diff?: string
	/**
	 * Whether the tool step was auto-approved (no human interaction). Auto-
	 * approved steps always get the compact ("summary") change card.
	 */
	autoApproved?: boolean
}
/**
 * Thrown when a checkpoint commit succeeded but its journal/card persistence
 * did not. Carries the committed checkpoint id and the complete affected write
 * set so tool callers can report an explicit partial-persistence state
 * instead of a silent full success.
 */
export class CheckpointPartialPersistenceError extends Error {
	constructor(
		message: string,
		readonly checkpointId: string,
		readonly writes: CheckpointWriteInfo[],
	) {
		super(message)
		this.name = "CheckpointPartialPersistenceError"
	}
}

export async function checkpointSave(
	task: Task,
	force = false,
	suppressMessage = false,
	write?: CheckpointWriteInfo | CheckpointWriteInfo[],
) {
	// A save that carries write metadata must end with rollback metadata
	// existing: every failure below (service init-failure, no commit, no
	// journal location, journal write failure) surfaces explicitly instead
	// of resolving to a tool success over an orphaned write. A user-disabled
	// checkpoint setting is NOT such a failure: absence of rollback metadata
	// is then the user's explicit choice, so the save resolves silently
	// (documented contract, see PR description).
	const journalWrites = write === undefined ? undefined : Array.isArray(write) ? write : [write]
	const hasWriteMetadata = !!journalWrites && journalWrites.length > 0

	// Captured before the lookup: getCheckpointService flips the flag off when
	// initialization fails, so reading it after the call cannot distinguish
	// "user disabled checkpoints" (resolve silently) from "init failed while
	// the user expects checkpoints" (throw).
	const checkpointsRequested = task.enableCheckpoints

	const service = await getCheckpointService(task)

	if (!service) {
		if (hasWriteMetadata && checkpointsRequested) {
			throw new Error(
				"Checkpoint save with write metadata could not initialize the checkpoint service; the write has no rollback metadata.",
			)
		}
		return
	}

	// A save that carries write metadata needs a stable journal location for
	// the whole commit + journal transaction. Capture it before the commit:
	// the weak provider reference can disappear while the Git save is
	// awaited, and a commit whose journal update was then silently skipped
	// leaves rollback metadata incomplete with no error surfaced. Without a
	// location at all, fail before committing so the tool reports an
	// explicit failure instead of a checkpoint nobody can roll back.
	const journalDir = task.providerRef.deref()?.context.globalStorageUri.fsPath
	if (hasWriteMetadata && !journalDir) {
		throw new Error(
			"Checkpoint save with write metadata requires a stable journal location, but the provider reference or global storage path is unavailable.",
		)
	}

	TelemetryService.instance.captureCheckpointCreated(task.taskId)

	// Save failures keep the historical behavior for non-write calls:
	// logged, checkpoints disabled, and the save resolves undefined. A
	// write-metadata save must not swallow a failed commit: the file write
	// already happened, so the caller must see an explicit failure instead
	// of a success whose rollback metadata does not exist. Journal/card
	// work below runs only for a real commit, and its failures propagate to
	// the caller instead of flowing through this handler.
	const savePromise = service.saveCheckpoint(`Task: ${task.taskId}, Time: ${Date.now()}`, {
		allowEmpty: force,
		suppressMessage,
	})
	// `void` keeps the historical union member of the awaited legacy
	// catch path (and of this function's return type) unchanged.
	let result: Awaited<typeof savePromise> | void
	if (hasWriteMetadata) {
		try {
			result = await savePromise
		} catch (err) {
			console.error("[Task#checkpointSave] caught unexpected error, disabling checkpoints", err)
			task.enableCheckpoints = false
			throw new Error(
				`Checkpoint save failed after a file write; the write has no rollback metadata: ${err instanceof Error ? err.message : String(err)}`,
				{ cause: err },
			)
		}
	} else {
		result = await savePromise.catch((err) => {
			console.error("[Task#checkpointSave] caught unexpected error, disabling checkpoints", err)
			task.enableCheckpoints = false
		})
	}

	// A save that resolves without a commit (e.g. a write to a Git-ignored
	// file the shadow repository never stages) produced no rollback point:
	// journaling is skipped and a later restore reports no entry. With
	// write metadata that is a partial persistence, not a success.
	if (hasWriteMetadata && !result?.commit) {
		throw new Error(
			"Checkpoint save with write metadata did not produce a commit; the write has no rollback metadata.",
		)
	}
	// B2: record successful file writes in the per-task change journal.
	// Only a real commit produces an entry (an empty or failed save
	// resolves to undefined / rejects), and non-write checkpoint calls
	// (e.g. the task-start baseline) pass no `write` value at all.
	// A no-op checkpoint carries an empty writes array: unrelated workspace
	// changes can still produce a commit, and emitting a card for it would
	// show a change card with zero files. The checkpoint itself still runs.
	if (result?.commit && hasWriteMetadata) {
		const writes = journalWrites ?? []
		if (!journalDir) {
			// Defensive: the pre-commit guard above normally makes this
			// unreachable. If the location is nonetheless gone while the commit
			// succeeded, surface the partial state instead of skipping the
			// journal silently.
			throw new CheckpointPartialPersistenceError(
				`Checkpoint ${result.commit} was committed but no stable journal location was available (files: ${writes
					.map((w) => w.path)
					.join(", ")}); rollback metadata is incomplete.`,
				result.commit,
				writes,
			)
		}
		// Persist the whole step's journal update as one serialized,
		// atomic replacement (temp file + fsync + rename + directory
		// sync), preserving write order. A journal failure is logged and
		// propagated: the checkpoint must not be reported fully durable
		// while its journal entries were lost.
		try {
			await appendChanges(
				journalDir,
				task.taskId,
				writes.map((w) => ({
					path: w.path,
					operation: w.operation,
					checkpointId: result.commit,
					...(w.diffStats ? { diffStats: w.diffStats } : {}),
				})),
			)
		} catch (err) {
			console.error("[Task#checkpointSave] failed to persist change journal entries", err)
			throw new CheckpointPartialPersistenceError(
				`Checkpoint ${result.commit} was committed but its change journal could not be persisted (files: ${writes
					.map((w) => w.path)
					.join(", ")}); rollback metadata is incomplete.`,
				result.commit,
				writes,
			)
		}

		// B3a: emit the per-step change card now that the checkpoint commit
		// exists and the journal update is durable (a journal failure above
		// propagated and skips the card). The card reuses the approval diff/stats the tool already
		// computed and is always emitted (auto-approved steps included);
		// a card failure is logged and never disables checkpoints.
		try {
			const state = await task.providerRef.deref()?.getState()
			const card = buildChangeCardPayload(result.commit, writes, state?.changeCardDetail)
			await task.say("change_card", JSON.stringify(card), undefined, undefined, undefined, undefined, {
				isNonInteractive: true,
			})
		} catch (err) {
			console.error("[Task#checkpointSave] failed to emit change card", err)
		}
	}
	return result
}

export type CheckpointRestoreOptions = {
	ts: number
	commitHash: string
	mode: "preview" | "restore"
	operation?: "delete" | "edit" // Optional to maintain backward compatibility
}

export async function checkpointRestore(
	task: Task,
	{ ts, commitHash, mode, operation = "delete" }: CheckpointRestoreOptions,
) {
	const service = await getCheckpointService(task)

	if (!service) {
		return
	}

	const index = task.clineMessages.findIndex((m) => m.ts === ts)

	if (index === -1) {
		return
	}

	const provider = task.providerRef.deref()

	try {
		await service.restoreCheckpoint(commitHash)
		TelemetryService.instance.captureCheckpointRestored(task.taskId)
		await provider?.postMessageToWebview({ type: "currentCheckpointUpdated", text: commitHash })

		if (mode === "restore") {
			// Calculate metrics from messages that will be deleted (must be done before rewind)
			const deletedMessages = task.clineMessages.slice(index + 1)

			const { totalTokensIn, totalTokensOut, totalCacheWrites, totalCacheReads, totalCost } = getApiMetrics(
				task.combineMessages(deletedMessages),
			)

			// Use MessageManager to properly handle context-management events
			// This ensures orphaned Summary messages and truncation markers are cleaned up
			await task.messageManager.rewindToTimestamp(ts, {
				includeTargetMessage: operation === "edit",
			})

			// Report the deleted API request metrics
			await task.say(
				"api_req_deleted",
				JSON.stringify({
					tokensIn: totalTokensIn,
					tokensOut: totalTokensOut,
					cacheWrites: totalCacheWrites,
					cacheReads: totalCacheReads,
					cost: totalCost,
				} satisfies ClineApiReqInfo),
			)
		}

		// The task is already cancelled by the provider beforehand, but we
		// need to re-init to get the updated messages.
		//
		// This was taken from Cline's implementation of the checkpoints
		// feature. The task instance will hang if we don't cancel twice,
		// so this is currently necessary, but it seems like a complicated
		// and hacky solution to a problem that I don't fully understand.
		// I'd like to revisit this in the future and try to improve the
		// task flow and the communication between the webview and the
		// `Task` instance.
		provider?.cancelTask()
	} catch {
		provider?.log("[checkpointRestore] disabling checkpoints for this task")
		task.enableCheckpoints = false
	}
}

export type CheckpointDiffOptions = {
	ts?: number
	previousCommitHash?: string
	commitHash: string
	/**
	 * from-init: Compare from the first checkpoint to the selected checkpoint.
	 * checkpoint: Compare the selected checkpoint to the next checkpoint.
	 * to-current: Compare the selected checkpoint to the current workspace.
	 * full: Compare from the first checkpoint to the current workspace.
	 */
	mode: "from-init" | "checkpoint" | "to-current" | "full"
}

export async function checkpointDiff(task: Task, { commitHash, mode }: CheckpointDiffOptions) {
	const service = await getCheckpointService(task)

	if (!service) {
		return
	}

	TelemetryService.instance.captureCheckpointDiffed(task.taskId)

	let fromHash: string | undefined
	let toHash: string | undefined
	let title: string

	const checkpoints = task.clineMessages.filter(({ say }) => say === "checkpoint_saved").map(({ text }) => text!)

	if (["from-init", "full"].includes(mode) && checkpoints.length < 1) {
		vscode.window.showInformationMessage(t("common:errors.checkpoint_no_first"))
		return
	}

	const idx = checkpoints.indexOf(commitHash)
	switch (mode) {
		case "checkpoint":
			fromHash = commitHash
			toHash = idx !== -1 && idx < checkpoints.length - 1 ? checkpoints[idx + 1] : undefined
			title = t("common:errors.checkpoint_diff_with_next")
			break
		case "from-init":
			fromHash = checkpoints[0]
			toHash = commitHash
			title = t("common:errors.checkpoint_diff_since_first")
			break
		case "to-current":
			fromHash = commitHash
			toHash = undefined
			title = t("common:errors.checkpoint_diff_to_current")
			break
		case "full":
			fromHash = checkpoints[0]
			toHash = undefined
			title = t("common:errors.checkpoint_diff_since_first")
			break
	}

	if (!fromHash) {
		vscode.window.showInformationMessage(t("common:errors.checkpoint_no_previous"))
		return
	}

	try {
		const changes = await service.getDiff({ from: fromHash, to: toHash })

		if (!changes?.length) {
			vscode.window.showInformationMessage(t("common:errors.checkpoint_no_changes"))
			return
		}

		await vscode.commands.executeCommand(
			"vscode.changes",
			title,
			changes.map((change) => [
				vscode.Uri.file(change.paths.absolute),
				vscode.Uri.parse(`${DIFF_VIEW_URI_SCHEME}:${change.paths.relative}`).with({
					query: Buffer.from(change.content.before ?? "").toString("base64"),
				}),
				vscode.Uri.parse(`${DIFF_VIEW_URI_SCHEME}:${change.paths.relative}`).with({
					query: Buffer.from(change.content.after ?? "").toString("base64"),
				}),
			]),
		)
	} catch {
		const provider = task.providerRef.deref()
		provider?.log("[checkpointDiff] disabling checkpoints for this task")
		task.enableCheckpoints = false
	}
}
