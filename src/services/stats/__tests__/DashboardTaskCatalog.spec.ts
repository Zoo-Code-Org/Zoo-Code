import type * as vscode from "vscode"

import type { HistoryItem } from "@roo-code/types"

import { DashboardTaskCatalog, type DashboardTaskCatalogSource } from "../DashboardTaskCatalog"

vi.mock("vscode", () => {
	class EventEmitter<T> {
		private readonly listeners = new Set<(event: T) => unknown>()
		public readonly event = (listener: (event: T) => unknown) => {
			this.listeners.add(listener)
			return { dispose: () => this.listeners.delete(listener) }
		}
		fire(event: T): void {
			for (const listener of this.listeners) {
				listener(event)
			}
		}
		dispose(): void {
			this.listeners.clear()
		}
	}

	return { EventEmitter }
})

function makeHistoryItem(overrides: Partial<HistoryItem> = {}): HistoryItem {
	return {
		id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
		number: 1,
		ts: Date.now(),
		task: "Test task",
		tokensIn: 100,
		tokensOut: 50,
		totalCost: 0.01,
		...overrides,
	}
}

function createCatalogSource(initialItems: HistoryItem[]): {
	source: DashboardTaskCatalogSource
	replace(items: HistoryItem[]): void
	emitChange(): void
} {
	let items = initialItems
	const listeners = new Set<() => void>()
	const onDidChange = ((listener: () => void) => {
		listeners.add(listener)
		return { dispose: () => listeners.delete(listener) }
	}) as vscode.Event<void>

	return {
		source: { getAll: () => items, onDidChange },
		replace(nextItems: HistoryItem[]) {
			items = nextItems
		},
		emitChange() {
			for (const listener of listeners) {
				listener()
			}
		},
	}
}

