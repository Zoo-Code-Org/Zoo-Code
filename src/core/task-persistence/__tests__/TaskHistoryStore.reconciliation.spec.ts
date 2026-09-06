// pnpm --filter zoo-code test core/task-persistence/__tests__/TaskHistoryStore.reconciliation.spec.ts

import * as fs from "fs/promises"
import * as path from "path"
import * as os from "os"

import type { HistoryItem } from "@roo-code/types"

import { GlobalFileNames } from "../../../shared/globalFileNames"
import { TaskHistoryStore, assertValidTransition } from "../TaskHistoryStore"

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

// Private static member read for the threshold-constant test. There is no
// typed accessor; this casts through `unknown` (not `as any`) following the
// same private-member access pattern used by
// "removes the repair-intent file after successful replay" below.
const LIVE_CHILD_MTIME_THRESHOLD_MS = (
	TaskHistoryStore as unknown as {
		LIVE_CHILD_MTIME_THRESHOLD_MS: number
	}
).LIVE_CHILD_MTIME_THRESHOLD_MS

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

function makeRepairIntent(parent: HistoryItem, child: HistoryItem): object {
	return {
		version: 1,
		operationId: "delegation-repair-test",
		parentTaskId: parent.id,
		childTaskId: child.id,
		expected: {
			parent: {
				status: "delegated",
				awaitingChildId: child.id,
				delegatedToId: parent.delegatedToId,
			},
			child: {
				status: "active",
				parentTaskId: child.parentTaskId,
				rootTaskId: child.rootTaskId,
			},
		},
		target: { childStatus: "interrupted", parentStatus: "active" },
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// assertValidTransition — pure function tests
// ─────────────────────────────────────────────────────────────────────────────

describe("assertValidTransition", () => {
	describe("valid transitions", () => {
		it("active → delegated", () => {
			expect(() => assertValidTransition("active", "delegated")).not.toThrow()
		})

		it("active → completed", () => {
			expect(() => assertValidTransition("active", "completed")).not.toThrow()
		})

		it("active → interrupted", () => {
			expect(() => assertValidTransition("active", "interrupted")).not.toThrow()
		})

		it("delegated → active", () => {
			expect(() => assertValidTransition("delegated", "active")).not.toThrow()
		})

		it("interrupted → completed", () => {
			expect(() => assertValidTransition("interrupted", "completed")).not.toThrow()
		})

		it("undefined (implicit active) → delegated", () => {
			expect(() => assertValidTransition(undefined, "delegated")).not.toThrow()
		})

		it("undefined (implicit active) → completed", () => {
			expect(() => assertValidTransition(undefined, "completed")).not.toThrow()
		})
	})

	describe("invalid transitions — throw", () => {
		it("delegated → completed", () => {
			expect(() => assertValidTransition("delegated", "completed")).toThrow(
				"Invalid task status transition: delegated → completed",
			)
		})

		it("delegated → delegated (self-loop)", () => {
			expect(() => assertValidTransition("delegated", "delegated")).toThrow(
				"Invalid task status transition: delegated → delegated",
			)
		})

		it("completed → active", () => {
			expect(() => assertValidTransition("completed", "active")).toThrow(
				"Invalid task status transition: completed → active",
			)
		})

		it("completed → delegated", () => {
			expect(() => assertValidTransition("completed", "delegated")).toThrow(
				"Invalid task status transition: completed → delegated",
			)
		})

		it("interrupted → active", () => {
			expect(() => assertValidTransition("interrupted", "active")).toThrow(
				"Invalid task status transition: interrupted → active",
			)
		})

		it("active → active (self-loop)", () => {
			expect(() => assertValidTransition("active", "active")).toThrow(
				"Invalid task status transition: active → active",
			)
		})

		it("undefined (implicit active) → delegated is valid", () => {
			expect(() => assertValidTransition(undefined, "delegated")).not.toThrow()
		})
	})
})

// ─────────────────────────────────────────────────────────────────────────────
// reconcileDelegationState — integration tests via initialize()
// ─────────────────────────────────────────────────────────────────────────────

describe("TaskHistoryStore reconcileDelegationState", () => {
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

	/**
	 * Backdate a task's history file mtime so the cross-instance liveness guard
	 * treats it as a crash orphan (last write > 5 minutes ago) rather than a
	 * live child owned by another window.
	 */
	async function markStaleMtime(taskId: string): Promise<void> {
		const filePath = path.join(tmpDir, "tasks", taskId, GlobalFileNames.historyItem)
		const stale = new Date(Date.now() - 10 * 60 * 1000)
		await fs.utimes(filePath, stale, stale)
	}

	/**
	 * Deterministic wall clock for liveness-boundary tests. The store's
	 * `Date.now()` is spied to return this same instant, and `setChildMtimeAge`
	 * additionally injects the exact mtime the store observes, so
	 * `Date.now() - mtimeMs` is exact regardless of how long the test body
	 * takes to run or how much millisecond precision the filesystem keeps.
	 */
	const FIXED_NOW = 1_756_886_400_000 // 2025-09-03T08:00:00.000Z

	// Restored in afterEach so a leaked spy can never poison the direct
	// `getChildFileMtimeMs` probe test.
	let mtimeSpy: { mockRestore(): void } | undefined

	/**
	 * Stamps a child's history file so the store observes a mtime of exactly
	 * `FIXED_NOW - ageMs`, independent of filesystem mtime precision.
	 *
	 * Two layers:
	 * 1. Best-effort `fs.utimes` keeps the on-disk file realistic, but tests
	 *    must NOT depend on it: some filesystems and CI runners truncate mtime
	 *    to seconds, which would silently flip live/stale expectations.
	 * 2. A spy on the private `TaskHistoryStore.prototype.getChildFileMtimeMs`
	 *    (the exact call path used by the cross-instance liveness guard)
	 *    injects the intended millisecond value. That single `mtimeMs` feeds
	 *    BOTH the `Date.now() - mtimeMs < threshold` guard and the
	 *    `Math.round((Date.now() - mtimeMs) / 1000)` skip-log render, so the
	 *    `<`-vs-`<=` boundary at 300_000 ms and the 300s/299s/-100s render
	 *    assertions stay deterministic and keep killing their mutants on any
	 *    filesystem.
	 *
	 * `ageMs` may be negative (future mtime). Other child ids delegate to the
	 * real implementation so unrelated probe paths keep exercising the FS.
	 */
	async function setChildMtimeAge(taskId: string, ageMs: number): Promise<void> {
		const filePath = path.join(tmpDir, "tasks", taskId, GlobalFileNames.historyItem)
		const stamp = new Date(FIXED_NOW - ageMs)
		await fs.utimes(filePath, stamp, stamp)
		const probe = TaskHistoryStore.prototype as unknown as {
			getChildFileMtimeMs: (childId: string) => Promise<number | undefined>
		}
		const original = probe.getChildFileMtimeMs
		mtimeSpy = vi
			.spyOn(probe, "getChildFileMtimeMs")
			.mockImplementation((childId: string) =>
				childId === taskId ? Promise.resolve(FIXED_NOW - ageMs) : original.call(store, childId),
			)
	}

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "reconcile-test-"))
		store = registerStore(new TaskHistoryStore(tmpDir))
	})

	it("getChildFileMtimeMs returns the file mtime for an existing child and undefined for a missing one", async () => {
		// Direct coverage of the private mtime probe used by the cross-instance
		// liveness guard (TaskHistoryStore.ts getChildFileMtimeMs): the happy
		// path returns stat.mtimeMs and the catch path returns undefined.
		// Bracket/typed access follows the same private-member pattern used by
		// "removes the repair-intent file after successful replay" below.
		const internals = store as unknown as {
			getChildFileMtimeMs: (childId: string) => Promise<number | undefined>
		}

		expect(await internals.getChildFileMtimeMs("missing-mtime-child")).toBeUndefined()

		const child = makeItem({ id: "present-mtime-child", status: "active" })
		await seedItems([child])
		const mtimeMs = await internals.getChildFileMtimeMs("present-mtime-child")
		expect(typeof mtimeMs).toBe("number")
		expect(mtimeMs).toBeGreaterThan(0)
	})

	afterEach(async () => {
		mtimeSpy?.mockRestore()
		mtimeSpy = undefined
		safeWriteJsonMock.mockImplementation(writeJson)
		for (const disposable of disposables) disposable.dispose()
		disposables.clear()
		await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
	})

	it("repairs orphaned delegation: delegated parent whose child does not exist → active", async () => {
		const parent = makeItem({ id: "parent-1", status: "delegated", awaitingChildId: "missing-child" })
		await seedItems([parent])

		await store.initialize()

		const repaired = store.get("parent-1")
		expect(repaired?.status).toBe("active")
		expect(repaired?.awaitingChildId).toBeUndefined()
		expect(repaired?.delegatedToId).toBeUndefined()
	})

	it("repairs interrupted handoff: delegated parent with completed child → active", async () => {
		const child = makeItem({
			id: "child-2",
			status: "completed",
			completionResultSummary: "Child result",
		})
		const parent = makeItem({
			id: "parent-2",
			status: "delegated",
			awaitingChildId: "child-2",
			delegatedToId: "child-2",
		})
		await seedItems([parent, child])

		await store.initialize()

		const repaired = store.get("parent-2")
		expect(repaired?.status).toBe("active")
		expect(repaired?.awaitingChildId).toBeUndefined()
		expect(repaired?.delegatedToId).toBeUndefined()
		expect(repaired?.completedByChildId).toBe("child-2")
		expect(repaired?.completionResultSummary).toBe("Child result")
	})

	it("uses fallback summary when child has no completionResultSummary", async () => {
		const child = makeItem({ id: "child-3", status: "completed" })
		const parent = makeItem({ id: "parent-3", status: "delegated", awaitingChildId: "child-3" })
		await seedItems([parent, child])

		await store.initialize()

		const repaired = store.get("parent-3")
		expect(repaired?.completionResultSummary).toBe("Task completed (recovered after interruption)")
	})

	it("repairs a delegated parent with an active orphaned child", async () => {
		const child = makeItem({
			id: "child-4",
			status: "active",
			parentTaskId: "parent-4",
			rootTaskId: "parent-4",
			childIds: ["grandchild-4"],
		})
		const parent = makeItem({
			id: "parent-4",
			status: "delegated",
			awaitingChildId: "child-4",
			delegatedToId: "child-4",
			childIds: ["child-4"],
		})
		await seedItems([parent, child])
		await markStaleMtime("child-4")

		await store.initialize()

		const repairedParent = store.get("parent-4")
		const repairedChild = store.get("child-4")
		expect(repairedChild).toMatchObject({
			id: "child-4",
			status: "interrupted",
			parentTaskId: "parent-4",
			rootTaskId: "parent-4",
			childIds: ["grandchild-4"],
		})
		expect(repairedParent).toMatchObject({
			id: "parent-4",
			status: "active",
			childIds: ["child-4"],
		})
		expect(repairedParent?.awaitingChildId).toBeUndefined()
		expect(repairedParent?.delegatedToId).toBeUndefined()

		const tasksDir = path.join(tmpDir, "tasks")
		const persistedChild = JSON.parse(
			await fs.readFile(path.join(tasksDir, "child-4", "history_item.json"), "utf8"),
		) as HistoryItem
		const persistedParent = JSON.parse(
			await fs.readFile(path.join(tasksDir, "parent-4", "history_item.json"), "utf8"),
		) as HistoryItem
		expect(persistedChild).toMatchObject({
			id: "child-4",
			status: "interrupted",
			parentTaskId: "parent-4",
			rootTaskId: "parent-4",
			childIds: ["grandchild-4"],
		})
		expect(persistedParent).toMatchObject({ id: "parent-4", status: "active" })
		expect(persistedParent.awaitingChildId).toBeUndefined()
		expect(persistedParent.delegatedToId).toBeUndefined()
	})

	it("pins LIVE_CHILD_MTIME_THRESHOLD_MS to exactly 5 minutes in milliseconds", async () => {
		// Kills the TaskHistoryStore.ts line-105 ArithmeticOperator mutants
		// directly: every mutated expression (5 * 60 / 1000 → 0.3,
		// 5 / 60 * 1000 → 83.33, ...) changes the constant's own value.
		//
		// Stryker treats the static-initializer mutants as "static" (no test
		// covers the module-load line under perTest analysis) and runs them
		// against all tests with the mutant active. The threshold is captured
		// at spec import time — before the mutant env switch is observed — so
		// a stale-cached read never sees the mutated initializer. Re-import
		// the module under test so the initializer re-executes while the
		// mutant is active, making the mutated value observable here.
		vi.resetModules()
		const { TaskHistoryStore: FreshTaskHistoryStore } = await import("../TaskHistoryStore")
		const freshThreshold = (
			FreshTaskHistoryStore as unknown as {
				LIVE_CHILD_MTIME_THRESHOLD_MS: number
			}
		).LIVE_CHILD_MTIME_THRESHOLD_MS
		expect(freshThreshold).toBe(5 * 60 * 1000)
		expect(LIVE_CHILD_MTIME_THRESHOLD_MS).toBe(5 * 60 * 1000)
	})

	it("skips repair for active child with recent mtime (live in another window)", async () => {
		const logSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
		const child = makeItem({
			id: "child-live",
			status: "active",
			parentTaskId: "parent-live",
			rootTaskId: "parent-live",
		})
		const parent = makeItem({
			id: "parent-live",
			status: "delegated",
			awaitingChildId: "child-live",
			delegatedToId: "child-live",
			childIds: ["child-live"],
		})
		await seedItems([parent, child])

		// Simulate another live window actively persisting the child: the file
		// was just written, so its mtime is within the 5-minute threshold.
		const childFilePath = path.join(tmpDir, "tasks", "child-live", "history_item.json")
		const now = new Date()
		await fs.utimes(childFilePath, now, now)

		await store.initialize()

		// Repair must NOT run: child stays active, parent delegation link preserved.
		expect(store.get("child-live")?.status).toBe("active")
		const preservedParent = store.get("parent-live")
		expect(preservedParent?.status).toBe("delegated")
		expect(preservedParent?.awaitingChildId).toBe("child-live")
		expect(preservedParent?.delegatedToId).toBe("child-live")

		// Persisted state must be untouched as well.
		const persistedChild = JSON.parse(await fs.readFile(childFilePath, "utf8")) as HistoryItem
		expect(persistedChild.status).toBe("active")
		const persistedParent = JSON.parse(
			await fs.readFile(path.join(tmpDir, "tasks", "parent-live", "history_item.json"), "utf8"),
		) as HistoryItem
		expect(persistedParent.status).toBe("delegated")
		expect(persistedParent.awaitingChildId).toBe("child-live")

		// Kills the line-484/485 StringLiteral mutants: the two concatenated
		// fragments of the skip message are asserted independently, so either
		// fragment mutated to '' breaks its matching stringContaining check.
		expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Skipping repair for live child child-live"))
		expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("owned by another window"))

		logSpy.mockRestore()
	})

	it("repairs active child with stale mtime (crash orphan)", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
		const child = makeItem({
			id: "child-stale",
			status: "active",
			parentTaskId: "parent-stale",
			rootTaskId: "parent-stale",
			childIds: ["grandchild-stale"],
		})
		const parent = makeItem({
			id: "parent-stale",
			status: "delegated",
			awaitingChildId: "child-stale",
			delegatedToId: "child-stale",
			childIds: ["child-stale"],
		})
		await seedItems([parent, child])

		// Simulate a crash orphan: the child file has not been written for 6
		// minutes, exceeding the 5-minute liveness threshold.
		const childFilePath = path.join(tmpDir, "tasks", "child-stale", "history_item.json")
		const sixMinutesAgo = new Date(Date.now() - 6 * 60 * 1000)
		await fs.utimes(childFilePath, sixMinutesAgo, sixMinutesAgo)

		await store.initialize()

		// Original repair behavior: child → interrupted, parent → active.
		const repairedChild = store.get("child-stale")
		const repairedParent = store.get("parent-stale")
		expect(repairedChild).toMatchObject({
			id: "child-stale",
			status: "interrupted",
			parentTaskId: "parent-stale",
			rootTaskId: "parent-stale",
			childIds: ["grandchild-stale"],
		})
		expect(repairedParent).toMatchObject({ id: "parent-stale", status: "active" })
		expect(repairedParent?.awaitingChildId).toBeUndefined()
		expect(repairedParent?.delegatedToId).toBeUndefined()

		// Kills line-495 StringLiteral mutants on the orphan-repair warning.
		expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Reconciled orphaned active child"))
		expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("child-stale"))

		warnSpy.mockRestore()
	})

	it("routes an undefined getChildFileMtimeMs through initialize() and still repairs the active child", async () => {
		// End-to-end companion to the direct-helper probe test above ("returns
		// the file mtime for an existing child and undefined for a missing
		// one"): that test covers the helper in isolation; this one feeds the
		// same `undefined` return through `reconcileDelegationStateCore` via
		// `initialize()` and asserts the conservative-repair contract fires —
		// an unreadable mtime must NOT be treated as "live in another window",
		// the child is repaired to interrupted and the parent back to active.
		// A mutant that flips the `mtimeMs !== undefined` short-circuit (e.g.
		// treating missing mtimes as live) would skip the repair and break the
		// status assertions and the negative skip-log assertion below.
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
		// Private-instance access follows the documented double-assertion
		// pattern used by the probe test and the repair-intent replay tests.
		const internals = store as unknown as {
			getChildFileMtimeMs: (childId: string) => Promise<number | undefined>
		}
		const originalGetChildFileMtimeMs = internals.getChildFileMtimeMs
		const mtimeUndefinedSpy = vi
			.spyOn(internals, "getChildFileMtimeMs")
			.mockImplementation((childId: string) =>
				childId === "child-undef-mtime"
					? Promise.resolve(undefined)
					: originalGetChildFileMtimeMs.call(store, childId),
			)
		try {
			const child = makeItem({
				id: "child-undef-mtime",
				status: "active",
				parentTaskId: "parent-undef-mtime",
				rootTaskId: "parent-undef-mtime",
				childIds: ["grandchild-undef-mtime"],
			})
			const parent = makeItem({
				id: "parent-undef-mtime",
				status: "delegated",
				awaitingChildId: "child-undef-mtime",
				delegatedToId: "child-undef-mtime",
				childIds: ["child-undef-mtime"],
			})
			// The child file is seeded normally (fresh mtime, and present in
			// persistedActiveIds); only the stat probe is forced to undefined,
			// simulating a file that races away or is unreadable at the moment
			// the liveness guard checks it.
			await seedItems([parent, child])

			await store.initialize()

			// Spy must have been exercised through the real reconciliation path.
			expect(mtimeUndefinedSpy).toHaveBeenCalledWith("child-undef-mtime")

			const repairedChild = store.get("child-undef-mtime")
			const repairedParent = store.get("parent-undef-mtime")
			expect(repairedChild).toMatchObject({
				id: "child-undef-mtime",
				status: "interrupted",
				parentTaskId: "parent-undef-mtime",
				rootTaskId: "parent-undef-mtime",
				childIds: ["grandchild-undef-mtime"],
			})
			expect(repairedParent).toMatchObject({ id: "parent-undef-mtime", status: "active" })
			expect(repairedParent?.awaitingChildId).toBeUndefined()
			expect(repairedParent?.delegatedToId).toBeUndefined()

			// Persisted state must match the cache, same as the stale-mtime test.
			const tasksDir = path.join(tmpDir, "tasks")
			const persistedChild = JSON.parse(
				await fs.readFile(path.join(tasksDir, "child-undef-mtime", "history_item.json"), "utf8"),
			) as HistoryItem
			const persistedParent = JSON.parse(
				await fs.readFile(path.join(tasksDir, "parent-undef-mtime", "history_item.json"), "utf8"),
			) as HistoryItem
			expect(persistedChild).toMatchObject({
				id: "child-undef-mtime",
				status: "interrupted",
				parentTaskId: "parent-undef-mtime",
				rootTaskId: "parent-undef-mtime",
			})
			expect(persistedParent).toMatchObject({ id: "parent-undef-mtime", status: "active" })
			expect(persistedParent.awaitingChildId).toBeUndefined()
			expect(persistedParent.delegatedToId).toBeUndefined()

			// Repair ran and the liveness-skip branch was NOT taken.
			expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Reconciled orphaned active child"))
			expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("child-undef-mtime"))
			expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining("Skipping repair for live child"))
		} finally {
			mtimeUndefinedSpy.mockRestore()
			warnSpy.mockRestore()
		}
	})

	it("repairs when child file age is exactly the liveness threshold (strict '<' boundary)", async () => {
		// Kills the TaskHistoryStore.ts line-481 EqualityOperator mutant `<=`:
		// under `<=`, age === threshold (300000 ms) would count as live and the
		// repair would be skipped. With the real strict `<`, age === threshold
		// is NOT live, so the crash orphan must be repaired.
		const nowSpy = vi.spyOn(Date, "now").mockReturnValue(FIXED_NOW)
		try {
			const child = makeItem({
				id: "child-boundary-equal",
				status: "active",
				parentTaskId: "parent-boundary-equal",
				rootTaskId: "parent-boundary-equal",
			})
			const parent = makeItem({
				id: "parent-boundary-equal",
				status: "delegated",
				awaitingChildId: "child-boundary-equal",
				delegatedToId: "child-boundary-equal",
			})
			await seedItems([parent, child])
			await setChildMtimeAge("child-boundary-equal", 300_000)

			await store.initialize()

			expect(store.get("child-boundary-equal")?.status).toBe("interrupted")
			expect(store.get("parent-boundary-equal")?.status).toBe("active")
			expect(store.get("parent-boundary-equal")?.awaitingChildId).toBeUndefined()
			expect(store.get("parent-boundary-equal")?.delegatedToId).toBeUndefined()
		} finally {
			nowSpy.mockRestore()
		}
	})

	it("skips repair when child file age is one millisecond below the liveness threshold", async () => {
		// Kills:
		// - line-481 EqualityOperator mutants `>` / `>=`: with either, age
		//   299999 < 300000 would evaluate stale and the repair would run.
		// - line-105 ArithmeticOperator mutants behaviorally: every mutated
		//   threshold (0.3, 83.3, 60005, 1300, -700, 300, 5000, ...) is far
		//   below 299999, so the child would no longer be considered live.
		// - line-484/485 StringLiteral mutants: both message fragments are
		//   asserted independently.
		// - line-485 `/ 1000` ArithmeticOperator mutants: Math.round(299999 /
		//   1000) renders "300", while `* 1000`, `+ 1000`, `- 1000` and
		//   `% 1000` all render a different second count.
		const nowSpy = vi.spyOn(Date, "now").mockReturnValue(FIXED_NOW)
		const logSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
		try {
			const child = makeItem({
				id: "child-boundary-live",
				status: "active",
				parentTaskId: "parent-boundary-live",
				rootTaskId: "parent-boundary-live",
			})
			const parent = makeItem({
				id: "parent-boundary-live",
				status: "delegated",
				awaitingChildId: "child-boundary-live",
				delegatedToId: "child-boundary-live",
			})
			await seedItems([parent, child])
			await setChildMtimeAge("child-boundary-live", 299_999)

			await store.initialize()

			expect(store.get("child-boundary-live")?.status).toBe("active")
			expect(store.get("parent-boundary-live")?.status).toBe("delegated")
			expect(store.get("parent-boundary-live")?.awaitingChildId).toBe("child-boundary-live")
			expect(store.get("parent-boundary-live")?.delegatedToId).toBe("child-boundary-live")
			expect(logSpy).toHaveBeenCalledWith(
				expect.stringContaining("[TaskHistoryStore] Skipping repair for live child child-boundary-live"),
			)
			// Split around the non-ASCII em dash so the assertion depends only on
			// the seconds count rendered from (Date.now() - mtimeMs) / 1000:
			// Math.round(299.999) = 300, while `* 1000`, `+ 1000`, `- 1000` and
			// `% 1000` ArithmeticOperator mutants all render a different string.
			expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("(mtime 300s ago)"))
			expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("owned by another window"))
		} finally {
			logSpy.mockRestore()
			nowSpy.mockRestore()
		}
	})

	it("repairs a child whose file mtime is at the unix epoch (kills '-' -> '%' mutant at the liveness subtraction)", async () => {
		// Files stamped 1970-01-01 (epoch-zero artifacts from misconfigured clocks,
		// zip extraction, or container images) must be treated as stale orphans.
		// Kills the ArithmeticOperator mutant `Date.now() - mtimeMs` ->
		// `Date.now() % mtimeMs`: with the mocked mtimeMs = 1000, the real
		// subtraction is ~56 years (stale -> repair), while FIXED_NOW % 1000 === 0
		// would be read as live and skip the repair. The same mutant inside the
		// skip-path log is never reached under the mutant because the guard
		// already diverges. The exact 1000 ms stamp comes from the mocked
		// `getChildFileMtimeMs`, so no filesystem millisecond precision is
		// assumed.
		const nowSpy = vi.spyOn(Date, "now").mockReturnValue(FIXED_NOW)
		const logSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
		try {
			const child = makeItem({
				id: "child-epoch-mtime",
				status: "active",
				parentTaskId: "parent-epoch-mtime",
				rootTaskId: "parent-epoch-mtime",
			})
			const parent = makeItem({
				id: "parent-epoch-mtime",
				status: "delegated",
				awaitingChildId: "child-epoch-mtime",
				delegatedToId: "child-epoch-mtime",
			})
			await seedItems([parent, child])
			await setChildMtimeAge("child-epoch-mtime", FIXED_NOW - 1_000) // store observes mtime 1970-01-01T00:00:01.000Z

			await store.initialize()

			expect(store.get("child-epoch-mtime")?.status).toBe("interrupted")
			expect(store.get("parent-epoch-mtime")?.status).toBe("active")
			expect(store.get("parent-epoch-mtime")?.awaitingChildId).toBeUndefined()
			expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining("Skipping repair for live child"))
		} finally {
			logSpy.mockRestore()
			nowSpy.mockRestore()
		}
	})

	it("treats a future child-file mtime as live and renders the negative age (kills '-' -> '%' in the skip log)", async () => {
		// Clock skew can put a child file's mtime ahead of Date.now(). The skip
		// path renders (Date.now() - mtimeMs) / 1000 = -100s. The
		// ArithmeticOperator mutant `Date.now() % mtimeMs` would instead render
		// the whole epoch magnitude (1756886400s), so the seconds-count
		// assertion below kills it. The live-side status assertions also kill
		// the same mutant on the guard subtraction in TaskHistoryStore.ts. The
		// exact future mtime is injected by the mocked `getChildFileMtimeMs`,
		// independent of filesystem millisecond precision.
		const nowSpy = vi.spyOn(Date, "now").mockReturnValue(FIXED_NOW)
		const logSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
		try {
			const child = makeItem({
				id: "child-future-mtime",
				status: "active",
				parentTaskId: "parent-future-mtime",
				rootTaskId: "parent-future-mtime",
			})
			const parent = makeItem({
				id: "parent-future-mtime",
				status: "delegated",
				awaitingChildId: "child-future-mtime",
				delegatedToId: "child-future-mtime",
			})
			await seedItems([parent, child])
			await setChildMtimeAge("child-future-mtime", -100_000) // store observes a mtime 100s in the future

			await store.initialize()

			expect(store.get("child-future-mtime")?.status).toBe("active")
			expect(store.get("parent-future-mtime")?.status).toBe("delegated")
			expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Skipping repair for live child"))
			expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("(mtime -100s ago)"))
		} finally {
			logSpy.mockRestore()
			nowSpy.mockRestore()
		}
	})

	it("skips repair and renders 299s for a child file age of threshold-501ms (kills Math.ceil mutant)", async () => {
		// Companion to the 299999 ms test: Math.round(299.499) = 299 while
		// Math.ceil(299.499) = 300 and Math.floor(299.499) = 299. The 299999 ms
		// test above covers the floor mutant (round = ceil = 300 there), and
		// this one covers the ceil mutant. It also re-asserts the live side of
		// the strict `<` boundary and the line-105 threshold mutants.
		const nowSpy = vi.spyOn(Date, "now").mockReturnValue(FIXED_NOW)
		const logSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
		try {
			const child = makeItem({
				id: "child-boundary-ceil",
				status: "active",
				parentTaskId: "parent-boundary-ceil",
				rootTaskId: "parent-boundary-ceil",
			})
			const parent = makeItem({
				id: "parent-boundary-ceil",
				status: "delegated",
				awaitingChildId: "child-boundary-ceil",
				delegatedToId: "child-boundary-ceil",
			})
			await seedItems([parent, child])
			await setChildMtimeAge("child-boundary-ceil", 299_499)

			await store.initialize()

			expect(store.get("child-boundary-ceil")?.status).toBe("active")
			expect(store.get("parent-boundary-ceil")?.status).toBe("delegated")
			expect(store.get("parent-boundary-ceil")?.awaitingChildId).toBe("child-boundary-ceil")
			expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Skipping repair for live child"))
			expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("(mtime 299s ago)"))
		} finally {
			logSpy.mockRestore()
			nowSpy.mockRestore()
		}
	})

	it("repairs a delegated child with an omitted status as implicit active", async () => {
		const child = makeItem({
			id: "child-implicit-active",
			parentTaskId: "parent-implicit-active",
			rootTaskId: "parent-implicit-active",
		})
		const parent = makeItem({
			id: "parent-implicit-active",
			status: "delegated",
			awaitingChildId: child.id,
			delegatedToId: child.id,
		})
		await seedItems([parent, child])
		await markStaleMtime(child.id)

		await store.initialize()

		expect(store.get(child.id)).toMatchObject({ id: child.id, status: "interrupted" })
		expect(store.get(parent.id)).toMatchObject({ id: parent.id, status: "active" })
		expect(store.get(parent.id)?.awaitingChildId).toBeUndefined()
		expect(store.get(parent.id)?.delegatedToId).toBeUndefined()

		const persistedChild = JSON.parse(
			await fs.readFile(path.join(tmpDir, "tasks", child.id, GlobalFileNames.historyItem), "utf8"),
		) as HistoryItem
		expect(persistedChild.status).toBe("interrupted")
	})

	it("replays an intent after a child-only write and removes it after completion", async () => {
		const child = makeItem({ id: "child-replay", status: "active", parentTaskId: "parent-replay" })
		const parent = makeItem({
			id: "parent-replay",
			status: "delegated",
			awaitingChildId: child.id,
			delegatedToId: child.id,
		})
		await seedItems([parent, child])
		const intentPath = path.join(tmpDir, "tasks", GlobalFileNames.delegationRepairIntent)
		await fs.writeFile(intentPath, JSON.stringify(makeRepairIntent(parent, child)))
		await fs.writeFile(
			path.join(tmpDir, "tasks", child.id, GlobalFileNames.historyItem),
			JSON.stringify({ ...child, status: "interrupted" }),
		)

		await store.initialize()

		expect(store.get(child.id)?.status).toBe("interrupted")
		expect(store.get(parent.id)?.status).toBe("active")
		const persistedChild = JSON.parse(
			await fs.readFile(path.join(tmpDir, "tasks", child.id, GlobalFileNames.historyItem), "utf8"),
		) as HistoryItem
		const persistedParent = JSON.parse(
			await fs.readFile(path.join(tmpDir, "tasks", parent.id, GlobalFileNames.historyItem), "utf8"),
		) as HistoryItem
		expect(persistedChild).toMatchObject({ id: child.id, status: "interrupted" })
		expect(persistedParent).toMatchObject({ id: parent.id, status: "active" })
		expect(persistedParent.awaitingChildId).toBeUndefined()
		expect(persistedParent.delegatedToId).toBeUndefined()
		await expect(fs.access(intentPath)).rejects.toThrow()
	})

	it("replays an intent after a failure before the child write", async () => {
		const child = makeItem({
			id: "child-fault-before-child",
			status: "active",
			parentTaskId: "parent-fault-before-child",
		})
		const parent = makeItem({
			id: "parent-fault-before-child",
			status: "delegated",
			awaitingChildId: child.id,
			delegatedToId: child.id,
		})
		await seedItems([parent, child])
		await markStaleMtime(child.id)
		safeWriteJsonMock.mockImplementation(async (filePath, data) => {
			if (filePath.includes(child.id) && filePath.endsWith(GlobalFileNames.historyItem))
				throw new Error("fault before child write")
			await writeJson(filePath, data)
		})
		await expect(store.initialize()).resolves.toBeUndefined()
		store.dispose()
		safeWriteJsonMock.mockImplementation(writeJson)
		const replayedStore = registerStore(new TaskHistoryStore(tmpDir))
		await replayedStore.initialize()
		expect(replayedStore.get(child.id)?.status).toBe("interrupted")
		expect(replayedStore.get(parent.id)?.status).toBe("active")
		const persistedChild = JSON.parse(
			await fs.readFile(path.join(tmpDir, "tasks", child.id, GlobalFileNames.historyItem), "utf8"),
		) as HistoryItem
		const persistedParent = JSON.parse(
			await fs.readFile(path.join(tmpDir, "tasks", parent.id, GlobalFileNames.historyItem), "utf8"),
		) as HistoryItem
		expect(persistedChild).toMatchObject({ id: child.id, status: "interrupted" })
		expect(persistedParent).toMatchObject({ id: parent.id, status: "active" })
		expect(persistedParent.awaitingChildId).toBeUndefined()
		expect(persistedParent.delegatedToId).toBeUndefined()
	})

	it("replays an intent after a failure before the parent write", async () => {
		const child = makeItem({
			id: "child-fault-before-parent",
			status: "active",
			parentTaskId: "parent-fault-before-parent",
		})
		const parent = makeItem({
			id: "parent-fault-before-parent",
			status: "delegated",
			awaitingChildId: child.id,
			delegatedToId: child.id,
		})
		await seedItems([parent, child])
		await markStaleMtime(child.id)
		safeWriteJsonMock.mockImplementation(async (filePath, data) => {
			if (filePath.includes(parent.id) && filePath.endsWith(GlobalFileNames.historyItem))
				throw new Error("fault before parent write")
			await writeJson(filePath, data)
		})
		await expect(store.initialize()).resolves.toBeUndefined()
		store.dispose()
		safeWriteJsonMock.mockImplementation(writeJson)
		const replayedStore = registerStore(new TaskHistoryStore(tmpDir))
		await replayedStore.initialize()
		expect(replayedStore.get(child.id)?.status).toBe("interrupted")
		expect(replayedStore.get(parent.id)?.status).toBe("active")
		const persistedChild = JSON.parse(
			await fs.readFile(path.join(tmpDir, "tasks", child.id, GlobalFileNames.historyItem), "utf8"),
		) as HistoryItem
		const persistedParent = JSON.parse(
			await fs.readFile(path.join(tmpDir, "tasks", parent.id, GlobalFileNames.historyItem), "utf8"),
		) as HistoryItem
		expect(persistedChild).toMatchObject({ id: child.id, status: "interrupted" })
		expect(persistedParent).toMatchObject({ id: parent.id, status: "active" })
		expect(persistedParent.awaitingChildId).toBeUndefined()
		expect(persistedParent.delegatedToId).toBeUndefined()
	})

	it("retains an intent when the callback fails after both writes", async () => {
		const child = makeItem({ id: "child-fault-cleanup", status: "active", parentTaskId: "parent-fault-cleanup" })
		const parent = makeItem({
			id: "parent-fault-cleanup",
			status: "delegated",
			awaitingChildId: child.id,
			delegatedToId: child.id,
		})
		await seedItems([parent, child])
		await markStaleMtime(child.id)
		store.dispose()
		store = registerStore(
			new TaskHistoryStore(tmpDir, { onWrite: vi.fn().mockRejectedValue(new Error("fault before cleanup")) }),
		)
		await expect(store.initialize()).resolves.toBeUndefined()
		const intentPath = path.join(tmpDir, "tasks", GlobalFileNames.delegationRepairIntent)
		expect(await fs.readFile(intentPath, "utf8")).toContain(child.id)
		store.dispose()
		safeWriteJsonMock.mockImplementation(writeJson)
		const replayedStore = registerStore(new TaskHistoryStore(tmpDir))
		await replayedStore.initialize()
		expect(replayedStore.get(child.id)?.status).toBe("interrupted")
		expect(replayedStore.get(parent.id)?.status).toBe("active")
		const persistedChild = JSON.parse(
			await fs.readFile(path.join(tmpDir, "tasks", child.id, GlobalFileNames.historyItem), "utf8"),
		) as HistoryItem
		const persistedParent = JSON.parse(
			await fs.readFile(path.join(tmpDir, "tasks", parent.id, GlobalFileNames.historyItem), "utf8"),
		) as HistoryItem
		expect(persistedChild).toMatchObject({ id: child.id, status: "interrupted" })
		expect(persistedParent).toMatchObject({ id: parent.id, status: "active" })
		expect(persistedParent.awaitingChildId).toBeUndefined()
		expect(persistedParent.delegatedToId).toBeUndefined()
		await expect(fs.access(intentPath)).rejects.toThrow()
	})

	it("replays a both-at-target intent without writing task files", async () => {
		const child = makeItem({ id: "child-at-target", status: "interrupted", parentTaskId: "parent-at-target" })
		const parent = makeItem({ id: "parent-at-target", status: "active" })
		await seedItems([parent, child])
		const intentPath = path.join(tmpDir, "tasks", GlobalFileNames.delegationRepairIntent)
		await fs.writeFile(
			intentPath,
			JSON.stringify(makeRepairIntent({ ...parent, status: "delegated", awaitingChildId: child.id }, child)),
		)

		const writeCalls: string[] = []
		safeWriteJsonMock.mockImplementation(async (filePath, data) => {
			writeCalls.push(filePath)
			await writeJson(filePath, data)
		})
		await store.initialize()

		expect(writeCalls.filter((filePath) => filePath.endsWith(GlobalFileNames.historyItem))).toEqual([])
		await expect(fs.access(intentPath)).rejects.toThrow()
	})

	it("removes the repair-intent file after successful replay", async () => {
		const child = makeItem({ id: "child-deferred-index", status: "active", parentTaskId: "parent-deferred-index" })
		const parent = makeItem({
			id: "parent-deferred-index",
			status: "delegated",
			awaitingChildId: child.id,
			delegatedToId: child.id,
		})
		await seedItems([parent, child])
		const intentPath = path.join(tmpDir, "tasks", GlobalFileNames.delegationRepairIntent)
		await fs.writeFile(intentPath, JSON.stringify(makeRepairIntent(parent, child)))
		// Keep this a crash-orphan replay: the child file must not look live in
		// another window, or the cross-window liveness guard quarantines the intent.
		await markStaleMtime(child.id)
		await store.reconcile({ forceRefresh: true })

		const storeInternals = store as unknown as {
			replayDelegationRepairIntent: () => Promise<void>
		}

		await storeInternals.replayDelegationRepairIntent()

		await expect(fs.access(intentPath)).rejects.toThrow()
	})

	it("quarantines malformed and stale intents without blocking unrelated startup", async () => {
		const unrelated = makeItem({ id: "unrelated-startup", status: "active" })
		await seedItems([unrelated])
		const tasksDir = path.join(tmpDir, "tasks")
		const intentPath = path.join(tasksDir, GlobalFileNames.delegationRepairIntent)
		await fs.writeFile(intentPath, JSON.stringify({ malformed: true }))

		await store.initialize()

		expect(store.get(unrelated.id)?.status).toBe("active")
		expect(
			(await fs.readdir(tasksDir)).some((name) =>
				name.startsWith(`${GlobalFileNames.delegationRepairIntent}.quarantine-`),
			),
		).toBe(true)
		await expect(fs.access(intentPath)).rejects.toThrow()
	})

	it("quarantines an intent with a missing task record without changing unrelated startup", async () => {
		const unrelated = makeItem({ id: "unrelated-missing-intent", status: "active" })
		const missingChild = makeItem({ id: "missing-intent-child", status: "active" })
		const parent = makeItem({ id: "missing-intent-parent", status: "delegated", awaitingChildId: missingChild.id })
		await seedItems([unrelated])
		const tasksDir = path.join(tmpDir, "tasks")
		const intentPath = path.join(tasksDir, GlobalFileNames.delegationRepairIntent)
		await fs.writeFile(intentPath, JSON.stringify(makeRepairIntent(parent, missingChild)))

		await store.initialize()

		expect(store.get(unrelated.id)?.status).toBe("active")
		expect(store.get(parent.id)).toBeUndefined()
		expect(
			(await fs.readdir(tasksDir)).some((name) =>
				name.startsWith(`${GlobalFileNames.delegationRepairIntent}.quarantine-`),
			),
		).toBe(true)
		await expect(fs.access(intentPath)).rejects.toThrow()
	})

	it("quarantines an intent when the parent no longer matches its repair guard", async () => {
		const child = makeItem({
			id: "mismatched-intent-child",
			status: "interrupted",
			parentTaskId: "mismatched-intent-parent",
		})
		const parent = makeItem({
			id: "mismatched-intent-parent",
			status: "completed",
			awaitingChildId: child.id,
			delegatedToId: child.id,
		})
		await seedItems([parent, child])
		const tasksDir = path.join(tmpDir, "tasks")
		const intentPath = path.join(tasksDir, GlobalFileNames.delegationRepairIntent)
		await fs.writeFile(intentPath, JSON.stringify(makeRepairIntent({ ...parent, status: "delegated" }, child)))
		const childPath = path.join(tasksDir, child.id, GlobalFileNames.historyItem)
		const parentPath = path.join(tasksDir, parent.id, GlobalFileNames.historyItem)
		const beforeChild = await fs.readFile(childPath, "utf8")
		const beforeParent = await fs.readFile(parentPath, "utf8")

		await store.initialize()

		expect(store.get(child.id)?.status).toBe("interrupted")
		expect(store.get(parent.id)?.status).toBe("completed")
		expect(await fs.readFile(childPath, "utf8")).toBe(beforeChild)
		expect(await fs.readFile(parentPath, "utf8")).toBe(beforeParent)
		expect(
			(await fs.readdir(tasksDir)).some((name) =>
				name.startsWith(`${GlobalFileNames.delegationRepairIntent}.quarantine-`),
			),
		).toBe(true)
		await expect(fs.access(intentPath)).rejects.toThrow()
	})

	it("quarantines an intent when the child no longer matches its repair guard", async () => {
		const child = makeItem({
			id: "child-mismatched-intent",
			status: "completed",
			parentTaskId: "mismatched-child-parent",
		})
		const parent = makeItem({
			id: "parent-mismatched-child-intent",
			status: "active",
		})
		await seedItems([parent, child])
		const tasksDir = path.join(tmpDir, "tasks")
		const intentPath = path.join(tasksDir, GlobalFileNames.delegationRepairIntent)
		await fs.writeFile(
			intentPath,
			JSON.stringify(
				makeRepairIntent(
					{ ...parent, status: "delegated", awaitingChildId: child.id, delegatedToId: child.id },
					{ ...child, status: "active" },
				),
			),
		)
		const childPath = path.join(tasksDir, child.id, GlobalFileNames.historyItem)
		const parentPath = path.join(tasksDir, parent.id, GlobalFileNames.historyItem)
		const beforeChild = await fs.readFile(childPath, "utf8")
		const beforeParent = await fs.readFile(parentPath, "utf8")

		await store.initialize()

		expect(store.get(child.id)?.status).toBe("completed")
		expect(store.get(parent.id)?.status).toBe("active")
		expect(await fs.readFile(childPath, "utf8")).toBe(beforeChild)
		expect(await fs.readFile(parentPath, "utf8")).toBe(beforeParent)
		await expect(fs.access(intentPath)).rejects.toThrow()
		expect(
			(await fs.readdir(tasksDir)).some((name) =>
				name.startsWith(`${GlobalFileNames.delegationRepairIntent}.quarantine-`),
			),
		).toBe(true)
	})

	it("quarantines a replay intent whose child is live in another window (recent mtime)", async () => {
		// Reviewer scenario: this window crashed mid-repair (the intent is durable
		// but the child write never landed), and another window then restarted the
		// same child. The child's history file mtime is recent, so replaying the
		// intent here would overwrite a live child as "interrupted". The intent must
		// be quarantined instead, and the startup reconciliation liveness guard must
		// likewise leave the delegation untouched.
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
		const child = makeItem({
			id: "child-replay-live",
			status: "active",
			parentTaskId: "parent-replay-live",
			rootTaskId: "parent-replay-live",
		})
		const parent = makeItem({
			id: "parent-replay-live",
			status: "delegated",
			awaitingChildId: child.id,
			delegatedToId: child.id,
		})
		await seedItems([parent, child])
		const tasksDir = path.join(tmpDir, "tasks")
		const intentPath = path.join(tasksDir, GlobalFileNames.delegationRepairIntent)
		await fs.writeFile(intentPath, JSON.stringify(makeRepairIntent(parent, child)))

		// Another live window has just persisted the child.
		const childFilePath = path.join(tasksDir, child.id, GlobalFileNames.historyItem)
		const now = new Date()
		await fs.utimes(childFilePath, now, now)

		await store.initialize()

		// Nothing may be written as "interrupted": child stays active and the
		// parent keeps its delegation links.
		expect(store.get(child.id)?.status).toBe("active")
		expect(store.get(parent.id)?.status).toBe("delegated")
		expect(store.get(parent.id)?.awaitingChildId).toBe(child.id)
		expect(store.get(parent.id)?.delegatedToId).toBe(child.id)

		const persistedChild = JSON.parse(await fs.readFile(childFilePath, "utf8")) as HistoryItem
		expect(persistedChild.status).toBe("active")
		const persistedParent = JSON.parse(
			await fs.readFile(path.join(tasksDir, parent.id, GlobalFileNames.historyItem), "utf8"),
		) as HistoryItem
		expect(persistedParent.status).toBe("delegated")
		expect(persistedParent.awaitingChildId).toBe(child.id)

		// The intent is moved out of the way rather than applied or left to retry.
		await expect(fs.access(intentPath)).rejects.toThrow()
		expect(
			(await fs.readdir(tasksDir)).some((name) =>
				name.startsWith(`${GlobalFileNames.delegationRepairIntent}.quarantine-`),
			),
		).toBe(true)
		// Kills the StringLiteral mutant on the new quarantine reason.
		expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("child live in another window (recent mtime)"))

		warnSpy.mockRestore()
	})

	it("replays a repair intent whose child mtime is stale (crash orphan still repaired)", async () => {
		// Regression guard for the replay liveness guard: a child file untouched for
		// longer than the threshold is a genuine crash orphan, so the durable intent
		// must still complete on restart — child → interrupted, parent → active.
		const child = makeItem({
			id: "child-replay-stale",
			status: "active",
			parentTaskId: "parent-replay-stale",
			rootTaskId: "parent-replay-stale",
		})
		const parent = makeItem({
			id: "parent-replay-stale",
			status: "delegated",
			awaitingChildId: child.id,
			delegatedToId: child.id,
		})
		await seedItems([parent, child])
		const tasksDir = path.join(tmpDir, "tasks")
		const intentPath = path.join(tasksDir, GlobalFileNames.delegationRepairIntent)
		await fs.writeFile(intentPath, JSON.stringify(makeRepairIntent(parent, child)))
		await markStaleMtime(child.id)

		await store.initialize()

		expect(store.get(child.id)?.status).toBe("interrupted")
		expect(store.get(parent.id)?.status).toBe("active")
		expect(store.get(parent.id)?.awaitingChildId).toBeUndefined()
		expect(store.get(parent.id)?.delegatedToId).toBeUndefined()
		const persistedChild = JSON.parse(
			await fs.readFile(path.join(tasksDir, child.id, GlobalFileNames.historyItem), "utf8"),
		) as HistoryItem
		expect(persistedChild.status).toBe("interrupted")
		await expect(fs.access(intentPath)).rejects.toThrow()
		expect(
			(await fs.readdir(tasksDir)).some((name) =>
				name.startsWith(`${GlobalFileNames.delegationRepairIntent}.quarantine-`),
			),
		).toBe(false)
	})

	it("completes a parent-only replay while the child is live in another window (child already at target)", async () => {
		// The guard must gate only actual child writes. Here the child is already at
		// intent.target.childStatus, so no child write happens and the recent (live)
		// mtime must not block the parent-side completion of the repair.
		const child = makeItem({
			id: "child-replay-parent-only",
			status: "interrupted",
			parentTaskId: "parent-replay-parent-only",
		})
		const parent = makeItem({
			id: "parent-replay-parent-only",
			status: "delegated",
			awaitingChildId: child.id,
			delegatedToId: child.id,
		})
		await seedItems([parent, child])
		const tasksDir = path.join(tmpDir, "tasks")
		const intentPath = path.join(tasksDir, GlobalFileNames.delegationRepairIntent)
		await fs.writeFile(intentPath, JSON.stringify(makeRepairIntent(parent, child)))
		const now = new Date()
		await fs.utimes(path.join(tasksDir, child.id, GlobalFileNames.historyItem), now, now)

		await store.initialize()

		expect(store.get(child.id)?.status).toBe("interrupted")
		expect(store.get(parent.id)?.status).toBe("active")
		expect(store.get(parent.id)?.awaitingChildId).toBeUndefined()
		await expect(fs.access(intentPath)).rejects.toThrow()
	})

	it("proceeds with a replay when the child history file mtime is unreadable", async () => {
		// Matches the reconcile-path convention: getChildFileMtimeMs returns
		// undefined for a missing/unreadable history file, which conservatively
		// proceeds with the repair instead of treating the child as live.
		const probe = TaskHistoryStore.prototype as unknown as {
			getChildFileMtimeMs: (childId: string) => Promise<number | undefined>
		}
		mtimeSpy = vi.spyOn(probe, "getChildFileMtimeMs").mockResolvedValue(undefined)

		const child = makeItem({
			id: "child-replay-unreadable",
			status: "active",
			parentTaskId: "parent-replay-unreadable",
		})
		const parent = makeItem({
			id: "parent-replay-unreadable",
			status: "delegated",
			awaitingChildId: child.id,
			delegatedToId: child.id,
		})
		await seedItems([parent, child])
		const tasksDir = path.join(tmpDir, "tasks")
		const intentPath = path.join(tasksDir, GlobalFileNames.delegationRepairIntent)
		await fs.writeFile(intentPath, JSON.stringify(makeRepairIntent(parent, child)))

		await store.initialize()

		expect(store.get(child.id)?.status).toBe("interrupted")
		expect(store.get(parent.id)?.status).toBe("active")
		await expect(fs.access(intentPath)).rejects.toThrow()
	})

	it("repairs invalid delegation: delegated parent with no awaitingChildId → active (clears delegatedToId and awaitingChildId)", async () => {
		// awaitingChildId is falsy but explicitly set (empty string), delegatedToId is stale
		const parent = makeItem({
			id: "parent-5",
			status: "delegated",
			delegatedToId: "stale-child",
			awaitingChildId: "",
		})
		await seedItems([parent])

		await store.initialize()

		const repaired = store.get("parent-5")
		expect(repaired?.status).toBe("active")
		expect(repaired?.delegatedToId).toBeUndefined()
		// Fix #4: falsy awaitingChildId must also be cleared
		expect(repaired?.awaitingChildId).toBeUndefined()
	})

	it("does not touch active or completed tasks", async () => {
		const active = makeItem({ id: "task-active", status: "active" })
		const completed = makeItem({ id: "task-completed", status: "completed" })
		await seedItems([active, completed])

		await store.initialize()

		expect(store.get("task-active")?.status).toBe("active")
		expect(store.get("task-completed")?.status).toBe("completed")
	})

	it("repairs multiple delegated parents in a single initialize()", async () => {
		const childA = makeItem({ id: "child-a", status: "completed" })
		const parentA = makeItem({ id: "parent-a", status: "delegated", awaitingChildId: "child-a" })
		const parentB = makeItem({ id: "parent-b", status: "delegated", awaitingChildId: "missing-b" })
		await seedItems([childA, parentA, parentB])

		await store.initialize()

		expect(store.get("parent-a")?.status).toBe("active")
		expect(store.get("parent-b")?.status).toBe("active")
	})

	it("repairs an orphaned link in a chained delegation without repairing its grandparent", async () => {
		// C doesn't exist (orphaned). B is delegated waiting for C → repaired to active.
		// A sees B as delegated in the persisted startup snapshot and remains delegated.
		const parentA = makeItem({ id: "parent-a-chain", status: "delegated", awaitingChildId: "parent-b-chain" })
		const parentB = makeItem({
			id: "parent-b-chain",
			status: "delegated",
			awaitingChildId: "missing-child-chain",
		})
		await seedItems([parentA, parentB])

		await store.initialize()

		// B is repaired: its child (C) was missing
		expect(store.get("parent-b-chain")?.status).toBe("active")
		// A stays delegated: B was repaired from delegated to active and remains
		// resumable rather than being mistaken for an active orphan from disk.
		expect(store.get("parent-a-chain")?.status).toBe("delegated")
		expect(store.get("parent-a-chain")?.awaitingChildId).toBe("parent-b-chain")
		expect(store.get("parent-b-chain")?.status).toBe("active")
		expect(store.get("parent-b-chain")?.awaitingChildId).toBeUndefined()
	})

	it("does not repair a grandparent when replay repairs the middle node", async () => {
		const grandparent = makeItem({
			id: "grandparent-replay-chain",
			status: "delegated",
			awaitingChildId: "parent-replay-chain",
			delegatedToId: "parent-replay-chain",
		})
		const parent = makeItem({
			id: "parent-replay-chain",
			status: "delegated",
			awaitingChildId: "child-replay-chain",
			delegatedToId: "child-replay-chain",
			parentTaskId: grandparent.id,
			rootTaskId: grandparent.id,
		})
		const child = makeItem({
			id: "child-replay-chain",
			status: "active",
			parentTaskId: parent.id,
			rootTaskId: grandparent.id,
		})
		await seedItems([grandparent, parent, child])
		const intentPath = path.join(tmpDir, "tasks", GlobalFileNames.delegationRepairIntent)
		await fs.writeFile(intentPath, JSON.stringify(makeRepairIntent(parent, child)))
		// Crash-orphan scenario: the child must not look live in another window, or
		// the replay/startup liveness guards would skip the repair entirely.
		await markStaleMtime(child.id)

		await store.initialize()

		// Replay repairs B/C, but B was delegated at the persisted startup snapshot.
		// A must remain delegated to the now-interrupted/resumable B.
		expect(store.get(grandparent.id)).toMatchObject({
			id: grandparent.id,
			status: "delegated",
			awaitingChildId: parent.id,
			delegatedToId: parent.id,
		})
		expect(store.get(parent.id)).toMatchObject({ id: parent.id, status: "active" })
		expect(store.get(parent.id)?.awaitingChildId).toBeUndefined()
		expect(store.get(parent.id)?.delegatedToId).toBeUndefined()
		expect(store.get(child.id)).toMatchObject({ id: child.id, status: "interrupted" })

		const persistedGrandparent = JSON.parse(
			await fs.readFile(path.join(tmpDir, "tasks", grandparent.id, GlobalFileNames.historyItem), "utf8"),
		) as HistoryItem
		const persistedParent = JSON.parse(
			await fs.readFile(path.join(tmpDir, "tasks", parent.id, GlobalFileNames.historyItem), "utf8"),
		) as HistoryItem
		const persistedChild = JSON.parse(
			await fs.readFile(path.join(tmpDir, "tasks", child.id, GlobalFileNames.historyItem), "utf8"),
		) as HistoryItem
		expect(persistedGrandparent).toMatchObject({
			id: grandparent.id,
			status: "delegated",
			awaitingChildId: parent.id,
			delegatedToId: parent.id,
		})
		expect(persistedParent).toMatchObject({ id: parent.id, status: "active" })
		expect(persistedParent.awaitingChildId).toBeUndefined()
		expect(persistedParent.delegatedToId).toBeUndefined()
		expect(persistedChild).toMatchObject({ id: child.id, status: "interrupted" })
		await expect(fs.access(intentPath)).rejects.toThrow()
	})

	it("is idempotent when recovering an active child", async () => {
		const child = makeItem({ id: "child-active-idempotent", status: "active" })
		const parent = makeItem({
			id: "parent-active-idempotent",
			status: "delegated",
			awaitingChildId: child.id,
			delegatedToId: child.id,
		})
		await seedItems([parent, child])
		await markStaleMtime(child.id)

		await store.initialize()
		const afterFirstParent = { ...store.get(parent.id) }
		const afterFirstChild = { ...store.get(child.id) }

		store.dispose()
		const store2 = registerStore(new TaskHistoryStore(tmpDir))
		await store2.initialize()
		const afterSecondParent = { ...store2.get(parent.id) }
		const afterSecondChild = { ...store2.get(child.id) }
		store2.dispose()

		expect(afterFirstParent).toMatchObject({ status: "active" })
		expect(afterSecondParent).toEqual(afterFirstParent)
		expect(afterFirstChild).toMatchObject({ status: "interrupted" })
		expect(afterSecondChild).toEqual(afterFirstChild)
	})

	it("is idempotent: running initialize twice produces the same result", async () => {
		const child = makeItem({ id: "child-6", status: "completed", completionResultSummary: "Done" })
		const parent = makeItem({ id: "parent-6", status: "delegated", awaitingChildId: "child-6" })
		await seedItems([parent, child])

		await store.initialize()
		const afterFirst = { ...store.get("parent-6") }

		store.dispose()
		const store2 = registerStore(new TaskHistoryStore(tmpDir))
		await store2.initialize()
		const afterSecond = { ...store2.get("parent-6") }
		store2.dispose()

		expect(afterFirst.status).toBe("active")
		expect(afterSecond.status).toBe("active")
		expect(afterSecond.completedByChildId).toBe(afterFirst.completedByChildId)
		expect(afterSecond.completionResultSummary).toBe(afterFirst.completionResultSummary)
	})

	it("logs repairs to console.warn", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

		const parent = makeItem({ id: "parent-log", status: "delegated", awaitingChildId: "nonexistent" })
		await seedItems([parent])

		await store.initialize()

		expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Reconciled orphaned delegation"))
		expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("parent-log"))

		warnSpy.mockRestore()
	})

	it("invokes onWrite callback after startup repairs", async () => {
		const onWrite = vi.fn().mockResolvedValue(undefined)
		store.dispose()
		store = registerStore(new TaskHistoryStore(tmpDir, { onWrite }))

		const parent = makeItem({ id: "parent-onwrite", status: "delegated", awaitingChildId: "nonexistent-child" })
		await seedItems([parent])

		await store.initialize()

		// The startup repair writes the repaired item, which must trigger onWrite
		expect(onWrite).toHaveBeenCalled()
		// The final state passed to onWrite must contain the repaired item
		const lastCall = onWrite.mock.calls[onWrite.mock.calls.length - 1][0] as HistoryItem[]
		const repaired = lastCall.find((i) => i.id === "parent-onwrite")
		expect(repaired?.status).toBe("active")
	})
})

