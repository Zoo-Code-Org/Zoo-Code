import { AsyncTaskTracker } from "./async-task-tracker.js"

describe("AsyncTaskTracker", () => {
	it("drains resolving and rejecting tasks", async () => {
		const tracker = new AsyncTaskTracker()
		let resolveTask!: () => void
		let rejectTask!: (error: Error) => void
		const resolving = new Promise<void>((resolve) => (resolveTask = resolve))
		const rejecting = new Promise<void>((_resolve, reject) => (rejectTask = reject))

		expect(tracker.track(resolving)).toBe(resolving)
		expect(tracker.track(rejecting)).toBe(rejecting)
		const drained = vi.fn()
		const drain = tracker.drain().then(drained)
		await Promise.resolve()
		expect(drained).not.toHaveBeenCalled()

		resolveTask()
		rejectTask(new Error("expected rejection"))
		await drain
		expect(drained).toHaveBeenCalledOnce()
	})

	it("includes tasks tracked while a drain is in progress", async () => {
		const tracker = new AsyncTaskTracker()
		let resolveFirst!: () => void
		let resolveSecond!: () => void
		tracker.track(new Promise<void>((resolve) => (resolveFirst = resolve)))
		const drain = tracker.drain()
		tracker.track(new Promise<void>((resolve) => (resolveSecond = resolve)))

		resolveFirst()
		let drained = false
		void drain.then(() => (drained = true))
		await Promise.resolve()
		expect(drained).toBe(false)
		resolveSecond()
		await drain
		expect(drained).toBe(true)
	})
})
