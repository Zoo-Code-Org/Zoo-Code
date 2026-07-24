/**
 * Batch tool asks that are near each other, allowing ignorable messages in between.
 *
 * Unlike `batchConsecutive` which only merges truly adjacent items, this function
 * merges items of the same type even when separated by low-information or invisible
 * messages (e.g., api_req_started/finished, empty text rows, partial streaming).
 *
 * It stops merging when it hits a "semantic boundary": user feedback, visible assistant
 * text, completion result, different tool group, checkpoint, error, etc.
 */

export interface BatchNearbyOptions<T> {
	/** Returns true if this item is the target type to batch (e.g., readFile ask) */
	isTarget: (item: T) => boolean
	/** Returns true if this item can be skipped over when looking for more targets */
	isIgnorableBetweenTargets: (item: T) => boolean
	/** Returns true if this item is a semantic boundary that stops merging */
	isBoundary: (item: T) => boolean
	/** Synthesize a batch of items into a single item */
	synthesize: (batch: T[]) => T
}

/**
 * Walk an item array and batch runs of items matching `isTarget`, allowing
 * ignorable messages between them. Stops at semantic boundaries.
 *
 * - Runs of length 1 are passed through unchanged.
 * - Runs of length >= 2 are replaced by a single synthetic item.
 * - Non-matching / boundary items are preserved in-order.
 */
export function batchNearby<T>(items: T[], options: BatchNearbyOptions<T>): T[] {
	const { isTarget, isIgnorableBetweenTargets, isBoundary, synthesize } = options

	const result: T[] = []
	let i = 0

	while (i < items.length) {
		if (isBoundary(items[i])) {
			// Boundary stops any current batch and is preserved as-is
			result.push(items[i])
			i++
		} else if (isTarget(items[i])) {
			// Start collecting a batch of targets, skipping ignorable messages in between
			const batch: T[] = [items[i]]
			let j = i + 1
			const pendingIgnorable: T[] = []

			while (j < items.length) {
				if (isBoundary(items[j])) {
					break // boundary stops the batch
				}
				if (isTarget(items[j])) {
					batch.push(items[j])
					j++
				} else if (isIgnorableBetweenTargets(items[j])) {
					pendingIgnorable.push(items[j]) // track but don't commit yet
					j++
				} else {
					break // non-ignorable, non-target message stops the batch
				}
			}

			if (batch.length > 1) {
				// Bridge succeeded — pending ignorable items are metadata consumed by the batch
				result.push(synthesize(batch))
			} else {
				// Bridge failed — restore pending ignorable items to preserve in-order semantics
				result.push(batch[0])
				if (pendingIgnorable.length > 0) {
					result.push(...pendingIgnorable)
				}
			}

			i = j // items[j] was not consumed — re-examine it on next iteration
		} else {
			// Non-target, non-boundary item — preserve as-is
			result.push(items[i])
			i++
		}
	}

	return result
}
