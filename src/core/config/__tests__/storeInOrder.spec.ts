import { storeInOrder } from "../storeInOrder"
import { giveUpAllOf, giveUpControllerFor } from "../giveUp"

const controllable = () => {
	const finish: Array<{ resolve: () => void; reject: (error: unknown) => void }> = []
	const write = vi.fn(() => new Promise<void>((resolve, reject) => finish.push({ resolve, reject })))
	return { write, finish }
}

let counter = 0
// Each test has a key of its own: what one leaves in line cannot reach another.
let current = "key"
const keyOf = (suffix = "") => `${current}${suffix}`

describe("storeInOrder", () => {
	beforeEach(() => {
		current = `key-${++counter}`
	})

	it("runs a write at once when nothing of that key is in line, and leaves nothing once it is done", async () => {
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

	it("starts a write of the same key only when the one before it has settled, and stores each one, in order", async () => {
		const stored: string[] = []
		const first = controllable()
		const second = controllable()
		const third = controllable()

		const a = storeInOrder(keyOf(), () => first.write().then(() => void stored.push("first")))
		const b = storeInOrder(keyOf(), () => second.write().then(() => void stored.push("second")))
		const c = storeInOrder(keyOf(), () => third.write().then(() => void stored.push("third")))
		await vi.waitFor(() => expect(first.write).toHaveBeenCalledTimes(1))
		expect(second.write).not.toHaveBeenCalled()

		first.finish[0].resolve()
		await a
		await vi.waitFor(() => expect(second.write).toHaveBeenCalledTimes(1))
		expect(third.write).not.toHaveBeenCalled()
		second.finish[0].resolve()
		await b
		await vi.waitFor(() => expect(third.write).toHaveBeenCalledTimes(1))
		third.finish[0].resolve()
		await c

		expect(stored).toEqual(["first", "second", "third"]) // the middle one is stored too: none is reported stored without it
	})

	it("does not hold up another key", async () => {
		const stalled = controllable()
		const other = controllable()

		void storeInOrder(keyOf("-a"), stalled.write)
		const b = storeInOrder(keyOf("-b"), other.write)
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
			void storeInOrder(keyOf(), async () => Promise.reject(new Error("nobody waits"))).catch(() => undefined)
			await new Promise((resolve) => setTimeout(resolve, 20))
			expect(unhandled).not.toHaveBeenCalled()
		} finally {
			process.off("unhandledRejection", unhandled)
		}
	})

	describe("a write whose caller has given up", () => {
		it("is taken out of the line when it has not started, so it is never stored", async () => {
			const running = controllable()
			const dropped = controllable()
			const later = controllable()
			const giveUp = new AbortController()

			void storeInOrder(keyOf(), running.write) // stalled
			const waiting = storeInOrder(keyOf(), dropped.write, { signal: giveUp.signal })
			const rejected = expect(waiting).rejects.toThrow("save timed out")
			const after = storeInOrder(keyOf(), later.write)
			giveUp.abort(new Error("save timed out"))
			await rejected

			running.finish[0].resolve() // the stalled store lands at last
			await vi.waitFor(() => expect(later.write).toHaveBeenCalledTimes(1)) // the write behind it is not held up
			later.finish[0].resolve()
			await after
			expect(dropped.write).not.toHaveBeenCalled()
		})

		it("cannot be taken back once it has started: the writes behind it wait for it", async () => {
			const running = controllable()
			const behind = controllable()
			const giveUp = new AbortController()

			const started = storeInOrder(keyOf(), running.write, { signal: giveUp.signal })
			await vi.waitFor(() => expect(running.write).toHaveBeenCalledTimes(1))
			const after = storeInOrder(keyOf(), behind.write)
			giveUp.abort(new Error("too late"))
			await new Promise((resolve) => setTimeout(resolve, 10))
			expect(behind.write).not.toHaveBeenCalled()

			running.finish[0].resolve()
			await started
			await vi.waitFor(() => expect(behind.write).toHaveBeenCalledTimes(1))
			behind.finish[0].resolve()
			await after
		})

		it("is refused at once when its signal has already been aborted", async () => {
			const { write } = controllable()
			const giveUp = new AbortController()
			giveUp.abort(new Error("already gone"))

			await expect(storeInOrder(keyOf(), write, { signal: giveUp.signal })).rejects.toThrow("already gone")

			expect(write).not.toHaveBeenCalled()
		})

		it("removes the listener that it added to the signal once the write is done", async () => {
			const controller = new AbortController()
			const add = vi.spyOn(controller.signal, "addEventListener")
			const remove = vi.spyOn(controller.signal, "removeEventListener")

			await storeInOrder(keyOf(), async () => undefined, { signal: controller.signal })

			const added = add.mock.calls.filter(([type]) => type === "abort").map(([, listener]) => listener)
			const removed = remove.mock.calls.filter(([type]) => type === "abort").map(([, listener]) => listener)
			expect(added).toHaveLength(1)
			expect(removed).toEqual(added) // the one that was added is the one that is removed
		})

		it("keeps a stalled line from growing: the writes of callers that gave up leave it", async () => {
			const running = controllable()
			const writes = Array.from({ length: 50 }, () => vi.fn(async () => undefined))
			void storeInOrder(keyOf(), running.write)

			for (const write of writes) {
				const giveUp = new AbortController()
				const waiting = storeInOrder(keyOf(), write, { signal: giveUp.signal })
				giveUp.abort(new Error("timed out"))
				await expect(waiting).rejects.toThrow("timed out")
			}
			running.finish[0].resolve()
			const next = controllable()
			const after = storeInOrder(keyOf(), next.write)
			await vi.waitFor(() => expect(next.write).toHaveBeenCalledTimes(1))
			next.finish[0].resolve()
			await after

			for (const write of writes) expect(write).not.toHaveBeenCalled() // none of the 50 was stored
		})
	})
})

describe("giveUp", () => {
	it("takes back what an owner queued and that has not started, and nothing of another owner", async () => {
		const owner = {}
		const other = {}
		const key = `giveUp-${++counter}`
		const running = controllable()
		const mine = controllable()
		const theirs = controllable()
		const mineGiveUp = giveUpControllerFor(owner)
		const theirsGiveUp = giveUpControllerFor(other)

		void storeInOrder(key, running.write)
		const queuedMine = storeInOrder(key, mine.write, { signal: mineGiveUp.controller.signal })
		const queuedTheirs = storeInOrder(key, theirs.write, { signal: theirsGiveUp.controller.signal })
		const rejected = expect(queuedMine).rejects.toThrow("The provider was disposed")

		giveUpAllOf(owner)
		await rejected
		running.finish[0].resolve()
		await vi.waitFor(() => expect(theirs.write).toHaveBeenCalledTimes(1))
		theirs.finish[0].resolve()
		await queuedTheirs

		expect(mine.write).not.toHaveBeenCalled()
		expect(theirsGiveUp.controller.signal.aborted).toBe(false)
	})

	it("keeps nothing for a caller that is done", () => {
		const owner = {}
		const caller = giveUpControllerFor(owner)

		caller.done()
		giveUpAllOf(owner)

		expect(caller.controller.signal.aborted).toBe(false) // it was not in use any more
	})
})
