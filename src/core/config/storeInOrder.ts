interface Entry {
	write: () => Promise<void>
	resolve: () => void
	reject: (error: unknown) => void
}

interface KeyLine {
	/** Whether a write of this key has started and has not settled. */
	running: boolean
	/** The writes that wait for their turn, oldest first. */
	waiting: Entry[]
}

const lines = new Map<string, KeyLine>()

function startNext(key: string, line: KeyLine): void {
	const entry = line.waiting.shift()
	if (!entry) {
		line.running = false
		if (lines.get(key) === line) lines.delete(key)
		return
	}
	line.running = true
	Promise.resolve()
		.then(entry.write)
		.then(entry.resolve, entry.reject)
		.finally(() => startNext(key, line))
}

/** Takes a write that has not started out of the line, and tells its caller. */
function drop(key: string, line: KeyLine, entry: Entry, reason: unknown): void {
	const index = line.waiting.indexOf(entry)
	if (index === -1) return // it has started, and cannot be taken back
	line.waiting.splice(index, 1)
	entry.reject(reason)
	if (!line.running && line.waiting.length === 0 && lines.get(key) === line) lines.delete(key)
}

/**
 * Stores one setting at a time for each key, in the order the writes were made, whoever makes them: a save, an import,
 * or the public API. A write whose caller gave up waiting (the store cannot be cancelled) may land late; a write of the
 * same key that was made after it must not be stored first and then be overwritten by it, so it waits.
 *
 * A write that has not started can be taken back: when its `signal` aborts (its caller timed out, or its provider was
 * disposed: see `giveUp.ts`). It is then not stored, and its caller is told. A write that has started cannot be taken
 * back, and the writes behind it wait for it; so nothing waits for a caller that has gone, and a store that never
 * settles holds only the writes of callers that are still waiting.
 */
export function storeInOrder(
	key: string,
	write: () => Promise<void>,
	options: { signal?: AbortSignal } = {},
): Promise<void> {
	const { signal } = options
	if (signal?.aborted) return Promise.reject(signal.reason)

	let line = lines.get(key)
	if (!line) {
		line = { running: false, waiting: [] }
		lines.set(key, line)
	}
	const current = line

	return new Promise<void>((resolve, reject) => {
		const entry: Entry = { write, resolve, reject }
		let leave: (() => void) | undefined
		if (signal) {
			leave = () => drop(key, current, entry, signal.reason)
			signal.addEventListener("abort", leave, { once: true })
		}
		const settled = () => leave && signal?.removeEventListener("abort", leave)
		entry.resolve = () => {
			settled()
			resolve()
		}
		entry.reject = (error) => {
			settled()
			reject(error)
		}
		current.waiting.push(entry)
		if (!current.running) startNext(key, current)
	})
}
