import type * as vscode from "vscode"
import { providerIdentifiers } from "@roo-code/types"

import type { HistoryItem, UsageEventV1 } from "@roo-code/types"

import {
	computeTaskDetail,
	computeTaskPage,
	computeTaskSummaries,
	DashboardTaskProjectionError,
	type DashboardTaskUsageReader,
} from "../DashboardTaskProjection"
import { DashboardTaskCatalog, type DashboardTaskCatalogSource } from "../DashboardTaskCatalog"
import { isWithinStatsQueryRange, type StatsQueryRangeMs } from "../statsQueryRange"
import type { TaskIdentityAggregate, TaskUsageRow } from "../UsageStatsDatabase"

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
		provider: providerIdentifiers.anthropic,
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
	identityByTaskId: Map<string, TaskIdentityAggregate> = new Map(),
	inputTokensByTaskId: Array<{
		taskId: string
		provider: string
		model: string
		inputTokens: number
		outputTokens?: number
		cacheWriteTokens?: number
		cacheReadTokens?: number
	}> = [],
): DashboardTaskUsageReader & {
	queriedUsageTaskIds: string[][]
	queriedEventTaskIds: string[][]
	queriedIdentityTaskIds: string[][]
	queriedUsageRanges: Array<StatsQueryRangeMs | undefined>
	queriedEventRanges: Array<StatsQueryRangeMs | undefined>
	queriedIdentityRanges: Array<StatsQueryRangeMs | undefined>
} {
	const queriedUsageTaskIds: string[][] = []
	const queriedEventTaskIds: string[][] = []
	const queriedIdentityTaskIds: string[][] = []
	const queriedUsageRanges: Array<StatsQueryRangeMs | undefined> = []
	const queriedEventRanges: Array<StatsQueryRangeMs | undefined> = []
	const queriedIdentityRanges: Array<StatsQueryRangeMs | undefined> = []
	return {
		queriedUsageTaskIds,
		queriedEventTaskIds,
		queriedIdentityTaskIds,
		queriedUsageRanges,
		queriedEventRanges,
		queriedIdentityRanges,
		queryTaskUsageByTaskIds(taskIds, rangeMs) {
			queriedUsageTaskIds.push(taskIds)
			queriedUsageRanges.push(rangeMs)
			return new Map(taskIds.map((taskId) => [taskId, usageByTaskId.get(taskId) ?? makeUsageRow({ taskId })]))
		},
		queryTaskIdentityAggregates(taskIds, rangeMs) {
			queriedIdentityTaskIds.push(taskIds)
			queriedIdentityRanges.push(rangeMs)
			return new Map(
				taskIds.map((taskId) => [
					taskId,
					identityByTaskId.get(taskId) ?? { inputTokens: 0, outputTokens: 0, models: [], modes: [] },
				]),
			)
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
		queryInputTokensByTaskId() {
			return inputTokensByTaskId
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

		// Only the root is a page row; direct children ride along in childTasks.
		expect(page.tasks.map((task) => task.taskId)).toEqual(["root"])
		expect(page.childTasks?.map((task) => task.taskId)).toEqual(["child"])

		const root = page.tasks[0]!
		expect(root.childTaskIds).toEqual(["child"])
		expect(root.totalCost).toBeCloseTo(0.6)
		expect(root).toMatchObject({
			totalTokens: 60,
			eventCount: 6,
			lastUsageAt: 300,
			model: "latest-model",
			provider: "latest-provider",
		})

		const child = page.childTasks![0]!
		expect(child.parentTaskId).toBe("root")
		expect(child.childTaskIds).toEqual(["grandchild"])
		expect(child.totalCost).toBeCloseTo(0.5)
		expect(child).toMatchObject({ totalTokens: 50, eventCount: 5 })
		catalog.dispose()
	})

	it("discounts subtree totalCost by cacheRatio × Σ cacheDiscountBase", () => {
		const catalog = createCatalog([
			makeHistoryItem({ id: "root", ts: 300, task: "Root" }),
			makeHistoryItem({ id: "child", ts: 200, task: "Child", parentTaskId: "root" }),
		])
		const reader = createUsageReader(
			new Map([
				["root", makeUsageRow({ taskId: "root", totalCost: 0.1, cacheDiscountBase: 0.01, eventCount: 1 })],
				["child", makeUsageRow({ taskId: "child", totalCost: 0.2, cacheDiscountBase: 0.02, eventCount: 2 })],
			]),
		)

		// Subtree: total 0.3, base 0.03 → 0.3 − 0.5 × 0.03 = 0.285.
		const discounted = computeTaskPage(catalog, reader, "request-cdb", undefined, 50, undefined, 0.5)
		expect(discounted.tasks[0]!.totalCost).toBeCloseTo(0.285, 10)
		expect(discounted.childTasks![0]!.totalCost).toBeCloseTo(0.19, 10)

		// Ratio 1 → 0.3 − 0.03 = 0.27; no ratio → verbatim 0.3.
		const full = computeTaskPage(catalog, reader, "request-cdb", undefined, 50, undefined, 1)
		expect(full.tasks[0]!.totalCost).toBeCloseTo(0.27, 10)
		const verbatim = computeTaskPage(catalog, reader, "request-cdb")
		expect(verbatim.tasks[0]!.totalCost).toBeCloseTo(0.3, 10)
		catalog.dispose()
	})

	it("floors the discounted subtree totalCost at 0", () => {
		const catalog = createCatalog([makeHistoryItem({ id: "root", ts: 300, task: "Root" })])
		const reader = createUsageReader(
			new Map([
				["root", makeUsageRow({ taskId: "root", totalCost: 0.001, cacheDiscountBase: 0.01, eventCount: 1 })],
			]),
		)

		const page = computeTaskPage(catalog, reader, "request-cdb-floor", undefined, 50, undefined, 1)
		expect(page.tasks[0]!.totalCost).toBe(0)
		catalog.dispose()
	})

	it("keeps computeTaskDetail per-call cost invariant for reporting providers (cacheRead=0 is a true miss)", () => {
		// Bug 1 fix: anthropic is a reporting provider. Both events use anthropic.
		// evt-reported has cacheRead=300 (reported hit). evt-unreported has cacheRead=0
		// (true cache miss). Both keep verbatim cost — slider has no effect.
		const catalog = createCatalog([makeHistoryItem({ id: "root", ts: 300, task: "Root" })])
		const reader = createUsageReader(new Map(), [
			{
				...makeEvent({
					eventId: "evt-reported",
					taskId: "root",
					model: "claude-sonnet-4-20250514",
					usage: {
						inputTokens: { value: 1000, source: "provider" },
						outputTokens: { value: 500, source: "provider" },
						cacheReadTokens: { value: 300, source: "provider" },
						costUsd: { value: 0.01, source: "provider" },
					},
				}),
				sequence: 1,
			},
			{
				...makeEvent({
					eventId: "evt-unreported",
					taskId: "root",
					model: "claude-sonnet-4-20250514",
					usage: {
						inputTokens: { value: 1000, source: "provider" },
						outputTokens: { value: 500, source: "provider" },
						costUsd: { value: 0.01, source: "provider" },
					},
				}),
				sequence: 2,
			},
		])

		const detail = computeTaskDetail(catalog, reader, "root", "request-cdb-detail", undefined, 0.5)

		// Both calls keep verbatim cost — reporting provider, true cache miss.
		expect(detail.apiCalls[0]!.costUsd).toBe(0.01)
		expect(detail.apiCalls[1]!.costUsd).toBe(0.01)
		expect(detail.totalCost).toBeCloseTo(0.02, 10)

		// Without a ratio both calls stay verbatim.
		const verbatim = computeTaskDetail(catalog, reader, "root", "request-cdb-detail")
		expect(verbatim.totalCost).toBeCloseTo(0.02)
		catalog.dispose()
	})

	it("sums input/output tokens and unions subtree models/modes in first-seen order", () => {
		const catalog = createCatalog([
			makeHistoryItem({ id: "root", ts: 300, task: "Root" }),
			makeHistoryItem({ id: "child", ts: 200, task: "Child", parentTaskId: "root" }),
			makeHistoryItem({ id: "grandchild", ts: 100, task: "Grandchild", parentTaskId: "child" }),
		])
		const reader = createUsageReader(
			new Map(),
			[],
			new Map([
				["root", { inputTokens: 100, outputTokens: 10, models: ["model-root", "shared"], modes: ["code"] }],
				[
					"child",
					{ inputTokens: 200, outputTokens: 20, models: ["shared", "model-child"], modes: ["ask", "code"] },
				],
				["grandchild", { inputTokens: 300, outputTokens: 30, models: ["model-grand"], modes: ["architect"] }],
			]),
		)

		const page = computeTaskPage(catalog, reader, "request-ident")

		const root = page.tasks[0]!
		expect(root.inputTokens).toBe(600)
		expect(root.outputTokens).toBe(60)
		// Union order: the task itself first, then descendants in getDescendantTaskIds order.
		expect(root.models).toEqual(["model-root", "shared", "model-child", "model-grand"])
		expect(root.modes).toEqual(["code", "ask", "architect"])

		const child = page.childTasks![0]!
		expect(child.inputTokens).toBe(500)
		expect(child.outputTokens).toBe(50)
		expect(child.models).toEqual(["shared", "model-child", "model-grand"])
		expect(child.modes).toEqual(["ask", "code", "architect"])
		catalog.dispose()
	})

	it("emits zero tokens and empty model/mode lists for tasks without usage", () => {
		const catalog = createCatalog([makeHistoryItem({ id: "unused", ts: 100, task: "Unused" })])
		const reader = createUsageReader()

		const page = computeTaskPage(catalog, reader, "request-ident-empty")

		expect(page.tasks[0]).toMatchObject({ inputTokens: 0, outputTokens: 0, models: [], modes: [] })
		catalog.dispose()
	})

	it("keeps upsert summaries for a root whose descendant was created inside the range", () => {
		const catalog = createCatalog([
			makeHistoryItem({ id: "old-root", ts: 50, task: "Old root" }),
			makeHistoryItem({ id: "new-child", ts: 200, task: "New child", parentTaskId: "old-root" }),
			makeHistoryItem({ id: "out-root", ts: 60, task: "Out root" }),
		])
		const reader = createUsageReader()
		const rangeMs = { fromMs: 100, toMs: 300 }

		const summaries = computeTaskSummaries(catalog, reader, ["old-root", "out-root", "new-child"], rangeMs)

		// old-root stays (its child is in range); out-root's whole subtree is out.
		expect(summaries.map((task) => task.taskId)).toEqual(["old-root", "new-child"])
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
		expect(reader.queriedIdentityRanges).toEqual([rangeMs])
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

	it("constructs DashboardTaskProjectionError with code and message", () => {
		const err = new DashboardTaskProjectionError("DASHBOARD_TASK_PROJECTION/computeTaskDetail/001", "Task missing")

		expect(err.code).toBe("DASHBOARD_TASK_PROJECTION/computeTaskDetail/001")
		expect(err.message).toContain("[DASHBOARD_TASK_PROJECTION/computeTaskDetail/001]")
		expect(err.message).toContain("Task missing")
		expect(err.name).toBe("DashboardTaskProjectionError")
	})

	it("throws when computing detail for a task absent from the catalog", () => {
		const catalog = createCatalog([makeHistoryItem({ id: "known", ts: 100, task: "Known" })])
		const reader = createUsageReader()

		expect(() => computeTaskDetail(catalog, reader, "unknown", "request-8")).toThrow(DashboardTaskProjectionError)
		try {
			computeTaskDetail(catalog, reader, "unknown", "request-8")
		} catch (err) {
			expect(err).toBeInstanceOf(DashboardTaskProjectionError)
			expect((err as DashboardTaskProjectionError).code).toBe("DASHBOARD_TASK_PROJECTION/computeTaskDetail/001")
		}

		catalog.dispose()
	})

	it("recomputes totalCost from aggregated tokens when customPricing is present and stored totalCost is 0", () => {
		const catalog = createCatalog([makeHistoryItem({ id: "task-custom", ts: 300, task: "Custom model task" })])
		const reader = createUsageReader(
			new Map([
				[
					"task-custom",
					makeUsageRow({
						taskId: "task-custom",
						totalCost: 0,
						totalTokens: 15_000,
						eventCount: 1,
						model: "my-custom-model",
						provider: providerIdentifiers.openai,
					}),
				],
			]),
			[],
			new Map([
				[
					"task-custom",
					{
						inputTokens: 10_000,
						outputTokens: 5_000,
						models: ["my-custom-model"],
						modes: ["code"],
					},
				],
			]),
			[
				{
					taskId: "task-custom",
					provider: providerIdentifiers.openai,
					model: "my-custom-model",
					inputTokens: 10_000,
					outputTokens: 5_000,
					cacheWriteTokens: 0,
					cacheReadTokens: 0,
				},
			],
		)

		const customPricing = new Map([["openai|my-custom-model", { inputPrice: 2.0, outputPrice: 10.0 }]])

		const page = computeTaskPage(catalog, reader, "req-cp", undefined, 50, undefined, 0, customPricing)
		// 10K input at $2/1M = $0.02, 5K output at $10/1M = $0.05 -> Total = $0.07
		expect(page.tasks[0].totalCost).toBeCloseTo(0.07, 4)
		catalog.dispose()
	})
})