// ─────────────────────────────────────────────────────────────────────────────
// migrateFromGlobalState — reconciliation runs after migration
// ─────────────────────────────────────────────────────────────────────────────

describe("TaskHistoryStore migrateFromGlobalState reconciliation", () => {
	let tmpDir: string
	let store: TaskHistoryStore

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "zoo-migrate-test-"))
		store = new TaskHistoryStore(tmpDir)
		await store.initialize()
	})

	afterEach(async () => {
		store.dispose()
		await fs.rm(tmpDir, { recursive: true, force: true })
	})

	it("repairs a delegated parent introduced by migrateFromGlobalState on the same startup", async () => {
		// Simulate a first-upgrade scenario: the child task file exists on disk
		// (from a pre-migration run) but the parent arrives via migrateFromGlobalState
		// with status "delegated" and an awaitingChildId whose task dir is also present.
		// The child's history_item.json does NOT exist yet — it too will be migrated.
		const tasksDir = path.join(tmpDir, "tasks")
		const childId = "migrate-child-1"
		const parentId = "migrate-parent-1"

		// Create task directories (simulating existing task folders)
		await fs.mkdir(path.join(tasksDir, childId), { recursive: true })
		await fs.mkdir(path.join(tasksDir, parentId), { recursive: true })

		const child = makeItem({ id: childId, status: "completed", completionResultSummary: "Done" })
		const parent = makeItem({ id: parentId, status: "delegated", awaitingChildId: childId, delegatedToId: childId })

		// Migrate both — parent is delegated with a completed child
		await store.migrateFromGlobalState([child, parent])

		// The parent should be repaired to active by the post-migration reconciliation
		const repairedParent = store.get(parentId)
		expect(repairedParent?.status).toBe("active")
		expect(repairedParent?.awaitingChildId).toBeUndefined()
		expect(repairedParent?.delegatedToId).toBeUndefined()
		expect(repairedParent?.completedByChildId).toBe(childId)
		expect(repairedParent?.completionResultSummary).toBe("Done")
	})
})

