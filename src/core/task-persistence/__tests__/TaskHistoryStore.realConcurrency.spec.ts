import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import type { HistoryItem } from "@roo-code/types"

import { lockJsonFile } from "../../../utils/safeWriteJson"
import { TASK_HISTORY_BACKUP_RETENTION_MS, TaskHistoryStore } from "../TaskHistoryStore"

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

async function seedHistoryBackup(storagePath: string, taskId: string, ageMs: number): Promise<string> {
	const taskDir = path.join(storagePath, "tasks", taskId)
	const historyPath = path.join(taskDir, "history_item.json")
	const backupPath = path.join(taskDir, `.history_item.json.bak_${Date.now() - ageMs}_backup.tmp`)
	await fs.mkdir(taskDir, { recursive: true })
	await fs.writeFile(historyPath, JSON.stringify({ ...item(taskId), status: "completed" }))
	await fs.writeFile(backupPath, JSON.stringify({ ...item(taskId), status: "active" }))
	const modified = new Date(Date.now() - ageMs)
	await fs.utimes(backupPath, modified, modified)
	return backupPath
}

describe("TaskHistoryStore real cross-host locking", () => {
	it("retains recent history backups during initialization", async () => {
		const storagePath = await fs.mkdtemp(path.join(os.tmpdir(), "task-history-recent-backup-"))
		const store = new TaskHistoryStore(storagePath)
		try {
			const backupPath = await seedHistoryBackup(storagePath, "recent-task", TASK_HISTORY_BACKUP_RETENTION_MS / 2)
			await store.initialize()
			await expect(fs.access(backupPath)).resolves.toBeUndefined()
		} finally {
			store.dispose()
			await fs.rm(storagePath, { recursive: true, force: true })
		}
	})

	it("prunes stale history backups during initialization", async () => {
		const storagePath = await fs.mkdtemp(path.join(os.tmpdir(), "task-history-stale-backup-"))
		const store = new TaskHistoryStore(storagePath)
		try {
			const backupPath = await seedHistoryBackup(storagePath, "stale-task", TASK_HISTORY_BACKUP_RETENTION_MS * 2)
			await store.initialize()
			await expect(fs.access(backupPath)).rejects.toMatchObject({ code: "ENOENT" })
		} finally {
			store.dispose()
			await fs.rm(storagePath, { recursive: true, force: true })
		}
	})

	it("waits for an active history operation before pruning its stale backup", async () => {
		const storagePath = await fs.mkdtemp(path.join(os.tmpdir(), "task-history-active-backup-"))
		const store = new TaskHistoryStore(storagePath)
		const backupPath = await seedHistoryBackup(storagePath, "active-task", TASK_HISTORY_BACKUP_RETENTION_MS * 2)
		const historyPath = path.join(storagePath, "tasks", "active-task", "history_item.json")
		const release = await lockJsonFile(historyPath)
		let released = false
		try {
			const initialization = store.initialize()
			await new Promise((resolve) => setTimeout(resolve, 50))
			await expect(fs.access(backupPath)).resolves.toBeUndefined()
			await release()
			released = true
			await initialization
			await expect(fs.access(backupPath)).rejects.toMatchObject({ code: "ENOENT" })
		} finally {
			store.dispose()
			if (!released) await release().catch(() => {})
			await fs.rm(storagePath, { recursive: true, force: true })
		}
	})

	it("preserves independent stale-cache deltas through the real per-file lock", async () => {
		const storagePath = await fs.mkdtemp(path.join(os.tmpdir(), "task-history-real-lock-"))
		const storeA = new TaskHistoryStore(storagePath)
		const storeB = new TaskHistoryStore(storagePath)

		try {
			await storeA.initialize()
			await storeA.upsert(item("shared-task"))
			await storeB.initialize()

			await Promise.all([
				storeA.atomicReadAndUpdate("shared-task", (current) => ({ ...current, mode: "architect" })),
				storeB.atomicReadAndUpdate("shared-task", (current) => ({ ...current, totalCost: 42 })),
			])

			await storeA.invalidate("shared-task")
			expect(storeA.get("shared-task")).toMatchObject({ mode: "architect", totalCost: 42 })
		} finally {
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
