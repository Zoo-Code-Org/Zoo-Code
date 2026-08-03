import type * as vscode from "vscode"

import type { HistoryItem, UsageEventV1 } from "@roo-code/types"

import {
	computeTaskDetail,
	computeTaskPage,
	computeTaskSummaries,
	type DashboardTaskUsageReader,
} from "../DashboardTaskProjection"
import { DashboardTaskCatalog, type DashboardTaskCatalogSource } from "../DashboardTaskCatalog"
import { isWithinStatsQueryRange, type StatsQueryRangeMs } from "../statsQueryRange"
import type { TaskUsageRow } from "../UsageStatsDatabase"

vi.mock("vscode", () => {
	class EventEmitter<T> {
		public readonly event = () => ({ dispose: () => {} })
		dispose(): void {}
	}

	return { EventEmitter }
})

function makeHistoryItem(overrides: Partial<HistoryItem> = {}): HistoryItem {
	return {
		id: "task",
		number: 1,
		ts: 1_000,
		task: "Task title",
		tokensIn: 0,
		tokensOut: 0,
		totalCost: 0,
		...overrides,
	}
}

function createCatalog(items: HistoryItem[]): DashboardTaskCatalog {
	const source: DashboardTaskCatalogSource = {
		getAll: () => items,
		onDidChange: (() => ({ dispose: () => {} })) as vscode.Event<void>,
	}
	return new DashboardTaskCatalog(source)
}

function makeUsageRow(overrides: Partial<TaskUsageRow> = {}): TaskUsageRow {
	return {
		taskId: "task",
		totalCost: 0,
		totalTokens: 0,
		eventCount: 0,
		lastActivity: 0,
		model: "",
		provider: "",
		...overrides,
	}
}

function makeEvent(overrides: Partial<UsageEventV1> = {}): UsageEventV1 {
	return {
		schemaVersion: 1,
		eventId: "event",
		idempotencyKey: "idempotency-key",
		occurredAt: "2026-08-03T00:00:00.000Z",
		timezoneOffsetMinutes: 0,
		status: "completed",
		attempt: 1,
		taskId: "task",
		provider: "anthropic",
		model: "claude-sonnet",
		mode: "code",
		usage: {
			inputTokens: { value: 10, source: "provider" },
			outputTokens: { value: 5, source: "provider" },
			costUsd: { value: 0.01, source: "provider" },
		},
		semantics: {
			cacheReadInInput: "excluded",
			cacheWriteInInput: "excluded",
			reasoningInOutput: "excluded",
		},
		provenance: "live",
		...overrides,
	}
}

function createUsageReader(
	usageByTaskId: Map<string, TaskUsageRow> = new Map(),
	events: Array<UsageEventV1 & { sequence: number }> = [],
): DashboardTaskUsageReader & {
	queriedUsageTaskIds: string[][]
	queriedEventTaskIds: string[][]
	queriedUsageRanges: Array<StatsQueryRangeMs | undefined>
	queriedEventRanges: Array<StatsQueryRangeMs | undefined>
} {
	const queriedUsageTaskIds: string[][] = []
	const queriedEventTaskIds: string[][] = []
	const queriedUsageRanges: Array<StatsQueryRangeMs | undefined> = []
	const queriedEventRanges: Array<StatsQueryRangeMs | undefined> = []
	return {
		queriedUsageTaskIds,
		queriedEventTaskIds,
		queriedUsageRanges,
		queriedEventRanges,
		queryTaskUsageByTaskIds(taskIds, rangeMs) {
			queriedUsageTaskIds.push(taskIds)
			queriedUsageRanges.push(rangeMs)
			return new Map(taskIds.map((taskId) => [taskId, usageByTaskId.get(taskId) ?? makeUsageRow({ taskId })]))
		},
		queryEventsByTaskIds(taskIds, rangeMs) {
			queriedEventTaskIds.push(taskIds)
			queriedEventRanges.push(rangeMs)
			return events.filter(
				(event) =>
					taskIds.includes(event.taskId) &&
					isWithinStatsQueryRange(rangeMs, new Date(event.occurredAt).getTime()),
			)
		},
	}
}

