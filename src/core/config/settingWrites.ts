import type { RooCodeSettings } from "@roo-code/types"

import type { ContextProxy } from "./ContextProxy"

/** The settings whose writes are tracked, so a failed save or import can be put back without undoing another one. */
export const TRACKED_SETTING_KEYS = ["timeFormat", "dateFormat", "showRelativeTimes"] as const

export type TrackedSettingKey = (typeof TRACKED_SETTING_KEYS)[number]

export const isTrackedSetting = (key: string): key is TrackedSettingKey =>
	(TRACKED_SETTING_KEYS as readonly string[]).includes(key)

/** One write of a tracked setting by a save or an import, linked to the writes of others that overlap it. */
export interface SettingWrite {
	key: TrackedSettingKey
	/** What was stored when this write was made. With overlapping writes, this can be another write's pending value. */
	previous: unknown
	/** The store clock just after this write's own store. A later store by someone else means something else wrote it. */
	generation?: number
	/**
	 * Set when `previous` was handed over by another write, to the store clock at the time that write stored its own
	 * value. The handed-over value is kept only while no store by someone else is later than that.
	 */
	handedOverAt?: number
	wrote: unknown
	/** The write before this one that has not finished yet, and the one after it. */
	prev?: SettingWrite
	next?: SettingWrite
	/** The save or import has finished: it succeeded, or it has been rolled back. */
	done: boolean
}

/**
 * The latest write of each tracked setting. The store is shared by every provider (sidebar, editor tab) and by the
 * settings import, so writes can overlap, and the writes to one key form a chain. Rolling a write back puts the key
 * back only while it is the latest one and the stored value is still what it wrote, so another write's value is kept
 * even when it is the same value. A write that is rolled back while a newer one is pending is taken out of the chain,
 * so that if the newer one fails too, it restores what was stored before either of them.
 */
const lastWriteOfSetting = new Map<TrackedSettingKey, SettingWrite>()

/**
 * The stores of tracked keys made by anyone but the saves and imports here. `ContextProxy` reports every store
 * (`noteSettingStored`), including the ones that do not go through a save or an import (the public API, other callers
 * of `setValues`). Each is numbered on a clock that only they advance. A write remembers the clock just after its own
 * store, and is put back only if no store by someone else has a later number, so a store made by anyone else in
 * between is kept, even when it stored the same value. A store that is rejected is taken out by its own number, so it
 * cannot cancel another store's.
 */
const othersStores = new Map<TrackedSettingKey, Set<number>>()
let storeClockValue = 0

const storeClock = () => storeClockValue

/** Whether anyone but the saves and imports here stored the key after the clock read `since`. */
const othersStoredSince = (key: TrackedSettingKey, since: number) => {
	for (const seq of othersStores.get(key) ?? []) if (seq > since) return true
	return false
}

/** The stores by others only matter while writes of the key are pending. */
const pruneOthersStores = (key: TrackedSettingKey) => {
	if (!isPending(key)) othersStores.delete(key)
}

/** Restores of an undone write that are still waiting in the queue: the key is not settled until they have run. */
const pendingRestores = new Map<TrackedSettingKey, number>()

const changePendingRestores = (key: TrackedSettingKey, change: 1 | -1) => {
	const count = (pendingRestores.get(key) ?? 0) + change
	if (count > 0) pendingRestores.set(key, count)
	else pendingRestores.delete(key)
}

/** A write of the key is pending, or a restore of one is still waiting its turn. */
const isPending = (key: TrackedSettingKey) => lastWriteOfSetting.has(key) || (pendingRestores.get(key) ?? 0) > 0

/** The key whose store is being issued right now by a save or an import, so that its report is not counted. */
let ownStoreOf: TrackedSettingKey | undefined

/** Issues a store made here. `ContextProxy` reports it synchronously, while `store` runs. */
const storeHere = <T>(key: TrackedSettingKey, store: () => T): T => {
	ownStoreOf = key
	try {
		return store()
	} finally {
		ownStoreOf = undefined
	}
}

/**
 * `ContextProxy` calls this, synchronously, each time a setting is stored. Returns the number of the store when it was
 * counted as one made by someone else (only while a write of the key is pending); if that store is then rejected, the caller reports it with
 * `forgetSettingStore`.
 */
export const noteSettingStored = (key: string): number | undefined => {
	// Only a store that a pending write could be mistaken for matters, so nothing is kept while no write of the key is
	// pending: the set stays as small as the writes that are in flight, however often others store the key.
	if (!isTrackedSetting(key) || key === ownStoreOf || !isPending(key)) return undefined
	const seq = ++storeClockValue
	othersStores.set(key, (othersStores.get(key) ?? new Set<number>()).add(seq))
	return seq
}

/** A store counted by `noteSettingStored` was rejected: it never reached storage, so it is not a store to protect. */
export const forgetSettingStore = (key: string, seq: number) => {
	if (isTrackedSetting(key)) othersStores.get(key)?.delete(seq)
}

