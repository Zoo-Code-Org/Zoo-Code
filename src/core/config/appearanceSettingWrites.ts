import { globalSettingsSchema, type RooCodeSettings } from "@roo-code/types"

import { SettingsWriteError, type ContextProxy } from "./ContextProxy"

/** The appearance settings, whose writes are tracked so a failed save can be put back without undoing another one. */
export const APPEARANCE_SETTING_KEYS = [
	"interfaceFontScale",
	"terminalFontSize",
	"editorFontSize",
	"spacingScale",
] as const

export type AppearanceSettingKey = (typeof APPEARANCE_SETTING_KEYS)[number]

export const isAppearanceSetting = (key: string): key is AppearanceSettingKey =>
	(APPEARANCE_SETTING_KEYS as readonly string[]).includes(key)

/** One write of an appearance setting by a save, linked to the writes of other saves that overlap it. */
export interface SettingWrite {
	key: AppearanceSettingKey
	/** What was stored when this write was made. With overlapping writes, this can be another write's pending value. */
	previous: unknown
	/** `previous` was handed over by a write that was rolled back, so it is not read again when this write starts. */
	inherited?: boolean
	/** Its store has been issued, so `previous` has been read. */
	started?: boolean
	/** It was refused, dropped or abandoned before its store was issued: it stored nothing. */
	skipped?: boolean
	wrote: unknown
	/**
	 * Values of writes before this one that were rolled back while this one was pending, and may have stored them (a
	 * store that landed late). This write's rollback puts `previous` back when the stored value is any of them.
	 */
	alsoWrote?: unknown[]
	/** The write before this one that has not finished yet, and the one after it. */
	prev?: SettingWrite
	next?: SettingWrite
	/** The save has finished: it succeeded, or it has been rolled back. */
	done: boolean
}

/**
 * The latest write of each appearance setting. The store is shared by every provider (sidebar, editor tab), so saves
 * can overlap, and the writes to one key form a chain. Rolling a write back puts the key
 * back only while it is the latest one and the stored value is still what it wrote, so another write's value is kept
 * even when it is the same value. A write that is rolled back while a newer one is pending is taken out of the chain,
 * so that if the newer one fails too, it restores what was stored before either of them.
 */
const lastWriteOfSetting = new Map<AppearanceSettingKey, SettingWrite>()

/** Records a write that is about to be made, as the latest one of its key. */
export const beginSettingWrite = (key: AppearanceSettingKey, previous: unknown, wrote: unknown): SettingWrite => {
	const before = lastWriteOfSetting.get(key)
	const write: SettingWrite = { key, previous, wrote, prev: before && !before.done ? before : undefined, done: false }
	if (write.prev) write.prev.next = write
	lastWriteOfSetting.set(key, write)
	return write
}

/**
 * The writes to one key, one at a time, from every save and rollback, across providers. A write is only
 * started once the one before it has reached durable storage, so a slower write cannot complete after a newer one
 * and overwrite it, and a rollback cannot land after a newer write has started. A write that fails does not hold up
 * the ones behind it. The entry of a key is released when the last write's store has settled, not when its caller
 * stopped waiting.
 */
const settingWriteQueues = new Map<AppearanceSettingKey, Tail>()

/**
 * The end of a write in the line of its key: the writes behind it wait for it to finish (`waiters`, in the order they
 * came). It is a list that can be edited, not a chain of promises: a write that gives up before it started takes itself
 * out of the line at once and hands the ones behind it to the one before it, so none stays attached to a write that
 * is stalled.
 */
interface Tail {
	done: boolean
	waiters: Set<Waiter>
}

/** A write waiting for the one in front of it: what it does when that one is over, and where it stands when it moves up. */
interface Waiter {
	run: () => void
	/** The write was moved behind another tail (the one it waited for gave up): that is the one it waits for now. */
	rebase: (tail: Tail) => void
}

/** Nothing ahead: a write that finds the key free starts on its own. */
const freeKey: Tail = { done: true, waiters: new Set() }

/** How many writes are attached to a tail that has not finished (the test hook below). */
let attachedWaiters = 0

const finishTail = (tail: Tail) => {
	tail.done = true
	const waiters = [...tail.waiters]
	attachedWaiters -= waiters.length
	tail.waiters.clear()
	// Each one goes on in a task of its own, as when this was a chain of promises.
	for (const waiter of waiters) void Promise.resolve().then(waiter.run)
}

