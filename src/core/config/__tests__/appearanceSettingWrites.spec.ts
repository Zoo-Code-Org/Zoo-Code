import {
	APPEARANCE_SETTING_KEYS,
	beginSettingWrite,
	finishSettingWrites,
	isAppearanceSetting,
	performSettingWrite,
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
})
