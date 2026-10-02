/**
 * Per-step change card builder (B3a).
 *
 * The card is emitted from `checkpointSave` (index.ts) once the per-write
 * checkpoint commit exists, so the payload can key the card by the real
 * checkpoint ID and reuse the approval diff + stats the tool already
 * computed (threaded through {@link CheckpointWriteInfo}). The card is
 * informational and always emitted for write steps, including auto-approved
 * ones — which always get the compact ("summary") form regardless of the
 * `changeCardDetail` setting.
 */
import { DEFAULT_CHANGE_CARD_DETAIL, type ChangeCardData, type ChangeCardDetail } from "@roo-code/types"

/**
 * The write data a change card is built from. Structurally compatible with
 * `CheckpointWriteInfo` (src/core/checkpoints/index.ts), minus the
 * `operation` field the card does not need.
 */
export interface ChangeCardWrite {
	/** The file path as the tool knows it (relative to the task cwd). */
	path: string
	/** { additions, deletions } from the approval diff, when computable. */
	diffStats?: { additions: number; deletions: number }
	/** The unified approval diff for this file (reused, not recomputed). */
	diff?: string
	/** Whether the tool step was auto-approved (no human interaction). */
	autoApproved?: boolean
}

/**
 * Whether every write of the step was auto-approved. Empty steps are not
 * auto-approved (there is nothing for the user to have skipped).
 */
export function isAutoApprovedStep(writes: readonly ChangeCardWrite[]): boolean {
	return writes.length > 0 && writes.every((write) => write.autoApproved === true)
}

/**
 * Resolve the card detail level for a step:
 * - auto-approved steps always get the compact "summary" card, regardless of
 *   the user setting (cards for steps the user never saw approving are
 *   informational only);
 * - otherwise the `changeCardDetail` setting applies, defaulting to
 *   "summary" when unset.
 */
export function resolveChangeCardDetail(
	writes: readonly ChangeCardWrite[],
	setting: ChangeCardDetail | undefined,
): ChangeCardDetail {
	if (isAutoApprovedStep(writes)) {
		return "summary"
	}
	return setting ?? DEFAULT_CHANGE_CARD_DETAIL
}

/**
 * Build the typed change-card payload for one step (one per-write checkpoint).
 *
 * With `detail: "full"` each file carries its unified diff inline; with
 * `detail: "summary"` the diff is omitted and the UI fetches it lazily
 * (B3b).
 */
export function buildChangeCard(
	checkpointId: string,
	writes: readonly ChangeCardWrite[],
	detail: ChangeCardDetail,
): ChangeCardData {
	return {
		checkpointIds: [checkpointId],
		files: writes.map((write) => ({
			path: write.path,
			additions: write.diffStats?.additions ?? 0,
			deletions: write.diffStats?.deletions ?? 0,
			...(detail === "full" && write.diff ? { diff: write.diff } : {}),
		})),
		totalFiles: writes.length,
		detail,
	}
}

/**
 * Convenience wrapper: resolve the detail level from the step + setting, then
 * build the payload. This is what `checkpointSave` calls.
 */
export function buildChangeCardPayload(
	checkpointId: string,
	writes: readonly ChangeCardWrite[],
	setting: ChangeCardDetail | undefined,
): ChangeCardData {
	return buildChangeCard(checkpointId, writes, resolveChangeCardDetail(writes, setting))
}
