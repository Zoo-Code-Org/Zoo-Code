import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import type { HistoryItem } from "@roo-code/types"
import type { MockInstance } from "vitest"

import { TaskHistoryStore } from "../TaskHistoryStore"

// Wrap the real fs/promises so a test can pause inside the per-file lock
// while every call still runs against the real filesystem.
vi.mock("fs/promises", async () => {
	const actual = await vi.importActual<typeof import("fs/promises")>("fs/promises")
	return { ...actual, readFile: vi.fn(actual.readFile) }
})

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

function createAction(actionId: string, message: string) {
	return {
		kind: "create_subtask" as const,
		actionId,
		approvalText: "{}",
		mode: "code",
		message,
		todos: [],
	}
}

describe("TaskHistoryStore real cross-host locking", () => {
	it("preserves a recovered record instead of overwriting it during legacy migration", async () => {
		const storagePath = await fs.mkdtemp(path.join(os.tmpdir(), "task-history-migrate-"))
		const store = new TaskHistoryStore(storagePath)
		try {
			const legacy = item("migrated")
			const committed = { ...legacy, task: "committed newer task", totalCost: 7 }
			const taskDir = path.join(storagePath, "tasks", legacy.id)
			await fs.mkdir(taskDir, { recursive: true })
			await fs.writeFile(path.join(taskDir, ".history_item.json.bak_1.tmp"), JSON.stringify(committed))
			await store.migrateFromGlobalState([legacy])
			expect(store.get(legacy.id)).toEqual(committed)
			expect(JSON.parse(await fs.readFile(path.join(taskDir, "history_item.json"), "utf8"))).toEqual(committed)
		} finally {
			store.dispose()
			await fs.rm(storagePath, { recursive: true, force: true })
		}
	})

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

	it("preserves a replacement pending action when a stale store settles the prior action", async () => {
		const storagePath = await fs.mkdtemp(path.join(os.tmpdir(), "task-history-stale-settlement-"))
		const storeA = new TaskHistoryStore(storagePath)
		const storeB = new TaskHistoryStore(storagePath)
		const actionA = createAction("action-a", "action A")
		const actionB = { ...actionA, actionId: "action-b", message: "action B" }

		try {
			await storeA.initialize()
			await storeA.upsert({ ...item("shared-task"), pendingAction: actionA })
			await storeB.initialize()

			await storeB.atomicReadAndUpdate("shared-task", (current) => ({ ...current, pendingAction: actionB }))
			expect(storeA.get("shared-task")?.pendingAction).toEqual(actionA)

			const authoritative = await storeA.clearPendingActionIfMatching("shared-task", actionA.actionId)
			expect(authoritative.pendingAction).toEqual(actionB)
			expect(storeA.get("shared-task")?.pendingAction).toEqual(actionB)
			await storeB.invalidate("shared-task")

			expect(storeB.get("shared-task")?.pendingAction).toEqual(actionB)
		} finally {
			storeA.dispose()
			storeB.dispose()
			await fs.rm(storagePath, { recursive: true, force: true })
		}
	})

	it("clears a matching create_subtask action from disk and refreshes the cache", async () => {
		const storagePath = await fs.mkdtemp(path.join(os.tmpdir(), "task-history-compare-clear-"))
		const storeA = new TaskHistoryStore(storagePath)
		const storeB = new TaskHistoryStore(storagePath)
		const actionA = createAction("action-a", "action A")

		try {
			await storeA.initialize()
			await storeA.upsert({ ...item("shared-task"), pendingAction: actionA })
			await storeB.initialize()

			const authoritative = await storeA.clearPendingActionIfMatching("shared-task", actionA.actionId)

			expect(authoritative.pendingAction).toBeUndefined()
			expect(storeA.get("shared-task")?.pendingAction).toBeUndefined()
			await storeB.invalidate("shared-task")
			expect(storeB.get("shared-task")?.pendingAction).toBeUndefined()
			expect(storeB.get("shared-task")).toMatchObject({ id: "shared-task", status: "active" })
		} finally {
			storeA.dispose()
			storeB.dispose()
			await fs.rm(storagePath, { recursive: true, force: true })
		}
	})

	it("preserves a matching create_subtask action on a completed record", async () => {
		const storagePath = await fs.mkdtemp(path.join(os.tmpdir(), "task-history-completed-settlement-"))
		const store = new TaskHistoryStore(storagePath)
		const pendingAction = createAction("action-a", "action A")
		const completed: HistoryItem = { ...item("shared-task"), status: "completed", pendingAction }
		const filePath = path.join(storagePath, "tasks", completed.id, "history_item.json")

		try {
			await store.initialize()
			await store.upsert(completed)

			const beforeDisk = JSON.parse(await fs.readFile(filePath, "utf8")) as HistoryItem
			expect({ cache: store.get(completed.id), disk: beforeDisk }).toEqual({ cache: completed, disk: completed })

			const returned = await store.clearPendingActionIfMatching(completed.id, pendingAction.actionId)
			const afterDisk = JSON.parse(await fs.readFile(filePath, "utf8")) as HistoryItem

			expect({ returned, disk: afterDisk, cache: store.get(completed.id) }).toEqual({
				returned: completed,
				disk: completed,
				cache: completed,
			})
		} finally {
			store.dispose()
			await fs.rm(storagePath, { recursive: true, force: true })
		}
	})

	it("clears a matching action from disk even when the calling store cache is stale", async () => {
		const storagePath = await fs.mkdtemp(path.join(os.tmpdir(), "task-history-disk-compare-clear-"))
		const storeA = new TaskHistoryStore(storagePath)
		const storeB = new TaskHistoryStore(storagePath)
		const actionA = createAction("action-a", "action A")

		try {
			await storeA.initialize()
			await storeA.upsert(item("shared-task"))
			await storeB.initialize()

			await storeB.atomicReadAndUpdate("shared-task", (current) => ({ ...current, pendingAction: actionA }))

			const authoritative = await storeA.clearPendingActionIfMatching("shared-task", actionA.actionId)

			expect(authoritative.pendingAction).toBeUndefined()
			await storeB.invalidate("shared-task")
			expect(storeB.get("shared-task")?.pendingAction).toBeUndefined()
		} finally {
			storeA.dispose()
			storeB.dispose()
			await fs.rm(storagePath, { recursive: true, force: true })
		}
	})

	it("preserves a different-kind pending action with the same action ID", async () => {
		const storagePath = await fs.mkdtemp(path.join(os.tmpdir(), "task-history-different-kind-"))
		const storeA = new TaskHistoryStore(storagePath)
		const finishAction = {
			kind: "finish_subtask" as const,
			actionId: "action-a",
			approvalText: "{}",
			parentTaskId: "parent-1",
			result: "done",
		}

		try {
			await storeA.initialize()
			await storeA.upsert({ ...item("shared-task"), pendingAction: finishAction })

			const authoritative = await storeA.clearPendingActionIfMatching("shared-task", finishAction.actionId)

			expect(authoritative.pendingAction).toEqual(finishAction)
			expect(storeA.get("shared-task")?.pendingAction).toEqual(finishAction)
		} finally {
			storeA.dispose()
			await fs.rm(storagePath, { recursive: true, force: true })
		}
	})

	it("preserves the record when no pending action is persisted", async () => {
		const storagePath = await fs.mkdtemp(path.join(os.tmpdir(), "task-history-no-action-"))
		const storeA = new TaskHistoryStore(storagePath)

		try {
			await storeA.initialize()
			await storeA.upsert(item("shared-task"))

			const authoritative = await storeA.clearPendingActionIfMatching("shared-task", "action-a")

			expect(authoritative.pendingAction).toBeUndefined()
			expect(authoritative).toMatchObject({ id: "shared-task", status: "active" })
		} finally {
			storeA.dispose()
			await fs.rm(storagePath, { recursive: true, force: true })
		}
	})

	it("does not recreate a task deleted by another host before settlement", async () => {
		const storagePath = await fs.mkdtemp(path.join(os.tmpdir(), "task-history-deleted-settlement-"))
		const storeA = new TaskHistoryStore(storagePath)
		const storeB = new TaskHistoryStore(storagePath)
		const actionA = createAction("action-a", "action A")

		try {
			await storeA.initialize()
			await storeA.upsert({ ...item("shared-task"), pendingAction: actionA })
			await storeB.initialize()

			await storeB.delete("shared-task")
			expect(storeA.get("shared-task")?.pendingAction).toEqual(actionA)

			await expect(storeA.clearPendingActionIfMatching("shared-task", actionA.actionId)).rejects.toThrow(
				"task shared-task not found",
			)
			expect(storeA.get("shared-task")).toBeUndefined()
			await storeB.invalidate("shared-task")
			expect(storeB.get("shared-task")).toBeUndefined()
		} finally {
			storeA.dispose()
			storeB.dispose()
			await fs.rm(storagePath, { recursive: true, force: true })
		}
	})

	it("serializes deletion after settlement reads disk without recreating the record", async () => {
		const storagePath = await fs.mkdtemp(path.join(os.tmpdir(), "task-history-delete-during-settlement-"))
		const storeA = new TaskHistoryStore(storagePath)
		const storeB = new TaskHistoryStore(storagePath)
		const action = createAction("action-a", "action A")
		const filePath = path.join(storagePath, "tasks", "shared-task", "history_item.json")
		const actualFs = await vi.importActual<typeof import("fs/promises")>("fs/promises")
		let signalReadComplete!: () => void
		const readComplete = new Promise<void>((resolve) => {
			signalReadComplete = resolve
		})
		let releaseSettlement!: () => void
		const settlementCanContinue = new Promise<void>((resolve) => {
			releaseSettlement = resolve
		})

		try {
			await storeA.initialize()
			await storeA.upsert({ ...item("shared-task"), pendingAction: action })
			await storeB.initialize()

			// Pause settlement inside its locked disk read, then start a
			// deletion from another store so it targets the settlement's
			// read-to-commit window.
			vi.mocked(fs.readFile).mockImplementation(async (...args: Parameters<typeof fs.readFile>) => {
				const result = await actualFs.readFile(...args)
				if (args[0] === filePath) {
					signalReadComplete()
					await settlementCanContinue
				}
				return result
			})

			const settlement = storeA.clearPendingActionIfMatching("shared-task", action.actionId)
			await readComplete
			const deletion = storeB.delete("shared-task")
			let deletionSettled = false
			void deletion.finally(() => {
				deletionSettled = true
			})
			await new Promise((resolve) => setTimeout(resolve, 25))
			// The deletion must stay blocked while settlement holds the
			// per-file lock across its read-to-commit window.
			expect(deletionSettled).toBe(false)

			releaseSettlement()
			await expect(settlement).resolves.toMatchObject({ id: "shared-task", pendingAction: undefined })
			await deletion

			// The settlement committed first and the locked deletion
			// removed the file afterwards, so the record stays deleted
			// instead of being resurrected.
			await expect(fs.access(filePath)).rejects.toMatchObject({ code: "ENOENT" })
			await expect(storeA.clearPendingActionIfMatching("shared-task", action.actionId)).rejects.toThrow(
				"task shared-task not found",
			)
			expect(storeA.get("shared-task")).toBeUndefined()
			expect(storeB.get("shared-task")).toBeUndefined()
		} finally {
			vi.mocked(fs.readFile).mockImplementation(actualFs.readFile)
			storeA.dispose()
			storeB.dispose()
			await fs.rm(storagePath, { recursive: true, force: true })
		}
	})

	it("rejects settlement for a task absent from the cache without creating it", async () => {
		const storagePath = await fs.mkdtemp(path.join(os.tmpdir(), "task-history-cache-miss-settlement-"))
		const store = new TaskHistoryStore(storagePath)
		const filePath = path.join(storagePath, "tasks", "missing-task", "history_item.json")

		try {
			await store.initialize()

			await expect(store.clearPendingActionIfMatching("missing-task", "action-a")).rejects.toThrow(
				"task missing-task not found in cache",
			)
			expect(store.get("missing-task")).toBeUndefined()
			await expect(fs.access(filePath)).rejects.toMatchObject({ code: "ENOENT" })
		} finally {
			store.dispose()
			await fs.rm(storagePath, { recursive: true, force: true })
		}
	})

	describe("setAutoTitleIfAbsent", () => {
		let warn: MockInstance<typeof console.warn>
		beforeEach(() => {
			warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		})
		afterEach(() => {
			warn.mockRestore()
		})

		async function withTwoStores(
			run: (a: TaskHistoryStore, b: TaskHistoryStore, storagePath: string) => Promise<void>,
		) {
			const storagePath = await fs.mkdtemp(path.join(os.tmpdir(), "task-history-auto-title-"))
			const storeA = new TaskHistoryStore(storagePath)
			const storeB = new TaskHistoryStore(storagePath)
			try {
				await storeA.initialize()
				await storeA.upsert(item("shared-task"))
				await storeB.initialize()
				await run(storeA, storeB, storagePath)
			} finally {
				storeA.dispose()
				storeB.dispose()
				await fs.rm(storagePath, { recursive: true, force: true })
			}
		}

		const taskFile = (storagePath: string) => path.join(storagePath, "tasks", "shared-task", "history_item.json")

		it("writes the title and trims it", async () => {
			await withTwoStores(async (storeA, storeB, storagePath) => {
				const result = await storeA.setAutoTitleIfAbsent("shared-task", "  Fix login bug  ")
				expect(result.applied).toBe(true)
				expect(result.item?.autoTitle).toBe("Fix login bug")
				expect(JSON.parse(await fs.readFile(taskFile(storagePath), "utf8")).autoTitle).toBe("Fix login bug")
				await storeB.invalidate("shared-task")
				expect(storeB.get("shared-task")?.autoTitle).toBe("Fix login bug")
			})
		})

		it("keeps a title written by another host and refreshes the stale cache", async () => {
			await withTwoStores(async (storeA, storeB) => {
				await storeB.setAutoTitleIfAbsent("shared-task", "First title")
				expect(storeA.get("shared-task")?.autoTitle).toBeUndefined()

				const result = await storeA.setAutoTitleIfAbsent("shared-task", "Second title")
				expect(result.applied).toBe(false)
				expect(result.item?.autoTitle).toBe("First title")
				expect(storeA.get("shared-task")?.autoTitle).toBe("First title")
			})
		})

		it("does not recreate a task deleted by another host", async () => {
			await withTwoStores(async (storeA, storeB, storagePath) => {
				await storeB.delete("shared-task")
				expect(storeA.get("shared-task")).toBeDefined()

				const result = await storeA.setAutoTitleIfAbsent("shared-task", "Late title")
				expect(result).toEqual({ applied: false })
				expect(storeA.get("shared-task")).toBeUndefined()
				await expect(fs.access(taskFile(storagePath))).rejects.toMatchObject({ code: "ENOENT" })
				// A deleted task is an expected outcome, not a read failure.
				expect(warn).not.toHaveBeenCalled()
			})
		})

		it("does not recreate a task deleted after the early disk read", async () => {
			await withTwoStores(async (storeA, storeB, storagePath) => {
				const stale = storeA.get("shared-task")
				if (!stale) throw new Error("test setup failed")
				const original = storeA["readTaskFileForAutoTitle"].bind(storeA)
				let reads = 0
				// The early read sees the record from before the delete; the merge and the re-read see the real disk.
				storeA["readTaskFileForAutoTitle"] = async (id) =>
					reads++ === 0 ? { kind: "found", item: stale } : original(id)

				await storeB.delete("shared-task")

				const result = await storeA.setAutoTitleIfAbsent("shared-task", "Late title")
				expect(reads).toBe(2)
				expect(result.applied).toBe(false)
				expect(storeA.get("shared-task")).toBeUndefined()
				await expect(fs.access(taskFile(storagePath))).rejects.toMatchObject({ code: "ENOENT" })
			})
		})

		const ioError = () => Object.assign(new Error("EIO: i/o error, read"), { code: "EIO" })
		// Each case corrupts the read and returns the file content that must remain on disk.
		const unreadableCases: Array<{ name: string; corrupt(storagePath: string, before: string): Promise<string> }> =
			[
				{
					name: "a read error",
					corrupt: async (_storagePath, before) => {
						vi.mocked(fs.readFile).mockRejectedValueOnce(ioError())
						return before
					},
				},
				{
					name: "unparsable JSON",
					corrupt: async (storagePath) => {
						await fs.writeFile(taskFile(storagePath), "{ torn")
						return "{ torn"
					},
				},
				{
					name: "a record with a different id",
					corrupt: async (storagePath) => {
						const other = JSON.stringify(item("other-task"))
						await fs.writeFile(taskFile(storagePath), other)
						return other
					},
				},
			]

		it.each(unreadableCases)("keeps the cache, writes nothing and logs on $name", async ({ corrupt }) => {
			await withTwoStores(async (storeA, _storeB, storagePath) => {
				const cached = storeA.get("shared-task")
				const expectedOnDisk = await corrupt(storagePath, await fs.readFile(taskFile(storagePath), "utf8"))

				const result = await storeA.setAutoTitleIfAbsent("shared-task", "Title")
				expect(result.applied).toBe(false)
				expect(storeA.get("shared-task")).toEqual(cached)
				expect(await fs.readFile(taskFile(storagePath), "utf8")).toBe(expectedOnDisk)
				expect(warn).toHaveBeenCalledExactlyOnceWith(
					"[TaskHistoryStore] Failed to read task shared-task for auto title:",
					expect.anything(),
				)
			})
		})

		it("does not let a stale save overwrite a peer update after a read error", async () => {
			await withTwoStores(async (storeA, storeB) => {
				await storeA.upsert({ ...item("shared-task"), mode: "code" })
				const stale = storeA.get("shared-task")!
				await storeB.invalidate("shared-task")
				await storeB.upsert({ ...storeB.get("shared-task")!, mode: "architect" })

				vi.mocked(fs.readFile).mockRejectedValueOnce(ioError())
				await storeA.setAutoTitleIfAbsent("shared-task", "Title")
				await storeA.upsert({ ...stale, tokensOut: 5 })

				await storeB.invalidate("shared-task")
				expect(storeB.get("shared-task")).toMatchObject({ mode: "architect", tokensOut: 5 })
			})
		})

		it.each([
			{ name: "writes the title", peerTitle: undefined, expectedTitle: "Title" },
			{ name: "skips a peer's title", peerTitle: "Peer title", expectedTitle: "Peer title" },
		])("does not let a stale save overwrite a peer update after it $name", async ({ peerTitle, expectedTitle }) => {
			await withTwoStores(async (storeA, storeB) => {
				await storeA.upsert({ ...item("shared-task"), mode: "code" })
				const stale = storeA.get("shared-task")!
				await storeB.invalidate("shared-task")
				await storeB.upsert({ ...storeB.get("shared-task")!, mode: "architect" })
				if (peerTitle) await storeB.setAutoTitleIfAbsent("shared-task", peerTitle)

				const result = await storeA.setAutoTitleIfAbsent("shared-task", "Title")
				expect(result.applied).toBe(!peerTitle)
				expect(storeA.get("shared-task")).toMatchObject({ mode: "code", autoTitle: expectedTitle })
				await storeA.upsert({ ...stale, tokensOut: 5 })

				await storeB.invalidate("shared-task")
				expect(storeB.get("shared-task")).toMatchObject({
					mode: "architect",
					tokensOut: 5,
					autoTitle: expectedTitle,
				})
			})
		})

		it.each(["", "   \n\t"])("rejects a blank title %j", async (blank) => {
			await withTwoStores(async (storeA, _storeB, storagePath) => {
				const result = await storeA.setAutoTitleIfAbsent("shared-task", blank)
				expect(result.applied).toBe(false)
				expect(JSON.parse(await fs.readFile(taskFile(storagePath), "utf8")).autoTitle).toBeUndefined()
			})
		})

		it("does not revert a concurrent manual title when writing the auto title", async () => {
			await withTwoStores(async (storeA, storeB) => {
				await storeB.atomicReadAndUpdate("shared-task", (current) => ({ ...current, title: "Manual" }))

				const result = await storeA.setAutoTitleIfAbsent("shared-task", "Generated")
				expect(result.item).toMatchObject({ title: "Manual", autoTitle: "Generated" })
			})
		})
	})
})
