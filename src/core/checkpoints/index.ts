import pWaitFor from "p-wait-for"
import * as vscode from "vscode"

import type { ClineApiReqInfo } from "@roo-code/types"
import { DEFAULT_CHECKPOINT_TIMEOUT_SECONDS } from "@roo-code/types"
import { TelemetryService } from "@roo-code/telemetry"

import { Task } from "../task/Task"

import { getWorkspacePath } from "../../utils/path"
import { checkGitInstalled } from "../../utils/git"
import { t } from "../../i18n"

import { getApiMetrics } from "../../shared/getApiMetrics"

import { DIFF_VIEW_URI_SCHEME } from "../../integrations/editor/DiffViewProvider"

import { CheckpointServiceOptions, RepoPerTaskCheckpointService } from "../../services/checkpoints"

import { assertRecordedCheckpoint } from "./recordedCheckpoint"

const WARNING_THRESHOLD_MS = 5000

function sendCheckpointInitWarn(task: Task, type?: "WAIT_TIMEOUT" | "INIT_TIMEOUT", timeout?: number) {
	task.providerRef.deref()?.postMessageToWebview({
		type: "checkpointInitWarning",
		checkpointWarning: type && timeout ? { type, timeout } : undefined,
	})
}

/** In-flight shadow-git initializations per task. Creating the service and running
 * initShadowGit is the one checkpoint operation the per-task work queue below does not cover,
 * so it carries its own handle: a caller whose own bounded wait expires must not release an
 * initialization it did not start, because a released lookup creates a second
 * RepoPerTaskCheckpointService over the same task directory while the first is still
 * committing. The entry leaves the map only when the operation settles, so a late caller
 * either joins it or finds it gone, never both. */
const checkpointInits = new Map<string, Promise<RepoPerTaskCheckpointService | undefined>>()

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

		const inFlight = checkpointInits.get(task.taskId)

		if (inFlight || task.checkpointServiceInitializing) {
			const checkpointInitStartTime = Date.now()
			let warningShown = false

			try {
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
			} catch (error) {
				// A handle still in the map means the initialization this caller joined is still
				// running: this caller's window closing is that caller's timeout, not the outcome of
				// the operation it waited on. Report no service and change nothing else - the caller
				// that started the initialization still owns the task's checkpoint state, and a later
				// lookup joins the same operation instead of creating a second shadow git for the
				// same task.
				if (error.name === "TimeoutError" && inFlight) {
					sendCheckpointInitWarn(task, "WAIT_TIMEOUT", checkpointTimeoutMs / 1000)
					return undefined
				}

				throw error
			}

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

		const starting = (async () => {
			const service = RepoPerTaskCheckpointService.create(options)
			task.checkpointServiceInitializing = true
			await checkGitInstallation(task, service, log, provider)
			if (!service.isInitialized) {
				// checkGitInstallation disables checkpoints when Git is unavailable and
				// logs initShadowGit failures without throwing: storing such a service
				// would hand later saves (and the fast path above) an uninitialized
				// handle whose isInitialized can never flip, so a failed
				// initialization must resolve to no service at all.
				task.checkpointServiceInitializing = false
				return undefined
			}
			task.checkpointService = service
			if (task.enableCheckpoints) {
				sendCheckpointInitWarn(task)
			}
			return service
		})()

		// Registered before this side awaits anything, so a lookup arriving on the next tick joins
		// this initialization instead of racing it into a second service.
		checkpointInits.set(task.taskId, starting)

		try {
			return await starting
		} finally {
			// Settled is the only moment the operation stops being shared: success or failure, the
			// handle leaves the map when the work it names is over, not when a caller loses patience.
			if (checkpointInits.get(task.taskId) === starting) {
				checkpointInits.delete(task.taskId)
			}
		}
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
			// The "initialize" event never fires for a failed initShadowGit, so
			// clear the flag here or later lookups wait on an initialization
			// that already died.
			task.checkpointServiceInitializing = false
		}
	} catch (err) {
		log(`[Task#getCheckpointService] Unexpected error during Git check: ${err.message}`)
		console.error("Git check error:", err)
		task.enableCheckpoints = false
		task.checkpointServiceInitializing = false
	}
}