// ─────────────────────────────────────────────────────────────────────────────
// upsert — transition guard enforcement at the write boundary
// ─────────────────────────────────────────────────────────────────────────────

describe("TaskHistoryStore upsert transition guard", () => {
	let tmpDir: string
	let store: TaskHistoryStore

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
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "upsert-guard-test-"))
		store = new TaskHistoryStore(tmpDir)
		await store.initialize()
	})

	afterEach(async () => {
		store.dispose()
		await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
	})

	it("rejects completed → active transition, preserving the completed status", async () => {
		const item = makeItem({ id: "task-guard-1", status: "completed" })
		await seedItems([item])
		store.dispose()
		store = new TaskHistoryStore(tmpDir)
		await store.initialize()

		// Fire-and-forget late save: tries to write status: "active" over "completed"
		await expect(store.upsert({ ...item, status: "active" })).rejects.toThrow(
			"Invalid task status transition: completed → active",
		)

		// The completed status must be preserved in the cache
		expect(store.get("task-guard-1")?.status).toBe("completed")
	})

	it("rejects delegated → completed transition", async () => {
		// Must include a live active child so reconciliation doesn't repair the parent to active
		const child = makeItem({ id: "child-guard-2", status: "interrupted" })
		const item = makeItem({ id: "task-guard-2", status: "delegated", awaitingChildId: "child-guard-2" })
		await seedItems([child, item])
		store.dispose()
		store = new TaskHistoryStore(tmpDir)
		await store.initialize()

		// Confirm reconciliation left the delegated status alone
		expect(store.get("task-guard-2")?.status).toBe("delegated")

		await expect(store.upsert({ ...item, status: "completed" })).rejects.toThrow(
			"Invalid task status transition: delegated → completed",
		)

		expect(store.get("task-guard-2")?.status).toBe("delegated")
	})

	it("allows valid active → completed transition", async () => {
		const item = makeItem({ id: "task-guard-3", status: "active" })
		await seedItems([item])
		store.dispose()
		store = new TaskHistoryStore(tmpDir)
		await store.initialize()

		await expect(store.upsert({ ...item, status: "completed" })).resolves.toBeDefined()
		expect(store.get("task-guard-3")?.status).toBe("completed")
	})

	it("rejects interrupted → active transition, preserving the interrupted status", async () => {
		const item = makeItem({ id: "task-guard-interrupted", status: "interrupted" })
		await seedItems([item])
		store.dispose()
		store = new TaskHistoryStore(tmpDir)
		await store.initialize()

		await expect(store.upsert({ ...item, status: "active" })).rejects.toThrow(
			"Invalid task status transition: interrupted → active",
		)
		expect(store.get("task-guard-interrupted")?.status).toBe("interrupted")
	})

	it("allows valid interrupted → completed transition", async () => {
		const item = makeItem({ id: "task-guard-interrupted-complete", status: "interrupted" })
		await seedItems([item])
		store.dispose()
		store = new TaskHistoryStore(tmpDir)
		await store.initialize()

		await expect(store.upsert({ ...item, status: "completed" })).resolves.toBeDefined()
		expect(store.get("task-guard-interrupted-complete")?.status).toBe("completed")
	})

	it("allows first insert with status: active (no prior record to transition from)", async () => {
		const item = makeItem({ id: "task-guard-new", status: "active" })
		// Do NOT seed — this is the very first write for this task
		await expect(store.upsert(item)).resolves.toBeDefined()
		expect(store.get("task-guard-new")?.status).toBe("active")
	})

	it("allows writing status: active over a legacy item with status: undefined (implicit active → active no-op)", async () => {
		// Legacy items pre-dating the status field have status: undefined, which normalizes
		// to "active". Writing status: "active" must not throw as an invalid self-loop.
		const item = makeItem({ id: "task-guard-legacy" })
		const { status: _status, ...legacyItem } = item
		await seedItems([legacyItem])
		store.dispose()
		store = new TaskHistoryStore(tmpDir)
		await store.initialize()

		await expect(store.upsert({ ...item, status: "active" })).resolves.toBeDefined()
		expect(store.get("task-guard-legacy")?.status).toBe("active")
	})

	it("allows upsert without a status field (no-op on status)", async () => {
		const item = makeItem({ id: "task-guard-4", status: "completed" })
		await seedItems([item])
		store.dispose()
		store = new TaskHistoryStore(tmpDir)
		await store.initialize()

		// Omitting status entirely — no transition should be validated
		const { status: _omit, ...noStatus } = item
		await expect(store.upsert(noStatus as HistoryItem)).resolves.toBeDefined()
		// Status is preserved from the existing cache entry
		expect(store.get("task-guard-4")?.status).toBe("completed")
	})

	it("atomicReadAndUpdate enforces the upsertCore transition guard on status changes", async () => {
		// atomicReadAndUpdate now flows through upsertCore without skipTransitionCheck,
		// so invalid transitions are rejected at the store boundary.
		const item = makeItem({ id: "task-atomic-guard", status: "active" })
		await store.upsert(item)

		// active → delegated via atomicReadAndUpdate — valid, must succeed
		await expect(
			store.atomicReadAndUpdate("task-atomic-guard", (current) => ({
				...current,
				status: "delegated" as const,
				awaitingChildId: "some-child",
			})),
		).resolves.toBeDefined()
		expect(store.get("task-atomic-guard")?.status).toBe("delegated")

		// delegated → completed via atomicReadAndUpdate — invalid, must throw
		await expect(
			store.atomicReadAndUpdate("task-atomic-guard", (current) => ({
				...current,
				status: "completed" as const,
			})),
		).rejects.toThrow("Invalid task status transition: delegated → completed")
	})
})

