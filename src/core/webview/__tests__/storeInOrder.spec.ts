import { resetStoreInOrder, storeInOrder, storeInOrderKeys } from "../storeInOrder"

const controllable = () => {
	const finish: Array<{ resolve: () => void; reject: (error: unknown) => void }> = []
	const write = vi.fn(() => new Promise<void>((resolve, reject) => finish.push({ resolve, reject })))
	return { write, finish }
}

describe("storeInOrder", () => {
	afterEach(() => resetStoreInOrder())

	it("runs a write at once when nothing of that key is in line, and keeps nothing once it is done", async () => {
		const { write, finish } = controllable()

		const stored = storeInOrder("key", write)
		await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1))
		finish[0].resolve()
		await stored

		expect(storeInOrderKeys()).toEqual([])
	})

	it("starts a write of the same key only when the one before it has settled", async () => {
		const first = controllable()
		const second = controllable()

		const a = storeInOrder("key", first.write)
		const b = storeInOrder("key", second.write)
		await vi.waitFor(() => expect(first.write).toHaveBeenCalledTimes(1))
		expect(second.write).not.toHaveBeenCalled()

		first.finish[0].resolve()
		await a
		await vi.waitFor(() => expect(second.write).toHaveBeenCalledTimes(1))
		second.finish[0].resolve()
		await b
		expect(storeInOrderKeys()).toEqual([])
	})

	it("keeps one write waiting at most: a newer one replaces it, and every caller is answered by the one that runs", async () => {
		const running = controllable()
		const replaced = controllable()
		const latest = controllable()

		const a = storeInOrder("key", running.write)
		const b = storeInOrder("key", replaced.write)
		const c = storeInOrder("key", latest.write)
		expect(c).toBe(b)
		await vi.waitFor(() => expect(running.write).toHaveBeenCalledTimes(1))
		running.finish[0].resolve()
		await a
		await vi.waitFor(() => expect(latest.write).toHaveBeenCalledTimes(1))
		latest.finish[0].resolve()
		await Promise.all([b, c])

		expect(replaced.write).not.toHaveBeenCalled() // the older value is never stored
	})

	it("does not hold up another key", async () => {
		const stalled = controllable()
		const other = controllable()

		void storeInOrder("a", stalled.write)
		const b = storeInOrder("b", other.write)
		await vi.waitFor(() => expect(other.write).toHaveBeenCalledTimes(1))
		other.finish[0].resolve()
		await b
	})

	it("starts the next write when the one before it failed, and tells each caller its own outcome", async () => {
		const first = controllable()
		const second = controllable()

		const a = storeInOrder("key", first.write)
		const aFailed = expect(a).rejects.toThrow("storage unavailable")
		const b = storeInOrder("key", second.write)
		await vi.waitFor(() => expect(first.write).toHaveBeenCalledTimes(1))
		first.finish[0].reject(new Error("storage unavailable"))
		await aFailed
		await vi.waitFor(() => expect(second.write).toHaveBeenCalledTimes(1))
		second.finish[0].resolve()

		await expect(b).resolves.toBeUndefined()
	})

	it("reports a write that throws before it returns a promise, and goes on", async () => {
		const next = controllable()

		const a = storeInOrder("key", () => {
			throw new Error("sync failure")
		})
		await expect(a).rejects.toThrow("sync failure")
		const b = storeInOrder("key", next.write)
		await vi.waitFor(() => expect(next.write).toHaveBeenCalledTimes(1))
		next.finish[0].resolve()
		await b
	})

	it("leaves no unhandled rejection for a failure that nobody waited for", async () => {
		const unhandled = vi.fn()
		process.on("unhandledRejection", unhandled)
		try {
			void storeInOrder("key", async () => Promise.reject(new Error("nobody waits")))
			await new Promise((resolve) => setTimeout(resolve, 20))
			expect(unhandled).not.toHaveBeenCalled()
		} finally {
			process.off("unhandledRejection", unhandled)
		}
	})
})
