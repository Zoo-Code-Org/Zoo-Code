import type { RooCodeSettings } from "@roo-code/types"

import type { ContextProxy } from "./ContextProxy"

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
	wrote: unknown
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
 * the ones behind it.
 */
const settingWriteQueues = new Map<AppearanceSettingKey, Promise<void>>()

const queuedSettingWrite = (key: AppearanceSettingKey, write: () => Promise<unknown>): Promise<void> => {
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

/** @internal test hook: how much is kept about writes. It is nothing once the saves are over. */
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
		if (!write.inherited) write.previous = contextProxy.getValue(write.key as keyof RooCodeSettings)
		write.started = true
		return contextProxy.setValue(write.key as keyof RooCodeSettings, write.wrote as never)
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

/** Puts a failed write back, unless another write has superseded it (see `lastWriteOfSetting`). */
export const undoSettingWrite = async (contextProxy: ContextProxy, write: SettingWrite) => {
	const { key } = write
	write.done = true

	if (lastWriteOfSetting.get(key) !== write) {
		// A newer write exists. Make it restore the value from before this one if it fails as well.
		if (write.next && !write.next.done) {
			write.next.previous = write.previous
			write.next.inherited = true
		}
		unlinkSettingWrite(write)
		return
	}

	// The write before this one is pending again: it is the latest, and the value now stored is its value.
	const { prev } = write
	if (prev && !prev.done) lastWriteOfSetting.set(key, prev)
	else lastWriteOfSetting.delete(key)
	unlinkSettingWrite(write)

	await queuedSettingWrite(key, async () => {
		if (contextProxy.getValue(key as keyof RooCodeSettings) === write.wrote) {
			await contextProxy.setValue(key as keyof RooCodeSettings, write.previous as never)
		}
	})
}
