import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import type { HistoryItem } from "@roo-code/types"

import { TaskHistoryStore } from "../TaskHistoryStore"

type WriteTaskFile = (item: HistoryItem, delta?: Partial<HistoryItem>) => Promise<HistoryItem>

interface WriteBarrier {
	arrivals(): number
	dispose(): void
}

function synchronizeNextWrites(stores: TaskHistoryStore[], timeoutMs = 2_000): WriteBarrier {
	let arrivals = 0
	let release!: () => void
	let rejectBarrier!: (error: Error) => void
	let settled = false
	let timer: ReturnType<typeof setTimeout> | undefined
	const barrier = new Promise<void>((resolve, reject) => {
		rejectBarrier = reject
		release = () => {
			if (settled) return
			settled = true
			if (timer) clearTimeout(timer)
			resolve()
		}
		timer = setTimeout(() => {
			if (settled) return
			settled = true
			reject(new Error(`Only ${arrivals}/${stores.length} stores reached writeTaskFile within ${timeoutMs}ms`))
		}, timeoutMs)
	})
	void barrier.catch(() => {})

	for (const store of stores) {
		const value: unknown = Reflect.get(store, "writeTaskFile")
		if (typeof value !== "function") throw new Error("TaskHistoryStore.writeTaskFile is unavailable")
		const original = value.bind(store) as WriteTaskFile
		Reflect.set(store, "writeTaskFile", async (historyItem: HistoryItem, delta?: Partial<HistoryItem>) => {
			arrivals++
			if (arrivals === stores.length) release()
			await barrier
			return original(historyItem, delta)
		})
	}

	return {
		arrivals: () => arrivals,
		dispose: () => {
			if (settled) return
			settled = true
			if (timer) clearTimeout(timer)
			rejectBarrier(new Error("Write barrier disposed before all stores arrived"))
		},
	}
}

function item(id: string): HistoryItem {
	return {
		id,
		number: 1,
		ts: 1,
		task: id,
		tokensIn: 0,
		tokensOut: 0,
		totalCost: 0,
		status: "active",
		childIds: [],
	}
}

describe("TaskHistoryStore real cross-host locking", () => {
	it("preserves independent stale-cache deltas through the real per-file lock", async () => {
		const storagePath = await fs.mkdtemp(path.join(os.tmpdir(), "task-history-real-lock-"))
		const storeA = new TaskHistoryStore(storagePath)
		const storeB = new TaskHistoryStore(storagePath)
		let writeBarrier: WriteBarrier | undefined

		try {
			await storeA.initialize()
			await storeA.upsert(item("shared-task"))
			await storeB.initialize()
			writeBarrier = synchronizeNextWrites([storeA, storeB])

			await Promise.all([
				storeA.atomicReadAndUpdate("shared-task", (current) => ({ ...current, mode: "architect" })),
				storeB.atomicReadAndUpdate("shared-task", (current) => ({ ...current, totalCost: 42 })),
			])

			expect(writeBarrier.arrivals()).toBe(2)
			await storeA.invalidate("shared-task")
			expect(storeA.get("shared-task")).toMatchObject({ mode: "architect", totalCost: 42 })
		} finally {
			writeBarrier?.dispose()
			storeA.dispose()
			storeB.dispose()
			await fs.rm(storagePath, { recursive: true, force: true })
		}
	})

	it("reports a bounded error when one store never reaches the write barrier", async () => {
		const storagePath = await fs.mkdtemp(path.join(os.tmpdir(), "task-history-missed-barrier-"))
		const storeA = new TaskHistoryStore(storagePath)
		const storeB = new TaskHistoryStore(storagePath)
		let writeBarrier: WriteBarrier | undefined

		try {
			await storeA.initialize()
			await storeA.upsert(item("shared-task"))
			await storeB.initialize()
			writeBarrier = synchronizeNextWrites([storeA, storeB], 50)

			await expect(
				storeA.atomicReadAndUpdate("shared-task", (current) => ({ ...current, mode: "architect" })),
			).rejects.toThrow("Only 1/2 stores reached writeTaskFile within 50ms")
			expect(writeBarrier.arrivals()).toBe(1)
		} finally {
			writeBarrier?.dispose()
			storeA.dispose()
			storeB.dispose()
			await fs.rm(storagePath, { recursive: true, force: true })
		}
	})
})