describe("DashboardTaskCatalog", () => {
	afterEach(() => {
		vi.useRealTimers()
		vi.restoreAllMocks()
	})

	it("orders all valid tasks by timestamp descending then ID descending without workspace filtering", () => {
		const source = createCatalogSource([
			makeHistoryItem({ id: "same-a", ts: 200, workspace: "/workspace-a" }),
			makeHistoryItem({ id: "new", ts: 300, workspace: "/workspace-b" }),
			makeHistoryItem({ id: "same-z", ts: 200, workspace: "/workspace-c" }),
			makeHistoryItem({ id: "invalid-timestamp", ts: 0 }),
			makeHistoryItem({ id: "invalid-task", task: "" }),
		])
		const catalog = new DashboardTaskCatalog(source.source)

		expect(catalog.orderedTaskIds).toEqual(["new", "same-z", "same-a"])
		expect(Object.isFrozen(catalog.getSnapshot())).toBe(true)
		expect(catalog.byId.get("same-a")?.workspace).toBe("/workspace-a")

		catalog.dispose()
	})

	it("traverses compound cursors exactly when multiple tasks share a timestamp", () => {
		const source = createCatalogSource([
			makeHistoryItem({ id: "d", ts: 200 }),
			makeHistoryItem({ id: "c", ts: 200 }),
			makeHistoryItem({ id: "b", ts: 200 }),
			makeHistoryItem({ id: "a", ts: 100 }),
		])
		const catalog = new DashboardTaskCatalog(source.source)
		const traversed: string[] = []
		let cursor: string | undefined

		do {
			const page = catalog.getPage(cursor, 2)
			traversed.push(...page.tasks)
			cursor = page.cursor
		} while (cursor)

		expect(traversed).toEqual(["d", "c", "b", "a"])
		expect(new Set(traversed).size).toBe(4)

		catalog.dispose()
	})

	it("filters pages by creation timestamp within [fromMs, toMs) with cursor continuity", () => {
		const source = createCatalogSource([
			makeHistoryItem({ id: "ts-100", ts: 100 }),
			makeHistoryItem({ id: "ts-200", ts: 200 }),
			makeHistoryItem({ id: "ts-300", ts: 300 }),
			makeHistoryItem({ id: "ts-400", ts: 400 }),
			makeHistoryItem({ id: "ts-500", ts: 500 }),
			makeHistoryItem({ id: "ts-600", ts: 600 }),
		])
		const catalog = new DashboardTaskCatalog(source.source)
		// Half-open: ts 200 is included, ts 500 is excluded.
		const rangeMs = { fromMs: 200, toMs: 500 }
		const traversed: string[] = []
		let cursor: string | undefined
		let totalEstimate = -1

		do {
			const page = catalog.getPage(cursor, 2, rangeMs)
			traversed.push(...page.tasks)
			totalEstimate = page.totalEstimate
			cursor = page.cursor
		} while (cursor)

		expect(traversed).toEqual(["ts-400", "ts-300", "ts-200"])
		expect(new Set(traversed).size).toBe(3)
		expect(totalEstimate).toBe(3)

		catalog.dispose()
	})

	it("treats an absent or unbounded range as no filtering", () => {
		const source = createCatalogSource([
			makeHistoryItem({ id: "ts-100", ts: 100 }),
			makeHistoryItem({ id: "ts-200", ts: 200 }),
		])
		const catalog = new DashboardTaskCatalog(source.source)

		for (const rangeMs of [undefined, {}, { fromMs: undefined, toMs: undefined }]) {
			const page = catalog.getPage(undefined, 50, rangeMs)
			expect(page.tasks).toEqual(["ts-200", "ts-100"])
			expect(page.totalEstimate).toBe(2)
		}

		// One-sided bounds still filter.
		expect(catalog.getPage(undefined, 50, { fromMs: 150 }).tasks).toEqual(["ts-200"])
		expect(catalog.getPage(undefined, 50, { toMs: 150 }).tasks).toEqual(["ts-100"])

		catalog.dispose()
	})

	it("builds ancestor and lazy descendant indexes for roots, nested children, and orphans", () => {
		const source = createCatalogSource([
			makeHistoryItem({ id: "root", ts: 400 }),
			makeHistoryItem({ id: "child", ts: 300, parentTaskId: "root" }),
			makeHistoryItem({ id: "grandchild", ts: 200, parentTaskId: "child" }),
			makeHistoryItem({ id: "orphan", ts: 100, parentTaskId: "missing-parent" }),
		])
		const catalog = new DashboardTaskCatalog(source.source)

		expect(catalog.childrenByParentId.get("root")).toEqual(["child"])
		expect(catalog.childrenByParentId.get("child")).toEqual(["grandchild"])
		expect(catalog.ancestorsByTaskId.get("root")).toEqual([])
		expect(catalog.ancestorsByTaskId.get("grandchild")).toEqual(["child", "root"])
		expect(catalog.ancestorsByTaskId.get("orphan")).toEqual([])
		expect(catalog.getDescendantTaskIds("root")).toEqual(["child", "grandchild"])
		expect(catalog.getDescendantTaskIds("child")).toEqual(["grandchild"])
		expect(catalog.getDescendantTaskIds("orphan")).toEqual([])
		expect(catalog.descendantsByTaskId.get("root")).toEqual(["child", "grandchild"])

		catalog.dispose()
	})

	it("stops ancestor and descendant traversal on a parent cycle while keeping tasks visible", () => {
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {})
		const source = createCatalogSource([
			makeHistoryItem({ id: "a", ts: 200, parentTaskId: "b" }),
			makeHistoryItem({ id: "b", ts: 100, parentTaskId: "a" }),
		])
		const catalog = new DashboardTaskCatalog(source.source)

		expect(catalog.orderedTaskIds).toEqual(["a", "b"])
		expect(catalog.ancestorsByTaskId.get("a")).toEqual(["b"])
		expect(catalog.ancestorsByTaskId.get("b")).toEqual(["a"])
		expect(catalog.getDescendantTaskIds("a")).toEqual(["b"])
		expect(warning).toHaveBeenCalledWith(expect.stringContaining("DASHBOARD_TASK_CATALOG/createSnapshot/001"))

		catalog.dispose()
	})

	it("advances one revision for a burst of source mutations after the 300ms debounce", async () => {
		vi.useFakeTimers()
		const source = createCatalogSource([makeHistoryItem({ id: "initial", ts: 100 })])
		const catalog = new DashboardTaskCatalog(source.source)
		const initialRevision = catalog.catalogRevision

		source.replace([makeHistoryItem({ id: "latest", ts: 200 })])
		source.emitChange()
		source.emitChange()
		source.emitChange()
		await vi.advanceTimersByTimeAsync(299)
		expect(catalog.catalogRevision).toBe(initialRevision)

		await vi.advanceTimersByTimeAsync(1)
		expect(catalog.catalogRevision).toBe(initialRevision + 1)
		expect(catalog.orderedTaskIds).toEqual(["latest"])

		catalog.dispose()
	})

	it("returns an empty page for an empty store", () => {
		const source = createCatalogSource([])
		const catalog = new DashboardTaskCatalog(source.source)

		expect(catalog.getPage()).toEqual({ tasks: [], totalEstimate: 0 })

		catalog.dispose()
	})

	it("pages root tasks only, promoting orphans whose parent is absent", () => {
		const source = createCatalogSource([
			makeHistoryItem({ id: "root-b", ts: 500 }),
			makeHistoryItem({ id: "child-of-b", ts: 450, parentTaskId: "root-b" }),
			makeHistoryItem({ id: "root-a", ts: 400 }),
			makeHistoryItem({ id: "grandchild-of-b", ts: 350, parentTaskId: "child-of-b" }),
			makeHistoryItem({ id: "orphan", ts: 300, parentTaskId: "missing-parent" }),
		])
		const catalog = new DashboardTaskCatalog(source.source)

		expect(catalog.orderedRootTaskIds).toEqual(["root-b", "root-a", "orphan"])

		const page = catalog.getPage()
		expect(page.tasks).toEqual(["root-b", "root-a", "orphan"])
		expect(page.totalEstimate).toBe(3)

		catalog.dispose()
	})

	it("pages roots with cursor continuity when subtasks share the root ordering", () => {
		const source = createCatalogSource([
			makeHistoryItem({ id: "root-c", ts: 300 }),
			makeHistoryItem({ id: "child-c", ts: 250, parentTaskId: "root-c" }),
			makeHistoryItem({ id: "root-b", ts: 200 }),
			makeHistoryItem({ id: "child-b", ts: 150, parentTaskId: "root-b" }),
			makeHistoryItem({ id: "root-a", ts: 100 }),
		])
		const catalog = new DashboardTaskCatalog(source.source)
		const traversed: string[] = []
		let cursor: string | undefined

		do {
			const page = catalog.getPage(cursor, 2)
			traversed.push(...page.tasks)
			cursor = page.cursor
		} while (cursor)

		expect(traversed).toEqual(["root-c", "root-b", "root-a"])

		catalog.dispose()
	})

	it("includes a root in a bounded range when any descendant was created inside it", () => {
		const source = createCatalogSource([
			makeHistoryItem({ id: "old-root", ts: 100 }),
			makeHistoryItem({ id: "new-child", ts: 500, parentTaskId: "old-root" }),
			makeHistoryItem({ id: "new-grandchild", ts: 600, parentTaskId: "new-child" }),
			makeHistoryItem({ id: "out-root", ts: 50 }),
			makeHistoryItem({ id: "out-child", ts: 60, parentTaskId: "out-root" }),
			makeHistoryItem({ id: "in-root", ts: 400 }),
			makeHistoryItem({ id: "out-child-of-in-root", ts: 700, parentTaskId: "in-root" }),
		])
		const catalog = new DashboardTaskCatalog(source.source)
		const rangeMs = { fromMs: 300, toMs: 550 }

		const page = catalog.getPage(undefined, 50, rangeMs)
		// old-root: descendant new-child (500) in range -> included.
		// out-root: root (50) and child (60) both out of range -> excluded.
		// in-root: root (400) in range -> included even though its child is not.
		// new-grandchild (600) is out of range but is not a root anyway.
		expect(page.tasks).toEqual(["in-root", "old-root"])
		expect(page.totalEstimate).toBe(2)

		catalog.dispose()
	})
})
