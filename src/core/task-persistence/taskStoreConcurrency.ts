import deepEqual from "fast-deep-equal"
import type { HistoryItem } from "@roo-code/types"

import { type HistoryItemStatus, VALID_TASK_STATUS_TRANSITIONS } from "./taskLifecycle"

export class DeltaRejectedError extends Error {
	constructor(
		public readonly taskId: string,
		public readonly diskStatus: HistoryItemStatus,
		public readonly attemptedStatus: HistoryItemStatus,
	) {
		super(`Delta rejected for task ${taskId}: disk status ${diskStatus} rejects transition to ${attemptedStatus}`)
		this.name = "DeltaRejectedError"
	}
}

export function computeHistoryDelta(cached: HistoryItem, incoming: Partial<HistoryItem>): Partial<HistoryItem> {
	return Object.fromEntries(
		Object.entries(incoming).filter(([key, value]) => !deepEqual(value, (cached as Record<string, unknown>)[key])),
	) as Partial<HistoryItem>
}

export function mergeHistoryDelta(existing: unknown, incoming: HistoryItem, delta: Partial<HistoryItem>): HistoryItem {
	if (!existing || typeof existing !== "object" || !("id" in existing)) {
		return incoming
	}
	const disk = existing as HistoryItem
	const normalizedDelta = { ...delta }
	if ("status" in delta) {
		const diskStatus: HistoryItemStatus = disk.status ?? "active"
		const attemptedStatus: HistoryItemStatus = delta.status ?? "active"
		if (attemptedStatus !== diskStatus) {
			const validTargets = VALID_TASK_STATUS_TRANSITIONS[diskStatus]
			if (!validTargets.includes(attemptedStatus)) {
				throw new DeltaRejectedError(disk.id, diskStatus, attemptedStatus)
			}
		}
		normalizedDelta.status = attemptedStatus
	}
	const merged = { ...disk, ...normalizedDelta }
	if (normalizedDelta.childIds && disk.childIds) {
		merged.childIds = [...new Set([...disk.childIds, ...normalizedDelta.childIds])]
	}
	return merged
}