/** Records a write that is about to be made, as the latest one of its key. */
export const beginSettingWrite = (key: TrackedSettingKey, previous: unknown, wrote: unknown): SettingWrite => {
	const before = lastWriteOfSetting.get(key)
	const write: SettingWrite = { key, previous, wrote, prev: before && !before.done ? before : undefined, done: false }
	if (write.prev) write.prev.next = write
	lastWriteOfSetting.set(key, write)
	return write
}

/**
 * The writes to one key, one at a time, from every save, import and rollback, across providers. A write is only
 * started once the one before it has reached durable storage, so a slower write cannot complete after a newer one
 * and overwrite it, and a rollback cannot land after a newer write has started. A write that fails does not hold up
 * the ones behind it.
 */
const settingWriteQueues = new Map<TrackedSettingKey, Promise<void>>()

const queuedSettingWrite = (key: TrackedSettingKey, write: () => Promise<unknown>): Promise<void> => {
	const run = (settingWriteQueues.get(key) ?? Promise.resolve()).then(async () => {
		await write()
	})
	const tail = run.catch(() => undefined)
	settingWriteQueues.set(key, tail)
	void tail.then(() => {
		if (settingWriteQueues.get(key) === tail) settingWriteQueues.delete(key)
	})
	return run
}

/** @internal test hook: how much is kept about writes. It is nothing once the saves and imports are over. */
export const settingWriteBookkeepingSize = () => ({
	latestWrites: lastWriteOfSetting.size,
	queuedKeys: settingWriteQueues.size,
})

/**
 * Stores a recorded write, in line behind the writes of its key. What it replaces is read when it starts, after the
 * writes before it have reached storage, unless a rolled-back write handed its own value over.
 */
export const performSettingWrite = (contextProxy: ContextProxy, write: SettingWrite): Promise<void> =>
	queuedSettingWrite(write.key, () => {
		// A handed-over value is kept only while nobody else has stored the key since it was handed over.
		if (write.handedOverAt === undefined || othersStoredSince(write.key, write.handedOverAt)) {
			write.previous = contextProxy.getValue(write.key as keyof RooCodeSettings)
		}
		const stored = storeHere(write.key, () =>
			contextProxy.setValue(write.key as keyof RooCodeSettings, write.wrote as never),
		)
		write.generation = storeClock()
		return stored
	})

/** Takes a write out of its chain, joining the writes on either side of it. */
const unlinkSettingWrite = (write: SettingWrite) => {
	if (write.prev) write.prev.next = write.next
	if (write.next) write.next.prev = write.prev
	write.prev = undefined
	write.next = undefined
}

/**
 * The save or import that made these writes succeeded. Nothing is kept about them once they are over. The value is
 * committed, so it is what a later write that has not started yet replaces, and the writes on either side of it no
 * longer hand values to each other: an earlier write that fails now has nothing left to put back behind it.
 */
export const finishSettingWrites = (writes: SettingWrite[]) => {
	for (const write of writes) {
		write.done = true
		if (lastWriteOfSetting.get(write.key) === write) lastWriteOfSetting.delete(write.key)

		const { next } = write
		if (next && !next.done) {
			if (next.generation === undefined) {
				next.previous = write.wrote
				next.handedOverAt = write.generation ?? storeClock()
			}
			next.prev = undefined
		}
		if (write.prev) write.prev.next = undefined
		write.prev = undefined
		write.next = undefined
		pruneOthersStores(write.key)
	}
}

/** Puts a failed write back, unless another write has superseded it (see `lastWriteOfSetting`). */
export const undoSettingWrite = async (contextProxy: ContextProxy, write: SettingWrite) => {
	const { key } = write
	write.done = true

	if (lastWriteOfSetting.get(key) !== write) {
		// A newer write exists. Make it restore the value from before this one if it fails as well, unless someone
		// else stored the key since this write stored: a write that already started has read that store.
		const heldByOthers = write.generation !== undefined && othersStoredSince(key, write.generation)
		if (write.next && !write.next.done && !heldByOthers) {
			write.next.previous = write.previous
			write.next.handedOverAt = write.generation ?? storeClock()
		}
		unlinkSettingWrite(write)
		return
	}

	// The write before this one is pending again: it is the latest, and the value now stored is its value.
	const { prev } = write
	if (prev && !prev.done) lastWriteOfSetting.set(key, prev)
	else lastWriteOfSetting.delete(key)
	unlinkSettingWrite(write)

	// The restore waits in the queue. Until it has run the key is still pending, so a store by someone else that
	// lands meanwhile is recorded, and the restore leaves it alone.
	changePendingRestores(key, 1)
	try {
		await queuedSettingWrite(key, async () => {
			const untouched = write.generation === undefined || !othersStoredSince(key, write.generation)
			if (untouched && contextProxy.getValue(key as keyof RooCodeSettings) === write.wrote) {
				const restored = storeHere(key, () =>
					contextProxy.setValue(key as keyof RooCodeSettings, write.previous as never),
				)
				// The write before this one is the owner of the value again.
				if (prev && !prev.done) prev.generation = storeClock()
				await restored
			}
		})
	} finally {
		changePendingRestores(key, -1)
		pruneOthersStores(key)
	}
}