const afterTail = (tail: Tail, waiter: Waiter) => {
	if (tail.done) {
		void Promise.resolve().then(waiter.run)
		return
	}
	tail.waiters.add(waiter)
	attachedWaiters++
}

/** Takes a write out of the line: what waited behind it waits behind the write before it. */
const leaveLine = (prior: Tail, tail: Tail, waiter: Waiter) => {
	prior.waiters.delete(waiter)
	attachedWaiters--
	for (const behind of tail.waiters) {
		behind.rebase(prior) // the same writes, waiting for another tail now
		prior.waiters.add(behind)
	}
	tail.waiters.clear()
	tail.done = true
}

/**
 * How long a caller waits for a write, counted from when it was queued. It is shorter than the time the webview waits
 * for the answer to a save, so the webview gets a failure, not silence. A write that has not started by then never
 * will. A write that has started cannot be cancelled (`globalState.update` has no cancellation), so its key stays
 * taken until the store settles: a later write of that key is refused at once (see `staleKeys`) rather than queued, so
 * a store that never settles holds one entry and one closure, not one per attempt, and a late store can never land
 * after, and overwrite, a newer write.
 */
const SETTING_WRITE_TIMEOUT_MS = 15_000

/**
 * Keys that are taken: a write whose caller gave up but whose store has not settled, and a rollback that is waiting
 * behind such a store, each hold the key until they are over (a count, because both can be there at once). A write of
 * the key is refused until none is left.
 */
const staleKeys = new Map<AppearanceSettingKey, { holders: number }>()
const isStale = (key: AppearanceSettingKey) => staleKeys.has(key)

/**
 * Who issued a write: the provider that handles the request (the sidebar and an editor tab share one ContextProxy but
 * are disposed separately), or the ContextProxy itself for a writer that has no provider (an import).
 */
type Owner = object

/** Writes that have not started, per owner, so that disposing the owner can drop them. */
const waitingByOwner = new WeakMap<Owner, Set<() => void>>()

/** How many writes are in `waitingByOwner`: a count, because a WeakMap cannot be looked into (see the test hook). */
let waitingWrites = 0

/** Owners that have been disposed: they issue no more writes. */
const disposedOwners = new WeakSet<Owner>()

/** Callbacks of rollbacks that are waiting for a store, per owner, so that disposing the owner can detach them. */
const callbacksByOwner = new WeakMap<Owner, Set<{ callback?: () => void }>>()

/**
 * Detaches a disposed provider from the writes. Those that have not started are dropped: never issued, their callers
 * told, their closures released. A write issued afterwards is refused. A store that has started cannot be cancelled
 * and runs on, and its key stays taken until it settles; so does a rollback waiting behind it, because the stored value
 * is still the store's to put right, but it no longer calls back into the provider.
 */
export const disposeSettingWrites = (owner: Owner) => {
	disposedOwners.add(owner)
	for (const cancel of [...(waitingByOwner.get(owner) ?? [])]) cancel()
	waitingByOwner.delete(owner)
	for (const holder of callbacksByOwner.get(owner) ?? []) holder.callback = undefined
	callbacksByOwner.delete(owner)
}

type WriteKind =
	/** A write: refused when its provider is disposed or the key is taken, dropped when it waits too long. */
	| "write"
	/**
	 * A rollback that was asked for while the key's store is still outstanding. It is not refused: it waits its turn
	 * behind that store, without a timeout, and runs when the store has settled, before any write that comes after it.
	 * It is not dropped when its owner is disposed either, and it keeps the key taken until it is over: a write of the
	 * key is refused until then, not queued behind a rollback that may stall.
	 */
	| "deferredRollback"
	/**
	 * The rollback of a write that failed, behind whatever is outstanding for the key: kept like a deferred one (no
	 * timeout, not refused, not dropped). A write that comes while it is on its way is queued behind it, in order; once
	 * it has been waited for the usual time without finishing it is stalled, and takes the key like a store that timed
	 * out does, so every later write is refused at once and none piles up behind it.
	 */
	| "keptRollback"

