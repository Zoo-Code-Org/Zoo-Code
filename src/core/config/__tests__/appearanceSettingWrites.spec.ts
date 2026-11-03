import {
	APPEARANCE_SETTING_KEYS,
	beginSettingWrite,
	finishSettingWrites,
	isAppearanceSetting,
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

		it("stops holding its key after the timeout, and the write behind it goes ahead", async () => {
			const hung = new Promise<void>(() => {})
			const proxy = {
				getValue: (key: string) => stored.get(key),
				setValue: vi.fn(async (key: string, value: unknown) => {
					if (value === 120) return hung // never settles
					stored.set(key, value)
				}),
			} as unknown as ContextProxy
			const first = beginSettingWrite("interfaceFontScale", 100, 120)
			const second = beginSettingWrite("interfaceFontScale", 100, 150)
			const firstDone = performSettingWrite(proxy, first)
			const secondDone = performSettingWrite(proxy, second)
			const firstFailed = expect(firstDone).rejects.toThrow("did not finish in 15 seconds")

			await vi.advanceTimersByTimeAsync(14_999)
			expect(stored.get("interfaceFontScale")).toBe(100) // the second is still waiting behind the first
			await vi.advanceTimersByTimeAsync(1)
			await firstFailed
			await secondDone

			expect(stored.get("interfaceFontScale")).toBe(150)
			await undoSettingWrite(proxy, first)
			finishSettingWrites([second])
			expect(settingWriteBookkeepingSize()).toEqual({ latestWrites: 0, queuedKeys: 0 })
			expect(vi.getTimerCount()).toBe(0)
		})

		it("lets a write that lands after the timeout stand, and a rollback keeps what it wrote", async () => {
			let landLate: () => void = () => {}
			const proxy = {
				getValue: (key: string) => stored.get(key),
				setValue: vi.fn(async (key: string, value: unknown) => {
					if (value === 120) {
						// Stores only when it is released, long after the timeout.
						await new Promise<void>((resolve) => (landLate = resolve))
					}
					stored.set(key, value)
				}),
			} as unknown as ContextProxy
			const first = beginSettingWrite("interfaceFontScale", 100, 120)
			const firstDone = performSettingWrite(proxy, first)
			const firstFailed = expect(firstDone).rejects.toThrow("did not finish in 15 seconds")

			await vi.advanceTimersByTimeAsync(15_000)
			await firstFailed
			// The key is free: a later write goes ahead while the first is still outstanding.
			const second = beginSettingWrite("interfaceFontScale", 100, 150)
			await performSettingWrite(proxy, second)
			expect(stored.get("interfaceFontScale")).toBe(150)

			// The timed-out write now lands, and the failed save is rolled back: the stored value is no longer
			// the one that write stored the last time it was looked at, so the rollback leaves it alone.
			landLate()
			await vi.advanceTimersByTimeAsync(0)
			finishSettingWrites([second])
			await undoSettingWrite(proxy, first)

			expect(stored.get("interfaceFontScale")).toBe(120) // the late write is the last one to have landed
			expect(settingWriteBookkeepingSize()).toEqual({ latestWrites: 0, queuedKeys: 0 })
			expect(vi.getTimerCount()).toBe(0)
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

		it("does not let a failing save that wrote the same value undo it", async () => {
			const save = beginSettingWrite("interfaceFontScale", 100, 120)
			await performSettingWrite(proxy, save)

			await setValuesThroughWriteChain(proxy, { interfaceFontScale: 120 })
			await undoSettingWrite(proxy, save)

			expect(stored.get("interfaceFontScale")).toBe(120)
		})
	})
})