// ─────────────────────────────────────────────────────────────────────────────
// startPeriodicReconciliation — delegation repair on each tick (review item #2)
// ─────────────────────────────────────────────────────────────────────────────

describe("TaskHistoryStore periodic delegation reconciliation", () => {
	let tmpDir: string
	let store: TaskHistoryStore | undefined
	let mtimeSpy: { mockRestore(): void } | undefined

	// Private static interval used to advance the fake clock by exactly one tick.
	// There is no typed accessor; this casts through `unknown` (not `as any`)
	// following the same private-member access pattern used for
	// LIVE_CHILD_MTIME_THRESHOLD_MS at the top of this spec.
	const RECONCILE_INTERVAL_MS = (TaskHistoryStore as unknown as { RECONCILE_INTERVAL_MS: number })
		.RECONCILE_INTERVAL_MS

	const CHILD_ID = "child-tick"
	const PARENT_ID = "parent-tick"

	/**
	 * Fake only what the tick scheduling needs: the 5-minute `setTimeout` clock
	 * and `Date` (consumed by the liveness guard). Everything else (fs I/O,
	 * microtasks) stays real so `flushUntil()` below can pump the event
	 * loop while the timer clock advances only 1 ms per yield.
	 */
	function useTickClock(): void {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
	}

	/**
	 * Drain pending real fs I/O by polling an observable condition instead of
	 * burning a fixed number of yields. The tick's reconcile/repair chain
	 * completes on libuv callbacks that fake timers alone never advance, and
	 * each `advanceTimersByTimeAsync(1)` yields one REAL macrotask turn
	 * (processing the poll phase) while advancing the fake clock only 1 ms.
	 * The yield count the chain needs is environment-dependent (~155 yields on
	 * a fast local SSD; higher on contended CI runners — the old fixed
	 * 2000-yield pumps intermittently starved on ubuntu CI, which is exactly
	 * what this helper replaces). Polling the SAME final state the assertions
	 * check makes the wait deterministic without weakening them. The pump
	 * stops as soon as the condition holds, so correct-code runs stay fast,
	 * and the generous cap costs sub-second wall time even when exhausted
	 * because fake timers never sleep (measured ~123 ms per 55K idle yields).
	 * On exhaustion it THROWS with a state snapshot rather than silently
	 * proceeding, converting a future hang into a loud, diagnosable failure.
	 *
	 * Predicates MUST be cheap and side-effect free: poll the in-memory cache
	 * getters (`store.get(...)`, which never touches disk) or spy call logs.
	 */
	async function flushUntil(
		predicate: () => boolean,
		options: { maxYields?: number; label?: string; snapshot?: () => string } = {},
	): Promise<void> {
		const { maxYields = 50_000, label = "flushUntil predicate", snapshot } = options
		for (let i = 0; i < maxYields; i++) {
			if (predicate()) {
				return
			}
			await vi.advanceTimersByTimeAsync(1)
		}
		if (predicate()) {
			return
		}
		let state = "snapshot unavailable"
		try {
			state = snapshot ? snapshot() : "no snapshot supplied"
		} catch {
			// A throwing snapshot must not mask the primary diagnostic below.
		}
		throw new Error(
			`flushUntil: "${label}" was not satisfied within ${maxYields} yields (~${maxYields} ms of fake ` +
				`time). The tick's async chain never settled; final state: ${state}.`,
		)
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

	/**
	 * Stateful mtime injection for the liveness guard. The guard computes
	 * `Date.now() - mtimeMs` against the (fake) clock, and this injector returns
	 * `Date.now() - childAgeMs` at call time, so flipping `childAgeMs` between
	 * the startup pass and a periodic tick deterministically models "live in
	 * another window at startup, then crashed before the next tick". Exact
	 * regardless of filesystem mtime precision, same convention as
	 * `setChildMtimeAge` above. Other child ids delegate to the real
	 * implementation so unrelated probe paths keep exercising the FS.
	 */
	let childAgeMs = 0
	function installChildAgeInjector(): void {
		const probe = TaskHistoryStore.prototype as unknown as {
			getChildFileMtimeMs: (childId: string) => Promise<number | undefined>
		}
		const original = probe.getChildFileMtimeMs
		mtimeSpy = vi
			.spyOn(probe, "getChildFileMtimeMs")
			.mockImplementation((childId: string) =>
				childId === CHILD_ID ? Promise.resolve(Date.now() - childAgeMs) : original.call(store!, childId),
			)
	}

	function makeDelegatedPair(): HistoryItem[] {
		const child = makeItem({
			id: CHILD_ID,
			status: "active",
			parentTaskId: PARENT_ID,
			rootTaskId: PARENT_ID,
		})
		const parent = makeItem({
			id: PARENT_ID,
			status: "delegated",
			awaitingChildId: CHILD_ID,
			delegatedToId: CHILD_ID,
			childIds: [CHILD_ID],
		})
		return [parent, child]
	}

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "periodic-deleg-test-"))
		childAgeMs = 60_000
	})

	afterEach(async () => {
		mtimeSpy?.mockRestore()
		mtimeSpy = undefined
		store?.dispose()
		store = undefined
		vi.useRealTimers()
		await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
	})

	it("repairs an active child whose mtime goes stale between startup and the next tick (the reported bug)", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		const [parent, child] = makeDelegatedPair()
		await seedItems([parent, child])

		const s = (store = new TaskHistoryStore(tmpDir))
		installChildAgeInjector()
		useTickClock()
		// Child looks live at startup (written 60s ago by another window) → startup skips repair.
		childAgeMs = 60_000
		await s.initialize()
		expect(errorSpy).not.toHaveBeenCalled()

		expect(s.get(CHILD_ID)?.status).toBe("active")
		expect(s.get(PARENT_ID)?.status).toBe("delegated")
		expect(s.get(PARENT_ID)?.awaitingChildId).toBe(CHILD_ID)

		// The owning window crashes: nobody rewrites the child file, so by the
		// next periodic tick its mtime is past the liveness threshold.
		childAgeMs = 10 * 60 * 1000
		await vi.advanceTimersByTimeAsync(RECONCILE_INTERVAL_MS)
		// Compound predicate: the "Reconciled orphaned active child" warn is
		// emitted only after repairActiveDelegation fully resolves (intent
		// write, both task-file writes, cache updates, intent cleanup), so
		// waiting for the cache flip AND the warn settles every observable the
		// assertions below depend on — a cache-only predicate could return
		// before the warnSpy assertion is satisfiable.
		await flushUntil(
			() =>
				s.get(CHILD_ID)?.status === "interrupted" &&
				warnSpy.mock.calls.some(
					(c) => typeof c[0] === "string" && c[0].includes("Reconciled orphaned active child"),
				),
			{
				label: "stale child repaired to interrupted and the repair was logged",
				snapshot: () =>
					`child=${s.get(CHILD_ID)?.status} parent=${s.get(PARENT_ID)?.status} warnCalls=${warnSpy.mock.calls.length}`,
			},
		)

		// Within ONE interval, the parent window must repair: child → interrupted,
		// parent → active with delegation links cleared.
		expect(s.get(CHILD_ID)).toMatchObject({ id: CHILD_ID, status: "interrupted", parentTaskId: PARENT_ID })
		expect(s.get(PARENT_ID)).toMatchObject({ id: PARENT_ID, status: "active" })
		expect(s.get(PARENT_ID)?.awaitingChildId).toBeUndefined()
		expect(s.get(PARENT_ID)?.delegatedToId).toBeUndefined()

		// Repaired on disk, not just in the cache.
		const persistedChild = JSON.parse(
			await fs.readFile(path.join(tmpDir, "tasks", CHILD_ID, GlobalFileNames.historyItem), "utf8"),
		) as HistoryItem
		const persistedParent = JSON.parse(
			await fs.readFile(path.join(tmpDir, "tasks", PARENT_ID, GlobalFileNames.historyItem), "utf8"),
		) as HistoryItem
		expect(persistedChild.status).toBe("interrupted")
		expect(persistedParent.status).toBe("active")
		expect(persistedParent.awaitingChildId).toBeUndefined()

		// The warn message proves the DELEGATION pass (not the plain cache
		// reconcile) ran inside the tick, and the tick raised no errors.
		expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Reconciled orphaned active child"))
		expect(errorSpy).not.toHaveBeenCalled()

		// Re-arm must survive the successful tick so the loop keeps running.
		const internals = s as unknown as { reconcileTimer: ReturnType<typeof setTimeout> | null }
		expect(internals.reconcileTimer).not.toBeNull()

		warnSpy.mockRestore()
		errorSpy.mockRestore()
	})

	it("never repairs a child this window itself persisted as active, even with a stale mtime (in-window delegation)", async () => {
		// Startup has no local sessions, so an active child on disk implies a
		// crashed host and is a valid repair target. Mid-session that inference
		// breaks: a child running IN THIS WINDOW (e.g. an in-window delegation)
		// can go minutes without rewriting its history file while it streams a
		// long turn or waits on a user prompt. The tick must not tear it away
		// from its own runner — only children this store never wrote active
		// (i.e. loaded from disk, owned elsewhere) are orphan candidates.
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		const child = makeItem({
			id: CHILD_ID,
			status: "active",
			parentTaskId: PARENT_ID,
			rootTaskId: PARENT_ID,
		})
		const parent = makeItem({ id: PARENT_ID, status: "active" })

		const s = (store = new TaskHistoryStore(tmpDir))
		useTickClock()
		await s.initialize()

		// This window creates the parent and the child, then delegates.
		await s.upsert(parent)
		await s.upsert(child)
		await s.atomicReadAndUpdate(PARENT_ID, (current) => ({
			...current,
			status: "delegated" as const,
			awaitingChildId: CHILD_ID,
			delegatedToId: CHILD_ID,
		}))
		expect(s.get(PARENT_ID)?.status).toBe("delegated")

		// Even though the child's mtime looks stale, it is owned HERE.
		const probe = TaskHistoryStore.prototype as unknown as {
			getChildFileMtimeMs: (childId: string) => Promise<number | undefined>
		}
		const realProbe = probe.getChildFileMtimeMs
		mtimeSpy = vi
			.spyOn(probe, "getChildFileMtimeMs")
			.mockImplementation((childId: string) =>
				childId === CHILD_ID ? Promise.resolve(Date.now() - 10 * 60 * 1000) : realProbe.call(s, childId),
			)

		// Negative test: the tick must do NOTHING to this locally-owned child,
		// so no positive log exists to poll. Settle on the recursive re-arm
		// instead — `startPeriodicReconciliation()` only re-runs after BOTH
		// `reconcile()` and the delegation pass have fully finished, so a
		// fresh timer handle proves the whole tick settled.
		const timerState = s as unknown as { reconcileTimer: ReturnType<typeof setTimeout> | null }
		const timerBeforeTick = timerState.reconcileTimer
		await vi.advanceTimersByTimeAsync(RECONCILE_INTERVAL_MS)
		await flushUntil(() => timerState.reconcileTimer !== timerBeforeTick, {
			label: "periodic tick completed without repairing the locally-owned child",
			snapshot: () =>
				`child=${s.get(CHILD_ID)?.status} parent=${s.get(PARENT_ID)?.status} awaiting=${s.get(PARENT_ID)?.awaitingChildId}`,
		})

		expect(s.get(CHILD_ID)?.status).toBe("active")
		expect(s.get(PARENT_ID)?.status).toBe("delegated")
		expect(s.get(PARENT_ID)?.awaitingChildId).toBe(CHILD_ID)
		expect(errorSpy).not.toHaveBeenCalled()

		errorSpy.mockRestore()
	})

	it("does not repair a child that stays live across the periodic tick (no cross-window clobbering)", async () => {
		const logSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
		const [parent, child] = makeDelegatedPair()
		await seedItems([parent, child])

		const s = (store = new TaskHistoryStore(tmpDir))
		installChildAgeInjector()
		useTickClock()
		childAgeMs = 60_000
		await s.initialize()
		// Startup also logs the skip; clear so remaining calls come from the tick.
		logSpy.mockClear()

		// The other window keeps writing: the child stays live at tick time.
		childAgeMs = 60_000
		await vi.advanceTimersByTimeAsync(RECONCILE_INTERVAL_MS)
		// The skip-guard warn is this test's own observable (asserted below);
		// once it fires the liveness check has run, no repair follows, and the
		// persisted-file read below is safe (reconcile() never writes).
		await flushUntil(
			() =>
				logSpy.mock.calls.some(
					(c) => typeof c[0] === "string" && c[0].includes(`Skipping repair for live child ${CHILD_ID}`),
				),
			{
				label: "tick skipped the repair for the live child",
				snapshot: () => `child=${s.get(CHILD_ID)?.status} warnCalls=${logSpy.mock.calls.length}`,
			},
		)

		// Nothing may be repaired: child stays active, parent keeps its delegation links.
		expect(s.get(CHILD_ID)?.status).toBe("active")
		expect(s.get(PARENT_ID)?.status).toBe("delegated")
		expect(s.get(PARENT_ID)?.awaitingChildId).toBe(CHILD_ID)
		expect(s.get(PARENT_ID)?.delegatedToId).toBe(CHILD_ID)

		const persistedChild = JSON.parse(
			await fs.readFile(path.join(tmpDir, "tasks", CHILD_ID, GlobalFileNames.historyItem), "utf8"),
		) as HistoryItem
		expect(persistedChild.status).toBe("active")

		// The skip log proves the tick ran delegation reconciliation and the
		// liveness guard protected the other window's child.
		expect(logSpy).toHaveBeenCalledWith(expect.stringContaining(`Skipping repair for live child ${CHILD_ID}`))

		logSpy.mockRestore()
	})

	it("logs and keeps re-arming when the periodic delegation step throws", async () => {
		const [parent, child] = makeDelegatedPair()
		await seedItems([parent, child])

		const internals = TaskHistoryStore.prototype as unknown as {
			runPeriodicDelegationReconciliation: () => Promise<void>
		}
		const throwingSpy = vi
			.spyOn(internals, "runPeriodicDelegationReconciliation")
			.mockRejectedValue(new Error("tick delegation boom"))
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

		const s = (store = new TaskHistoryStore(tmpDir))
		useTickClock()
		await s.initialize()

		await vi.advanceTimersByTimeAsync(RECONCILE_INTERVAL_MS)
		// The error log happens in the tick callback's catch AFTER the throwing
		// delegation step settles, so the spy firing means the tick is done.
		await flushUntil(
			() =>
				errorSpy.mock.calls.some(
					(c) => typeof c[0] === "string" && c[0].includes("Periodic delegation reconciliation failed"),
				),
			{
				label: "tick logged the delegation failure",
				snapshot: () => `errorCalls=${errorSpy.mock.calls.length}`,
			},
		)
		expect(errorSpy).toHaveBeenCalledWith(
			expect.stringContaining("Periodic delegation reconciliation failed"),
			expect.objectContaining({ message: "tick delegation boom" }),
		)

		// One more interval still fires the delegation step: the recursive
		// re-arm is preserved even though the step threw.
		await vi.advanceTimersByTimeAsync(RECONCILE_INTERVAL_MS)
		await flushUntil(() => throwingSpy.mock.calls.length >= 2, {
			label: "second tick invoked the throwing delegation step",
			snapshot: () => `throwingSpyCalls=${throwingSpy.mock.calls.length}`,
		})
		expect(throwingSpy).toHaveBeenCalledTimes(2)

		errorSpy.mockRestore()
		throwingSpy.mockRestore()
	})
})

