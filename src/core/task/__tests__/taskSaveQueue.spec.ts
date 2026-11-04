import { describe, expect, it } from "vitest"

import { createTaskSaveQueues, enqueueTaskSave } from "../taskSaveQueue"

const deferred = <T = void>() => {
	let resolve: (value: T) => void = () => {}
	let reject: (reason: unknown) => void = () => {}
	const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)))
	return { promise, resolve, reject }
}

describe("enqueueTaskSave", () => {
	it("runs the work of one task one at a time, in the order it was queued", async () => {
		const queues = createTaskSaveQueues()
		const events: string[] = []
		const first = deferred()

		const a = enqueueTaskSave(queues, "t", async () => {
			events.push("a start")
			await first.promise
			events.push("a end")
		})
		const b = enqueueTaskSave(queues, "t", async () => void events.push("b"))
		await Promise.resolve()
		expect(events).toEqual(["a start"]) // b waits

		first.resolve()
		await Promise.all([a, b])
		expect(events).toEqual(["a start", "a end", "b"])
	})

	it("does not make one task wait for another", async () => {
		const queues = createTaskSaveQueues()
		const blocked = deferred()
		void enqueueTaskSave(queues, "slow", () => blocked.promise)

		await expect(enqueueTaskSave(queues, "other", async () => "done")).resolves.toBe("done")
		blocked.resolve()
	})

	it("returns the result of the work, and its failure, to its own caller only", async () => {
		const queues = createTaskSaveQueues()
		const failing = enqueueTaskSave(queues, "t", async () => {
			throw new Error("disk full")
		})
		const next = enqueueTaskSave(queues, "t", async () => "ok") // not held up, and not failed by it

		await expect(failing).rejects.toThrow("disk full")
		await expect(next).resolves.toBe("ok")
	})

	it("drops the queue of a task once it is idle, and keeps it while more work is queued", async () => {
		const queues = createTaskSaveQueues()
		const first = deferred()
		const a = enqueueTaskSave(queues, "t", () => first.promise)
		const b = enqueueTaskSave(queues, "t", async () => undefined)
		expect(queues.size).toBe(1)

		first.resolve()
		await a
		await Promise.resolve()
		expect(queues.size).toBe(1) // b has not run yet or is still the tail
		await b
		await new Promise((resolve) => setImmediate(resolve))
		expect(queues.size).toBe(0)

		await enqueueTaskSave(queues, "failing", () => Promise.reject(new Error("no"))).catch(() => undefined)
		await new Promise((resolve) => setImmediate(resolve))
		expect(queues.size).toBe(0) // a failed save leaves nothing behind either
	})
})
