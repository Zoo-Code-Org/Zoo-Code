/** What the helper needs of the hub (the shared `McpHub`): the one call that applies a change. */
interface McpEnabledTarget {
	handleMcpEnabledChange(enabled: boolean): Promise<void>
}

interface Running {
	value: boolean
	promise: Promise<void>
}

/** The one change that waits behind the running one. Later values replace its value: only the latest is applied. */
interface Pending {
	value: boolean
	promise: Promise<void>
	resolve: () => void
	reject: (error: unknown) => void
}

interface HubChanges {
	running?: Running
	pending?: Pending
	/** The value of the change that was started last. */
	last?: boolean
	reconciling: boolean
}

/** What is in line for each hub. A hub is shared by every provider, so this is across providers too. */
const hubs = new WeakMap<McpEnabledTarget, HubChanges>()

const changesOf = (hub: McpEnabledTarget): HubChanges => {
	let changes = hubs.get(hub)
	if (!changes) {
		changes = { reconciling: false }
		hubs.set(hub, changes)
	}
	return changes
}

function start(hub: McpEnabledTarget, changes: HubChanges, value: boolean): Promise<void> {
	const running: Running = { value, promise: Promise.resolve() }
	changes.last = value

	const finish = (succeeded: boolean) => {
		changes.running = undefined
		const next = changes.pending
		changes.pending = undefined
		if (!next) return
		// The value that was applied is the one that is wanted now: there is nothing left to do.
		if (succeeded && next.value === value) next.resolve()
		else start(hub, changes, next.value).then(next.resolve, next.reject)
	}

	running.promise = Promise.resolve()
		.then(() => hub.handleMcpEnabledChange(value))
		.then(
			() => finish(true),
			(error: unknown) => {
				finish(false)
				throw error
			},
		)
	// Whoever waits for it sees its failure; a caller that gave up waiting leaves no rejection unhandled.
	running.promise.catch(() => undefined)
	changes.running = running
	return running.promise
}

/**
 * Applies a change of the MCP switch to the hub, one at a time per hub, with at most one change waiting behind the one
 * under way. A save that is sent again (the webview retries one that was not answered in time) carries the same switch:
 * while that change is still being applied, the retry joins it instead of starting another one, so a disconnect that is
 * under way is not started a second time on a transport that is closing (the hub removes a connection only after its
 * close has finished). A different value waits for the change that is under way, so the changes are applied in the order
 * they were made. What waits is only the latest value: a change that never started is replaced by a newer one (every
 * caller that waited for it is answered by the one that runs), so a stalled change cannot make a queue grow.
 */
export function changeMcpEnabled(hub: McpEnabledTarget, value: boolean): Promise<void> {
	const changes = changesOf(hub)
	const { running, pending } = changes
	if (!running) return start(hub, changes, value)

	if (pending) {
		pending.value = value
		return pending.promise
	}
	if (running.value === value) return running.promise

	let resolve!: () => void
	let reject!: (error: unknown) => void
	const promise = new Promise<void>((res, rej) => {
		resolve = res
		reject = rej
	})
	promise.catch(() => undefined)
	changes.pending = { value, promise, resolve, reject }
	return promise
}

/**
 * Brings the hub to the stored setting once every change that is in line has settled, however each ends. For a save that
 * gave up waiting on a change: that change may still land late, and must not leave the hub other than the setting says.
 * One of these runs per hub, and it looks at what is stored when the changes are done, so several saves that gave up
 * leave one reconciliation behind, not one each. Nothing is applied if the stored value is the one the hub got last.
 */
export async function reconcileMcpEnabled(hub: McpEnabledTarget, getStored: () => boolean): Promise<void> {
	const changes = changesOf(hub)
	if (changes.reconciling) return
	changes.reconciling = true
	try {
		for (;;) {
			// A change that waits is only ever behind one that runs: when that one settles, the next one is running.
			const running = changes.running?.promise
			if (running) {
				await running.catch(() => undefined)
				continue
			}
			// Nothing is running: the hub has what the last change gave it. If a change that came in while this one was under
			// way (a save that timed out and joined the reconciliation) moved it from what is stored, bring it back.
			const stored = getStored()
			if (stored === changes.last) break
			let failed = false
			await changeMcpEnabled(hub, stored).catch(() => {
				failed = true
			})
			// A change that failed is not repeated here: the loop would not end.
			if (failed) break
		}
	} finally {
		changes.reconciling = false
	}
}
