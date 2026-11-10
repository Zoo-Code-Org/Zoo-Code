/** What the helper needs of the hub (the shared `McpHub`): the one call that applies a change. */
interface McpEnabledTarget {
	handleMcpEnabledChange(enabled: boolean): Promise<void>
}

interface Running {
	value: boolean
	promise: Promise<void>
}

/**
 * The one change that waits behind the running one. Later values replace its value: only the latest is applied. It is
 * kept while a save that is still waiting for it asks for it: when every one of them has given up, it is dropped.
 */
interface Pending {
	value: boolean
	/** The values that the saves waiting for this change asked for, oldest first; the last one is `value`. */
	waiters: Array<{ value: boolean }>
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
	/** The providers that asked for a reconciliation: only what is needed to read the stored setting, and not kept alive. */
	owners: Array<WeakRef<McpOwner>>
}

/** What a reconciliation needs of a provider: whether it is gone, and the setting that it stores. */
interface McpOwner {
	readonly isDisposed?: boolean
	readonly contextProxy: { getValue(key: "mcpEnabled"): unknown }
}

/** What is in line for each hub. A hub is shared by every provider, so this is across providers too. */
const hubs = new WeakMap<McpEnabledTarget, HubChanges>()

const changesOf = (hub: McpEnabledTarget): HubChanges => {
	let changes = hubs.get(hub)
	if (!changes) {
		changes = { reconciling: false, owners: [] }
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
				// What the hub has is not known any more, so a later look at what is stored does not take it for granted.
				changes.last = undefined
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
export function changeMcpEnabled(hub: McpEnabledTarget, value: boolean, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return Promise.reject(signal.reason)
	const changes = changesOf(hub)
	const { running, pending } = changes
	if (!running) return forCaller(start(hub, changes, value), signal)

	if (pending) {
		return forCaller(joinPending(changes, pending, value, signal), signal)
	}
	if (running.value === value) return forCaller(running.promise, signal)

	let resolve!: () => void
	let reject!: (error: unknown) => void
	const promise = new Promise<void>((res, rej) => {
		resolve = res
		reject = rej
	})
	promise.catch(() => undefined)
	const created: Pending = { value, waiters: [], promise, resolve, reject }
	changes.pending = created
	return forCaller(joinPending(changes, created, value, signal), signal)
}

/**
 * The promise a caller waits on: its own, so that a caller that gives up (its `signal` aborts) is answered at once and
 * lets go of what it was doing, while the change that other callers still wait for goes on.
 */
function forCaller(shared: Promise<void>, signal?: AbortSignal): Promise<void> {
	if (!signal) return shared
	return new Promise<void>((resolve, reject) => {
		const abort = () => reject(signal.reason)
		signal.addEventListener("abort", abort, { once: true })
		shared.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort))
	})
}

/**
 * Adds a save to the saves that wait for the change that has not started. When the save gives up (its `signal` aborts)
 * and no other save waits for it, the change is dropped: it must not start later, with a value that nothing asks for.
 */
function joinPending(changes: HubChanges, pending: Pending, value: boolean, signal?: AbortSignal): Promise<void> {
	const waiter = { value }
	pending.waiters.push(waiter)
	pending.value = value
	if (!signal) return pending.promise

	const leave = () => {
		// A change that has started is under way, and cannot be taken back: it is the reconciliation's business then.
		if (changes.pending !== pending) return
		pending.waiters.splice(pending.waiters.indexOf(waiter), 1)
		const latest = pending.waiters.at(-1)
		if (latest) {
			pending.value = latest.value
			return
		}
		changes.pending = undefined
		pending.reject(signal.reason)
	}
	signal.addEventListener("abort", leave, { once: true })
	const settled = () => signal.removeEventListener("abort", leave)
	pending.promise.then(settled, settled)
	return pending.promise
}

/**
 * Brings the hub to the stored setting once every change that is in line has settled, however each ends. For a save that
 * gave up waiting on a change: that change may still land late, and must not leave the hub other than the setting says.
 * One of these runs per hub, and it looks at what is stored when the changes are done, so several saves that gave up
 * leave one reconciliation behind, not one each. Nothing is applied if the stored value is the one the hub got last.
 * The providers are only remembered weakly, and one that has been disposed is not asked: a reconciliation that waits for
 * a change that never settles does not keep a provider that was closed meanwhile.
 */
export async function reconcileMcpEnabled(hub: McpEnabledTarget, owner: McpOwner): Promise<void> {
	const changes = changesOf(hub)
	changes.owners = changes.owners.filter((ref) => {
		const known = ref.deref()
		return known !== undefined && !known.isDisposed && known !== owner
	})
	changes.owners.push(new WeakRef(owner))
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
			// The setting is the same for every provider: any one that is still there can say what is stored.
			const live = [...changes.owners]
				.reverse() // the latest one that was asked for first
				.map((ref) => ref.deref())
				.find((known) => known && !known.isDisposed)
			if (!live) break
			const stored = (live.contextProxy.getValue("mcpEnabled") ?? true) as boolean
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
		changes.owners = changes.owners.filter((ref) => {
			const known = ref.deref()
			return known !== undefined && !known.isDisposed
		})
	}
}
