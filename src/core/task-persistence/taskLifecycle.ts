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
		throw new Error(`Invalid task status transition: ${fromStatus} → ${to}`)
	}
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
