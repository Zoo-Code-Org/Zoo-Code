import {
	TRACKED_SETTING_KEYS,
	beginSettingWrite,
	finishSettingWrites,
	forgetSettingStore,
	isTrackedSetting,
	noteSettingStored,
	performSettingWrite,
	undoSettingWrite,
} from "../settingWrites"
import type { ContextProxy } from "../ContextProxy"

describe("settingWrites", () => {
	let stored: Map<string, unknown>
	// Only the two methods the module uses. The cast says so: the real ContextProxy has far more.
	let contextProxy: ContextProxy

	beforeEach(() => {
		stored = new Map<string, unknown>([["timeFormat", "auto"]])
		contextProxy = {
			getValue: (key: string) => stored.get(key),
			setValue: async (key: string, value: unknown) => {
				stored.set(key, value)
			},
		} as unknown as ContextProxy
	})

	/** Stores the value, as the write that was just recorded would have. */
	const store = (key: string, value: unknown) => stored.set(key, value)

	describe("which settings are tracked", () => {
		it.each(TRACKED_SETTING_KEYS)("tracks %s", (key) => {
			expect(isTrackedSetting(key)).toBe(true)
		})

		it.each(["soundEnabled", "language", "", "TimeFormat"])("does not track %j", (key) => {
			expect(isTrackedSetting(key)).toBe(false)
		})
	})

	describe("a save and an import writing the same setting", () => {
		it("a failed save does not undo an import that wrote the same value afterwards", async () => {
			const save = beginSettingWrite("timeFormat", "auto", "24h")
			store("timeFormat", "24h")
			const importWrite = beginSettingWrite("timeFormat", "24h", "24h")
			store("timeFormat", "24h")
			finishSettingWrites([importWrite])

			await undoSettingWrite(contextProxy, save)

			expect(stored.get("timeFormat")).toBe("24h")
		})

		it("a failed import does not undo a save that wrote the same value afterwards", async () => {
			const importWrite = beginSettingWrite("timeFormat", "auto", "12h")
			store("timeFormat", "12h")
			const save = beginSettingWrite("timeFormat", "12h", "12h")
			store("timeFormat", "12h")
			finishSettingWrites([save])

			await undoSettingWrite(contextProxy, importWrite)

			expect(stored.get("timeFormat")).toBe("12h")
		})

		it("when both fail, each restores what was stored before either of them", async () => {
			const save = beginSettingWrite("timeFormat", "auto", "24h")
			store("timeFormat", "24h")
			const importWrite = beginSettingWrite("timeFormat", "24h", "12h")
			store("timeFormat", "12h")

			await undoSettingWrite(contextProxy, save) // superseded by the import: nothing changes yet
			expect(stored.get("timeFormat")).toBe("12h")

			await undoSettingWrite(contextProxy, importWrite)
			expect(stored.get("timeFormat")).toBe("auto")
		})
	})

	describe("a store made by anyone else (the public API, other callers of setValues)", () => {
		beforeEach(() => {
			// As ContextProxy: every store is reported, synchronously, when it is made.
			contextProxy = {
				getValue: (key: string) => stored.get(key),
				setValue: async (key: string, value: unknown) => {
					noteSettingStored(key)
					stored.set(key, value)
				},
			} as unknown as ContextProxy
		})

		it("is kept when a failed write is rolled back, even if it stored the same value", async () => {
			const write = beginSettingWrite("timeFormat", "auto", "24h")
			await performSettingWrite(contextProxy, write)

			await contextProxy.setValue("timeFormat" as never, "24h" as never) // the API stores the same value

			await undoSettingWrite(contextProxy, write)

			expect(stored.get("timeFormat")).toBe("24h")
		})

		it("keeps a store made while the restore of the undone latest write is still waiting in the queue", async () => {
			const write = beginSettingWrite("timeFormat", "auto", "24h")
			await performSettingWrite(contextProxy, write)

			const undone = undoSettingWrite(contextProxy, write) // the restore waits its turn in the queue
			await contextProxy.setValue("timeFormat" as never, "24h" as never) // the same value, by someone else
			await undone

			expect(stored.get("timeFormat")).toBe("24h")
		})

		it("keeps the key pending until every waiting restore has run", async () => {
			const first = beginSettingWrite("timeFormat", "auto", "12h")
			await performSettingWrite(contextProxy, first)
			const second = beginSettingWrite("timeFormat", "12h", "24h")
			await performSettingWrite(contextProxy, second)

			const undoSecond = undoSettingWrite(contextProxy, second) // two restores wait in the queue
			const undoFirst = undoSettingWrite(contextProxy, first)
			await undoSecond
			await undoFirst

			expect(stored.get("timeFormat")).toBe("auto")
			expect(noteSettingStored("timeFormat")).toBeUndefined() // all restores have run
		})

		it("still puts the write back when nobody stored the key while the restore waited", async () => {
			const write = beginSettingWrite("timeFormat", "auto", "24h")
			await performSettingWrite(contextProxy, write)

			await undoSettingWrite(contextProxy, write)

			expect(stored.get("timeFormat")).toBe("auto")
		})

		it("keeps nothing for a store made after the restore has run", async () => {
			const write = beginSettingWrite("timeFormat", "auto", "24h")
			await performSettingWrite(contextProxy, write)
			await undoSettingWrite(contextProxy, write)

			expect(noteSettingStored("timeFormat")).toBeUndefined()
		})

		it("does not stop a write from being put back when nobody else stored the key", async () => {
			const write = beginSettingWrite("timeFormat", "auto", "24h")
			await performSettingWrite(contextProxy, write)

			await undoSettingWrite(contextProxy, write)

			expect(stored.get("timeFormat")).toBe("auto")
		})

		it("only counts stores of tracked keys", async () => {
			const write = beginSettingWrite("timeFormat", "auto", "24h")
			await performSettingWrite(contextProxy, write)

			await contextProxy.setValue("soundEnabled" as never, true as never)
			await undoSettingWrite(contextProxy, write)

			expect(stored.get("timeFormat")).toBe("auto")
		})

		it("does not count the restore of a rolled-back write as a store by someone else", async () => {
			const first = beginSettingWrite("timeFormat", "auto", "12h")
			await performSettingWrite(contextProxy, first)
			const second = beginSettingWrite("timeFormat", "12h", "24h")
			await performSettingWrite(contextProxy, second)

			await undoSettingWrite(contextProxy, second) // restores "12h", which the first write owns again
			await undoSettingWrite(contextProxy, first)

			expect(stored.get("timeFormat")).toBe("auto")
		})

		it("keeps the value of a write that finished between two that fail", async () => {
			const first = beginSettingWrite("timeFormat", "auto", "12h")
			await performSettingWrite(contextProxy, first)
			const second = beginSettingWrite("timeFormat", "12h", "24h")
			await performSettingWrite(contextProxy, second)
			const third = beginSettingWrite("timeFormat", "24h", "9h") // registered while the second is pending
			finishSettingWrites([second]) // committed, between the other two
			await performSettingWrite(contextProxy, third)

			await undoSettingWrite(contextProxy, first) // superseded: the committed value is not its to restore
			await undoSettingWrite(contextProxy, third)

			expect(stored.get("timeFormat")).toBe("24h")
		})

		it("leaves what a write read when it started, if that write had already started when the earlier one finished", async () => {
			const first = beginSettingWrite("timeFormat", "auto", "12h")
			await performSettingWrite(contextProxy, first)
			const second = beginSettingWrite("timeFormat", "12h", "24h")
			await performSettingWrite(contextProxy, second)
			const third = beginSettingWrite("timeFormat", "24h", "9h")
			await performSettingWrite(contextProxy, third) // started: it read "24h"

			finishSettingWrites([second])
			await undoSettingWrite(contextProxy, third)

			expect(stored.get("timeFormat")).toBe("24h")
		})

		it("keeps an external store made after a write stored, when that write is handed over", async () => {
			const first = beginSettingWrite("timeFormat", "auto", "12h")
			await performSettingWrite(contextProxy, first)
			const second = beginSettingWrite("timeFormat", "12h", "24h")
			await performSettingWrite(contextProxy, second)
			await contextProxy.setValue("timeFormat" as never, "12h" as never) // external store before the handover
			const third = beginSettingWrite("timeFormat", "24h", "9h")

			finishSettingWrites([second])
			await performSettingWrite(contextProxy, third)
			await undoSettingWrite(contextProxy, third)

			expect(stored.get("timeFormat")).toBe("12h")
		})

		it("keeps an external store made after a superseded write stored, before the write after it starts", async () => {
			const first = beginSettingWrite("timeFormat", "auto", "12h")
			await performSettingWrite(contextProxy, first)
			const second = beginSettingWrite("timeFormat", "12h", "24h")
			await contextProxy.setValue("timeFormat" as never, "9h" as never) // external store before the superseded undo

			await undoSettingWrite(contextProxy, first) // superseded by second
			await performSettingWrite(contextProxy, second)
			await undoSettingWrite(contextProxy, second)

			expect(stored.get("timeFormat")).toBe("9h")
		})

		it("hands over the value of a write that finished without having been stored through performSettingWrite", async () => {
			const first = beginSettingWrite("timeFormat", "auto", "12h")
			store("timeFormat", "12h")
			const second = beginSettingWrite("timeFormat", "12h", "24h")

			finishSettingWrites([first])
			await performSettingWrite(contextProxy, second)
			await undoSettingWrite(contextProxy, second)

			expect(stored.get("timeFormat")).toBe("12h")
		})

		it("keeps the value of a write that finished before a queued write that then fails", async () => {
			const first = beginSettingWrite("timeFormat", "auto", "12h")
			await performSettingWrite(contextProxy, first)
			const second = beginSettingWrite("timeFormat", "12h", "24h")
			await performSettingWrite(contextProxy, second)
			const third = beginSettingWrite("timeFormat", "24h", "9h") // queued, not started

			await undoSettingWrite(contextProxy, first)
			finishSettingWrites([second])
			await performSettingWrite(contextProxy, third)
			await undoSettingWrite(contextProxy, third)

			expect(stored.get("timeFormat")).toBe("24h")
		})

		it("restores through a whole chain of failed writes: no restore is taken for a store by someone else", async () => {
			const first = beginSettingWrite("timeFormat", "auto", "9h")
			await performSettingWrite(contextProxy, first)
			const second = beginSettingWrite("timeFormat", "9h", "12h")
			await performSettingWrite(contextProxy, second)
			const third = beginSettingWrite("timeFormat", "12h", "24h")
			await performSettingWrite(contextProxy, third)

			await undoSettingWrite(contextProxy, third)
			await undoSettingWrite(contextProxy, second)
			await undoSettingWrite(contextProxy, first)

			expect(stored.get("timeFormat")).toBe("auto")
		})

		it("does not hand a rolled-back value to a write that already started after someone else stored the key", async () => {
			const first = beginSettingWrite("timeFormat", "auto", "12h")
			await performSettingWrite(contextProxy, first)
			await contextProxy.setValue("timeFormat" as never, "9h" as never) // someone else stores
			const second = beginSettingWrite("timeFormat", "12h", "24h")
			await performSettingWrite(contextProxy, second) // started: it read "9h"

			await undoSettingWrite(contextProxy, first) // superseded
			await undoSettingWrite(contextProxy, second)

			expect(stored.get("timeFormat")).toBe("9h")
		})

		it("does not hand a rolled-back value on when the other store has the same value", async () => {
			const first = beginSettingWrite("timeFormat", "auto", "12h")
			await performSettingWrite(contextProxy, first)
			await contextProxy.setValue("timeFormat" as never, "12h" as never) // the same value, by someone else
			const second = beginSettingWrite("timeFormat", "12h", "24h")
			await performSettingWrite(contextProxy, second)

			await undoSettingWrite(contextProxy, first)
			await undoSettingWrite(contextProxy, second)

			expect(stored.get("timeFormat")).toBe("12h")
		})

		it("keeps a store made after the restore that handed the value back, even with the same value", async () => {
			const first = beginSettingWrite("timeFormat", "auto", "12h")
			await performSettingWrite(contextProxy, first)
			const second = beginSettingWrite("timeFormat", "12h", "24h")
			await performSettingWrite(contextProxy, second)

			await undoSettingWrite(contextProxy, second)
			await contextProxy.setValue("timeFormat" as never, "12h" as never) // someone else stores the same value
			await undoSettingWrite(contextProxy, first)

			expect(stored.get("timeFormat")).toBe("12h")
		})

		it("reads what a handed-over write replaces when someone else stored the key before it started", async () => {
			const first = beginSettingWrite("timeFormat", "auto", "12h")
			await performSettingWrite(contextProxy, first)
			const second = beginSettingWrite("timeFormat", "12h", "24h") // queued, not started

			await undoSettingWrite(contextProxy, first) // hands "auto" to the second write
			await contextProxy.setValue("timeFormat" as never, "9h" as never) // someone else stores before it starts
			await performSettingWrite(contextProxy, second)
			await undoSettingWrite(contextProxy, second)

			expect(stored.get("timeFormat")).toBe("9h")
		})

		it("keeps a handed-over value when nobody else stored the key before the write started", async () => {
			const first = beginSettingWrite("timeFormat", "auto", "12h")
			await performSettingWrite(contextProxy, first)
			const second = beginSettingWrite("timeFormat", "12h", "24h")

			await undoSettingWrite(contextProxy, first)
			await performSettingWrite(contextProxy, second)
			await undoSettingWrite(contextProxy, second)

			expect(stored.get("timeFormat")).toBe("auto")
		})

		it("puts back the earlier write when the write after it is rolled back, and that one then fails too", async () => {
			const first = beginSettingWrite("timeFormat", "auto", "12h")
			await performSettingWrite(contextProxy, first)
			const second = beginSettingWrite("timeFormat", "12h", "24h")
			await performSettingWrite(contextProxy, second)

			await undoSettingWrite(contextProxy, second) // puts "12h" back: the first owns the value again
			expect(stored.get("timeFormat")).toBe("12h")
			await undoSettingWrite(contextProxy, first)

			expect(stored.get("timeFormat")).toBe("auto")
		})
	})

	describe("noteSettingStored and forgetSettingStore", () => {
		it("number the stores of a tracked key made while a write of it is pending, and tolerate an unknown one", async () => {
			const write = beginSettingWrite("timeFormat", "auto", "24h")
			expect(noteSettingStored("soundEnabled")).toBeUndefined()
			const first = noteSettingStored("timeFormat")
			const second = noteSettingStored("timeFormat")
			expect(first).toEqual(expect.any(Number))
			expect(second).toBeGreaterThan(first as number)

			forgetSettingStore("soundEnabled", 1) // not tracked: ignored
			forgetSettingStore("dateFormat", 1) // nothing recorded for the key
			forgetSettingStore("timeFormat", first as number)
			forgetSettingStore("timeFormat", first as number) // already forgotten
			forgetSettingStore("timeFormat", second as number)
			finishSettingWrites([write])
		})

		it("keeps nothing for a store made while no write of the key is pending", () => {
			expect(noteSettingStored("timeFormat")).toBeUndefined()
			expect(noteSettingStored("dateFormat")).toBeUndefined()
		})

		it("does not let stores made before a write stored block its rollback, nor grow without a write", async () => {
			for (let i = 0; i < 1000; i++) noteSettingStored("timeFormat") // no write pending: nothing is recorded

			const write = beginSettingWrite("timeFormat", "auto", "24h")
			await performSettingWrite(contextProxy, write)
			await undoSettingWrite(contextProxy, write)

			expect(stored.get("timeFormat")).toBe("auto")
		})

		it("a rejected store cancels only itself, not a store made by someone else after it", async () => {
			const write = beginSettingWrite("timeFormat", "auto", "24h")
			await performSettingWrite(contextProxy, write)
			const rejected = noteSettingStored("timeFormat") as number // an outside store, still pending
			const later = noteSettingStored("timeFormat") as number // another outside store, which lands
			void later
			forgetSettingStore("timeFormat", rejected) // the first one is rejected

			await undoSettingWrite(contextProxy, write)

			// The later store is not forgotten: the failed write leaves the value alone.
			expect(stored.get("timeFormat")).toBe("24h")
		})
	})

	describe("performSettingWrite", () => {
		it("reads what the write replaces when it starts", async () => {
			const write = beginSettingWrite("timeFormat", "stale", "24h")
			store("timeFormat", "12h") // an earlier write reached storage after this one registered

			await performSettingWrite(contextProxy, write)

			expect(write.previous).toBe("12h")
			expect(stored.get("timeFormat")).toBe("24h")
		})

		it("keeps the value handed over by a write that was rolled back before this one started", async () => {
			const first = beginSettingWrite("timeFormat", "auto", "12h")
			store("timeFormat", "12h")
			const second = beginSettingWrite("timeFormat", "12h", "24h")

			await undoSettingWrite(contextProxy, first) // superseded: hands "auto" to the second write
			await performSettingWrite(contextProxy, second)
			expect(second.previous).toBe("auto")

			await undoSettingWrite(contextProxy, second)
			expect(stored.get("timeFormat")).toBe("auto")
		})
	})

	it("puts a failed write back to what was stored before it", async () => {
		const write = beginSettingWrite("timeFormat", "auto", "24h")
		store("timeFormat", "24h")

		await undoSettingWrite(contextProxy, write)

		expect(stored.get("timeFormat")).toBe("auto")
	})

	it("leaves a value alone that was changed by something else after the write", async () => {
		const write = beginSettingWrite("timeFormat", "auto", "24h")
		store("timeFormat", "12h")

		await undoSettingWrite(contextProxy, write)

		expect(stored.get("timeFormat")).toBe("12h")
	})

	it("does not link a new write to one that has finished", async () => {
		const first = beginSettingWrite("timeFormat", "auto", "24h")
		store("timeFormat", "24h")
		finishSettingWrites([first])
		const second = beginSettingWrite("timeFormat", "24h", "12h")
		store("timeFormat", "12h")

		await undoSettingWrite(contextProxy, second)

		// Back to the finished write's value, not past it.
		expect(stored.get("timeFormat")).toBe("24h")
		expect(second.prev).toBeUndefined()
	})
})
