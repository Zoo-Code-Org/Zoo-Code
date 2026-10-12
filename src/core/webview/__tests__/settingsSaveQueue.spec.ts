import { enqueueSettingsSave } from "../settingsSaveQueue"

describe("settings save queue", () => {
	it("removes cancelled callers without releasing an active write's storage lock", async () => {
		const context = {}
		const closedView = new AbortController()
		const liveView = new AbortController()
		let release!: () => void
		const active = enqueueSettingsSave(
			context,
			closedView.signal,
			() =>
				new Promise<void>((resolve) => {
					release = resolve
				}),
		)
		const cancelledWrite = vi.fn()
		const pending = enqueueSettingsSave(context, closedView.signal, cancelledWrite)
		const liveWrite = vi.fn().mockResolvedValue(undefined)
		const next = enqueueSettingsSave(context, liveView.signal, liveWrite)
		const cancellations = Promise.all([
			expect(active).rejects.toMatchObject({ name: "AbortError" }),
			expect(pending).rejects.toMatchObject({ name: "AbortError" }),
		])
		closedView.abort()
		await cancellations
		expect(cancelledWrite).not.toHaveBeenCalled()
		expect(liveWrite).not.toHaveBeenCalled()
		release()
		await next
		expect(cancelledWrite).not.toHaveBeenCalled()
		expect(liveWrite).toHaveBeenCalledOnce()
	})

	it("cleans up listeners after failure and accepts saves after the queue drains", async () => {
		const context = {}
		const controller = new AbortController()
		const remove = vi.spyOn(controller.signal, "removeEventListener")
		await expect(
			enqueueSettingsSave(context, controller.signal, async () => {
				throw new Error("write failed")
			}),
		).rejects.toThrow("write failed")
		await enqueueSettingsSave(context, controller.signal, async () => {})
		expect(remove).toHaveBeenCalledTimes(2)
	})
})