// Serialize checkpoint work per task. saveCheckpoint() runs stageAll + commit and
// restoreCheckpoint() resets the workspace through the same shadow git, so two concurrent
// operations for the same task (for example the task-start baseline racing the first
// per-write save after the baseline timeout, or a restore while a per-write save is still
// queued) can stage each other's writes or interleave commits. A per-task promise queue
// makes every save and every restore wait for the previous one, including a baseline that
// is still running.
const checkpointWorkQueues = new Map<string, Promise<unknown>>()

type QueuedCheckpointWorkOptions = {
	/** Human-readable name used in the skip warning, e.g. "queued per-write checkpoint save". */
	label: string
	/** Wall-clock deadline after which the operation must not start: a save requested behind a
	 * stalled predecessor stages whatever the workspace looks like when it finally gets its turn,
	 * which is not the state the caller asked to record. Omit for work that must run whenever its
	 * turn arrives, such as a user-initiated restore. */
	expiresAt?: number
	/** Checked when the operation's turn arrives, not when it is requested: a task that was canceled
	 * while its work was queued performs no checkpoint work. */
	isCanceled?: () => boolean
}

const DEFAULT_QUEUED_WORK_OPTIONS: QueuedCheckpointWorkOptions = { label: "checkpoint work" }

function enqueueCheckpointWork<T>(
	taskId: string,
	operation: () => Promise<T>,
	options: QueuedCheckpointWorkOptions = DEFAULT_QUEUED_WORK_OPTIONS,
): Promise<T | undefined> {
	const previous = checkpointWorkQueues.get(taskId) ?? Promise.resolve()
	// Both arms of the previous settlement get the same gate, so a failed predecessor does not
	// smuggle an expired or canceled operation past it.
	// attempt may return the operation's promise or nothing at all; Promise.then flattens the
	// former and resolves the latter, which is exactly the two outcomes callers need.
	// Whether the deadline arm below already let this caller go. attempt reads it, because the
	// expiry test in the gate asks whether the clock is past the deadline, and a predecessor that
	// settles in the very millisecond the deadline falls in has not passed it: without this record
	// the released caller would hold the answer the release gave it and the operation would start
	// anyway. Releasing a wait only means the wait is over if the released work cannot start.
	let releasedByDeadline = false
	const attempt = (): T | Promise<T> | undefined => {
		const expired = options.expiresAt !== undefined && Date.now() > options.expiresAt
		let reason: string | undefined
		if (expired) {
			reason = "expired behind a slower checkpoint"
		} else if (releasedByDeadline) {
			reason = "released at its deadline while a slower checkpoint was still running"
		} else if (options.isCanceled?.()) {
			reason = "task canceled"
		}
		if (reason !== undefined) {
			console.warn(
				`[checkpoints] skipping ${options.label} for task ${taskId}: ${reason}; it never reached the shadow git`,
			)
			return undefined
		}
		return operation()
	}
	// Whether the operation ahead of this caller has released the queue. The deadline below
	// releases a wait, so it must stop being able to once the caller's own turn has arrived:
	// from that point the caller is either running or already dropped by the gate above.
	let predecessorSettled = false
	void previous.then(
		() => {
			predecessorSettled = true
		},
		() => {
			predecessorSettled = true
		},
	)
	const next = previous.then(attempt, attempt)
	const tail = next.then(
		() => undefined,
		() => undefined,
	)
	checkpointWorkQueues.set(taskId, tail)
	void tail.finally(() => {
		if (checkpointWorkQueues.get(taskId) === tail) {
			checkpointWorkQueues.delete(taskId)
		}
	})
	if (options.expiresAt === undefined) {
		return next
	}
	// The deadline below bounds the wait as well as the start. A caller whose window closes
	// while its predecessor is still running is released now, the way it is released when its
	// turn arrives: no work ran and the caller resolves with no commit, which is how a dropped
	// save and a missing service are already reported. The queue itself keeps waiting on the
	// predecessor, so the lock is not handed to the operation behind this one early, and the
	// release is recorded for attempt to honour when that predecessor settles, so a released
	// operation never starts late - not even in the millisecond the deadline falls in, which is
	// the one reading the expiry test alone cannot tell apart from a turn arriving on time. A
	// user-initiated restore carries no expiry and keeps waiting for its turn, which is what
	// dropping one would mean the loss of.
	const waitMs = Math.max(0, options.expiresAt - Date.now())
	let stopWaitTimer = (): void => {}
	const releasedAtDeadline = new Promise<undefined>((resolve) => {
		const timer = setTimeout(() => {
			if (predecessorSettled) {
				// Its turn arrived, so there is no wait left to release. The operation either ran
				// or the gate above dropped it, and next carries whichever answer that was.
				return
			}
			console.warn(
				`[checkpoints] releasing the wait for ${options.label} for task ${taskId}: its window closed while a slower checkpoint was still running; the queue keeps the lock and this operation will not start late`,
			)
			// Latched before the caller is released, so the gate at the top of this function sees the
			// release even when the clock has not moved past the deadline by the time the predecessor
			// settles. Order matters: setting it after resolve would let a settled predecessor start
			// the work in between.
			releasedByDeadline = true
			resolve(undefined)
		}, waitMs)
		stopWaitTimer = (): void => {
			clearTimeout(timer)
			resolve(undefined)
		}
	})
	// Whichever arm settles first ends the caller's wait, so the timer is cancelled on the
	// normal path and the caller keeps the result it already had on the released path.
	void next.then(stopWaitTimer, stopWaitTimer)
	return Promise.race([next, releasedAtDeadline])
}