// ─────────────────────────────────────────────────────────────────────────────
// Mutation-gate kill tests — focused coverage for the 15 surviving changed-code
// mutants reproduced locally against TaskHistoryStore.ts (PR #1495 mutation-diff
// gate). Each test names the exact mutant(s) it kills and asserts an observable
// behavioral difference so the mutant cannot survive.
// ─────────────────────────────────────────────────────────────────────────────

describe("TaskHistoryStore mutation-gate kill tests", () => {
	let tmpDir: string
	let store: TaskHistoryStore | undefined
	let mtimeSpy: { mockRestore(): void } | undefined

	const RECONCILE_INTERVAL_MS = (TaskHistoryStore as unknown as { RECONCILE_INTERVAL_MS: number })
		.RECONCILE_INTERVAL_MS

	function useTickClock(): void {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
	}

	// Condition-polling pump; see the full doc comment on the identical helper
	// in the "periodic delegation reconciliation" block above for the
	// rationale (the fixed 2000-yield pumps intermittently starved on slow
	// ubuntu CI runners).
	async function flushUntil(
		predicate: () => boolean,
		options: { maxYields?: number; label?: string; snapshot?: () => string } = {},
	): Promise<void> {
		const { maxYields = 50_000, label = "flushUntil predicate", snapshot } = options
		for (let i = 0; i < maxYields; i++) {
			if (predicate()) {
				return
			}
			await vi.advanceTimersByTimeAsync(1)
		}
		if (predicate()) {
			return
		}
		let state = "snapshot unavailable"
		try {
			state = snapshot ? snapshot() : "no snapshot supplied"
		} catch {
			// A throwing snapshot must not mask the primary diagnostic below.
		}
		throw new Error(
			`flushUntil: "${label}" was not satisfied within ${maxYields} yields (~${maxYields} ms of fake ` +
				`time). The tick's async chain never settled; final state: ${state}.`,
		)
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

	/**
	 * Read the private `locallyActiveTaskIds` set — the exact piece of state every
	 * ownership-track mutant below (L278/L299/L324/L566/L569/L1181/L1188/L1189)
	 * mutates. Its documented consumer is the periodic tick's orphan-repair
	 * exclusion (TaskHistoryStore.ts line 1083), so asserting membership is a
	 * direct observable of the mutated behavior. Same private-member cast pattern
	 * as LIVE_CHILD_MTIME_THRESHOLD_MS at the top of this spec.
	 */
	function ownedIds(s: TaskHistoryStore): Set<string> {
		return (s as unknown as { locallyActiveTaskIds: Set<string> }).locallyActiveTaskIds
	}

	/** Inject a stale mtime for `childId` so the liveness guard sees a crash orphan. */
	function installStaleChildInjector(childId: string): void {
		const probe = TaskHistoryStore.prototype as unknown as {
			getChildFileMtimeMs: (id: string) => Promise<number | undefined>
		}
		const original = probe.getChildFileMtimeMs
		mtimeSpy = vi
			.spyOn(probe, "getChildFileMtimeMs")
			.mockImplementation((id: string) =>
				id === childId ? Promise.resolve(Date.now() - 10 * 60 * 1000) : original.call(store!, id),
			)
	}

	function delegatedPair(parentId: string, childId: string): HistoryItem[] {
		const child = makeItem({ id: childId, status: "active", parentTaskId: parentId, rootTaskId: parentId })
		const parent = makeItem({
			id: parentId,
			status: "delegated",
			awaitingChildId: childId,
			delegatedToId: childId,
			childIds: [childId],
		})
		return [parent, child]
	}

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mutkill-test-"))
	})

	afterEach(async () => {
		mtimeSpy?.mockRestore()
		mtimeSpy = undefined
		store?.dispose()
		store = undefined
		vi.useRealTimers()
		await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
	})

	it("repair writes (skipTransitionCheck) do NOT register local ownership (kills L278 ConditionalExpression)", async () => {
		// upsertCore: `if (!options.skipTransitionCheck) { trackLocalSessionOwnership(written) }`.
		// The "interrupted handoff" repair path (reconcileDelegationStateCore) sets the parent to
		// ACTIVE via upsertCore(..., { skipTransitionCheck: true }). Replacing `!options.skipTransitionCheck`
		// with `true` would ALSO run trackLocalSessionOwnership(written) for that repair write, and
		// because written.status === "active" the parent would be ADDED to locallyActiveTaskIds.
		// Assert the repaired parent is NOT in the ownership set: present under the mutant, absent
		// under correct code.
		const child = makeItem({
			id: "child-l278",
			status: "completed",
			completionResultSummary: "done",
			parentTaskId: "parent-l278",
			rootTaskId: "parent-l278",
		})
		const parent = makeItem({
			id: "parent-l278",
			status: "delegated",
			awaitingChildId: child.id,
			delegatedToId: child.id,
		})
		await seedItems([parent, child])

		const s = (store = new TaskHistoryStore(tmpDir))
		await s.initialize()

		// The completed-child handoff repaired the parent to active via skipTransitionCheck.
		expect(s.get(parent.id)?.status).toBe("active")
		expect(s.get(parent.id)?.awaitingChildId).toBeUndefined()
		// Under L278->true the active repair write adds parent.id to this set; correct code does not.
		expect(ownedIds(s).has(parent.id)).toBe(false)
	})

	it("non-active runtime write DELETES local ownership (kills L566 Conditional->true / LogicalOperator / StringLiteral, L569 CallExpression)", async () => {
		// trackLocalSessionOwnership: `if ((written.status ?? "active") === "active") add else delete`.
		// Observable under test: after an active runtime write registers ownership, a later NON-active
		// runtime write must remove it (the else/`delete(id)` branch). If the mutant forces the add
		// branch (L566 ->true) or drops the delete (L569 `;`), the task stays owned and the periodic
		// tick will NOT repair it as a crash orphan.
		//
		// Sequence on ONE task id `orphan`:
		//   1. runtime `active` write   -> ownership ADDED.
		//   2. runtime `completed` write (valid active->completed) -> ownership DELETED.
		//   3. seed disk so the SAME id is again an active child of a delegated parent (crash orphan)
		//      and reload the store — the only ownership signal is from step 1/2 runtime writes.
		//   4. tick: with ownership deleted, the orphan is repaired (interrupted). Under either mutant
		//      it stays owned -> stays active.
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		const childId = "orphan-l566"
		const parentId = "parent-l566"

		const s = (store = new TaskHistoryStore(tmpDir))
		useTickClock()
		await s.initialize()

		// Steps 1+2: register then delete ownership via valid runtime transitions.
		await s.upsert(makeItem({ id: childId, status: "active", parentTaskId: parentId, rootTaskId: parentId }))
		await s.atomicReadAndUpdate(childId, (c) => ({ ...c, status: "completed" as const }))
		expect(s.get(childId)?.status).toBe("completed")
		s.dispose()

		// Step 3: rewrite disk so the same child id is once more an ACTIVE orphan of a delegated
		// parent (as if another window crashed mid-delegation), then reload into a fresh store.
		const [parent, child] = delegatedPair(parentId, childId)
		await seedItems([parent, child])
		const s2 = (store = new TaskHistoryStore(tmpDir))
		useTickClock()

		// Startup reconciliation must NOT repair it yet: make the mtime look live at startup, then
		// stale only for the tick.
		let age = 60_000
		const probe = TaskHistoryStore.prototype as unknown as {
			getChildFileMtimeMs: (id: string) => Promise<number | undefined>
		}
		mtimeSpy = vi
			.spyOn(probe, "getChildFileMtimeMs")
			.mockImplementation((id: string) =>
				id === childId ? Promise.resolve(Date.now() - age) : Promise.resolve(undefined),
			)

		await s2.initialize()
		expect(s2.get(childId)?.status).toBe("active")

		// Step 4: tick with a now-stale mtime.
		age = 10 * 60 * 1000
		await vi.advanceTimersByTimeAsync(RECONCILE_INTERVAL_MS)
		await flushUntil(() => s2.get(childId)?.status === "interrupted", {
			label: "completed write released ownership so the tick repaired the orphan",
			snapshot: () => `child=${s2.get(childId)?.status} parent=${s2.get(parentId)?.status}`,
		})

		// Ownership was deleted by the completed write, so the orphan is repaired.
		// (Under L566->true or L569 `;` it would remain owned and stay active.)
		expect(s2.get(childId)?.status).toBe("interrupted")
		expect(errorSpy).not.toHaveBeenCalled()
		errorSpy.mockRestore()
	})

	it("non-active runtime write removes the id from locallyActiveTaskIds (kills L566 Conditional->true / LogicalOperator, L569 CallExpression)", async () => {
		// Direct set assertion for the else/`delete(id)` branch of trackLocalSessionOwnership.
		// After an active runtime write the id is present; after a completed runtime write it must
		// be removed. Under L566->true (forced add branch) or L569 `;` (delete dropped), the id
		// would still be present after the completed write.
		const s = (store = new TaskHistoryStore(tmpDir))
		await s.initialize()
		await s.upsert(makeItem({ id: "own-add", status: "active" }))
		expect(ownedIds(s).has("own-add")).toBe(true)

		// Valid active -> completed transition exercises the else branch (delete).
		await s.upsert(makeItem({ id: "own-add", status: "completed" }))
		expect(ownedIds(s).has("own-add")).toBe(false)
	})

	it("active runtime write adds the id to locallyActiveTaskIds (kills L566 Conditional->true add-branch, LogicalOperator)", async () => {
		// Complement: the add branch must actually insert. Under L566 LogicalOperator mutants
		// (e.g. `written.status && "active"`), an explicit "active" status short-circuits to a
		// truthy-but-not-"active" value, so `=== "active"` is false and the add is skipped.
		const s = (store = new TaskHistoryStore(tmpDir))
		await s.initialize()
		await s.upsert(makeItem({ id: "add-explicit", status: "active" }))
		expect(ownedIds(s).has("add-explicit")).toBe(true)
	})

	it('undefined status is treated as implicit active and registers ownership (kills L566 StringLiteral->"")', async () => {
		// `(written.status ?? "active") === "active"`: StringLiteral->"" makes undefined status fall
		// to "" !== "active" -> delete branch. A runtime write with NO status field must still count
		// as implicit active and register ownership, so the tick leaves this in-window child alone.
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		const childId = "child-l566-undef"
		const parentId = "parent-l566-undef"
		const [parent, child] = delegatedPair(parentId, childId)
		await seedItems([parent, child])

		const s = (store = new TaskHistoryStore(tmpDir))
		useTickClock()
		await s.initialize()
		await s.upsert(makeItem({ id: parentId, status: "active" }))
		// Runtime write with status omitted entirely (legacy implicit active).
		const noStatus = makeItem({ id: childId, parentTaskId: parentId, rootTaskId: parentId })
		delete (noStatus as Partial<HistoryItem>).status
		await s.upsert(noStatus)
		// Delegate the pair; the child must remain owned HERE because its write was implicit-active.
		await s.atomicReadAndUpdate(parentId, (c) => ({
			...c,
			status: "delegated" as const,
			awaitingChildId: childId,
			delegatedToId: childId,
		}))
		await s.atomicReadAndUpdate(childId, (c) => ({ ...c, status: "active" as const }))

		installStaleChildInjector(childId)
		// Negative test (child owned HERE via the implicit-active write): the
		// tick must leave it alone, so settle on the recursive re-arm, which
		// only happens after both passes fully finish.
		const timerState = s as unknown as { reconcileTimer: ReturnType<typeof setTimeout> | null }
		const timerBeforeTick = timerState.reconcileTimer
		await vi.advanceTimersByTimeAsync(RECONCILE_INTERVAL_MS)
		await flushUntil(() => timerState.reconcileTimer !== timerBeforeTick, {
			label: "tick completed without clobbering the locally-owned implicit-active child",
			snapshot: () => `child=${s.get(childId)?.status} parent=${s.get(parentId)?.status}`,
		})

		// Owned here (implicit active) -> the tick must NOT tear it away from its own runner.
		expect(s.get(childId)?.status).toBe("active")
		expect(s.get(parentId)?.status).toBe("delegated")
		expect(errorSpy).not.toHaveBeenCalled()
		errorSpy.mockRestore()
	})

	it('undefined status is treated as implicit active and adds the id to locallyActiveTaskIds (kills L566 StringLiteral->"")', async () => {
		// `(written.status ?? "active") === "active"`: StringLiteral->"" makes an undefined status
		// fall to `"" !== "active"` -> delete branch, so the id is never added. A runtime write with
		// NO status field must count as implicit active and register ownership. Assert membership.
		const s = (store = new TaskHistoryStore(tmpDir))
		await s.initialize()
		const noStatus = makeItem({ id: "undef-status" })
		delete (noStatus as Partial<HistoryItem>).status
		await s.upsert(noStatus)
		// Under L566 StringLiteral->"" this stays absent; correct code adds it.
		expect(ownedIds(s).has("undef-status")).toBe(true)
	})

	it("delete() removes the id from locallyActiveTaskIds (kills L299 CallExpression)", async () => {
		// delete(): the `locallyActiveTaskIds.delete(taskId)` statement is the CallExpression the
		// mutant drops (`;`). Register ownership via an active runtime write, then delete the task
		// and assert the id is gone from the ownership set — under the mutant it would remain.
		const s = (store = new TaskHistoryStore(tmpDir))
		await s.initialize()
		await s.upsert(makeItem({ id: "del-l299", status: "active" }))
		expect(ownedIds(s).has("del-l299")).toBe(true)

		await s.delete("del-l299")
		expect(s.get("del-l299")).toBeUndefined()
		expect(ownedIds(s).has("del-l299")).toBe(false)
	})

	it("deleteMany() removes every deleted id from locallyActiveTaskIds (kills L324 CallExpression)", async () => {
		// deleteMany(): the per-task `locallyActiveTaskIds.delete(taskId)` is the CallExpression the
		// mutant drops. Own two tasks, delete both, and assert neither remains in the ownership set.
		const s = (store = new TaskHistoryStore(tmpDir))
		await s.initialize()
		await s.upsert(makeItem({ id: "dm-1", status: "active" }))
		await s.upsert(makeItem({ id: "dm-2", status: "active" }))
		await s.upsert(makeItem({ id: "dm-3", status: "active" }))
		expect(ownedIds(s).has("dm-1")).toBe(true)
		expect(ownedIds(s).has("dm-3")).toBe(true)

		await s.deleteMany(["dm-1", "dm-3"])
		expect(s.get("dm-1")).toBeUndefined()
		expect(s.get("dm-3")).toBeUndefined()
		expect(ownedIds(s).has("dm-1")).toBe(false)
		expect(ownedIds(s).has("dm-3")).toBe(false)
		// Untouched task keeps its ownership.
		expect(ownedIds(s).has("dm-2")).toBe(true)
	})

	it("replay liveness guard treats child file age exactly at threshold as NOT live and repairs (kills L627 EqualityOperator '<'->'<=')", async () => {
		// replayDelegationRepairIntent: `Date.now() - mtimeMs < LIVE_CHILD_MTIME_THRESHOLD_MS`.
		// Under `<=`, age === threshold counts as live and the stale intent is quarantined. With the
		// real strict `<`, age === threshold is NOT live, so the crash-orphan intent is replayed:
		// child -> interrupted, parent -> active. Assert the replay happens at exactly threshold.
		const FIXED_NOW = 1_756_886_400_000
		const nowSpy = vi.spyOn(Date, "now").mockReturnValue(FIXED_NOW)
		try {
			const child = makeItem({
				id: "child-l627",
				status: "active",
				parentTaskId: "parent-l627",
				rootTaskId: "parent-l627",
			})
			const parent = makeItem({
				id: "parent-l627",
				status: "delegated",
				awaitingChildId: child.id,
				delegatedToId: child.id,
			})
			await seedItems([parent, child])
			const tasksDir = path.join(tmpDir, "tasks")
			const intentPath = path.join(tasksDir, GlobalFileNames.delegationRepairIntent)
			await fs.writeFile(intentPath, JSON.stringify(makeRepairIntent(parent, child)))

			// Isolate the REPLAY guard's decision from the later startup reconcile (step 3 of
			// initialize). The replay runs first and reads getChildFileMtimeMs once; make that first
			// call return age EXACTLY == threshold, then make every subsequent call (the step-3
			// startup reconcile's own liveness probe) return a RECENT age so step 3 treats the child
			// as live and does NOT repair it. The child's final status then reflects ONLY the replay
			// guard at line 627: strict '<' (correct) -> threshold age is NOT live -> replay repairs
			// (child interrupted); '<=' (mutant) -> live -> quarantine (child stays active).
			let probeCalls = 0
			const probe = TaskHistoryStore.prototype as unknown as {
				getChildFileMtimeMs: (id: string) => Promise<number | undefined>
			}
			mtimeSpy = vi.spyOn(probe, "getChildFileMtimeMs").mockImplementation((id: string) => {
				if (id !== child.id) return Promise.resolve(undefined)
				probeCalls++
				// First call = the replayDelegationRepairIntent guard (line 627): exactly threshold.
				// Later calls = the startup reconcile guard (line 506): recent -> child stays live.
				return Promise.resolve(probeCalls === 1 ? FIXED_NOW - LIVE_CHILD_MTIME_THRESHOLD_MS : FIXED_NOW - 1_000)
			})

			const s = (store = new TaskHistoryStore(tmpDir))
			await s.initialize()

			// Strict '<': threshold age is NOT live -> the intent replays (child interrupted).
			// Under '<=': the intent would be quarantined and the child would stay active (step 3
			// sees the child as live and leaves it alone).
			expect(s.get(child.id)?.status).toBe("interrupted")
			expect(s.get(parent.id)?.status).toBe("active")
		} finally {
			nowSpy.mockRestore()
		}
	})

	it("runPeriodicDelegationReconciliation does not run the pass when disposed (kills L1077 Conditional->false / LogicalOperator)", async () => {
		// `if (this.disposed || this.delegationTickRunning) return`. Conditional->false forces the
		// guard OFF so the pass runs even after dispose(); LogicalOperator->&& makes it run only
		// when disposed AND already-running (also wrong). The observable is whether the method
		// reaches reconcileDelegationState. Assert that after dispose() the pass body does NOT run.
		const s = (store = new TaskHistoryStore(tmpDir))
		await s.initialize()
		s.dispose()

		const internals = TaskHistoryStore.prototype as unknown as {
			runPeriodicDelegationReconciliation: () => Promise<void>
		}
		// Hook reconcileDelegationState to detect whether the guarded body executes.
		const reconProbe = s as unknown as { reconcileDelegationState: (ids: Set<string>) => Promise<void> }
		let passRan = false
		reconProbe.reconcileDelegationState = async () => {
			passRan = true
		}

		await internals.runPeriodicDelegationReconciliation.call(s)
		// Guard fired (disposed) -> the pass body never ran. Under L1077->false it would run.
		expect(passRan).toBe(false)
	})

	it("runPeriodicDelegationReconciliation runs the pass when NOT disposed and NOT already running (kills L1077 LogicalOperator->&&)", async () => {
		// Complement: with disposed=false and delegationTickRunning=false the guard must NOT fire,
		// so the pass runs. Under LogicalOperator->&& the condition `disposed && tickRunning` is
		// false here too... but Conditional->true (always skip) would suppress the run. Assert the
		// pass executes in the normal case, pinning the guard's truth table from the other side.
		const s = (store = new TaskHistoryStore(tmpDir))
		await s.initialize()

		const internals = TaskHistoryStore.prototype as unknown as {
			runPeriodicDelegationReconciliation: () => Promise<void>
		}
		const reconProbe = s as unknown as { reconcileDelegationState: (ids: Set<string>) => Promise<void> }
		let passRan = false
		reconProbe.reconcileDelegationState = async () => {
			passRan = true
		}

		await internals.runPeriodicDelegationReconciliation.call(s)
		expect(passRan).toBe(true)
	})

	it("runPeriodicDelegationReconciliation sets then clears delegationTickRunning around the pass (kills L1080 BooleanLiteral->false, L1087 BooleanLiteral->true)", async () => {
		// L1080 sets the flag true before the pass; L1087 clears it false in `finally`.
		// - L1080->false: a concurrent second call would NOT see the flag set and would run twice.
		// - L1087->true: after completion the flag stays set, so every subsequent call no-ops.
		const [parent, child] = delegatedPair("parent-flag", "child-flag")
		await seedItems([parent, child])
		const s = (store = new TaskHistoryStore(tmpDir))
		installStaleChildInjector(child.id)
		await s.initialize()

		const internals = TaskHistoryStore.prototype as unknown as {
			runPeriodicDelegationReconciliation: () => Promise<void>
		}
		const flagReader = s as unknown as { delegationTickRunning: boolean }

		// Observe the flag being true DURING the pass via a hook into reconcileDelegationState.
		const reconProbe = s as unknown as { reconcileDelegationState: (ids: Set<string>) => Promise<void> }
		const originalRecon = reconProbe.reconcileDelegationState.bind(s)
		let flagDuringPass: boolean | undefined
		reconProbe.reconcileDelegationState = async (ids: Set<string>) => {
			flagDuringPass = flagReader.delegationTickRunning
			return originalRecon(ids)
		}

		await internals.runPeriodicDelegationReconciliation.call(s)
		// Flag was true while the pass ran (kills L1080->false).
		expect(flagDuringPass).toBe(true)
		// Flag cleared after the pass completed (kills L1087->true).
		expect(flagReader.delegationTickRunning).toBe(false)

		// A second call runs again (proves the flag was actually reset, not stuck).
		let secondRan = false
		reconProbe.reconcileDelegationState = async (ids: Set<string>) => {
			secondRan = true
			return originalRecon(ids)
		}
		await internals.runPeriodicDelegationReconciliation.call(s)
		expect(secondRan).toBe(true)
	})

	it("atomicUpdatePair registers ownership for both records on success (kills L1188/L1189 CallExpression)", async () => {
		// The success path calls trackLocalSessionOwnership(writtenFirst) and (writtenSecond). The
		// CallExpression `;` mutants drop those calls, so the ids never enter locallyActiveTaskIds.
		// Assert both ids are present after a pair write that leaves both active.
		const s = (store = new TaskHistoryStore(tmpDir))
		await s.initialize()
		await s.upsert(makeItem({ id: "pf-first", status: "active" }))
		await s.upsert(makeItem({ id: "pf-second", status: "active" }))
		// Clear prior ownership so only the atomicUpdatePair calls can re-add them.
		ownedIds(s).clear()
		expect(ownedIds(s).size).toBe(0)

		await s.atomicUpdatePair(
			"pf-first",
			"pf-second",
			(c) => ({ ...c, status: "active" as const }),
			(c) => ({ ...c, status: "active" as const }),
		)

		// Under L1188/L1189 `;` the trackLocalSessionOwnership calls vanish and these stay absent.
		expect(ownedIds(s).has("pf-first")).toBe(true)
		expect(ownedIds(s).has("pf-second")).toBe(true)
	})

	it("atomicUpdatePair registers ownership for the committed first record on partial failure (kills L1181 CallExpression)", async () => {
		// On second-write failure the catch block updates the cache AND calls
		// trackLocalSessionOwnership(writtenFirst) before rethrowing. The `;` mutant drops that call,
		// so the committed first record never enters locallyActiveTaskIds. Force the SECOND
		// writeTaskFile to fail, then assert the first record IS in the ownership set (under the
		// mutant it stays absent).
		const s = (store = new TaskHistoryStore(tmpDir))
		await s.initialize()
		await s.upsert(makeItem({ id: "pf-first", status: "active" }))
		await s.upsert(makeItem({ id: "pf-second", status: "active" }))
		ownedIds(s).clear()

		// Spy writeTaskFile: succeed for the first record, reject for the second, so the catch
		// path (which contains L1181) runs.
		const storeAny = s as unknown as { writeTaskFile: (item: HistoryItem, delta?: unknown) => Promise<HistoryItem> }
		const originalWrite = storeAny.writeTaskFile.bind(s)
		const writeSpy = vi
			.spyOn(storeAny, "writeTaskFile")
			.mockImplementation(async (item: HistoryItem, delta?: unknown) => {
				if (item.id === "pf-second") {
					throw new Error("simulated second-write failure")
				}
				return originalWrite(item, delta)
			})

		await expect(
			s.atomicUpdatePair(
				"pf-first",
				"pf-second",
				(c) => ({ ...c, status: "active" as const }),
				(c) => ({ ...c, status: "active" as const }),
			),
		).rejects.toThrow("simulated second-write failure")

		// The catch block committed pf-first to disk and must have registered its ownership.
		// Under L1181 `;` that call vanishes and pf-first stays absent.
		expect(ownedIds(s).has("pf-first")).toBe(true)
		writeSpy.mockRestore()
	})
})
