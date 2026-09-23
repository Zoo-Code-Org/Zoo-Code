// npx vitest run __tests__/delegation-concurrent.spec.ts

import { describe, it, expect, vi, beforeEach } from "vitest"
import type { HistoryItem } from "@roo-code/types"

vi.mock("fs/promises", () => ({
	mkdir: vi.fn().mockResolvedValue(undefined),
	readFile: vi.fn().mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" })),
	readdir: vi.fn().mockResolvedValue([]),
	unlink: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("fs", () => ({
	default: {
		watch: vi.fn().mockReturnValue({ on: vi.fn(), close: vi.fn() }),
		existsSync: vi.fn().mockReturnValue(false),
	},
	watch: vi.fn().mockReturnValue({ on: vi.fn(), close: vi.fn() }),
	existsSync: vi.fn().mockReturnValue(false),
}))

vi.mock("../utils/safeWriteJson", () => ({
	safeWriteJson: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("../utils/storage", () => ({
	getStorageBasePath: vi.fn().mockResolvedValue("/tmp/test-storage"),
}))

import { TaskHistoryStore } from "../core/task-persistence/TaskHistoryStore"

const makeItem = (id: string, overrides: Partial<HistoryItem> = {}): HistoryItem =>
	({
		id,
		ts: Date.now(),
		task: "test task",
		tokensIn: 0,
		tokensOut: 0,
		totalCost: 0,
		status: "active",
		mode: "code",
		workspace: "/tmp",
		...overrides,
	}) as HistoryItem

describe("TaskHistoryStore.atomicReadAndUpdate", () => {
	let store: TaskHistoryStore

	beforeEach(() => {
		vi.clearAllMocks()
		store = new TaskHistoryStore("/tmp/test-storage")
	})

	it("serializes concurrent operations — second caller reads the state written by the first", async () => {
		// Seed the cache with an item that has no childIds yet.
		const item = makeItem("parent-task", { childIds: [] })
		;(store as any).cache.set(item.id, item)

		// Two concurrent delegations each append their child ID.
		// Because they are serialized by the lock, the second caller must
		// read the cache state that the first caller wrote — not the original.
		const delegation1 = store.atomicReadAndUpdate("parent-task", (current) => ({
			...current,
			childIds: [...(current.childIds ?? []), "child-A"],
		}))

		const delegation2 = store.atomicReadAndUpdate("parent-task", (current) => ({
			...current,
			childIds: [...(current.childIds ?? []), "child-B"],
		}))

		await Promise.all([delegation1, delegation2])

		// Both child IDs must be present: delegation2 saw delegation1's write.
		const final = (store as any).cache.get("parent-task") as HistoryItem
		expect(final.childIds).toContain("child-A")
		expect(final.childIds).toContain("child-B")
	})

	it("two concurrent delegations produce consistent HistoryItem state (full field set)", async () => {
		const item = makeItem("parent-task", { status: "active", childIds: [] })
		;(store as any).cache.set(item.id, item)

		// Each delegation sets awaitingChildId and appends to childIds.
		const delegation1 = store.atomicReadAndUpdate("parent-task", (historyItem) => {
			const childIds = Array.from(new Set([...(historyItem.childIds ?? []), "child-A"]))
			return {
				...historyItem,
				status: "delegated",
				delegatedToId: "child-A",
				awaitingChildId: "child-A",
				childIds,
			}
		})

		const delegation2 = store.atomicReadAndUpdate("parent-task", (historyItem) => {
			const childIds = Array.from(new Set([...(historyItem.childIds ?? []), "child-B"]))
			return {
				...historyItem,
				status: "delegated",
				delegatedToId: "child-B",
				awaitingChildId: "child-B",
				childIds,
			}
		})

		await Promise.all([delegation1, delegation2])

		const final = (store as any).cache.get("parent-task") as HistoryItem
		// Both child IDs present — neither write clobbered the other's childIds.
		expect(final.childIds).toContain("child-A")
		expect(final.childIds).toContain("child-B")
		// The last writer wins on scalar fields; whichever child ran second is authoritative.
		expect(final.status).toBe("delegated")
		expect(["child-A", "child-B"]).toContain(final.awaitingChildId)
		expect(final.delegatedToId).toBe(final.awaitingChildId)
		expect(final.childIds).toContain(final.awaitingChildId)
	})

	it("completes without deadlock — updater is pure and does not re-acquire the lock", async () => {
		const item = makeItem("task-1", { childIds: [] })
		;(store as any).cache.set(item.id, item)

		// With the typed (taskId, updater) API, the updater is synchronous and
		// cannot call upsert/withLock — no re-entrancy, no deadlock.
		const result = await Promise.race([
			store
				.atomicReadAndUpdate("task-1", (current) => ({
					...current,
					childIds: [...(current.childIds ?? []), "child-1"],
				}))
				.then(() => "completed"),
			new Promise<string>((resolve) => setTimeout(() => resolve("deadlocked"), 100)),
		])

		expect(result).toBe("completed")

		const final = (store as any).cache.get("task-1") as HistoryItem
		expect(final.childIds).toContain("child-1")
	})

	it("throws if the task ID is not in the cache", async () => {
		await expect(
			store.atomicReadAndUpdate("nonexistent-task", (current) => ({ ...current, status: "delegated" })),
		).rejects.toThrow("nonexistent-task")
	})
})
