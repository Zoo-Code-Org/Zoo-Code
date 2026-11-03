import type { HistoryItem } from "@roo-code/types"

/** Valid status values for a task's HistoryItem. */
export type HistoryItemStatus = NonNullable<HistoryItem["status"]>

export const VALID_TASK_STATUS_TRANSITIONS: Readonly<Record<HistoryItemStatus, readonly HistoryItemStatus[]>> = {
	active: ["delegated", "completed", "interrupted"],
	delegated: ["active"],
	interrupted: ["completed"],
	completed: [],
}

export class LifecycleTransitionError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "LifecycleTransitionError"
	}
}

export function assertValidTransition(from: HistoryItemStatus | undefined, to: HistoryItemStatus): void {
	const fromStatus: HistoryItemStatus = from ?? "active"
	if (!VALID_TASK_STATUS_TRANSITIONS[fromStatus].includes(to)) {
		throw new LifecycleTransitionError(`Invalid task status transition: ${fromStatus} → ${to}`)
	}
}

/**
 * Settles the pending create_subtask action whose delegation the authoritative
 * parent record rejected (#1714). Only the exact matching action ID is cleared;
 * status, lineage, accounting, and unrelated fields are preserved. A replaced
 * or different-kind pending action is never cleared.
 */
export function settleRejectedCreateSubtaskAction(parent: HistoryItem, pendingActionId: string): HistoryItem {
	const pending = parent.pendingAction
	if (parent.status === "completed") {
		return parent
	}
	if (pending?.kind !== "create_subtask" || pending.actionId !== pendingActionId) {
		return parent
	}
	return { ...parent, pendingAction: undefined }
}

export function delegateTaskToChild(
	parent: HistoryItem,
	childId: string,
	awaitedChildStatus?: HistoryItemStatus,
): HistoryItem {
	let base = parent
	if (parent.status === "delegated") {
		if (awaitedChildStatus !== "interrupted") {
			throw new LifecycleTransitionError(
				`Cannot re-delegate task ${parent.id}: existing child ${parent.awaitingChildId} is ${awaitedChildStatus}, not interrupted`,
			)
		}
		base = {
			...parent,
			status: "active",
			awaitingChildId: undefined,
			delegatedToId: undefined,
		}
	}

	assertValidTransition(base.status, "delegated")
	return {
		...base,
		status: "delegated",
		delegatedToId: childId,
		awaitingChildId: childId,
		childIds: Array.from(new Set([...(base.childIds ?? []), childId])),
	}
}

export function interruptDelegatedChild(parent: HistoryItem, child: HistoryItem): HistoryItem {
	if (parent.status !== "delegated" || parent.awaitingChildId !== child.id) {
		throw new LifecycleTransitionError(`Task ${parent.id} is not delegated to child ${child.id}`)
	}
	assertValidTransition(child.status, "interrupted")
	return { ...child, status: "interrupted" }
}

export function completeDelegatedChild(
	parent: HistoryItem,
	child: HistoryItem,
	completionResultSummary: string,
): { parent: HistoryItem; child: HistoryItem } {
	if ((parent.status !== "delegated" && parent.status !== "active") || parent.awaitingChildId !== child.id) {
		throw new LifecycleTransitionError(`Task ${parent.id} is not delegated to child ${child.id}`)
	}
	assertValidTransition(child.status, "completed")
	if (parent.status !== "active") assertValidTransition(parent.status, "active")

	return {
		child: {
			...child,
			status: "completed",
			completionResultSummary,
		},
		parent: {
			...parent,
			status: "active",
			completedByChildId: child.id,
			completionResultSummary,
			awaitingChildId: undefined,
			delegatedToId: undefined,
			childIds: Array.from(new Set([...(parent.childIds ?? []), child.id])),
		},
	}
}

export function abandonDelegatedChild(
	parent: HistoryItem,
	child: HistoryItem,
): { parent: HistoryItem; child: HistoryItem } {
	if (parent.status !== "delegated" || parent.awaitingChildId !== child.id) {
		throw new LifecycleTransitionError(`Task ${parent.id} is not delegated to child ${child.id}`)
	}
	if (child.status !== "interrupted") {
		throw new LifecycleTransitionError(`Cannot abandon child ${child.id} with status ${child.status}`)
	}
	assertValidTransition(parent.status, "active")

	return {
		child: { ...child, parentTaskId: undefined, rootTaskId: undefined },
		parent: {
			...parent,
			status: "active",
			awaitingChildId: undefined,
			delegatedToId: undefined,
		},
	}
}

/**
 * Returns true when a liveness timestamp is fresh relative to `now`: present,
 * less than `thresholdMs` old, and no further than `thresholdMs` in the
 * future.
 *
 * The bounded future window is the threat model. A timestamp a little ahead of
 * `now` is ordinary clock skew between windows, or the future-shifted sentinel
 * `getChildFileMtimeMs` returns for a transient stat failure (`now + threshold
 * - 1`, one millisecond inside the bound so the strict `<` below keeps it
 * fresh, and repair is skipped for a later tick to retry). A timestamp far
 * ahead is not evidence of life: it is a dead record whose clock rolled back,
 * or one restored from an archive, and treating it as live would keep the
 * parent delegated forever across startup and every periodic tick. Both
 * directions therefore share one bound, so anything inside it stays fresh
 * while anything at or beyond it does not. An absent timestamp is never fresh —
 * callers must treat "no signal" as "not evidence of life".
 */
export function isLivenessSignalFresh(timestamp: number | undefined, now: number, thresholdMs: number): boolean {
	return timestamp !== undefined && Math.abs(now - timestamp) < thresholdMs
}

/**
 * Cross-instance liveness decision for an active delegated child, owned by
 * the shared reconciliation guard in `TaskHistoryStore` (startup/periodic
 * orphan repair and repair-intent replay).
 *
 * A child is live when EITHER signal is fresh within `thresholdMs`:
 * - its history file mtime (`fileMtimeMs`) — another window is persisting it;
 * - its persisted `lastActivityAt` heartbeat — the owning session is running
 *   a long turn that legitimately writes nothing else to the history file
 *   (minutes of model streaming between saves).
 *
 * Requiring both signals to be stale before repair is what keeps a live
 * child streamed by another window (or by this window before an
 * extension-host restart wiped the local ownership claim) from being
 * misjudged as a crash orphan and cut out of its delegation link.
 */
export function isDelegatedChildLive(
	child: Pick<HistoryItem, "lastActivityAt">,
	now: number,
	thresholdMs: number,
	fileMtimeMs?: number,
): boolean {
	return (
		isLivenessSignalFresh(fileMtimeMs, now, thresholdMs) ||
		isLivenessSignalFresh(child.lastActivityAt, now, thresholdMs)
	)
}

/**
 * Administrative missing-child repair target: the lifecycle fields a delegated
 * parent must reach when the child record it awaits is gone. This is the single
 * source of truth for both sides — `TaskHistoryStore` writes it as its
 * under-lock repair delta and the lifecycle model checker derives its repaired
 * parent from the same constant, so the two cannot drift.
 *
 * This is NOT the active-child (crash-orphan) repair target. That repair stops at
 * the child half and leaves the parent `delegated` with `awaitingChildId` intact,
 * so a resumed child's result still routes back; `interruptDelegatedChild`
 * supplies the child side of it.
 */
export const DELEGATED_PARENT_REPAIR_FIELDS = {
	status: "active",
	awaitingChildId: undefined,
	delegatedToId: undefined,
} as const satisfies Partial<HistoryItem>
