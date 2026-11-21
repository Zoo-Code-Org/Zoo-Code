// pnpm --filter zoo-code test core/task-persistence/__tests__/TaskHistoryStore.backgroundChildren.spec.ts

import * as fs from "fs/promises"
import * as path from "path"
import * as os from "os"

import type { HistoryItem } from "@roo-code/types"

import { GlobalFileNames } from "../../../shared/globalFileNames"
import { TaskHistoryStore } from "../TaskHistoryStore"

vi.mock("../../../utils/storage", () => ({
	getStorageBasePath: vi.fn().mockImplementation((defaultPath: string) => defaultPath),
}))

const writeJson = async (filePath: string, data: unknown): Promise<void> => {
	await fs.mkdir(path.dirname(filePath), { recursive: true })
	await fs.writeFile(filePath, JSON.stringify(data, null, "\t"), "utf8")
}

const safeWriteJsonMock = vi.hoisted(() => vi.fn())

vi.mock("../../../utils/safeWriteJson", () => ({ safeWriteJson: safeWriteJsonMock }))

safeWriteJsonMock.mockImplementation(writeJson)

const readFileMocks = vi.hoisted(() => ({
	readFileWithMissingRetry: vi.fn(),
	realReadFileWithMissingRetry: null as null | ((filePath: string) => Promise<string>),
}))

vi.mock("../readFileWithMissingRetry", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../readFileWithMissingRetry")>()
	readFileMocks.realReadFileWithMissingRetry = actual.readFileWithMissingRetry
	readFileMocks.readFileWithMissingRetry.mockImplementation(actual.readFileWithMissingRetry)
	return { ...actual, readFileWithMissingRetry: readFileMocks.readFileWithMissingRetry }
})

function makeItem(overrides: Partial<HistoryItem> = {}): HistoryItem {
	return {
		id: `task-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`,
		number: 1,
		ts: Date.now(),
		task: "Test task",
		tokensIn: 0,
		tokensOut: 0,
		totalCost: 0,
		...overrides,
	}
}

async function readPersistedItem(tasksDir: string, taskId: string): Promise<HistoryItem> {
	return JSON.parse(
		await fs.readFile(path.join(tasksDir, taskId, GlobalFileNames.historyItem), "utf8"),
	) as HistoryItem
}

type SafeWriteOptions = { merge?: (existing: unknown, incoming: unknown) => unknown }

/**
 * A safeWriteJson stand-in that honors the merge contract the store relies
 * on: read the current file (null when missing), hand it to options.merge,
 * and write whatever merge returns. The default suite mock writes data
 * verbatim, so a guard living inside a merge callback would never run there.
 */
const mergeHonoringWriteJson = async (filePath: string, data: unknown, options?: SafeWriteOptions): Promise<void> => {
	let existing: unknown = null
	try {
		existing = JSON.parse(await fs.readFile(filePath, "utf8"))
	} catch {
		existing = null
	}
	const result = options?.merge ? options.merge(existing, data) : data
	await writeJson(filePath, result)
}

/**
 * Wrap mergeHonoringWriteJson with a hook that runs before each merge, used to
 * simulate another host mutating or deleting a record between the scan and
 * the repair write.
 */
const withConcurrentMutation =
	(mutate: (filePath: string) => Promise<void>) =>
	async (filePath: string, data: unknown, options?: SafeWriteOptions): Promise<void> => {
		await mutate(filePath)
		await mergeHonoringWriteJson(filePath, data, options)
	}

// ─────────────────────────────────────────────────────────────────────────────
// reconcileBackgroundChildren — startup orphan cleanup (D11) via initialize()
// ─────────────────────────────────────────────────────────────────────────────

