/**
 * Pure helpers for task nesting depth.
 *
 * Depth is the number of delegation hops from the root task (root = 0).
 * It is derived from the `parentTaskId` chain so that legacy tasks without a
 * persisted `depth` field can be backfilled on load, and so that a corrupted
 * or circular parent chain cannot produce an invalid depth.
 */

/** Maximum ancestor hops to follow before giving up (guards against cycles). */
export const MAX_DEPTH_WALK = 32

export type DepthLookup = (taskId: string) => { parentTaskId?: string; depth?: number } | undefined

function isValidDepth(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0
}

/**
 * Compute the nesting depth for a task.
 *
 * - A persisted `depth` on the task itself is authoritative.
 * - Otherwise, walk up the `parentTaskId` chain:
 *   - if an ancestor has a valid persisted depth, the task sits that many hops below it;
 *   - if we reach a root (no parent) without a persisted depth, the task's depth equals
 *     the number of hops taken to get there (a root is at depth 0);
 *   - on a cycle, a dangling reference, or an overly long chain, return `undefined`
 *     so callers fall back to treating the task as a root without persisting a bogus value.
 */
export function computeTaskDepth(
	taskId: string,
	ownDepth: number | undefined,
	lookup: DepthLookup,
): number | undefined {
	if (isValidDepth(ownDepth)) {
		return ownDepth
	}

	const seen = new Set<string>([taskId])
	let currentId: string | undefined = taskId
	let hopsFromTask = 0

	while (hopsFromTask < MAX_DEPTH_WALK) {
		const node: { parentTaskId?: string; depth?: number } | undefined = currentId ? lookup(currentId) : undefined
		if (!node) {
			// Parent chain references a task we cannot load — stop.
			return undefined
		}
		if (isValidDepth(node.depth)) {
			// Nearest ancestor with an authoritative depth: the original task sits
			// `hopsFromTask` levels below it.
			return node.depth + hopsFromTask
		}
		const parentId: string | undefined = node.parentTaskId
		if (parentId === undefined) {
			// Reached a root without a persisted depth (root = 0).
			return hopsFromTask
		}
		if (seen.has(parentId)) {
			// Cycle detected — refuse to persist a derived depth.
			return undefined
		}
		seen.add(parentId)
		currentId = parentId
		hopsFromTask += 1
	}

	return undefined
}
