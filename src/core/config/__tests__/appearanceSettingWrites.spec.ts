import type { RooCodeSettings } from "@roo-code/types"

import {
	APPEARANCE_SETTING_KEYS,
	beginSettingWrite,
	finishSettingWrites,
	isAppearanceSetting,
	disposeSettingWrites,
	performSettingWrite,
	setValuesThroughWriteChain,
	settingWriteBookkeepingSize,
	undoSettingWrite,
} from "../appearanceSettingWrites"
import type { ContextProxy } from "../ContextProxy"

describe("appearanceSettingWrites", () => {
	let stored: Map<string, unknown>
	// Only the two methods the module uses. The cast says so: the real ContextProxy has far more.
	let contextProxy: ContextProxy

	beforeEach(() => {
		stored = new Map<string, unknown>([["interfaceFontScale", 100]])
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
		it.each(APPEARANCE_SETTING_KEYS)("tracks %s", (key) => {
			expect(isAppearanceSetting(key)).toBe(true)
		})

		it.each(["soundEnabled", "language", "", "TimeFormat"])("does not track %j", (key) => {
			expect(isAppearanceSetting(key)).toBe(false)
		})
	})

	describe("two saves writing the same setting", () => {
		it("a failed save does not undo a later save that wrote the same value afterwards", async () => {
			const save = beginSettingWrite("interfaceFontScale", 100, 120)
			store("interfaceFontScale", 120)
			const other = beginSettingWrite("interfaceFontScale", 120, 120)
			store("interfaceFontScale", 120)
			finishSettingWrites([other])

			await undoSettingWrite(contextProxy, save)

			expect(stored.get("interfaceFontScale")).toBe(120)
		})

		it("a failed earlier save does not undo a later save that wrote the same value afterwards", async () => {
			const other = beginSettingWrite("interfaceFontScale", 100, 150)
			store("interfaceFontScale", 150)
			const save = beginSettingWrite("interfaceFontScale", 150, 150)
			store("interfaceFontScale", 150)
			finishSettingWrites([save])

			await undoSettingWrite(contextProxy, other)

			expect(stored.get("interfaceFontScale")).toBe(150)
		})

		it("when both fail, each restores what was stored before either of them", async () => {
			const save = beginSettingWrite("interfaceFontScale", 100, 120)
			store("interfaceFontScale", 120)
			const other = beginSettingWrite("interfaceFontScale", 120, 150)
			store("interfaceFontScale", 150)

			await undoSettingWrite(contextProxy, save) // superseded by the other save: nothing changes yet
			expect(stored.get("interfaceFontScale")).toBe(150)

			await undoSettingWrite(contextProxy, other)
			expect(stored.get("interfaceFontScale")).toBe(100)
		})
	})

	describe("performSettingWrite", () => {
		it("reads what the write replaces when it starts", async () => {
			const write = beginSettingWrite("interfaceFontScale", "stale", 120)
			store("interfaceFontScale", 150) // an earlier write reached storage after this one registered

			await performSettingWrite(contextProxy, write)

			expect(write.previous).toBe(150)
			expect(stored.get("interfaceFontScale")).toBe(120)
			finishSettingWrites([write]) // leave nothing linked for the next test
		})

		it("keeps the value handed over by a write that was rolled back before this one started", async () => {
			const first = beginSettingWrite("interfaceFontScale", 100, 150)
			store("interfaceFontScale", 150)
			const second = beginSettingWrite("interfaceFontScale", 150, 120)

			await undoSettingWrite(contextProxy, first) // superseded: hands 100 to the second write
			await performSettingWrite(contextProxy, second)
			expect(second.previous).toBe(100)

			await undoSettingWrite(contextProxy, second)
			expect(stored.get("interfaceFontScale")).toBe(100)
		})
	})

	describe("a write that finished between two that fail", () => {
		it("keeps its value when the earlier one fails and then the later one", async () => {
			const first = beginSettingWrite("interfaceFontScale", 100, 150)
			await performSettingWrite(contextProxy, first)
			const second = beginSettingWrite("interfaceFontScale", 150, 120)
			await performSettingWrite(contextProxy, second)
			const third = beginSettingWrite("interfaceFontScale", 120, 80) // registered while the second is pending
			finishSettingWrites([second]) // committed, between the other two
			await performSettingWrite(contextProxy, third)

			await undoSettingWrite(contextProxy, first) // superseded: the committed value is not its to restore
			await undoSettingWrite(contextProxy, third)

			expect(stored.get("interfaceFontScale")).toBe(120)
		})

		it("keeps its value for a later write that has not started when the earlier one fails", async () => {
			const first = beginSettingWrite("interfaceFontScale", 100, 150)
			await performSettingWrite(contextProxy, first)
			const second = beginSettingWrite("interfaceFontScale", 150, 120)
			await performSettingWrite(contextProxy, second)
			const third = beginSettingWrite("interfaceFontScale", 120, 80) // queued, not started

			await undoSettingWrite(contextProxy, first)
			finishSettingWrites([second])
			await performSettingWrite(contextProxy, third)
			await undoSettingWrite(contextProxy, third)

			expect(stored.get("interfaceFontScale")).toBe(120)
		})

		it("leaves what a write read when it started, if it had started when the earlier one finished", async () => {
			const first = beginSettingWrite("interfaceFontScale", 100, 150)
			await performSettingWrite(contextProxy, first)
			const second = beginSettingWrite("interfaceFontScale", 150, 120)
			await performSettingWrite(contextProxy, second)
			const third = beginSettingWrite("interfaceFontScale", 120, 80)
			await performSettingWrite(contextProxy, third) // started: it read 120

			finishSettingWrites([second])
			await undoSettingWrite(contextProxy, third)

			expect(stored.get("interfaceFontScale")).toBe(120)
		})
	})

	it("puts a failed write back to what was stored before it", async () => {
		const write = beginSettingWrite("interfaceFontScale", 100, 120)
		store("interfaceFontScale", 120)

		await undoSettingWrite(contextProxy, write)

		expect(stored.get("interfaceFontScale")).toBe(100)
	})

	it("leaves a value alone that was changed by something else after the write", async () => {
		const write = beginSettingWrite("interfaceFontScale", 100, 120)
		store("interfaceFontScale", 150)

		await undoSettingWrite(contextProxy, write)

		expect(stored.get("interfaceFontScale")).toBe(150)
	})

	it("does not link a new write to one that has finished", async () => {
		const first = beginSettingWrite("interfaceFontScale", 100, 120)
		store("interfaceFontScale", 120)
		finishSettingWrites([first])
		const second = beginSettingWrite("interfaceFontScale", 120, 150)
		store("interfaceFontScale", 150)

		await undoSettingWrite(contextProxy, second)

		// Back to the finished write's value, not past it.
		expect(stored.get("interfaceFontScale")).toBe(120)
		expect(second.prev).toBeUndefined()
	})

	describe("a write that never settles", () => {
		beforeEach(() => vi.useFakeTimers())
		afterEach(() => vi.useRealTimers())

		/** A store that settles only when it is released, and records what it stored. */
		const deferredProxy = () => {
			const releases: Array<() => void> = []
			const proxy = {
				getValue: (key: string) => stored.get(key),
				setValue: vi.fn(async (key: string, value: unknown) => {
					if (value === 120) await new Promise<void>((resolve) => releases.push(resolve))
					stored.set(key, value)
				}),
			} as unknown as ContextProxy
			return { proxy, landLate: () => releases.splice(0).forEach((release) => release()) }
		}

		it("tells the caller after the timeout, refuses a new write of that key while the store is outstanding, and goes ahead once it has settled", async () => {
			const { proxy, landLate } = deferredProxy()
			const first = beginSettingWrite("interfaceFontScale", 100, 120)
			const firstFailed = expect(performSettingWrite(proxy, first)).rejects.toThrow(
				"did not finish in 15 seconds",
			)

			await vi.advanceTimersByTimeAsync(14_999)
			await vi.advanceTimersByTimeAsync(1)
			await firstFailed

			// The store is still outstanding: a new write is refused at once, not queued behind it and not started.
			const second = beginSettingWrite("interfaceFontScale", 100, 150)
			await expect(performSettingWrite(proxy, second)).rejects.toThrow("has not finished yet")
			expect(proxy.setValue).toHaveBeenCalledTimes(1)
			expect(stored.get("interfaceFontScale")).toBe(100)

			// It lands late. Nothing newer was written meanwhile, so it cannot have been overwritten or have overwritten.
			landLate()
			await vi.advanceTimersByTimeAsync(0)
			expect(stored.get("interfaceFontScale")).toBe(120)
			expect(settingWriteBookkeepingSize().queuedKeys).toBe(0)

			// The key is free again.
			const third = beginSettingWrite("interfaceFontScale", 120, 150)
			await performSettingWrite(proxy, third)
			expect(stored.get("interfaceFontScale")).toBe(150)

			finishSettingWrites([third])
			await undoSettingWrite(proxy, second)
			await undoSettingWrite(proxy, first)
			expect(vi.getTimerCount()).toBe(0)
		})

		it("restores the previous value when the store of a rolled-back write lands after the timeout", async () => {
			const { proxy, landLate } = deferredProxy()
			const save = beginSettingWrite("interfaceFontScale", 100, 120)
			const saveFailed = expect(performSettingWrite(proxy, save)).rejects.toThrow("did not finish")
			await vi.advanceTimersByTimeAsync(15_000)
			await saveFailed

			// The save reported failure, so it is rolled back; its store has not settled yet.
			await undoSettingWrite(proxy, save) // returns at once: nobody waits for the store
			expect(stored.get("interfaceFontScale")).toBe(100)
			const newer = beginSettingWrite("interfaceFontScale", 100, 150)
			await expect(performSettingWrite(proxy, newer)).rejects.toThrow("has not finished yet")

			landLate()
			await vi.advanceTimersByTimeAsync(0)

			// The store landed, and the rollback that was waiting behind it put the value back.
			expect(stored.get("interfaceFontScale")).toBe(100)
			expect(settingWriteBookkeepingSize().queuedKeys).toBe(0)
			await undoSettingWrite(proxy, newer)
		})

		it("runs a deferred rollback before a write made after the store has settled, and does not undo that write", async () => {
			const { proxy, landLate } = deferredProxy()
			const save = beginSettingWrite("interfaceFontScale", 100, 120)
			const saveFailed = expect(performSettingWrite(proxy, save)).rejects.toThrow("did not finish")
			await vi.advanceTimersByTimeAsync(15_000)
			await saveFailed
			await undoSettingWrite(proxy, save)

			landLate()
			// A write made as soon as the store has settled queues behind the rollback.
			await vi.advanceTimersByTimeAsync(0)
			const newer = beginSettingWrite("interfaceFontScale", 100, 150)
			await performSettingWrite(proxy, newer)
			finishSettingWrites([newer])

			expect(stored.get("interfaceFontScale")).toBe(150)
		})

		it("leaves the value alone when the store that timed out fails in the end", async () => {
			const failLate: Array<() => void> = []
			const proxy = {
				getValue: (key: string) => stored.get(key),
				setValue: vi.fn(
					() =>
						new Promise<void>((_resolve, reject) => {
							failLate.push(() => reject(new Error("storage unavailable")))
						}),
				),
			} as unknown as ContextProxy
			const save = beginSettingWrite("interfaceFontScale", 100, 120)
			const saveFailed = expect(performSettingWrite(proxy, save)).rejects.toThrow("did not finish")
			await vi.advanceTimersByTimeAsync(15_000)
			await saveFailed
			await undoSettingWrite(proxy, save)

			failLate.forEach((fail) => fail())
			await vi.advanceTimersByTimeAsync(0)

			expect(stored.get("interfaceFontScale")).toBe(100)
			expect(proxy.setValue).toHaveBeenCalledTimes(1) // nothing was stored, so nothing was put back
			expect(settingWriteBookkeepingSize().queuedKeys).toBe(0)
		})

		describe("a rollback that waits behind the slow rollback of a newer save", () => {
			/** The rollback of the newer save puts back 120, and that store is the one that hangs. */
			const slowRollbackProxy = () => {
				const releases: Array<() => void> = []
				const proxy = {
					getValue: (key: string) => stored.get(key),
					setValue: vi.fn(async (key: string, value: unknown) => {
						if (value === 120 && stored.get(key) === 150)
							await new Promise<void>((resolve) => releases.push(resolve))
						stored.set(key, value)
					}),
				} as unknown as ContextProxy
				return { proxy, release: () => releases.splice(0).forEach((release) => release()) }
			}

			/** Two saves that both stored their value (the first 120, the second 150), and the second one's rollback is slow. */
			const bothStoredThenFail = async () => {
				const { proxy, release } = slowRollbackProxy()
				const first = beginSettingWrite("interfaceFontScale", 100, 120)
				await performSettingWrite(proxy, first)
				const second = beginSettingWrite("interfaceFontScale", 120, 150)
				await performSettingWrite(proxy, second)
				const secondUndone = undoSettingWrite(proxy, second)
				secondUndone.catch(() => undefined) // what the test expects of it is asserted where it is awaited
				await vi.advanceTimersByTimeAsync(0) // the rollback of the second save has started, and hangs
				return { proxy, release, first, secondUndone }
			}

			it("is not lost when the wait goes past the timeout: it runs when its turn comes, and puts the original value back", async () => {
				const { proxy, release, first, secondUndone } = await bothStoredThenFail()
				const firstUndone = undoSettingWrite(proxy, first)
				firstUndone.catch(() => undefined)

				await vi.advanceTimersByTimeAsync(15_000) // both callers give up waiting
				await expect(firstUndone).rejects.toThrow("did not finish")
				await expect(secondUndone).rejects.toThrow("did not finish")
				release() // the slow rollback of the second save lands: 120, the value of the first save
				await vi.advanceTimersByTimeAsync(0)

				// Both saves failed: what the first one stored is put back too, not left behind.
				expect(stored.get("interfaceFontScale")).toBe(100)
			})

			it("is not lost when its provider is disposed while it waits", async () => {
				const sidebar = {}
				const { proxy, release, first, secondUndone } = await bothStoredThenFail()
				const firstUndone = undoSettingWrite(proxy, first, { owner: sidebar })
				firstUndone.catch(() => undefined)

				disposeSettingWrites(sidebar) // the view is closed while the rollback waits for its turn
				await vi.advanceTimersByTimeAsync(15_000)
				await expect(firstUndone).rejects.toThrow("did not finish")
				await expect(secondUndone).rejects.toThrow("did not finish")
				release()
				await vi.advanceTimersByTimeAsync(0)

				expect(stored.get("interfaceFontScale")).toBe(100)
			})

			it("is run once the rollback ahead of it settles even when its caller has not given up yet, and leaves no bookkeeping", async () => {
				const { proxy, release, first, secondUndone } = await bothStoredThenFail()
				const firstUndone = undoSettingWrite(proxy, first)

				await vi.advanceTimersByTimeAsync(5_000)
				release() // the rollback ahead of it settles within the wait
				await vi.advanceTimersByTimeAsync(0)
				await firstUndone // it was waiting, and did not time out
				await secondUndone // nor did the rollback ahead of it
				await vi.advanceTimersByTimeAsync(15_000)

				expect(stored.get("interfaceFontScale")).toBe(100)
				expect(settingWriteBookkeepingSize()).toEqual({ latestWrites: 0, queuedKeys: 0 })
			})
		})

		it("drops a write whose caller gave up before it started, so it never lands later", async () => {
			const { proxy, landLate } = deferredProxy()
			const first = beginSettingWrite("interfaceFontScale", 100, 120) // the store that hangs
			const second = beginSettingWrite("interfaceFontScale", 100, 150) // queued behind it
			const firstDone = expect(performSettingWrite(proxy, first)).rejects.toThrow("did not finish")
			const secondDone = expect(performSettingWrite(proxy, second)).rejects.toThrow("did not finish")

			await vi.advanceTimersByTimeAsync(15_000)
			await firstDone
			await secondDone
			landLate()
			await vi.advanceTimersByTimeAsync(0)

			// Only the first store was ever issued; the second was dropped, not run after the first landed.
			expect(proxy.setValue).toHaveBeenCalledTimes(1)
			expect(stored.get("interfaceFontScale")).toBe(120)
			expect(settingWriteBookkeepingSize().queuedKeys).toBe(0)
			await undoSettingWrite(proxy, second)
			await undoSettingWrite(proxy, first)
		})

		it("puts the first value back when two saves both fail, the second never having started, and the first lands late", async () => {
			const { proxy, landLate } = deferredProxy()
			const first = beginSettingWrite("interfaceFontScale", 100, 120) // the store that hangs
			const second = beginSettingWrite("interfaceFontScale", 100, 150) // queued behind it, dropped at its timeout
			const firstDone = expect(performSettingWrite(proxy, first)).rejects.toThrow("did not finish")
			const secondDone = expect(performSettingWrite(proxy, second)).rejects.toThrow("did not finish")
			await vi.advanceTimersByTimeAsync(15_000)
			await firstDone
			await secondDone

			// The saves report their failures in the order they gave up: the first one first.
			await undoSettingWrite(proxy, first)
			await undoSettingWrite(proxy, second)
			landLate()
			await vi.advanceTimersByTimeAsync(0)

			// The first save's value landed after both had failed, and the rollback of the second (which took over the
			// first's) put back what was stored before either.
			expect(stored.get("interfaceFontScale")).toBe(100)
			expect(settingWriteBookkeepingSize()).toEqual({ latestWrites: 0, queuedKeys: 0 })
		})

		it("tells the caller when the rollback of a timed-out write is over, after the store has settled", async () => {
			const { proxy, landLate } = deferredProxy()
			const save = beginSettingWrite("interfaceFontScale", 100, 120)
			const saveFailed = expect(performSettingWrite(proxy, save)).rejects.toThrow("did not finish")
			await vi.advanceTimersByTimeAsync(15_000)
			await saveFailed
			const settled = vi.fn()

			await undoSettingWrite(proxy, save, { onDeferredSettled: settled })
			expect(settled).not.toHaveBeenCalled() // the store is still outstanding

			landLate()
			await vi.advanceTimersByTimeAsync(0)

			expect(settled).toHaveBeenCalledTimes(1)
			expect(stored.get("interfaceFontScale")).toBe(100)
		})

		it("tells the caller too when the late store failed and nothing had to be put back", async () => {
			const failLate: Array<() => void> = []
			const proxy = {
				getValue: (key: string) => stored.get(key),
				setValue: vi.fn(
					() => new Promise<void>((_resolve, reject) => failLate.push(() => reject(new Error("no")))),
				),
			} as unknown as ContextProxy
			const save = beginSettingWrite("interfaceFontScale", 100, 120)
			const saveFailed = expect(performSettingWrite(proxy, save)).rejects.toThrow("did not finish")
			await vi.advanceTimersByTimeAsync(15_000)
			await saveFailed
			const settled = vi.fn()
			await undoSettingWrite(proxy, save, { onDeferredSettled: settled })

			failLate.forEach((fail) => fail())
			await vi.advanceTimersByTimeAsync(0)

			expect(settled).toHaveBeenCalledTimes(1)
		})

		it("does not call back for a rollback that did not have to wait for a store", async () => {
			const proxy = {
				getValue: (key: string) => stored.get(key),
				setValue: async (key: string, value: unknown) => void stored.set(key, value),
			} as unknown as ContextProxy
			const write = beginSettingWrite("interfaceFontScale", 100, 120)
			await performSettingWrite(proxy, write)
			const settled = vi.fn()

			await undoSettingWrite(proxy, write, { onDeferredSettled: settled })

			expect(settled).not.toHaveBeenCalled()
			expect(stored.get("interfaceFontScale")).toBe(100)
		})

		describe("when the provider is disposed", () => {
			// The sidebar and an editor tab share one ContextProxy but are disposed separately.
			let sidebar: { name: string }
			let tab: { name: string }
			beforeEach(() => {
				sidebar = { name: "sidebar" }
				tab = { name: "tab" }
			})

			it("drops a write that is waiting behind a store, so it is never issued, and tells its caller", async () => {
				const { proxy, landLate } = deferredProxy()
				const first = beginSettingWrite("interfaceFontScale", 100, 120) // hangs
				const second = beginSettingWrite("interfaceFontScale", 100, 150) // waiting behind it
				const firstDone = expect(performSettingWrite(proxy, first, sidebar)).rejects.toThrow("did not finish")
				const secondDone = expect(performSettingWrite(proxy, second, sidebar)).rejects.toThrow(
					"provider was disposed",
				)
				await vi.advanceTimersByTimeAsync(1_000)

				disposeSettingWrites(sidebar)
				await secondDone
				await vi.advanceTimersByTimeAsync(14_000)
				await firstDone
				landLate()
				await vi.advanceTimersByTimeAsync(0)

				// Only the first store was ever issued, and it was not cancelled: it landed.
				expect(proxy.setValue).toHaveBeenCalledTimes(1)
				expect(stored.get("interfaceFontScale")).toBe(120)
				expect(settingWriteBookkeepingSize().queuedKeys).toBe(0)
				expect(vi.getTimerCount()).toBe(0)
				await undoSettingWrite(proxy, second)
				await undoSettingWrite(proxy, first)
			})

			it("still puts back a write that had started and fails after its provider was disposed", async () => {
				let failStore: () => void = () => {}
				const proxy = {
					getValue: (key: string) => stored.get(key),
					setValue: vi.fn(async (key: string, value: unknown) => {
						if (value !== 120) {
							stored.set(key, value) // the rollback
							return
						}
						stored.set(key, value) // stored, and then it fails
						await new Promise<void>(
							(_resolve, reject) => (failStore = () => reject(new Error("failed after storing"))),
						)
					}),
				} as unknown as ContextProxy
				const write = beginSettingWrite("interfaceFontScale", 100, 120)
				const saving = expect(performSettingWrite(proxy, write, sidebar)).rejects.toThrow(
					"failed after storing",
				)
				await vi.advanceTimersByTimeAsync(1_000) // the store has started and is waiting

				disposeSettingWrites(sidebar)
				failStore()
				await saving
				const settled = vi.fn()
				await undoSettingWrite(proxy, write, { owner: sidebar, onDeferredSettled: settled })

				expect(stored.get("interfaceFontScale")).toBe(100) // put back, not refused with the disposed provider
				expect(settled).not.toHaveBeenCalled() // and nothing is called back into the disposed provider
				expect(settingWriteBookkeepingSize().queuedKeys).toBe(0)
			})

			it("does not let the rollback of a write that was dropped before its store started undo another provider's write of the same value", async () => {
				const { proxy, landLate } = deferredProxy()
				const fromSidebar = beginSettingWrite("interfaceFontScale", 100, 120) // its store is the one that runs
				const fromTab = beginSettingWrite("interfaceFontScale", 100, 120) // the same value, queued behind it
				const sidebarDone = performSettingWrite(proxy, fromSidebar, sidebar)
				const tabDone = expect(performSettingWrite(proxy, fromTab, tab)).rejects.toThrow(
					"provider was disposed",
				)
				await vi.advanceTimersByTimeAsync(1_000)

				disposeSettingWrites(tab)
				await tabDone
				landLate()
				await sidebarDone // the sidebar's save succeeded
				finishSettingWrites([fromSidebar])

				// The tab's save failed, so it is rolled back: it stored nothing, and the stored value is the sidebar's.
				await undoSettingWrite(proxy, fromTab, { owner: tab })

				expect(stored.get("interfaceFontScale")).toBe(120)
				expect(proxy.setValue).toHaveBeenCalledTimes(1)
			})

			it("refuses a write issued after the provider was disposed, and still serves the provider that shares its store", async () => {
				const { proxy } = deferredProxy()
				disposeSettingWrites(sidebar)

				const late = beginSettingWrite("terminalFontSize", 12, 14)
				await expect(performSettingWrite(proxy, late, sidebar)).rejects.toThrow("was refused")
				expect(stored.get("terminalFontSize")).toBeUndefined()

				const other = beginSettingWrite("terminalFontSize", 12, 16)
				await performSettingWrite(proxy, other, tab)
				expect(stored.get("terminalFontSize")).toBe(16)
				finishSettingWrites([other])
				await undoSettingWrite(proxy, late, { owner: sidebar }) // nothing to put back: it was never issued
				expect(stored.get("terminalFontSize")).toBe(16)
			})

			it("keeps the rollback that is waiting behind a store, so a late store is still put right, but no longer calls back", async () => {
				const { proxy, landLate } = deferredProxy()
				const save = beginSettingWrite("interfaceFontScale", 100, 120)
				const saveFailed = expect(performSettingWrite(proxy, save, sidebar)).rejects.toThrow("did not finish")
				await vi.advanceTimersByTimeAsync(15_000)
				await saveFailed
				const settled = vi.fn()
				await undoSettingWrite(proxy, save, { owner: sidebar, onDeferredSettled: settled })

				disposeSettingWrites(sidebar)
				landLate()
				await vi.advanceTimersByTimeAsync(0)

				// The save failed and its store landed: the value is put back all the same.
				expect(stored.get("interfaceFontScale")).toBe(100)
				// The provider is gone: nothing is called back into it.
				expect(settled).not.toHaveBeenCalled()
				expect(settingWriteBookkeepingSize().queuedKeys).toBe(0)
			})

			it("registers no callback for a provider that was disposed before the write timed out, and still puts the late store right", async () => {
				const { proxy, landLate } = deferredProxy()
				const save = beginSettingWrite("interfaceFontScale", 100, 120)
				const saveFailed = expect(performSettingWrite(proxy, save, sidebar)).rejects.toThrow("did not finish")
				await vi.advanceTimersByTimeAsync(5_000)

				disposeSettingWrites(sidebar) // before the timeout: the store has started and cannot be cancelled
				await vi.advanceTimersByTimeAsync(10_000)
				await saveFailed
				const settled = vi.fn()
				await undoSettingWrite(proxy, save, { owner: sidebar, onDeferredSettled: settled }) // registered after disposal

				landLate()
				await vi.advanceTimersByTimeAsync(0)

				expect(stored.get("interfaceFontScale")).toBe(100) // the storage rollback still ran
				expect(settled).not.toHaveBeenCalled() // and nothing was called back into the disposed provider
				expect(settingWriteBookkeepingSize().queuedKeys).toBe(0)
			})

			it("does not drop a second time a write whose caller already gave up, and releases it", async () => {
				const { proxy, landLate } = deferredProxy()
				const first = beginSettingWrite("interfaceFontScale", 100, 120) // hangs
				const second = beginSettingWrite("interfaceFontScale", 100, 150) // waits, then times out
				const firstDone = expect(performSettingWrite(proxy, first, sidebar)).rejects.toThrow("did not finish")
				const secondDone = expect(performSettingWrite(proxy, second, sidebar)).rejects.toThrow("did not finish")
				await vi.advanceTimersByTimeAsync(15_000)
				await firstDone
				await secondDone

				expect(() => disposeSettingWrites(sidebar)).not.toThrow() // the second one still sits in the queue

				landLate()
				await vi.advanceTimersByTimeAsync(0)
				expect(proxy.setValue).toHaveBeenCalledTimes(1)
				expect(settingWriteBookkeepingSize().queuedKeys).toBe(0)
				await undoSettingWrite(proxy, second)
				await undoSettingWrite(proxy, first)
			})

			it("hands a pending write only the values that a superseded write may have stored: none for one that never started", async () => {
				const { proxy, landLate } = deferredProxy()
				const hung = beginSettingWrite("interfaceFontScale", 100, 120)
				const dropped = beginSettingWrite("interfaceFontScale", 100, 150) // owned by the tab: dropped on disposal
				const pending = beginSettingWrite("interfaceFontScale", 100, 170) // owned by the sidebar: still waiting
				const hungDone = expect(performSettingWrite(proxy, hung, sidebar)).rejects.toThrow("did not finish")
				const droppedDone = expect(performSettingWrite(proxy, dropped, tab)).rejects.toThrow("was dropped")
				const pendingDone = expect(performSettingWrite(proxy, pending, sidebar)).rejects.toThrow(
					"did not finish",
				)
				await vi.advanceTimersByTimeAsync(1_000)
				disposeSettingWrites(tab)
				await droppedDone

				await undoSettingWrite(proxy, dropped, { owner: tab }) // superseded by the pending write

				expect(pending.alsoWrote).toEqual([]) // the dropped write stored nothing: it hands over no value
				expect(pending.previous).toBe(100)
				await vi.advanceTimersByTimeAsync(15_000)
				await hungDone
				await pendingDone
				landLate()
				await vi.advanceTimersByTimeAsync(0)
				await undoSettingWrite(proxy, pending, { owner: sidebar })
				await undoSettingWrite(proxy, hung, { owner: sidebar })
			})

			it("reports a rollback that fails after its store landed, and still calls back", async () => {
				const landLate: Array<() => void> = []
				const proxy = {
					getValue: (key: string) => stored.get(key),
					setValue: vi.fn(async (key: string, value: unknown) => {
						if (value === 120) await new Promise<void>((resolve) => landLate.push(resolve))
						if (value === 100) throw new Error("storage unavailable") // the rollback cannot be written
						stored.set(key, value)
					}),
				} as unknown as ContextProxy
				const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
				const save = beginSettingWrite("interfaceFontScale", 100, 120)
				const saveFailed = expect(performSettingWrite(proxy, save)).rejects.toThrow("did not finish")
				await vi.advanceTimersByTimeAsync(15_000)
				await saveFailed
				const settled = vi.fn()
				await undoSettingWrite(proxy, save, { onDeferredSettled: settled })

				landLate.forEach((land) => land())
				await vi.advanceTimersByTimeAsync(0)

				expect(consoleError).toHaveBeenCalledWith(
					'Failed to restore setting "interfaceFontScale" after a write that timed out:',
					expect.objectContaining({ message: "storage unavailable" }),
				)
				expect(settled).toHaveBeenCalledTimes(1)
				consoleError.mockRestore()
			})

			it("does nothing for a provider with no writes", () => {
				expect(() => disposeSettingWrites({})).not.toThrow()
			})
		})

		it("does not put back a value for a write that was refused while an earlier store was outstanding", async () => {
			const { proxy, landLate } = deferredProxy()
			const hung = beginSettingWrite("interfaceFontScale", 100, 120)
			const hungDone = expect(performSettingWrite(proxy, hung)).rejects.toThrow("did not finish")
			await vi.advanceTimersByTimeAsync(15_000)
			await hungDone

			// Another save's value, refused because the store is outstanding.
			const refused = beginSettingWrite("interfaceFontScale", 100, 120)
			await expect(performSettingWrite(proxy, refused)).rejects.toThrow("has not finished yet")
			await undoSettingWrite(proxy, refused)
			await undoSettingWrite(proxy, hung)

			landLate()
			await vi.advanceTimersByTimeAsync(0)

			// The first save was rolled back, once, when its store landed; the refused one left no continuation behind.
			expect(stored.get("interfaceFontScale")).toBe(100)
			expect(settingWriteBookkeepingSize().queuedKeys).toBe(0)
		})

		it("does not time out a write that finishes in time, and leaves no timer behind", async () => {
			const proxy = {
				getValue: (key: string) => stored.get(key),
				setValue: async (key: string, value: unknown) => {
					await new Promise((resolve) => setTimeout(resolve, 14_000))
					stored.set(key, value)
				},
			} as unknown as ContextProxy
			const write = beginSettingWrite("interfaceFontScale", 100, 120)
			const done = performSettingWrite(proxy, write)

			await vi.advanceTimersByTimeAsync(14_000)
			await done
			finishSettingWrites([write])

			expect(stored.get("interfaceFontScale")).toBe(120)
			expect(vi.getTimerCount()).toBe(0)
		})
	})

	describe("setValuesThroughWriteChain", () => {
		let setValues: ReturnType<typeof vi.fn>
		let proxy: ContextProxy

		beforeEach(() => {
			setValues = vi.fn().mockResolvedValue(undefined)
			stored = new Map<string, unknown>([
				["interfaceFontScale", 100],
				["terminalFontSize", 12],
			])
			proxy = {
				getValue: (key: string) => stored.get(key),
				setValue: async (key: string, value: unknown) => {
					stored.set(key, value)
				},
				setValues,
			} as unknown as ContextProxy
		})

		it("hands settings with no appearance value to setValues as they are", async () => {
			await setValuesThroughWriteChain(proxy, { mode: "code" })

			expect(setValues).toHaveBeenCalledExactlyOnceWith({ mode: "code" })
		})

		it("stores several appearance values through the chain and the rest through setValues", async () => {
			await setValuesThroughWriteChain(proxy, { interfaceFontScale: 120, terminalFontSize: 14, mode: "code" })

			expect(stored.get("interfaceFontScale")).toBe(120)
			expect(stored.get("terminalFontSize")).toBe(14)
			expect(setValues).toHaveBeenCalledExactlyOnceWith({ mode: "code" })
			expect(settingWriteBookkeepingSize()).toEqual({ latestWrites: 0, queuedKeys: 0 })
		})

		it("puts back the value whose write failed after storing it, keeps the other, and throws the failure", async () => {
			proxy.setValue = (async (key: string, value: unknown) => {
				stored.set(key, value)
				if (key === "interfaceFontScale") throw new Error("failed after storing")
			}) as unknown as ContextProxy["setValue"]

			await expect(
				setValuesThroughWriteChain(proxy, { interfaceFontScale: 120, terminalFontSize: 14 }),
			).rejects.toThrow("failed after storing")

			expect(stored.get("interfaceFontScale")).toBe(100)
			expect(stored.get("terminalFontSize")).toBe(14)
			expect(settingWriteBookkeepingSize()).toEqual({ latestWrites: 0, queuedKeys: 0 })
		})

		it("keeps the stored appearance values when the other settings fail, and throws that failure", async () => {
			setValues.mockRejectedValue(new Error("other settings failed"))

			await expect(setValuesThroughWriteChain(proxy, { interfaceFontScale: 120, mode: "code" })).rejects.toThrow(
				"other settings failed",
			)

			expect(stored.get("interfaceFontScale")).toBe(120)
		})

		it.each([
			["interfaceFontScale", 49],
			["interfaceFontScale", 201],
			["terminalFontSize", 999],
			["terminalFontSize", 12.5],
			["editorFontSize", "12"],
			["spacingScale", Number.NaN],
			["spacingScale", {}],
		])("rejects %s = %j before anything is written", async (key, value) => {
			const setValue = vi.spyOn(proxy, "setValue")

			await expect(
				setValuesThroughWriteChain(proxy, { interfaceFontScale: 100, [key]: value, mode: "code" } as never),
			).rejects.toThrow(`Invalid value for ${key}`)

			expect(setValue).not.toHaveBeenCalled()
			expect(setValues).not.toHaveBeenCalled()
			expect(stored.get("interfaceFontScale")).toBe(100)
			expect(settingWriteBookkeepingSize()).toEqual({ latestWrites: 0, queuedKeys: 0 })
		})

		it.each([
			["interfaceFontScale", 50],
			["interfaceFontScale", 200],
			["terminalFontSize", 8],
			["terminalFontSize", 32],
			["editorFontSize", null],
			["spacingScale", undefined],
		])("accepts %s = %j", async (key, value) => {
			await setValuesThroughWriteChain(proxy, { [key]: value } as never)

			expect(stored.get(key)).toBe(value)
		})

		it("does not take an inherited value for something the caller wrote", async () => {
			const inherited = Object.create({ interfaceFontScale: 150 }) as RooCodeSettings
			inherited.mode = "code"

			await setValuesThroughWriteChain(proxy, inherited)

			expect(stored.get("interfaceFontScale")).toBe(100)
			expect(setValues).toHaveBeenCalledExactlyOnceWith({ mode: "code" })
		})

		it("does not let a failing save that wrote the same value undo it", async () => {
			const save = beginSettingWrite("interfaceFontScale", 100, 120)
			await performSettingWrite(proxy, save)

			await setValuesThroughWriteChain(proxy, { interfaceFontScale: 120 })
			await undoSettingWrite(proxy, save)

			expect(stored.get("interfaceFontScale")).toBe(120)
		})
	})
})