describe("DashboardTaskProjection", () => {
	it("pages History tasks first, batch-loads the page subtrees, and excludes usage-only IDs", () => {
		const catalog = createCatalog([
			makeHistoryItem({ id: "newest", ts: 300, task: "Newest" }),
			makeHistoryItem({ id: "older", ts: 200, task: "Older" }),
		])
		const reader = createUsageReader(
			new Map([
				["newest", makeUsageRow({ taskId: "newest", totalTokens: 20, eventCount: 1 })],
				["usage-only", makeUsageRow({ taskId: "usage-only", totalTokens: 999, eventCount: 9 })],
			]),
		)

		const page = computeTaskPage(catalog, reader, "request-1", undefined, 1)

		expect(page.tasks.map((task) => task.taskId)).toEqual(["newest"])
		expect(page.totalEstimate).toBe(2)
		expect(page.cursor).toBeDefined()
		expect(reader.queriedUsageTaskIds).toEqual([["newest"]])
		catalog.dispose()
	})

	it("left-joins zero usage onto every catalog task instead of omitting it", () => {
		const catalog = createCatalog([makeHistoryItem({ id: "unused", ts: 100, task: "No API usage" })])
		const reader = createUsageReader()

		const page = computeTaskPage(catalog, reader, "request-2")

		expect(page.tasks).toEqual([
			expect.objectContaining({
				taskId: "unused",
				title: "No API usage",
				taskTimestamp: 100,
				totalCost: 0,
				totalTokens: 0,
				eventCount: 0,
				model: "",
				provider: "",
				lastUsageAt: undefined,
			}),
		])
		catalog.dispose()
	})

	it("sums root, child, and grandchild subtrees and takes metadata from the latest usage", () => {
		const catalog = createCatalog([
			makeHistoryItem({ id: "root", ts: 300, task: "Root" }),
			makeHistoryItem({ id: "child", ts: 200, task: "Child", parentTaskId: "root" }),
			makeHistoryItem({ id: "grandchild", ts: 100, task: "Grandchild", parentTaskId: "child" }),
		])
		const reader = createUsageReader(
			new Map([
				[
					"root",
					makeUsageRow({
						taskId: "root",
						totalCost: 0.1,
						totalTokens: 10,
						eventCount: 1,
						lastActivity: 100,
						model: "root-model",
						provider: "root-provider",
					}),
				],
				[
					"child",
					makeUsageRow({
						taskId: "child",
						totalCost: 0.2,
						totalTokens: 20,
						eventCount: 2,
						lastActivity: 200,
						model: "child-model",
						provider: "child-provider",
					}),
				],
				[
					"grandchild",
					makeUsageRow({
						taskId: "grandchild",
						totalCost: 0.3,
						totalTokens: 30,
						eventCount: 3,
						lastActivity: 300,
						model: "latest-model",
						provider: "latest-provider",
					}),
				],
			]),
		)

		const page = computeTaskPage(catalog, reader, "request-3")
		const summaries = new Map(page.tasks.map((task) => [task.taskId, task]))

		const root = summaries.get("root")!
		const child = summaries.get("child")!
		const grandchild = summaries.get("grandchild")!
		expect(root.totalCost).toBeCloseTo(0.6)
		expect(root).toMatchObject({
			totalTokens: 60,
			eventCount: 6,
			lastUsageAt: 300,
			model: "latest-model",
			provider: "latest-provider",
		})
		expect(child.totalCost).toBeCloseTo(0.5)
		expect(child).toMatchObject({ totalTokens: 50, eventCount: 5 })
		expect(grandchild.totalCost).toBeCloseTo(0.3)
		expect(grandchild).toMatchObject({ totalTokens: 30, eventCount: 3 })
		catalog.dispose()
	})

	it("returns successful zero-usage detail from History metadata without querying all events", () => {
		const catalog = createCatalog([makeHistoryItem({ id: "unused", ts: 1234, task: "No calls yet" })])
		const reader = createUsageReader()

		const detail = computeTaskDetail(catalog, reader, "unused", "request-4")

		expect(detail).toEqual({
			taskId: "unused",
			title: "No calls yet",
			taskTimestamp: 1234,
			models: [],
			modes: [],
			totalTokens: 0,
			totalCost: 0,
			callCount: 0,
			apiCalls: [],
		})
		expect(reader.queriedEventTaskIds).toEqual([["unused"]])
		catalog.dispose()
	})

	it("reads detail only for the selected subtree and keeps API calls in sequence order", () => {
		const catalog = createCatalog([
			makeHistoryItem({ id: "root", ts: 300, task: "Root" }),
			makeHistoryItem({ id: "child", ts: 200, task: "Child", parentTaskId: "root" }),
			makeHistoryItem({ id: "other", ts: 100, task: "Other" }),
		])
		const reader = createUsageReader(new Map(), [
			{ ...makeEvent({ taskId: "child", model: "child-model", mode: "ask" }), sequence: 2 },
			{ ...makeEvent({ taskId: "root", model: "root-model", mode: "code" }), sequence: 1 },
			{ ...makeEvent({ taskId: "other" }), sequence: 3 },
		])

		const detail = computeTaskDetail(catalog, reader, "root", "request-5")

		expect(reader.queriedEventTaskIds).toEqual([["root", "child"]])
		expect(detail.callCount).toBe(2)
		expect(detail.totalTokens).toBe(30)
		expect(detail.totalCost).toBeCloseTo(0.02)
		expect(detail.models).toEqual(["root-model", "child-model"])
		expect(detail.modes).toEqual(["code", "ask"])
		expect(detail.apiCalls.map((call) => call.model)).toEqual(["root-model", "child-model"])
		catalog.dispose()
	})

	it("pages only tasks created within the range and threads the range to usage reads", () => {
		const catalog = createCatalog([
			makeHistoryItem({ id: "in-range", ts: 200, task: "In range" }),
			makeHistoryItem({ id: "out-of-range", ts: 50, task: "Out of range" }),
		])
		const reader = createUsageReader(
			new Map([["in-range", makeUsageRow({ taskId: "in-range", totalTokens: 42, eventCount: 2 })]]),
		)
		const rangeMs = { fromMs: 100, toMs: 300 }

		const page = computeTaskPage(catalog, reader, "request-6", undefined, 50, rangeMs)

		expect(page.tasks.map((task) => task.taskId)).toEqual(["in-range"])
		expect(page.totalEstimate).toBe(1)
		expect(page.tasks[0]).toMatchObject({ totalTokens: 42, eventCount: 2 })
		expect(reader.queriedUsageRanges).toEqual([rangeMs])
		catalog.dispose()
	})

	it("drops summaries for tasks created outside the range while keeping unbounded behavior", () => {
		const catalog = createCatalog([
			makeHistoryItem({ id: "in-range", ts: 200, task: "In range" }),
			makeHistoryItem({ id: "out-of-range", ts: 50, task: "Out of range" }),
		])
		const reader = createUsageReader()
		const rangeMs = { fromMs: 100, toMs: 300 }

		const ranged = computeTaskSummaries(catalog, reader, ["in-range", "out-of-range", "unknown"], rangeMs)
		expect(ranged.map((task) => task.taskId)).toEqual(["in-range"])
		expect(reader.queriedUsageRanges).toEqual([rangeMs])

		// Without a range, every catalog task keeps its summary.
		const unbounded = computeTaskSummaries(catalog, reader, ["in-range", "out-of-range", "unknown"])
		expect(unbounded.map((task) => task.taskId)).toEqual(["in-range", "out-of-range"])
		catalog.dispose()
	})

	it("filters task detail events to the range", () => {
		const catalog = createCatalog([
			makeHistoryItem({ id: "root", ts: 300, task: "Root" }),
			makeHistoryItem({ id: "child", ts: 200, task: "Child", parentTaskId: "root" }),
		])
		const reader = createUsageReader(new Map(), [
			{
				...makeEvent({ taskId: "root", model: "root-model", occurredAt: "2026-08-01T00:00:00.000Z" }),
				sequence: 1,
			},
			{
				...makeEvent({ taskId: "child", model: "child-model", occurredAt: "2026-07-01T00:00:00.000Z" }),
				sequence: 2,
			},
		])
		const rangeMs = {
			fromMs: Date.parse("2026-07-15T00:00:00.000Z"),
			toMs: Date.parse("2026-08-15T00:00:00.000Z"),
		}

		const detail = computeTaskDetail(catalog, reader, "root", "request-7", rangeMs)

		expect(reader.queriedEventRanges).toEqual([rangeMs])
		expect(detail.callCount).toBe(1)
		expect(detail.totalTokens).toBe(15)
		expect(detail.totalCost).toBeCloseTo(0.01)
		expect(detail.models).toEqual(["root-model"])
		expect(detail.apiCalls.map((call) => call.model)).toEqual(["root-model"])
		catalog.dispose()
	})
})