const queuedSettingWrite = (
	owner: Owner,
	key: AppearanceSettingKey,
	write: () => Promise<unknown>,
	kind: WriteKind = "write",
): Promise<void> => {
	const behindStale = kind !== "write"
	if (!behindStale && disposedOwners.has(owner)) {
		return Promise.reject(new Error(`The write of ${key} was refused: its provider was disposed`))
	}
	if (isStale(key) && !behindStale) {
		return Promise.reject(new Error(`An earlier write of ${key} has not finished yet`))
	}

	let prior = settingWriteQueues.get(key) ?? freeKey
	let gaveUp = false
	let started = false
	// Dropped as soon as the write gives up, so a write that waits behind a store does not keep what it captured alive.
	let work: (() => Promise<unknown>) | undefined = write

	const tail: Tail = { done: false, waiters: new Set() }
	settingWriteQueues.set(key, tail)
	// The key is free for the next write once this one's store has settled (or it was dropped before it started).
	// The entry of the key in `staleKeys` while this write holds it (it holds the key at most once).
	let heldKey: { holders: number } | undefined
	let stalledTimer: ReturnType<typeof setTimeout> | undefined
	const takeKey = () => {
		const entry = staleKeys.get(key) ?? { holders: 0 }
		entry.holders++
		staleKeys.set(key, entry)
		heldKey = entry
	}
	const release = () => {
		clearTimeout(stalledTimer)
		if (heldKey) {
			if (--heldKey.holders === 0) staleKeys.delete(key)
			heldKey = undefined
		}
		if (settingWriteQueues.get(key) === tail) settingWriteQueues.delete(key)
		finishTail(tail)
	}
	if (kind === "deferredRollback") takeKey()
	// A rollback that has not finished after the usual wait has stalled: it holds the key from then until it is over.
	if (kind === "keptRollback") stalledTimer = setTimeout(takeKey, SETTING_WRITE_TIMEOUT_MS)

	const waiting = waitingByOwner.get(owner) ?? new Set<() => void>()
	if (!behindStale) waitingByOwner.set(owner, waiting)

	return new Promise<void>((resolve, reject) => {
		// A write that gave up before it started is gone from the bookkeeping at once, not when the writes before it are
		// over (they may never be): what it captured is let go, and the queue of the key leads to the write before it.
		const giveUpBeforeStarting = () => {
			gaveUp = true
			work = undefined
			leaveWaiting()
			// Behind a write that has not finished, this one leaves the line now (and the writes behind it move up). When
			// the write before it had finished, this one is about to be told so and releases itself.
			if (!prior.done) {
				leaveLine(prior, tail, waiter)
				if (settingWriteQueues.get(key) === tail) settingWriteQueues.set(key, prior)
			}
		}
		// Only a write that is still waiting can be dropped: one that started, or gave up, has left `waiting` already.
		const cancel = () => {
			giveUpBeforeStarting()
			clearTimeout(timer)
			reject(new Error(`The write of ${key} was dropped: its provider was disposed`))
		}
		const leaveWaiting = () => {
			if (waiting.delete(cancel)) waitingWrites--
		}
		if (!behindStale) {
			waiting.add(cancel)
			waitingWrites++
		}
		const timer = behindStale
			? undefined
			: setTimeout(() => {
					if (started) {
						gaveUp = true
						takeKey()
					} else {
						giveUpBeforeStarting()
					}
					reject(new Error(`Writing ${key} did not finish in ${SETTING_WRITE_TIMEOUT_MS / 1000} seconds`))
				}, SETTING_WRITE_TIMEOUT_MS)

		const onPriorDone = () => {
			// Its caller has given up before it started: it is dropped, and the next write may go ahead.
			leaveWaiting()
			if (gaveUp || !work) return release()
			started = true
			void Promise.resolve()
				.then(work)
				.then(
					() => undefined,
					(error: unknown) => ({ error }),
				)
				.then((failure) => {
					clearTimeout(timer)
					work = undefined
					release()
					// After the timeout the caller has been told already: a second answer is ignored.
					if (failure) reject(failure.error)
					else resolve()
				})
		}
		const waiter: Waiter = {
			run: onPriorDone,
			rebase: (to) => {
				prior = to
			},
		}
		afterTail(prior, waiter)
	})
}

/** @internal test hook: how many writes are attached to a write in front of them, in the line of a key. */
export const settingWritesAttachedToALine = () => attachedWaiters

/** @internal test hook: how many writes are waiting for their turn to start, in the bookkeeping of their providers. */
export const settingWritesWaitingToStart = () => waitingWrites

/** @internal test hook: how much is kept about writes. It is nothing once the saves are over. */
export const settingWriteBookkeepingSize = () => ({
	latestWrites: lastWriteOfSetting.size,
	queuedKeys: settingWriteQueues.size + staleKeys.size,
})

