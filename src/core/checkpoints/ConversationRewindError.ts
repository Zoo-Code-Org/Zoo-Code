import { t } from "../../i18n"

/**
 * The files were put back to the checkpoint, but the conversation could not be rewound to it (the messages could not be
 * saved, and were left as they were). The task is started again from what is saved, so the workspace and the task are
 * not left apart with the task stopped; the caller still has to tell the user, and may keep an edit for it.
 */
export class ConversationRewindError extends Error {
	/** Whether the task was started again. When it was not, nothing will take a pending edit: the caller hands it back. */
	readonly restarted: boolean

	/** `restartFailure` is given when starting the task again failed too (what failed is in its `error`). */
	constructor(
		override readonly cause: unknown,
		readonly restartFailure?: { error: unknown },
	) {
		super(cause instanceof Error ? cause.message : String(cause))
		this.name = "ConversationRewindError"
		this.restarted = restartFailure === undefined
	}
}

/**
 * What the user is told when a checkpoint restore failed. A restore that put the files back but could not rewind the
 * conversation says so: the files did change, and the task was started again with its previous conversation (or, when
 * that failed too, it has to be started by the user).
 */
export function checkpointRestoreFailureMessage(error: unknown): string {
	const reason = error instanceof Error ? error.message : String(error)
	if (!(error instanceof ConversationRewindError))
		return t("common:errors.checkpoint_restore_failed", { error: reason })
	return t(
		error.restarted ? "common:errors.checkpoint_rewind_failed" : "common:errors.checkpoint_rewind_restart_failed",
		{ error: reason },
	)
}
