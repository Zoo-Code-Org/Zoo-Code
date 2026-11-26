import { getEventListeners } from "node:events"
import { awaitWithAbort } from "../awaitWithAbort"

describe("awaitWithAbort", () => {
	it("does not retain listeners across many chunks on the same signal", async () => {
		const controller = new AbortController()
		for (let i = 0; i < 20_000; i++) {
			expect(await awaitWithAbort(Promise.resolve(i), controller.signal)).toBe(i)
			if (i % 100 === 0) expect(getEventListeners(controller.signal, "abort")).toHaveLength(0)
		}
	})
	it("settles promptly on abort, detaches, and observes a late rejection", async () => {
		const controller = new AbortController()
		let reject!: (error: Error) => void
		const operation = new Promise<never>((_, fail) => {
			reject = fail
		})
		const pending = awaitWithAbort(operation, controller.signal)
		controller.abort()
		await expect(pending).rejects.toThrow("Request cancelled by user")
		expect(getEventListeners(controller.signal, "abort")).toHaveLength(0)
		reject(new Error("late failure"))
		await Promise.resolve()
	})
	it("cleans up failures and already-aborted calls without hiding operation failures", async () => {
		const controller = new AbortController()
		await expect(awaitWithAbort(Promise.reject(new Error("provider failed")), controller.signal)).rejects.toThrow(
			"provider failed",
		)
		expect(getEventListeners(controller.signal, "abort")).toHaveLength(0)
		controller.abort()
		await expect(awaitWithAbort(new Promise(() => {}), controller.signal)).rejects.toThrow("cancelled")
		expect(getEventListeners(controller.signal, "abort")).toHaveLength(0)
	})
})