/**
 * Stores a recorded write, in line behind the writes of its key. What it replaces is read when it starts, after the
 * writes before it have reached storage, unless a rolled-back write handed its own value over.
 */
export const performSettingWrite = (
	contextProxy: ContextProxy,
	write: SettingWrite,
	owner: Owner = contextProxy,
): Promise<void> =>
	queuedSettingWrite(owner, write.key, () => {
		if (!write.inherited) write.previous = contextProxy.getValue(write.key as keyof RooCodeSettings)
		write.started = true
		return contextProxy.setValue(write.key as keyof RooCodeSettings, write.wrote as never)
	}).catch((error: unknown) => {
		// Refused, dropped or abandoned before its store was issued: it stored nothing, so there is nothing to put back.
		if (!write.started) write.skipped = true
		throw error
	})

/** Takes a write out of its chain, joining the writes on either side of it. */
const unlinkSettingWrite = (write: SettingWrite) => {
	if (write.prev) write.prev.next = write.next
	if (write.next) write.next.prev = write.prev
	write.prev = undefined
	write.next = undefined
}

/**
 * The save that made these writes succeeded. Nothing is kept about them once they are over. The value is committed,
 * so it is what a later write that has not started yet replaces, and the writes on either side of it no longer hand
 * values to each other: an earlier write that fails now has nothing left to put back behind it.
 */
export const finishSettingWrites = (writes: SettingWrite[]) => {
	for (const write of writes) {
		write.done = true
		if (lastWriteOfSetting.get(write.key) === write) lastWriteOfSetting.delete(write.key)

		const { next } = write
		if (next && !next.done) {
			if (!next.started) {
				next.previous = write.wrote
				next.inherited = true
			}
			next.prev = undefined
		}
		if (write.prev) write.prev.next = undefined
		write.prev = undefined
		write.next = undefined
	}
}

export interface SettingWriteOptions {
	/** Who issued the write; the ContextProxy itself if it was not a provider. */
	owner?: Owner
	/** Called when a rollback that had to wait for an outstanding store is over, to show what is really stored. */
	onDeferredSettled?: () => void
}

/**
 * Lets the provider that issued a rollback know when it is over, while respecting its disposal: the callback is attached to
 * the owner, so disposing the owner detaches it, and a provider that is already disposed gets none. Returns what to call
 * when the rollback has settled.
 */
const callWhenSettled = (owner: Owner, onSettled: (() => void) | undefined) => {
	const holder: { callback?: () => void } = { callback: disposedOwners.has(owner) ? undefined : onSettled }
	const holders = callbacksByOwner.get(owner) ?? new Set<{ callback?: () => void }>()
	if (holder.callback) {
		holders.add(holder)
		callbacksByOwner.set(owner, holders)
	}
	return () => {
		holders.delete(holder)
		holder.callback?.()
	}
}

/**
 * Puts a failed write back, unless another write has superseded it (see `lastWriteOfSetting`). Resolves to `"settled"`
 * when the value is as it will stay (put back, or never this write's to put back), and to `"pending"` when the rollback
 * is queued behind a store that has not finished: its outcome is not known yet, and `onDeferredSettled` runs when it
 * is. Rejects when the rollback failed, or was not over after the usual wait (it goes on, and `onDeferredSettled` runs
 * when it is): what is stored is then uncertain.
 */
