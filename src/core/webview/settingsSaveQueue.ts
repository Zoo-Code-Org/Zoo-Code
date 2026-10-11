// Serialize writes sharing a ContextProxy, but keep waiting jobs removable on disposal.
// VS Code persistence has no cancellation API: an active write must settle before
// another view can write to the same context, even after its caller is cancelled.
type SaveJob = { run: () => Promise<void> }
type SaveQueue = { pending: Set<SaveJob>; running: boolean }
const queues = new WeakMap<object, SaveQueue>()

export function enqueueSettingsSave(context: object, signal: AbortSignal, write: () => Promise<void>): Promise<void> {
	signal.throwIfAborted()
	let queue = queues.get(context)
	if (!queue) {
		queue = { pending: new Set(), running: false }
		queues.set(context, queue)
	}
	const currentQueue = queue
	return new Promise<void>((resolve, reject) => {
		const onAbort = () => {
			currentQueue.pending.delete(job)
			signal.removeEventListener("abort", onAbort)
			reject(signal.reason)
		}
		const job: SaveJob = {
			run: async () => {
				try {
					signal.throwIfAborted()
					await write()
					resolve()
				} catch (error) {
					reject(error)
				} finally {
					signal.removeEventListener("abort", onAbort)
				}
			},
		}
		signal.addEventListener("abort", onAbort, { once: true })
		currentQueue.pending.add(job)
		void drain(context, currentQueue)
	})
}

async function drain(context: object, queue: SaveQueue): Promise<void> {
	if (queue.running) return
	queue.running = true
	try {
		for (const job of queue.pending) {
			queue.pending.delete(job)
			await job.run()
		}
	} finally {
		queues.delete(context)
	}
}
