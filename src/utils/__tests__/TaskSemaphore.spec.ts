import { TaskSemaphore } from "../TaskSemaphore"

describe("TaskSemaphore", () => {
	it("acquire() resolves immediately when permits are available", async () => {
		const sem = new TaskSemaphore(2)
		const release = await sem.acquire()
		expect(sem.available).toBe(1)
		expect(sem.waiting).toBe(0)
		release()
	})

	it("second acquire() queues when no permits remain; resolves after release", async () => {
		const sem = new TaskSemaphore(1)
		const release1 = await sem.acquire()
		expect(sem.available).toBe(0)

		let acquired = false
		const p = sem.acquire().then((r) => {
			acquired = true
			return r
		})

		await Promise.resolve()
		expect(sem.waiting).toBe(1)
		expect(acquired).toBe(false)

		release1()
		const release2 = await p
		expect(acquired).toBe(true)
		expect(sem.waiting).toBe(0)
		release2()
	})

	it("release restores exactly one permit and unblocks one waiter", async () => {
		const sem = new TaskSemaphore(1)
		const release1 = await sem.acquire()

		const results: number[] = []
		const p1 = sem.acquire().then((r) => {
			results.push(1)
			return r
		})
		const p2 = sem.acquire().then((r) => {
			results.push(2)
			return r
		})

		await Promise.resolve()
		expect(sem.waiting).toBe(2)

		release1()
		const r1 = await p1
		expect(results).toEqual([1])
		expect(sem.waiting).toBe(1)

		r1()
		const r2 = await p2
		expect(results).toEqual([1, 2])
		expect(sem.waiting).toBe(0)
		r2()
	})

	it("available and waiting return correct values at each step", async () => {
		const sem = new TaskSemaphore(2)
		expect(sem.available).toBe(2)
		expect(sem.waiting).toBe(0)

		const r1 = await sem.acquire()
		expect(sem.available).toBe(1)
		expect(sem.waiting).toBe(0)

		const r2 = await sem.acquire()
		expect(sem.available).toBe(0)
		expect(sem.waiting).toBe(0)

		const p = sem.acquire()
		await Promise.resolve()
		expect(sem.waiting).toBe(1)

		r1()
		await p.then((r) => r())
		expect(sem.available).toBe(1)
		expect(sem.waiting).toBe(0)

		r2()
		expect(sem.available).toBe(2)
	})

	it("cancel() rejects all queued waiters", async () => {
		const sem = new TaskSemaphore(1)
		const release = await sem.acquire()

		const errors: unknown[] = []
		const p1 = sem.acquire().catch((e) => errors.push(e))
		const p2 = sem.acquire().catch((e) => errors.push(e))

		await Promise.resolve()
		expect(sem.waiting).toBe(2)

		sem.cancel()
		await Promise.all([p1, p2])

		expect(errors).toHaveLength(2)
		release()
	})

	it("waiting is 0 while an immediate acquire is in flight (permit available)", async () => {
		const sem = new TaskSemaphore(2)
		// Do NOT await — capture the promise before it settles.
		const p = sem.acquire()
		// Permit was available so nothing should be queued.
		expect(sem.waiting).toBe(0)
		const release = await p
		expect(sem.waiting).toBe(0)
		release()
	})

	it("cancel() resets waiting count to 0 synchronously", async () => {
		const sem = new TaskSemaphore(1)
		const release = await sem.acquire()

		const p1 = sem.acquire().catch(() => {})
		const p2 = sem.acquire().catch(() => {})

		await Promise.resolve()
		expect(sem.waiting).toBe(2)

		sem.cancel()
		// Synchronous check — waiting must be 0 before any promise callbacks run.
		expect(sem.waiting).toBe(0)
		await Promise.all([p1, p2])

		expect(sem.waiting).toBe(0)
		release()
	})

	it("acquire() works after cancel() with permits still available", async () => {
		const sem = new TaskSemaphore(1)
		sem.cancel() // no waiters, no holders
		const release = await sem.acquire()
		expect(sem.available).toBe(0)
		release()
		expect(sem.available).toBe(1)
	})

	it("cancel() on an idle semaphore is a safe no-op", () => {
		const sem = new TaskSemaphore(2)
		expect(() => sem.cancel()).not.toThrow()
		expect(sem.waiting).toBe(0)
		expect(sem.available).toBe(2)
	})
})
