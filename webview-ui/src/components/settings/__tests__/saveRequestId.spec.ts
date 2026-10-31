import { describe, expect, it, vi } from "vitest"

describe("nextSaveRequestId", () => {
	it("never repeats within a load", async () => {
		const { nextSaveRequestId } = await import("../saveRequestId")

		const ids = Array.from({ length: 1000 }, () => nextSaveRequestId())

		expect(new Set(ids).size).toBe(1000)
		for (const id of ids) expect(id).toMatch(/^settings-save-[a-z0-9]+-\d+$/)
	})

	it("does not repeat after the webview reloads, although the counter starts again", async () => {
		vi.resetModules()
		const beforeReload = (await import("../saveRequestId")).nextSaveRequestId()

		vi.resetModules()
		const afterReload = (await import("../saveRequestId")).nextSaveRequestId()

		// Both are the first save of their load, so only the part that is different on every load tells them apart.
		expect(beforeReload.endsWith("-1")).toBe(true)
		expect(afterReload.endsWith("-1")).toBe(true)
		expect(afterReload).not.toBe(beforeReload)
	})

	it("would repeat without the part that differs per load", async () => {
		// The reason the part exists: with the counter alone, the first save after a reload has the first save's id.
		const counterOnly = () => {
			let counter = 0
			return () => `settings-save-${++counter}`
		}
		expect(counterOnly()()).toBe(counterOnly()())
	})
})