describe("TaskHistoryStore reconcileBackgroundChildren", () => {
	let tmpDir: string
	let store: TaskHistoryStore
	const disposables = new Set<TaskHistoryStore>()

	function registerStore(nextStore: TaskHistoryStore): TaskHistoryStore {
		disposables.add(nextStore)
		return nextStore
	}

	async function seedItems(items: HistoryItem[]): Promise<void> {
		const tasksDir = path.join(tmpDir, "tasks")
		await fs.mkdir(tasksDir, { recursive: true })
		for (const item of items) {
			const taskDir = path.join(tasksDir, item.id)
			await fs.mkdir(taskDir, { recursive: true })
			await fs.writeFile(path.join(taskDir, "history_item.json"), JSON.stringify(item))
		}
	}

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "bg-children-test-"))
		store = registerStore(new TaskHistoryStore(tmpDir))
	})

	afterEach(async () => {
		vi.restoreAllMocks()
		safeWriteJsonMock.mockImplementation(writeJson)
		if (readFileMocks.realReadFileWithMissingRetry) {
			readFileMocks.readFileWithMissingRetry.mockImplementation(readFileMocks.realReadFileWithMissingRetry)
		}
		for (const disposable of disposables) disposable.dispose()
		disposables.clear()
		await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
	})

	it("marks a persisted background child interrupted when its parent record is missing", async () => {
		const child = makeItem({ id: "child-orphan", status: "active", backgroundParentTaskId: "missing-parent" })
		await seedItems([child])

		await store.initialize()

		const repaired = store.get("child-orphan")
		expect(repaired).toMatchObject({
			id: "child-orphan",
			status: "interrupted",
			backgroundParentTaskId: "missing-parent",
		})
		const persisted = await readPersistedItem(path.join(tmpDir, "tasks"), "child-orphan")
		expect(persisted.status).toBe("interrupted")
	})

	it.each(["completed", "interrupted"] as const)(
		"marks a persisted background child interrupted when its parent is %s",
		async (parentStatus) => {
			const parent = makeItem({ id: "parent-terminal", status: parentStatus })
			const child = makeItem({ id: "child-terminal-parent", status: "active", backgroundParentTaskId: parent.id })
			await seedItems([parent, child])

			await store.initialize()

			expect(store.get(child.id)?.status).toBe("interrupted")
			expect(store.get(parent.id)?.status).toBe(parentStatus)
			const persisted = await readPersistedItem(path.join(tmpDir, "tasks"), child.id)
			expect(persisted.status).toBe("interrupted")
		},
	)

	it.each(["active", "delegated"] as const)(
		"leaves a background child untouched when its parent is %s",
		async (parentStatus) => {
			const parent = makeItem({
				id: "parent-live",
				status: parentStatus,
				...(parentStatus === "delegated" ? { awaitingChildId: "some-child", delegatedToId: "some-child" } : {}),
			})
			const items = [parent]
			if (parentStatus === "delegated") {
				// Seed the awaited child as interrupted: that is the branch that
				// keeps a delegated parent delegated at startup. Without this
				// record the delegation repair fires first (awaited child not
				// found), so the delegated branch would never be exercised.
				items.push(makeItem({ id: "some-child", status: "interrupted", parentTaskId: parent.id }))
			}
			const child = makeItem({ id: "child-live-parent", status: "active", backgroundParentTaskId: parent.id })
			items.push(child)
			await seedItems(items)

			await store.initialize()

			expect(store.get(child.id)).toMatchObject({
				id: child.id,
				status: "active",
				backgroundParentTaskId: parent.id,
			})
			// The delegated case must survive startup with the parent still
			// delegated and the delegation link intact.
			if (parentStatus === "delegated") {
				expect(store.get(parent.id)).toMatchObject({
					status: "delegated",
					awaitingChildId: "some-child",
					delegatedToId: "some-child",
				})
			}
		},
	)

	it("defers the repair when the parent's record is unreadable at startup instead of assuming the parent is gone", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
		const parent = makeItem({ id: "parent-transient", status: "active" })
		const child = makeItem({ id: "child-transient-parent", status: "active", backgroundParentTaskId: parent.id })
		await seedItems([parent, child])
		const realReadFileWithMissingRetry = readFileMocks.realReadFileWithMissingRetry
		if (!realReadFileWithMissingRetry) {
			throw new Error("readFileWithMissingRetry mock not initialized")
		}
		readFileMocks.readFileWithMissingRetry.mockImplementation(async (filePath: string) => {
			if (filePath.includes(parent.id) && filePath.endsWith(GlobalFileNames.historyItem)) {
				// A transient read error keeps the live parent out of the startup
				// cache while the child's record loads normally.
				const error = new Error("device busy") as NodeJS.ErrnoException
				error.code = "EBUSY"
				throw error
			}
			return realReadFileWithMissingRetry(filePath)
		})

		await store.initialize()

		// The read error must not be mistaken for a missing parent: the child
		// stays active in the cache and on disk.
		expect(store.get(child.id)?.status).toBe("active")
		const persisted = await readPersistedItem(path.join(tmpDir, "tasks"), child.id)
		expect(persisted.status).toBe("active")
		expect(warnSpy).toHaveBeenCalledWith(
			expect.stringContaining("Deferred orphaned-background-child repair"),
			expect.anything(),
		)
		warnSpy.mockRestore()
	})

	it.each(["interrupted", "completed"] as const)(
		"leaves a background child whose own status is already %s untouched",
		async (childStatus) => {
			const child = makeItem({
				id: "child-terminal",
				status: childStatus,
				backgroundParentTaskId: "missing-parent",
			})
			await seedItems([child])

			await store.initialize()

			expect(store.get(child.id)?.status).toBe(childStatus)
		},
	)

	it("leaves a non-background active child untouched even without a parent record", async () => {
		const plain = makeItem({ id: "plain-active", status: "active" })
		await seedItems([plain])

		await store.initialize()

		expect(store.get("plain-active")?.status).toBe("active")
	})

	it("repairs an implicit-active background child with no status field", async () => {
		const { status: _status, ...legacyChild } = makeItem({
			id: "child-legacy",
			status: "active",
			backgroundParentTaskId: "missing-parent",
		})
		await seedItems([legacyChild as HistoryItem])

		await store.initialize()

		expect(store.get("child-legacy")?.status).toBe("interrupted")
	})

	it("keeps the parent's record unchanged while repairing the child", async () => {
		const parent = makeItem({ id: "parent-unchanged", status: "completed", childIds: ["child-repair"] })
		const child = makeItem({ id: "child-repair", status: "active", backgroundParentTaskId: parent.id })
		await seedItems([parent, child])

		await store.initialize()

		expect(store.get(parent.id)).toMatchObject({ id: parent.id, status: "completed", childIds: ["child-repair"] })
		expect(store.get(child.id)?.status).toBe("interrupted")
	})

	it("repairs several orphaned background children in a single initialize()", async () => {
		const parent = makeItem({ id: "parent-multi", status: "completed" })
		const childA = makeItem({ id: "child-multi-a", status: "active", backgroundParentTaskId: parent.id })
		const childB = makeItem({ id: "child-multi-b", status: "active", backgroundParentTaskId: parent.id })
		const childC = makeItem({ id: "child-multi-c", status: "active", backgroundParentTaskId: "missing-parent" })
		await seedItems([parent, childA, childB, childC])

		await store.initialize()

		expect(store.get("child-multi-a")?.status).toBe("interrupted")
		expect(store.get("child-multi-b")?.status).toBe("interrupted")
		expect(store.get("child-multi-c")?.status).toBe("interrupted")
	})

	it("continues repairing the remaining children when one repair write fails", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		const childA = makeItem({ id: "child-pf-a", status: "active", backgroundParentTaskId: "missing-parent" })
		const childB = makeItem({ id: "child-pf-b", status: "active", backgroundParentTaskId: "missing-parent" })
		const childC = makeItem({ id: "child-pf-c", status: "active", backgroundParentTaskId: "missing-parent" })
		await seedItems([childA, childB, childC])
		// Fail the second repair attempt wherever it lands: the store iterates
		// task directories in filesystem order, which this test does not
		// control. Recording the attempt order both pins the injected failure
		// to a middle attempt and lets the test prove a later attempt succeeded.
		const repairOrder: string[] = []
		safeWriteJsonMock.mockImplementation(async (filePath: string, data: unknown) => {
			if (filePath.endsWith(GlobalFileNames.historyItem)) {
				repairOrder.push(path.basename(path.dirname(filePath)))
				if (repairOrder.length === 2) {
					throw new Error("disk full")
				}
			}
			await writeJson(filePath, data)
		})

		await store.initialize()

		const [firstId, failedId, laterId] = repairOrder
		// All three repairs were attempted: the pass did not stop at the first
		// failed write.
		expect(repairOrder).toHaveLength(3)
		// The failed child's repair did not stick anywhere.
		expect(store.get(failedId)?.status).toBe("active")
		const persistedFailed = await readPersistedItem(path.join(tmpDir, "tasks"), failedId)
		expect(persistedFailed.status).toBe("active")
		// The repairs attempted before and after the failure both persisted.
		for (const repairedId of [firstId, laterId]) {
			expect(store.get(repairedId)?.status).toBe("interrupted")
			const persisted = await readPersistedItem(path.join(tmpDir, "tasks"), repairedId)
			expect(persisted.status).toBe("interrupted")
		}
		errorSpy.mockRestore()
	})

	describe("isLiveBackgroundChild seam", () => {
		it("never marks a child the hook reports as live", async () => {
			store.dispose()
			store = registerStore(
				new TaskHistoryStore(tmpDir, { isLiveBackgroundChild: (taskId: string) => taskId === "child-live" }),
			)
			const child = makeItem({ id: "child-live", status: "active", backgroundParentTaskId: "missing-parent" })
			await seedItems([child])

			await store.initialize()

			expect(store.get("child-live")?.status).toBe("active")
		})

		it("still repairs other children when the hook reports only one as live", async () => {
			store.dispose()
			store = registerStore(
				new TaskHistoryStore(tmpDir, { isLiveBackgroundChild: (taskId: string) => taskId === "child-live" }),
			)
			const live = makeItem({ id: "child-live", status: "active", backgroundParentTaskId: "missing-parent" })
			const orphan = makeItem({
				id: "child-orphan-seam",
				status: "active",
				backgroundParentTaskId: "missing-parent",
			})
			await seedItems([live, orphan])

			await store.initialize()

			expect(store.get("child-live")?.status).toBe("active")
			expect(store.get("child-orphan-seam")?.status).toBe("interrupted")
		})
	})

	it("does not block startup when the repair write fails", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		const child = makeItem({ id: "child-write-fails", status: "active", backgroundParentTaskId: "missing-parent" })
		await seedItems([child])
		safeWriteJsonMock.mockImplementation(async (filePath: string, data: unknown) => {
			if (filePath.includes(child.id) && filePath.endsWith(GlobalFileNames.historyItem)) {
				throw new Error("disk full")
			}
			await writeJson(filePath, data)
		})

		await expect(store.initialize()).resolves.toBeUndefined()

		expect(errorSpy).toHaveBeenCalledWith(
			`[TaskHistoryStore] Failed to reconcile background child ${child.id}:`,
			expect.any(Error),
		)
		// The failed repair must not leave a half-updated cache entry behind.
		expect(store.get(child.id)?.status).toBe("active")
		errorSpy.mockRestore()
	})

	it("logs each repaired child to console.warn", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
		const child = makeItem({ id: "child-logged", status: "active", backgroundParentTaskId: "missing-parent" })
		await seedItems([child])

		await store.initialize()

		expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Reconciled orphaned background child"))
		expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("child-logged"))

		warnSpy.mockRestore()
	})

	it("invokes onWrite after an orphan repair", async () => {
		const onWrite = vi.fn().mockResolvedValue(undefined)
		store.dispose()
		store = registerStore(new TaskHistoryStore(tmpDir, { onWrite }))
		const child = makeItem({ id: "child-onwrite", status: "active", backgroundParentTaskId: "missing-parent" })
		await seedItems([child])

		await store.initialize()

		expect(onWrite).toHaveBeenCalled()
		const lastCall = onWrite.mock.calls[onWrite.mock.calls.length - 1][0] as HistoryItem[]
		expect(lastCall.find((i) => i.id === "child-onwrite")?.status).toBe("interrupted")
	})

	describe("concurrent changes by another host", () => {
		it("does not recreate a background child deleted between the scan and the repair write", async () => {
			const parent = makeItem({ id: "parent-concurrent-delete", status: "completed" })
			const child = makeItem({
				id: "child-concurrent-delete",
				status: "active",
				backgroundParentTaskId: parent.id,
			})
			await seedItems([parent, child])
			const childFile = path.join(tmpDir, "tasks", child.id, GlobalFileNames.historyItem)
			safeWriteJsonMock.mockImplementation(
				withConcurrentMutation(async (filePath) => {
					if (filePath === childFile) {
						// Another host deletes the child after the startup scan
						// cached it; the merge then sees no disk record.
						await fs.rm(childFile, { force: true })
					}
				}),
			)

			await store.initialize()

			// The repair must not recreate the deleted record, and the stale
			// cache entry must not linger as an active task.
			await expect(fs.access(childFile)).rejects.toThrow()
			expect(store.get(child.id)).toBeUndefined()
		})

		it("does not overwrite a background child reassigned to a different parent before the repair write", async () => {
			const parent = makeItem({ id: "parent-reassign", status: "completed" })
			const child = makeItem({ id: "child-reassigned", status: "active", backgroundParentTaskId: parent.id })
			await seedItems([parent, child])
			const childFile = path.join(tmpDir, "tasks", child.id, GlobalFileNames.historyItem)
			safeWriteJsonMock.mockImplementation(
				withConcurrentMutation(async (filePath) => {
					if (filePath === childFile) {
						// Another host moved the child under a new parent; the
						// stale snapshot's repair must not stamp it interrupted.
						await writeJson(childFile, { ...child, backgroundParentTaskId: "parent-new-owner" })
					}
				}),
			)

			await store.initialize()

			const persisted = await readPersistedItem(path.join(tmpDir, "tasks"), child.id)
			expect(persisted).toMatchObject({ status: "active", backgroundParentTaskId: "parent-new-owner" })
			expect(store.get(child.id)).toMatchObject({ status: "active", backgroundParentTaskId: "parent-new-owner" })
		})

		it("skips the repair cleanly when another host completes the child before the repair write", async () => {
			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
			const parent = makeItem({ id: "parent-concurrent-complete", status: "completed" })
			const child = makeItem({
				id: "child-concurrent-complete",
				status: "active",
				backgroundParentTaskId: parent.id,
			})
			await seedItems([parent, child])
			const childFile = path.join(tmpDir, "tasks", child.id, GlobalFileNames.historyItem)
			safeWriteJsonMock.mockImplementation(
				withConcurrentMutation(async (filePath) => {
					if (filePath === childFile) {
						await writeJson(childFile, { ...child, status: "completed" })
					}
				}),
			)

			await store.initialize()

			const persisted = await readPersistedItem(path.join(tmpDir, "tasks"), child.id)
			expect(persisted.status).toBe("completed")
			expect(store.get(child.id)?.status).toBe("completed")
			// The guard turns a changed child into a clean skip, not a failed
			// repair write.
			expect(errorSpy).not.toHaveBeenCalled()
			errorSpy.mockRestore()
		})
	})

	describe("deferred orphan-repair retry", () => {
		const makeParentUnreadable = (parentId: string) => {
			const realRead = readFileMocks.realReadFileWithMissingRetry
			if (!realRead) {
				throw new Error("readFileWithMissingRetry mock not initialized")
			}
			readFileMocks.readFileWithMissingRetry.mockImplementation(async (filePath: string) => {
				if (filePath.includes(parentId) && filePath.endsWith(GlobalFileNames.historyItem)) {
					const error = new Error("device busy") as NodeJS.ErrnoException
					error.code = "EBUSY"
					throw error
				}
				return realRead(filePath)
			})
		}

		const restoreRealReads = () => {
			const realRead = readFileMocks.realReadFileWithMissingRetry
			if (!realRead) {
				throw new Error("readFileWithMissingRetry mock not initialized")
			}
			readFileMocks.readFileWithMissingRetry.mockImplementation(realRead)
		}

		it("retries a deferred repair on the next reconciliation once the parent becomes readable", async () => {
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
			const parent = makeItem({ id: "parent-deferred-repair", status: "completed" })
			const child = makeItem({ id: "child-deferred-repair", status: "active", backgroundParentTaskId: parent.id })
			await seedItems([parent, child])
			makeParentUnreadable(parent.id)

			await store.initialize()

			// Startup defers: the parent record is unreadable, so the child
			// stays active in the cache and on disk.
			expect(store.get(child.id)?.status).toBe("active")
			const persistedBefore = await readPersistedItem(path.join(tmpDir, "tasks"), child.id)
			expect(persistedBefore.status).toBe("active")
			expect(warnSpy).toHaveBeenCalledWith(
				expect.stringContaining("Deferred orphaned-background-child repair"),
				expect.anything(),
			)

			// The parent record becomes readable again (a transient lock or
			// device error cleared). Reconciliation is the path watcher and
			// periodic timers take, so it must retry the deferred repair and
			// now confirm the terminal parent.
			restoreRealReads()
			await store.reconcile()

			expect(store.get(child.id)?.status).toBe("interrupted")
			const persisted = await readPersistedItem(path.join(tmpDir, "tasks"), child.id)
			expect(persisted.status).toBe("interrupted")
			expect(warnSpy).toHaveBeenCalledWith(
				expect.stringContaining("Reconciled deferred orphaned background child"),
			)
			warnSpy.mockRestore()
		})

		it("keeps the child unchanged while the parent is still unreadable at the retry", async () => {
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
			const parent = makeItem({ id: "parent-still-unreadable", status: "completed" })
			const child = makeItem({
				id: "child-still-unreadable",
				status: "active",
				backgroundParentTaskId: parent.id,
			})
			await seedItems([parent, child])
			makeParentUnreadable(parent.id)

			await store.initialize()
			await store.reconcile()
			await store.reconcile()

			expect(store.get(child.id)?.status).toBe("active")
			const persisted = await readPersistedItem(path.join(tmpDir, "tasks"), child.id)
			expect(persisted.status).toBe("active")
			warnSpy.mockRestore()
		})

		it("drops the deferral without writing when the parent is readable and active at the retry", async () => {
			const parent = makeItem({ id: "parent-active-later", status: "active" })
			const child = makeItem({ id: "child-parent-active", status: "active", backgroundParentTaskId: parent.id })
			await seedItems([parent, child])
			makeParentUnreadable(parent.id)

			await store.initialize()
			expect(store.get(child.id)?.status).toBe("active")

			restoreRealReads()
			await store.reconcile()

			expect(store.get(child.id)?.status).toBe("active")
			const persisted = await readPersistedItem(path.join(tmpDir, "tasks"), child.id)
			expect(persisted.status).toBe("active")

			// The deferral was consumed: even if the parent later turns
			// terminal, the child was left for normal lifecycle handling and a
			// later pass must not resurrect the repair.
			await fs.writeFile(
				path.join(tmpDir, "tasks", parent.id, GlobalFileNames.historyItem),
				JSON.stringify({ ...parent, status: "completed" }),
			)
			await store.reconcile()

			expect(store.get(child.id)?.status).toBe("active")
		})

		it("drops the deferral without writing when the child is owned by the live host at the retry", async () => {
			let live = false
			store.dispose()
			store = registerStore(new TaskHistoryStore(tmpDir, { isLiveBackgroundChild: () => live }))
			const parent = makeItem({ id: "parent-live-later", status: "completed" })
			const child = makeItem({ id: "child-live-later", status: "active", backgroundParentTaskId: parent.id })
			await seedItems([parent, child])
			makeParentUnreadable(parent.id)

			await store.initialize()
			expect(store.get(child.id)?.status).toBe("active")

			live = true
			restoreRealReads()
			await store.reconcile()

			expect(store.get(child.id)?.status).toBe("active")
			const persisted = await readPersistedItem(path.join(tmpDir, "tasks"), child.id)
			expect(persisted.status).toBe("active")
		})

		it("drops the deferral without writing when the child reached a terminal state before the retry", async () => {
			const parent = makeItem({ id: "parent-child-terminal", status: "completed" })
			const child = makeItem({ id: "child-terminal-later", status: "active", backgroundParentTaskId: parent.id })
			await seedItems([parent, child])
			makeParentUnreadable(parent.id)

			await store.initialize()

			// Another host completes the child while the parent stays unreadable.
			await fs.writeFile(
				path.join(tmpDir, "tasks", child.id, GlobalFileNames.historyItem),
				JSON.stringify({ ...child, status: "completed" }),
			)

			await store.reconcile()

			expect(store.get(child.id)?.status).toBe("completed")
			const persisted = await readPersistedItem(path.join(tmpDir, "tasks"), child.id)
			expect(persisted.status).toBe("completed")
		})

		it("does not recreate a deferred child deleted between the reconcile scan and the retry write", async () => {
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
			const parent = makeItem({ id: "parent-deferred-delete", status: "completed" })
			const child = makeItem({
				id: "child-deferred-delete",
				status: "active",
				backgroundParentTaskId: parent.id,
			})
			await seedItems([parent, child])
			makeParentUnreadable(parent.id)

			await store.initialize()

			// Startup defers on the unreadable parent; the child stays active.
			expect(store.get(child.id)?.status).toBe("active")

			restoreRealReads()
			const childFile = path.join(tmpDir, "tasks", child.id, GlobalFileNames.historyItem)
			let repairAttempted = false
			safeWriteJsonMock.mockImplementation(
				withConcurrentMutation(async (filePath) => {
					if (filePath === childFile) {
						repairAttempted = true
						// Another host deletes the child after the reconcile
						// scan refreshed the cache but before the retry write.
						await fs.rm(childFile, { force: true })
					}
				}),
			)

			await store.reconcile()

			// The deferred repair ran against the deleted record and must not
			// have recreated it.
			expect(repairAttempted).toBe(true)
			await expect(fs.access(childFile)).rejects.toThrow()
			expect(store.get(child.id)).toBeUndefined()
			// The deferral was dropped, not retried: a later pass must not
			// attempt the repair again.
			await store.reconcile()
			await expect(fs.access(childFile)).rejects.toThrow()
			expect(warnSpy).not.toHaveBeenCalledWith(
				expect.stringContaining("Reconciled deferred orphaned background child"),
			)
			warnSpy.mockRestore()
		})

		it("does not overwrite a deferred child reassigned to a different parent before the retry write", async () => {
			const parent = makeItem({ id: "parent-deferred-reassign", status: "completed" })
			const child = makeItem({
				id: "child-deferred-reassign",
				status: "active",
				backgroundParentTaskId: parent.id,
			})
			await seedItems([parent, child])
			makeParentUnreadable(parent.id)

			await store.initialize()
			expect(store.get(child.id)?.status).toBe("active")

			restoreRealReads()
			const childFile = path.join(tmpDir, "tasks", child.id, GlobalFileNames.historyItem)
			safeWriteJsonMock.mockImplementation(
				withConcurrentMutation(async (filePath) => {
					if (filePath === childFile) {
						await writeJson(childFile, { ...child, backgroundParentTaskId: "parent-new-owner" })
					}
				}),
			)

			await store.reconcile()

			const persisted = await readPersistedItem(path.join(tmpDir, "tasks"), child.id)
			expect(persisted).toMatchObject({ status: "active", backgroundParentTaskId: "parent-new-owner" })
			expect(store.get(child.id)).toMatchObject({ status: "active", backgroundParentTaskId: "parent-new-owner" })
		})
	})
})
