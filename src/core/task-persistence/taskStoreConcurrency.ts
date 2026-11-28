import deepEqual from "fast-deep-equal"
import { attachedMcpToolNamesSchema, type HistoryItem } from "@roo-code/types"

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
	const delta = Object.fromEntries(
		Object.entries(incoming).filter(([key, value]) => !deepEqual(value, (cached as Record<string, unknown>)[key])),
	) as Partial<HistoryItem>
	// Keep the attachment generation with its snapshot even when the cache matches.
	if ("attachedMcpToolNames" in incoming || incoming.mcpToolSelectionEpoch !== undefined) {
		delta.mcpToolSelectionEpoch = incoming.mcpToolSelectionEpoch ?? 0
		delta.attachedMcpToolNames = incoming.attachedMcpToolNames
	}
	return delta
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
	// Replace on a new generation, union within it, and ignore older snapshots.
	const diskEpoch = disk.mcpToolSelectionEpoch ?? 0
	const snapshotEpoch = normalizedDelta.mcpToolSelectionEpoch ?? 0
	const diskNames = attachedMcpToolNamesSchema.parse(disk.attachedMcpToolNames)
	if (snapshotEpoch < diskEpoch) {
		merged.mcpToolSelectionEpoch = disk.mcpToolSelectionEpoch
		merged.attachedMcpToolNames = diskNames
	} else if (snapshotEpoch === diskEpoch) {
		const snapshotNames = normalizedDelta.attachedMcpToolNames
		merged.attachedMcpToolNames = diskNames
		if (snapshotNames !== undefined) {
			merged.attachedMcpToolNames = diskNames ? [...new Set([...diskNames, ...snapshotNames])] : snapshotNames
		}
	} else {
		merged.attachedMcpToolNames = normalizedDelta.attachedMcpToolNames
	}
	if (normalizedDelta.childIds && disk.childIds) {
		merged.childIds = [...new Set([...disk.childIds, ...normalizedDelta.childIds])]
	}
	return merged
}