export const undoSettingWrite = async (
	contextProxy: ContextProxy,
	write: SettingWrite,
	{ owner = contextProxy, onDeferredSettled }: SettingWriteOptions = {},
) => {
	const { key } = write
	write.done = true

	if (lastWriteOfSetting.get(key) !== write) {
		// A newer write exists. Make it restore the value from before this one if it fails as well, including when this
		// write's store lands late (it never completed for its caller, but it may have stored its value).
		const { next } = write
		if (next && !next.done) {
			next.previous = write.previous
			next.inherited = true
			next.alsoWrote = [
				...(write.alsoWrote ?? []),
				...(write.skipped ? [] : [write.wrote]),
				...(next.alsoWrote ?? []),
			]
		}
		unlinkSettingWrite(write)
		return "settled" as const
	}

	// The write before this one is pending again: it is the latest, and the value now stored is its value.
	const { prev } = write
	if (prev && !prev.done) lastWriteOfSetting.set(key, prev)
	else lastWriteOfSetting.delete(key)
	unlinkSettingWrite(write)

	// The values this write may have stored: its own, unless its store was never issued, and the ones it took over.
	// With none, there is nothing to put back: what is stored belongs to someone else, even when it is the same value.
	const mayHaveStored = [...(write.skipped ? [] : [write.wrote]), ...(write.alsoWrote ?? [])]
	if (mayHaveStored.length === 0) return "settled" as const

	const restore = async () => {
		if (mayHaveStored.includes(contextProxy.getValue(key as keyof RooCodeSettings))) {
			await contextProxy.setValue(key as keyof RooCodeSettings, write.previous as never)
		}
	}

	if (isStale(key)) {
		// The store of this write (or of an earlier one of the key) is still outstanding and may yet land, after the
		// caller was told it failed. The rollback is attached to that store: it is queued now, behind it, so it runs
		// when the store has settled and before any write that comes after, which are refused until then. Nobody
		// waits for it (the store may never settle), and a newer write cannot have been stored in between.
		// `onDeferredSettled` runs when it is over, so the caller can show what is really stored; disposing the owner
		// detaches it.
		// An owner that is already disposed registers no callback at all: nothing may be called back into it, or kept
		// alive by it, however late the store settles.
		const settled = callWhenSettled(owner, onDeferredSettled)
		void queuedSettingWrite(owner, key, restore, "deferredRollback")
			.catch((error: unknown) =>
				console.error(`Failed to restore setting "${key}" after a write that timed out:`, error),
			)
			.finally(settled)
		return "pending" as const
	}

	// This write may have stored its value (it started, and then failed), so it has to be put back whatever happens
	// to its caller or its provider. It is queued behind what is outstanding for the key (another write's rollback, a
	// store), and kept: it is not refused when the provider was disposed, not dropped when it is disposed while the
	// rollback waits, and has no timeout of its own, so a slow rollback ahead of it cannot cost it its turn. The caller
	// stops waiting after the usual time, and the rollback runs when its turn comes; the provider is told when it is over
	// (`onDeferredSettled`), unless it was disposed meanwhile, so it shows what is really stored.
	const rollback = queuedSettingWrite(owner, key, restore, "keptRollback")
	let timer: ReturnType<typeof setTimeout> | undefined
	const gaveUp = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => {
			const settled = callWhenSettled(owner, onDeferredSettled)
			void rollback
				.catch((error: unknown) =>
					console.error(`Failed to restore setting "${key}" after its write failed:`, error),
				)
				.finally(settled)
			reject(new Error(`Writing ${key} did not finish in ${SETTING_WRITE_TIMEOUT_MS / 1000} seconds`))
		}, SETTING_WRITE_TIMEOUT_MS)
	})
	try {
		await Promise.race([rollback, gaveUp])
	} finally {
		clearTimeout(timer)
	}
	return "settled" as const
}

/** What a failed write of the settings that are not appearance values says about them. */
const reportOthers = (reason: unknown): { stored: string[]; notStored: string[] } =>
	reason instanceof SettingsWriteError
		? { stored: [...reason.committed], notStored: [...reason.failed] }
		: { stored: [], notStored: ["the other settings"] }

/** A write that was not all stored: which settings were stored (they are final), which were not, and which are not known. */
export class PartialSettingsWriteError extends Error {
	constructor(
		readonly stored: string[],
		readonly notStored: string[],
		readonly uncertain: string[],
		override readonly cause: unknown,
	) {
		const reason = cause instanceof Error ? cause.message : String(cause)
		const parts = [
			`not stored: ${notStored.length > 0 ? notStored.join(", ") : "none"}`,
			`stored: ${stored.length > 0 ? stored.join(", ") : "none"}`,
		]
		if (uncertain.length > 0) parts.push(`uncertain, could not be put back: ${uncertain.join(", ")}`)
		super(`${reason} (${parts.join("; ")})`)
		this.name = "PartialSettingsWriteError"
	}
}

/**
 * The error for a report with a failure. A write that failed on its own, with nothing else stored and nothing uncertain,
 * is reported as it was. When it was only partly done, or several failed, or a rollback is not known to have worked, the
 * error names the settings that were stored, those that were not, and those that are uncertain: the ones that were
 * stored are final, so what is stored is not what the caller asked for.
 */
export function describeFailedWrite({ failure, stored, notStored, uncertain }: WriteValuesReport): unknown {
	if (notStored.length <= 1 && stored.length === 0 && uncertain.length === 0) return failure?.reason
	// A store that says which settings failed has said it in its message: the cause is what is left to tell.
	const cause = failure?.reason instanceof SettingsWriteError ? failure.reason.cause : failure?.reason
	return new PartialSettingsWriteError(stored, notStored, uncertain, cause)
}

