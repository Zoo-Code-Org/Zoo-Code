import { globalSettingsSchema, type RooCodeSettings } from "@roo-code/types"

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

/**
 * How long a write may take before the queue stops waiting for it. A store that never settles would otherwise hold
 * every later write of its key, and the closure over its ContextProxy, for as long as the extension host lives. It is
 * shorter than the time the webview waits for the answer to a save, so the webview gets a failure, not silence. The
 * write itself is not cancelled: if it lands later, the stored-value check of a rollback keeps what it wrote.
 */
const SETTING_WRITE_TIMEOUT_MS = 15_000

const withinTimeout = (write: Promise<unknown>, key: AppearanceSettingKey): Promise<void> =>
	new Promise<void>((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error(`Writing ${key} did not finish in ${SETTING_WRITE_TIMEOUT_MS / 1000} seconds`)),
			SETTING_WRITE_TIMEOUT_MS,
		)
		write
			.then(
				() => resolve(),
				(error: unknown) => reject(error),
			)
			.finally(() => clearTimeout(timer))
	})

const queuedSettingWrite = (key: AppearanceSettingKey, write: () => Promise<unknown>): Promise<void> => {
	const run = (settingWriteQueues.get(key) ?? Promise.resolve()).then(() => withinTimeout(write(), key))
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

/**
 * Writes settings from a generic writer (an import, the public API, the configuration of a new task). The appearance
 * values go through the same per-key write chain as saves, so a save that fails and rolls back does not undo a value
 * written here meanwhile, even when it is the same value. The write is not rolled back as a whole: a write that
 * succeeded is final. A write that failed is undone, not finished, so it leaves the chain the way a failed save does
 * and an earlier save that is still pending keeps its own rollback. An invalid appearance value rejects the write
 * before any value is stored.
 */
export async function setValuesThroughWriteChain(contextProxy: ContextProxy, settings: RooCodeSettings) {
	const keys = APPEARANCE_SETTING_KEYS.filter((key) => key in settings)
	if (keys.length === 0) return contextProxy.setValues(settings)

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

	// Every write is awaited before any is finished or undone, so none is still running when it leaves the chain.
	const [othersResult, ...writeResults] = await Promise.allSettled([
		contextProxy.setValues(others),
		...writes.map((write) => performSettingWrite(contextProxy, write)),
	])

	let failure = othersResult.status === "rejected" ? othersResult : undefined
	for (const [index, write] of writes.entries()) {
		const result = writeResults[index]
		if (result.status === "fulfilled") {
			finishSettingWrites([write])
			continue
		}
		failure ??= result
		try {
			await undoSettingWrite(contextProxy, write)
		} catch (restoreError) {
			console.error(`Failed to restore setting "${write.key}" after a failed write:`, restoreError)
		}
	}

	if (failure) throw failure.reason
}