export async function checkpointSave(task: Task, force = false, suppressMessage = false) {
	const service = await getCheckpointService(task)

	if (!service) {
		return
	}

	TelemetryService.instance.captureCheckpointCreated(task.taskId)

	// Start the checkpoint process in the background, queued behind any checkpoint work
	// already running for this task so stageAll + commit never overlap. The queue is not only a
	// lock: a save that is still queued past the caller's own checkpoint window is describing a
	// workspace that has moved on, so it is dropped rather than started late, and a save queued by a
	// task that has since been canceled performs no checkpoint work at all. A dropped save is
	// reported to the caller the same way a missing service is (a resolve with no commit), which is
	// how the task-start baseline already treats it - by retrying on a later loop entry.
	const timeoutSeconds = task.checkpointTimeout > 0 ? task.checkpointTimeout : DEFAULT_CHECKPOINT_TIMEOUT_SECONDS
	// A task-start baseline describes the workspace before any agent write: it is the rollback point for
	// the first write of the request loop. The queue orders this save behind whatever is already running,
	// but ordering is not content - saveCheckpoint stages when it executes - so a baseline that is still
	// running when the first write lands would commit the write bytes as the pre-task state, and the
	// per-write save queued behind it would then find nothing to commit. The branch taken here is to
	// decline to publish. The other branch the ask names - freezing what the baseline stages, by copying
	// the workspace at request time or by staging and writing a tree then - is worse: either does its
	// expensive git work outside the very lock whose comment claims it makes late work safe, a copy can
	// catch a file half-written and so records a state that is neither pre-write nor post-write, and it
	// would leave the shadow git meaning two different things by what the workspace looked like. A
	// declined baseline costs the caller nothing it does not already handle: a resolve with no commit is
	// how a dropped save is reported today, which is how the task-start baseline already treats it - by
	// retrying on a later loop entry. The content the task started with stays recorded in the
	// initialization commit, and the write keeps a record of its own whose diff base is that content.
	// Per-write saves carry no premise, because recording the workspace as it stands when the save runs
	// is exactly what a per-write save is for.
	const requestedBeforeAnyWrite = force && !task.didEditFile
	return enqueueCheckpointWork(
		task.taskId,
		() =>
			service.saveCheckpoint(`Task: ${task.taskId}, Time: ${Date.now()}`, {
				allowEmpty: force,
				suppressMessage,
				contentPremise: requestedBeforeAnyWrite ? () => !task.didEditFile : undefined,
			}),
		{
			label: force ? "queued task-start checkpoint baseline" : "queued per-write checkpoint save",
			expiresAt: Date.now() + Math.max(1, timeoutSeconds * 1000),
			isCanceled: () => task.abort,
		},
	).catch((err) => {
		console.error("[Task#checkpointSave] caught unexpected error, disabling checkpoints", err)
		task.enableCheckpoints = false
	})
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
	assertRecordedCheckpoint(task, commitHash)

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
		// The same per-task lock the saves use, in both directions: a restore resets the
		// workspace through shadow git, so a queued save must not stage and commit while it
		// is running (that save would record the restored bytes and drop the write's own
		// checkpoint), and a restore requested during a save waits for that save to settle.
		await enqueueCheckpointWork(task.taskId, () => service.restoreCheckpoint(commitHash))
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
	} catch (error) {
		provider?.log("[checkpointRestore] failed to restore checkpoint")
		throw error
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
	try {
		assertRecordedCheckpoint(task, commitHash)
	} catch (error) {
		void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error))
		return
	}

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
