interface Waiting {
	write: () => Promise<void>
	promise: Promise<void>
	resolve: () => void
	reject: (error: unknown) => void
}

interface KeySlot {
	/** Whether a write of this key has started and has not settled. */
	running: boolean
	/** The one write that waits behind it. A newer write replaces it: only the latest value is stored. */
	waiting?: Waiting
}

const slots = new Map<string, KeySlot>()

function run(key: string, slot: KeySlot, write: () => Promise<void>): Promise<void> {
	slot.running = true
	const done = Promise.resolve()
		.then(write)
		.finally(() => {
			slot.running = false
			const next = slot.waiting
			slot.waiting = undefined
			if (!next) {
				if (slots.get(key) === slot) slots.delete(key)
				return
			}
			run(key, slot, next.write).then(next.resolve, next.reject)
		})
	// Whoever waits for it sees its failure; a caller that gave up waiting leaves no rejection unhandled.
	done.catch(() => undefined)
	return done
}

/**
 * Stores one setting at a time for each key, in the order the saves were made. A save whose wait for a store was given up
 * (the store cannot be cancelled) may be sent again with a newer value: that value must not be written first and then
 * overwritten by the older write that lands late. At most one write waits behind the one that runs, and a newer write
 * replaces it, so a store that never settles does not make a line of writes grow.
 */
export function storeInOrder(key: string, write: () => Promise<void>): Promise<void> {
	let slot = slots.get(key)
	if (!slot) {
		slot = { running: false }
		slots.set(key, slot)
	}
	if (!slot.running) return run(key, slot, write)

	if (slot.waiting) {
		slot.waiting.write = write
		return slot.waiting.promise
	}
	let resolve!: () => void
	let reject!: (error: unknown) => void
	const promise = new Promise<void>((res, rej) => {
		resolve = res
		reject = rej
	})
	promise.catch(() => undefined)
	slot.waiting = { write, promise, resolve, reject }
	return promise
}
