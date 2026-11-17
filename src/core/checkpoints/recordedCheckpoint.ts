import type { Task } from "../task/Task"
import { t } from "../../i18n"

// `git init` honours the user's init.defaultObjectFormat, so full hashes are SHA-1 or SHA-256.
const FULL_COMMIT_HASH = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

// The hash arrives from the webview, so it must name a checkpoint this task recorded before reaching Git.
export function assertRecordedCheckpoint(
	task: Pick<Task, "clineMessages">,
	commitHash: unknown,
): asserts commitHash is string {
	const isRecorded =
		typeof commitHash === "string" &&
		FULL_COMMIT_HASH.test(commitHash) &&
		task.clineMessages.some(({ say, text }) => say === "checkpoint_saved" && text === commitHash)

	if (!isRecorded) {
		throw new Error(t("common:errors.checkpoint_invalid_hash"))
	}
}
