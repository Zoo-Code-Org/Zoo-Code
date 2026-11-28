import { waitForThoughtSignatureDrain } from "../thoughtSignatureDrain"

describe("waitForThoughtSignatureDrain", () => {
	beforeEach(() => vi.useFakeTimers())
	afterEach(() => vi.useRealTimers())

	it("clears the deadline after a completed drain", async () => {
		const onTimeout = vi.fn()
		await waitForThoughtSignatureDrain(Promise.resolve(), { timeoutMs: 20_000, onTimeout })
		expect(vi.getTimerCount()).toBe(0)
		expect(onTimeout).not.toHaveBeenCalled()
	})

	it("propagates a drain failure and clears its deadline", async () => {
		const error = new Error("stream failed")
		const onTimeout = vi.fn()
		await expect(
			waitForThoughtSignatureDrain(Promise.reject(error), { timeoutMs: 20_000, onTimeout }),
		).rejects.toBe(error)
		expect(vi.getTimerCount()).toBe(0)
		expect(onTimeout).not.toHaveBeenCalled()
	})

	it("allows a late signature beyond the usage collection window", async () => {
		let finish!: () => void
		const drain = new Promise<void>((resolve) => {
			finish = resolve
		})
		const onTimeout = vi.fn()
		const waiting = waitForThoughtSignatureDrain(drain, { timeoutMs: 20_000, onTimeout })
		await vi.advanceTimersByTimeAsync(6_001)
		expect(onTimeout).not.toHaveBeenCalled()
		finish()
		await waiting
		expect(vi.getTimerCount()).toBe(0)
	})

	it("rejects a stalled drain at the independent deadline", async () => {
		const onTimeout = vi.fn()
		const waiting = waitForThoughtSignatureDrain(new Promise<void>(() => {}), { timeoutMs: 20_000, onTimeout })
		const rejected = expect(waiting).rejects.toMatchObject({ name: "TimeoutError" })
		await vi.advanceTimersByTimeAsync(19_999)
		expect(onTimeout).not.toHaveBeenCalled()
		await vi.advanceTimersByTimeAsync(1)
		await rejected
		expect(onTimeout).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ name: "TimeoutError" }))
		expect(vi.getTimerCount()).toBe(0)
	})

	it.each(["before", "during"])("propagates cancellation %s the wait", async (when) => {
		const controller = new AbortController()
		const reason = new Error("cancelled")
		if (when === "before") controller.abort(reason)
		const onTimeout = vi.fn()
		const waiting = waitForThoughtSignatureDrain(new Promise<void>(() => {}), {
			timeoutMs: 20_000,
			signal: controller.signal,
			onTimeout,
		})
		const rejected = expect(waiting).rejects.toBe(reason)
		if (when === "during") controller.abort(reason)
		await rejected
		expect(onTimeout).not.toHaveBeenCalled()
		expect(vi.getTimerCount()).toBe(0)
	})
})