/** What a write through the chain did: the first failure, and which settings were stored and which were not. */
export interface WriteValuesReport {
	failure?: { reason: unknown }
	/** The settings that were stored: they are final. */
	stored: string[]
	/**
	 * The settings that were not stored: the appearance settings that failed and were put back, and the others, by name
	 * when the store says which of them failed (`SettingsWriteError`) and as a group when it does not.
	 */
	notStored: string[]
	/**
	 * The appearance settings whose write failed and whose rollback failed or has not finished: what is stored for them
	 * is not known (it may still be the value that failed to be stored). `onDeferredSettled` runs when the last rollback
	 * that was pending is over.
	 */
	uncertain: string[]
}

/**
 * Writes settings from a generic writer (an import, the public API, the configuration of a new task) and reports what
 * was stored. The appearance values go through the same per-key write chain as saves, so a save that fails and rolls
 * back does not undo a value written here meanwhile, even when it is the same value. The write is not rolled back as a
 * whole: a write that succeeded is final. A write that failed is undone, not finished, so it leaves the chain the way
 * a failed save does and an earlier save that is still pending keeps its own rollback. The failure is reported, not
 * thrown, together with the settings that were stored and those that were not (see `describeFailedWrite` for the
 * error). An invalid appearance value still throws, before any value is stored.
 */
export async function writeValuesThroughWriteChain(
	contextProxy: ContextProxy,
	settings: RooCodeSettings,
	options: SettingWriteOptions = {},
): Promise<WriteValuesReport> {
	// Own properties only: an inherited value is not something the caller wrote.
	const keys = APPEARANCE_SETTING_KEYS.filter((key) => Object.prototype.hasOwnProperty.call(settings, key))
	if (keys.length === 0) {
		try {
			await contextProxy.setValues(settings)
			return { stored: Object.keys(settings), notStored: [], uncertain: [] }
		} catch (reason) {
			return { failure: { reason }, ...reportOthers(reason), uncertain: [] }
		}
	}

	// Every appearance value is checked before anything is written (these values come from the API and from a
	// webview's new-task configuration, which are not bound by the settings controls): an invalid one rejects the
	// whole write, so no appearance value is started and no other setting is stored.
	for (const key of keys) {
		if (!globalSettingsSchema.shape[key].safeParse(settings[key]).success) {
			throw new Error(`Invalid value for ${key}`)
		}
	}

	const writes = keys.map((key) => beginSettingWrite(key, contextProxy.getValue(key), settings[key]))
	const others = Object.fromEntries(
		Object.entries(settings).filter(([key]) => !isAppearanceSetting(key)),
	) as RooCodeSettings

	// Each appearance write is finished, or undone, as soon as its own store has settled: what is kept about it does not
	// wait for the other settings, whose store may take long, or never settle (the chain of a key is its own). The
	// rollback of a failed one is awaited here (the outcome is part of the report), and the rollbacks of different keys
	// do not wait for one another.
	const appearance = writes.map(async (write) => {
		try {
			await performSettingWrite(contextProxy, write, options.owner)
		} catch (reason) {
			let outcome: "settled" | "pending" | "failed"
			try {
				outcome = await undoSettingWrite(contextProxy, write, options)
			} catch (restoreError) {
				console.error(`Failed to restore setting "${write.key}" after a failed write:`, restoreError)
				outcome = "failed"
			}
			return { key: write.key, failure: { reason }, uncertain: outcome !== "settled" }
		}
		finishSettingWrites([write])
		return { key: write.key }
	})
	const [othersResult, ...results] = await Promise.all([
		contextProxy.setValues(others).then(
			() => ({ ok: true as const }),
			(reason: unknown) => ({ ok: false as const, reason }),
		),
		...appearance,
	])

	let failure = othersResult.ok ? undefined : { reason: othersResult.reason }
	const { stored, notStored } = othersResult.ok
		? { stored: Object.keys(others), notStored: [] as string[] }
		: reportOthers(othersResult.reason)
	const uncertain: string[] = []
	for (const result of results) {
		if (!("failure" in result)) {
			stored.push(result.key)
			continue
		}
		failure ??= result.failure
		// A rollback that failed, or is not over yet, leaves what is stored unknown: it is not "not stored".
		if (result.uncertain) uncertain.push(result.key)
		else notStored.push(result.key)
	}

	return { failure, stored, notStored, uncertain }
}
