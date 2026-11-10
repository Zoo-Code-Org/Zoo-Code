import { storeInOrder } from "../storeInOrder"

const controllable = () => {
	const finish: Array<{ resolve: () => void; reject: (error: unknown) => void }> = []
	const write = vi.fn(() => new Promise<void>((resolve, reject) => finish.push({ resolve, reject })))
	return { write, finish }
}

let counter = 0
// Each test has a key of its own: what one leaves in line cannot reach another.
let current = "key"
const keyOf = () => current

describe("storeInOrder", () => {
	beforeEach(() => {
		current = `key-${++counter}`
	})

	it("runs a write at once when nothing of that key is in line, and keeps nothing once it is done", async () => {
		const { write, finish } = controllable()

		const stored = storeInOrder(keyOf(), write)
		await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1))
		finish[0].resolve()
		await stored

		// Nothing is left in line: the next write of the key starts at once.
		const next = controllable()
		void storeInOrder(keyOf(), next.write)
		await vi.waitFor(() => expect(next.write).toHaveBeenCalledTimes(1))
		next.finish[0].resolve()
	})

	it("starts a write of the same key only when the one before it has settled", async () => {
		const first = controllable()
		const second = controllable()

		const a = storeInOrder(keyOf(), first.write)
		const b = storeInOrder(keyOf(), second.write)
		await vi.waitFor(() => expect(first.write).toHaveBeenCalledTimes(1))
		expect(second.write).not.toHaveBeenCalled()

		first.finish[0].resolve()
		await a
		await vi.waitFor(() => expect(second.write).toHaveBeenCalledTimes(1))
		second.finish[0].resolve()
		await b
	})

	it("keeps one write waiting at most: a newer one replaces it, and every caller is answered by the one that runs", async () => {
		const running = controllable()
		const replaced = controllable()
		const latest = controllable()

		const a = storeInOrder(keyOf(), running.write)
		const b = storeInOrder(keyOf(), replaced.write)
		const c = storeInOrder(keyOf(), latest.write)
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

		void storeInOrder(`${keyOf()}-a`, stalled.write)
		const b = storeInOrder(`${keyOf()}-b`, other.write)
		await vi.waitFor(() => expect(other.write).toHaveBeenCalledTimes(1))
		other.finish[0].resolve()
		await b
	})

	it("starts the next write when the one before it failed, and tells each caller its own outcome", async () => {
		const first = controllable()
		const second = controllable()

		const a = storeInOrder(keyOf(), first.write)
		const aFailed = expect(a).rejects.toThrow("storage unavailable")
		const b = storeInOrder(keyOf(), second.write)
		await vi.waitFor(() => expect(first.write).toHaveBeenCalledTimes(1))
		first.finish[0].reject(new Error("storage unavailable"))
		await aFailed
		await vi.waitFor(() => expect(second.write).toHaveBeenCalledTimes(1))
		second.finish[0].resolve()

		await expect(b).resolves.toBeUndefined()
	})

	it("reports a write that throws before it returns a promise, and goes on", async () => {
		const next = controllable()

		const a = storeInOrder(keyOf(), () => {
			throw new Error("sync failure")
		})
		await expect(a).rejects.toThrow("sync failure")
		const b = storeInOrder(keyOf(), next.write)
		await vi.waitFor(() => expect(next.write).toHaveBeenCalledTimes(1))
		next.finish[0].resolve()
		await b
	})

	it("leaves no unhandled rejection for a failure that nobody waited for", async () => {
		const unhandled = vi.fn()
		process.on("unhandledRejection", unhandled)
		try {
			void storeInOrder(keyOf(), async () => Promise.reject(new Error("nobody waits")))
			await new Promise((resolve) => setTimeout(resolve, 20))
			expect(unhandled).not.toHaveBeenCalled()
		} finally {
			process.off("unhandledRejection", unhandled)
		}
	})
})
