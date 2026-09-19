// npx vitest run src/components/dashboard/__tests__/dashboardStreamReducer.spec.ts

import {
	providerIdentifiers,
	type DashboardStatsSubscription,
	type DashboardTaskStatsSnapshot,
	type DashboardTaskStatsDelta,
	type DashboardStatsError,
	type DashboardTaskPage,
	type StatsBucket,
	type StatsBucketDelta,
	type StatsSnapshot,
	type StatsQuery,
	type DashboardTaskSummary,
	type DashboardTaskUpsert,
} from "@roo-code/types"

import {
	dashboardStreamReducer,
	initialDashboardStreamState,
	type DashboardStreamState,
} from "../dashboardStreamReducer"

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makeQuery(overrides: Partial<StatsQuery> = {}): StatsQuery {
	return {
		timezone: "UTC",
		groupBy: ["day"],
		includeCancelled: false,
		...overrides,
	}
}

function makeBucket(overrides: Partial<StatsBucket> = {}): StatsBucket {
	return {
		key: {},
		events: 10,
		completedCalls: 8,
		failedCalls: 1,
		cancelledCalls: 1,
		inputTokens: 5000,
		outputTokens: 2500,
		cacheReadTokens: 1000,
		cacheWriteTokens: 500,
		reasoningTokens: 200,
		totalTokens: 7500,
		costUsd: 0.15,
		unknownEventCount: 0,
		...overrides,
	}
}

function makeStatsSnapshot(overrides: Partial<StatsSnapshot> = {}): StatsSnapshot {
	return {
		query: makeQuery(),
		generatedAt: "2026-01-01T00:00:00Z",
		buckets: [makeBucket({ key: { model: "gpt-4" } })],
		totals: makeBucket({ events: 10, totalTokens: 7500 }),
		coverage: {
			recordingPaused: false,
			backfilledEventCount: 0,
		},
		...overrides,
	}
}

function makeTask(overrides: Partial<DashboardTaskSummary> = {}): DashboardTaskSummary {
	return {
		taskId: "task-001",
		rootTaskId: "root-001",
		title: "Test task",
		taskTimestamp: Date.now(),
		totalCost: 0.05,
		totalTokens: 1500,
		inputTokens: 1000,
		outputTokens: 500,
		model: "gpt-4",
		provider: providerIdentifiers.openai,
		models: ["gpt-4"],
		modes: ["code"],
		eventCount: 1,
		childTaskIds: [],
		...overrides,
	}
}

function makeSubscription(overrides: Partial<DashboardStatsSubscription> = {}): DashboardStatsSubscription {
	return {
		requestId: "sub-001",
		range: makeQuery(),
		sessionPageSize: 50,
		heatmapRangeDays: 30,
		...overrides,
	}
}

function makeSnapshot(overrides: Partial<DashboardTaskStatsSnapshot> = {}): DashboardTaskStatsSnapshot {
	return {
		requestId: "sub-001",
		generation: 1,
		sequence: 100,
		stats: makeStatsSnapshot(),
		tasks: {
			requestId: "sub-001",
			catalogRevision: 1,
			tasks: [makeTask()],
			totalEstimate: 1,
		},
		heatmap: {
			rangeDays: 30,
			values: new Array(30).fill(0.1),
		},
		...overrides,
	}
}

function makeBucketDelta(overrides: Partial<StatsBucketDelta> = {}): StatsBucketDelta {
	return {
		key: { model: "gpt-4" },
		events: 1,
		completedCalls: 1,
		failedCalls: 0,
		cancelledCalls: 0,
		inputTokens: 100,
		outputTokens: 50,
		cacheReadTokens: 10,
		cacheWriteTokens: 5,
		reasoningTokens: 2,
		totalTokens: 150,
		costUsd: 0.01,
		unknownEventCount: 0,
		...overrides,
	}
}

function makeDelta(overrides: Partial<DashboardTaskStatsDelta> = {}): DashboardTaskStatsDelta {
	return {
		requestId: "sub-001",
		generation: 1,
		sequence: 101,
		totalDelta: makeBucketDelta(),
		breakdownDelta: [makeBucketDelta()],
		heatmapDayDelta: { dayIndex: 29, delta: 0.01 },
		taskUpsert: [],
		...overrides,
	}
}

function makeTaskPage(overrides: Partial<DashboardTaskPage> = {}): DashboardTaskPage {
	return {
		requestId: "sub-001",
		catalogRevision: 1,
		tasks: [makeTask({ taskId: "task-002", rootTaskId: "root-002", title: "Second task" })],
		totalEstimate: 2,
		...overrides,
	}
}

function makeError(overrides: Partial<DashboardStatsError> = {}): DashboardStatsError {
	return {
		requestId: "sub-001",
		code: "STATS_STREAM/query/001",
		message: "Snapshot query failed",
		...overrides,
	}
}

// Helper: subscribe then snapshot to get a connected state
function connectedState(
	snapshotOverrides: Partial<DashboardTaskStatsSnapshot> = {},
	subscriptionOverrides: Partial<DashboardStatsSubscription> = {},
): DashboardStreamState {
	const sub = makeSubscription(subscriptionOverrides)
	let state = dashboardStreamReducer(initialDashboardStreamState, { type: "SUBSCRIBE", subscription: sub })
	state = dashboardStreamReducer(state, {
		type: "SNAPSHOT",
		snapshot: makeSnapshot({ requestId: sub.requestId, ...snapshotOverrides }),
	})
	return state
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("dashboardStreamReducer", () => {
	describe("initial state", () => {
		it("should have idle status and null data", () => {
			expect(initialDashboardStreamState.status).toBe("idle")
			expect(initialDashboardStreamState.subscriptionId).toBeNull()
			expect(initialDashboardStreamState.generation).toBeNull()
			expect(initialDashboardStreamState.sequence).toBe(0)
			expect(initialDashboardStreamState.isLoading).toBe(false)
			expect(initialDashboardStreamState.totals).toBeNull()
			expect(initialDashboardStreamState.buckets).toEqual({})
			expect(initialDashboardStreamState.tasks).toEqual({})
		})
	})

	describe("SUBSCRIBE", () => {
		it("should set loading state and store subscription identity", () => {
			const sub = makeSubscription()
			const state = dashboardStreamReducer(initialDashboardStreamState, { type: "SUBSCRIBE", subscription: sub })

			expect(state.status).toBe("loading")
			expect(state.isLoading).toBe(true)
			expect(state.subscriptionId).toBe("sub-001")
		})

		it("should reset all data to initial values", () => {
			const connected = connectedState()
			const newSub = makeSubscription({ requestId: "sub-002" })
			const state = dashboardStreamReducer(connected, { type: "SUBSCRIBE", subscription: newSub })

			expect(state.status).toBe("loading")
			expect(state.isLoading).toBe(true)
			expect(state.subscriptionId).toBe("sub-002")
			expect(state.totals).toBeNull()
			expect(state.buckets).toEqual({})
		})
	})

	describe("SNAPSHOT", () => {
		it("should atomically replace all state with snapshot data", () => {
			const sub = makeSubscription()
			let state = dashboardStreamReducer(initialDashboardStreamState, { type: "SUBSCRIBE", subscription: sub })
			state = dashboardStreamReducer(state, { type: "SNAPSHOT", snapshot: makeSnapshot() })

			expect(state.status).toBe("connected")
			expect(state.isLoading).toBe(false)
			expect(state.subscriptionId).toBe("sub-001")
			expect(state.generation).toBe(1)
			expect(state.sequence).toBe(100)
			expect(state.totals).toBeDefined()
			expect(state.totals!.events).toBe(10)
			expect(Object.keys(state.buckets)).toHaveLength(1)
			expect(state.bucketOrder).toHaveLength(1)
			expect(state.heatmapValues).toHaveLength(30)
			expect(state.heatmapRangeDays).toBe(30)
			expect(Object.keys(state.tasks)).toHaveLength(1)
			expect(state.taskOrder).toEqual(["task-001"])
			expect(state.pendingResync).toBe(false)
			expect(state.backgroundError).toBeNull()
		})

		it("should reject snapshot with mismatched requestId (stale epoch)", () => {
			const sub = makeSubscription({ requestId: "sub-001" })
			let state = dashboardStreamReducer(initialDashboardStreamState, { type: "SUBSCRIBE", subscription: sub })
			state = dashboardStreamReducer(state, {
				type: "SNAPSHOT",
				snapshot: makeSnapshot({ requestId: "sub-002" }),
			})

			// Should remain in loading state with no data
			expect(state.status).toBe("loading")
			expect(state.totals).toBeNull()
		})

		it("should clear pendingResync flag", () => {
			let state = connectedState()
			state = dashboardStreamReducer(state, { type: "REQUEST_RESYNC" })
			expect(state.pendingResync).toBe(true)

			state = dashboardStreamReducer(state, { type: "SNAPSHOT", snapshot: makeSnapshot() })
			expect(state.pendingResync).toBe(false)
		})

		it("should tolerate a legacy snapshot without a task page instead of throwing", () => {
			const sub = makeSubscription()
			let state = dashboardStreamReducer(initialDashboardStreamState, { type: "SUBSCRIBE", subscription: sub })
			const legacySnapshot = makeSnapshot() as unknown as Record<string, unknown>
			delete legacySnapshot.tasks

			expect(() => {
				state = dashboardStreamReducer(state, {
					type: "SNAPSHOT",
					snapshot: legacySnapshot as ReturnType<typeof makeSnapshot>,
				})
			}).not.toThrow()
			expect(state.status).toBe("connected")
			expect(state.taskOrder).toEqual([])
			expect(state.taskTotalEstimate).toBe(0)
			// The rest of the dashboard still updates.
			expect(state.totals).toBeDefined()
			expect(state.totals!.events).toBe(10)
		})

		it("should normalize buckets into keyed map with stable order", () => {
			const bucket1 = makeBucket({ key: { model: "gpt-4" }, events: 5 })
			const bucket2 = makeBucket({ key: { model: "claude" }, events: 3 })
			const snapshot = makeSnapshot({
				stats: makeStatsSnapshot({ buckets: [bucket1, bucket2] }),
			})

			let state = dashboardStreamReducer(initialDashboardStreamState, {
				type: "SUBSCRIBE",
				subscription: makeSubscription(),
			})
			state = dashboardStreamReducer(state, { type: "SNAPSHOT", snapshot })

			expect(Object.keys(state.buckets)).toHaveLength(2)
			expect(state.bucketOrder).toHaveLength(2)
			// Order matches snapshot order
			expect(state.buckets[state.bucketOrder[0]].key).toEqual({ model: "gpt-4" })
			expect(state.buckets[state.bucketOrder[1]].key).toEqual({ model: "claude" })
		})

		it("should normalize tasks into keyed map with stable order", () => {
			const task1 = makeTask({ taskId: "task-a", rootTaskId: "root-a" })
			const task2 = makeTask({ taskId: "task-b", rootTaskId: "root-b" })
			const snapshot = makeSnapshot({
				tasks: {
					requestId: "sub-001",
					catalogRevision: 1,
					tasks: [task1, task2],
					totalEstimate: 2,
				},
			})

			let state = dashboardStreamReducer(initialDashboardStreamState, {
				type: "SUBSCRIBE",
				subscription: makeSubscription(),
			})
			state = dashboardStreamReducer(state, { type: "SNAPSHOT", snapshot })

			expect(Object.keys(state.tasks)).toHaveLength(2)
			expect(state.taskOrder).toEqual(["task-a", "task-b"])
		})
	})

	describe("DELTA", () => {
		it("should apply total delta to totals", () => {
			const state = connectedState()
			const delta = makeDelta({ totalDelta: makeBucketDelta({ events: 1, costUsd: 0.01 }) })
			const newState = dashboardStreamReducer(state, { type: "DELTA", delta })

			expect(newState.totals!.events).toBe(11) // 10 + 1
			expect(newState.totals!.costUsd).toBeCloseTo(0.16) // 0.15 + 0.01
			expect(newState.sequence).toBe(101)
		})

		it("should apply breakdown delta to existing bucket", () => {
			const state = connectedState()
			const delta = makeDelta({
				breakdownDelta: [makeBucketDelta({ key: { model: "gpt-4" }, events: 2 })],
			})
			const newState = dashboardStreamReducer(state, { type: "DELTA", delta })

			const bucketKey = state.bucketOrder[0]
			expect(newState.buckets[bucketKey].events).toBe(12) // 10 + 2
		})

		it("should create new bucket from delta if key doesn't exist", () => {
			const state = connectedState()
			const delta = makeDelta({
				breakdownDelta: [makeBucketDelta({ key: { model: "claude" }, events: 5 })],
			})
			const newState = dashboardStreamReducer(state, { type: "DELTA", delta })

			const newKey = JSON.stringify({ model: "claude" })
			expect(newState.buckets[newKey]).toBeDefined()
			expect(newState.buckets[newKey].events).toBe(5)
		})

		it("should apply heatmap day delta", () => {
			const state = connectedState()
			const originalValue = state.heatmapValues[29]
			const delta = makeDelta({
				heatmapDayDelta: { dayIndex: 29, delta: 0.05 },
			})
			const newState = dashboardStreamReducer(state, { type: "DELTA", delta })

			expect(newState.heatmapValues[29]).toBeCloseTo(originalValue + 0.05)
		})

		it("should ignore heatmap delta with out-of-range dayIndex", () => {
			const state = connectedState()
			const originalValues = [...state.heatmapValues]
			const delta = makeDelta({
				heatmapDayDelta: { dayIndex: 999, delta: 0.05 },
			})
			const newState = dashboardStreamReducer(state, { type: "DELTA", delta })

			expect(newState.heatmapValues).toEqual(originalValues)
		})

		it("should apply task upsert to existing task without reordering", () => {
			const state = connectedState()
			const upsert: DashboardTaskUpsert = {
				taskId: "task-001",
				rootTaskId: "root-001",
				title: "Updated title",
				taskTimestamp: Date.now(),
				totalCost: 0.1,
				totalTokens: 2000,
				inputTokens: 1300,
				outputTokens: 700,
				model: "gpt-4",
				provider: providerIdentifiers.openai,
				models: ["gpt-4"],
				modes: ["code"],
				eventCount: 2,
				childTaskIds: [],
			}
			const delta = makeDelta({ taskUpsert: [upsert] })
			const newState = dashboardStreamReducer(state, { type: "DELTA", delta })

			expect(newState.tasks["task-001"].title).toBe("Updated title")
			expect(newState.tasks["task-001"].totalCost).toBe(0.1)
			expect(newState.taskOrder).toEqual(["task-001"]) // No reorder
		})

		it("should insert new task at top of order", () => {
			const state = connectedState()
			const upsert: DashboardTaskUpsert = {
				taskId: "task-new",
				rootTaskId: "root-new",
				title: "New task",
				taskTimestamp: Date.now(),
				totalCost: 0.02,
				totalTokens: 500,
				inputTokens: 300,
				outputTokens: 200,
				model: "claude",
				provider: providerIdentifiers.anthropic,
				models: ["claude"],
				modes: ["code"],
				eventCount: 1,
				childTaskIds: [],
			}
			const delta = makeDelta({ taskUpsert: [upsert] })
			const newState = dashboardStreamReducer(state, { type: "DELTA", delta })

			expect(newState.tasks["task-new"]).toBeDefined()
			expect(newState.taskOrder[0]).toBe("task-new") // Inserted at top
			expect(newState.taskOrder[1]).toBe("task-001") // Existing pushed down
		})

		it("should reject delta with mismatched requestId (stale epoch)", () => {
			const state = connectedState()
			const delta = makeDelta({ requestId: "sub-999" })
			const newState = dashboardStreamReducer(state, { type: "DELTA", delta })

			expect(newState).toBe(state) // No change
		})

		it("should ignore duplicate sequence (sequence <= local)", () => {
			const state = connectedState({ sequence: 100 })
			const delta = makeDelta({ sequence: 100 }) // Same sequence
			const newState = dashboardStreamReducer(state, { type: "DELTA", delta })

			expect(newState).toBe(state) // No change
		})

		it("should ignore delta with sequence less than local", () => {
			const state = connectedState({ sequence: 100 })
			const delta = makeDelta({ sequence: 99 })
			const newState = dashboardStreamReducer(state, { type: "DELTA", delta })

			expect(newState).toBe(state) // No change
		})

		it("should set pendingResync on generation mismatch", () => {
			const state = connectedState({ generation: 1 })
			const delta = makeDelta({ generation: 2 })
			const newState = dashboardStreamReducer(state, { type: "DELTA", delta })

			expect(newState.pendingResync).toBe(true)
			// Data should NOT change
			expect(newState.totals).toBe(state.totals)
		})

		it("should ignore deltas while pendingResync is true", () => {
			let state = connectedState({ generation: 1 })
			state = dashboardStreamReducer(state, { type: "REQUEST_RESYNC" })
			expect(state.pendingResync).toBe(true)

			const delta = makeDelta({ generation: 1, sequence: 102 })
			const newState = dashboardStreamReducer(state, { type: "DELTA", delta })

			expect(newState).toBe(state) // No change while pendingResync
		})

		it("should accept delta after resync snapshot clears pendingResync", () => {
			let state = connectedState({ generation: 1 })
			state = dashboardStreamReducer(state, { type: "REQUEST_RESYNC" })

			// Snapshot clears pendingResync
			state = dashboardStreamReducer(state, {
				type: "SNAPSHOT",
				snapshot: makeSnapshot({ generation: 2, sequence: 150 }),
			})
			expect(state.pendingResync).toBe(false)
			expect(state.generation).toBe(2)
			expect(state.sequence).toBe(150)

			// Now delta should be accepted
			const delta = makeDelta({ generation: 2, sequence: 151 })
			const newState = dashboardStreamReducer(state, { type: "DELTA", delta })

			expect(newState.sequence).toBe(151)
			expect(newState.totals!.events).toBe(11) // 10 + 1
		})

		it("should handle negative delta values (correction/reset)", () => {
			const state = connectedState()
			const delta = makeDelta({
				totalDelta: makeBucketDelta({ events: -2, costUsd: -0.05 }),
			})
			const newState = dashboardStreamReducer(state, { type: "DELTA", delta })

			expect(newState.totals!.events).toBe(8) // 10 - 2
			expect(newState.totals!.costUsd).toBeCloseTo(0.1) // 0.15 - 0.05
		})
	})

	describe("TASK_PAGE", () => {
		it("should append new tasks to the end of order", () => {
			const state = connectedState()
			const page = makeTaskPage()
			const newState = dashboardStreamReducer(state, { type: "TASK_PAGE", page })

			expect(newState.tasks["task-002"]).toBeDefined()
			expect(newState.taskOrder).toEqual(["task-001", "task-002"])
		})

		it("should update existing tasks without reordering", () => {
			const state = connectedState()
			const page: DashboardTaskPage = {
				requestId: "sub-001",
				catalogRevision: 1,
				tasks: [makeTask({ taskId: "task-001", rootTaskId: "root-001", title: "Updated" })],
				totalEstimate: 1,
			}
			const newState = dashboardStreamReducer(state, { type: "TASK_PAGE", page })

			expect(newState.tasks["task-001"].title).toBe("Updated")
			expect(newState.taskOrder).toEqual(["task-001"]) // No reorder
		})

		it("should update cursor and totalEstimate", () => {
			const state = connectedState()
			const page = makeTaskPage({ cursor: "next-page-cursor", totalEstimate: 50 })
			const newState = dashboardStreamReducer(state, { type: "TASK_PAGE", page })

			expect(newState.taskCursor).toBe("next-page-cursor")
			expect(newState.taskTotalEstimate).toBe(50)
		})

		it("should reject page with mismatched requestId", () => {
			const state = connectedState()
			const page = makeTaskPage({ requestId: "sub-999" })
			const newState = dashboardStreamReducer(state, { type: "TASK_PAGE", page })

			expect(newState).toBe(state) // No change
		})
	})

	describe("task hierarchy", () => {
		it("keeps snapshot childTasks out of the visible root order", () => {
			const state = connectedState({
				tasks: {
					requestId: "sub-001",
					catalogRevision: 1,
					tasks: [makeTask({ taskId: "root-a", rootTaskId: "root-a", childTaskIds: ["child-a"] })],
					childTasks: [
						makeTask({
							taskId: "child-a",
							rootTaskId: "root-a",
							parentTaskId: "root-a",
							title: "Child A",
						}),
					],
					totalEstimate: 1,
				},
			})

			expect(state.taskOrder).toEqual(["root-a"])
			expect(state.tasks["root-a"]?.childTaskIds).toEqual(["child-a"])
			expect(state.tasks["child-a"]?.title).toBe("Child A")
		})

		it("stores TASK_PAGE childTasks in the map without appending to the order", () => {
			const state = connectedState()
			const page = makeTaskPage({
				tasks: [makeTask({ taskId: "root-b", rootTaskId: "root-b", childTaskIds: ["child-b"] })],
				childTasks: [
					makeTask({ taskId: "child-b", rootTaskId: "root-b", parentTaskId: "root-b", title: "Child B" }),
				],
				totalEstimate: 3,
			})
			const newState = dashboardStreamReducer(state, { type: "TASK_PAGE", page })

			expect(newState.taskOrder).toEqual(["task-001", "root-b"])
			expect(newState.tasks["child-b"]?.title).toBe("Child B")
		})

		it("does not insert new subtask upserts into the visible root order", () => {
			const state = connectedState()
			const delta = makeDelta({
				taskUpsert: [
					makeTask({ taskId: "child-x", rootTaskId: "task-001", parentTaskId: "task-001", title: "Sub" }),
				],
			})
			const newState = dashboardStreamReducer(state, { type: "DELTA", delta })

			expect(newState.taskOrder).toEqual(["task-001"])
			expect(newState.tasks["child-x"]?.title).toBe("Sub")
		})

		it("still prepends brand-new root upserts to the order", () => {
			const state = connectedState()
			const delta = makeDelta({
				taskUpsert: [makeTask({ taskId: "root-new", rootTaskId: "root-new", title: "New root" })],
			})
			const newState = dashboardStreamReducer(state, { type: "DELTA", delta })

			expect(newState.taskOrder).toEqual(["root-new", "task-001"])
		})
	})

	describe("ERROR", () => {
		it("should set background error and preserve existing data", () => {
			const state = connectedState()
			const error = makeError()
			const newState = dashboardStreamReducer(state, { type: "ERROR", error })

			expect(newState.status).toBe("error")
			expect(newState.backgroundError).toEqual({
				code: "STATS_STREAM/query/001",
				message: "Snapshot query failed",
			})
			// Data preserved
			expect(newState.totals).toBe(state.totals)
			expect(newState.buckets).toBe(state.buckets)
		})

		it("should never set isLoading on error", () => {
			const state = connectedState()
			const error = makeError()
			const newState = dashboardStreamReducer(state, { type: "ERROR", error })

			expect(newState.isLoading).toBe(false)
		})

		it("should reject error with mismatched requestId", () => {
			const state = connectedState()
			const error = makeError({ requestId: "sub-999" })
			const newState = dashboardStreamReducer(state, { type: "ERROR", error })

			expect(newState).toBe(state) // No change
		})
	})

	describe("REQUEST_RESYNC", () => {
		it("should set pendingResync flag", () => {
			const state = connectedState()
			const newState = dashboardStreamReducer(state, { type: "REQUEST_RESYNC" })

			expect(newState.pendingResync).toBe(true)
		})

		it("should not clear existing data", () => {
			const state = connectedState()
			const newState = dashboardStreamReducer(state, { type: "REQUEST_RESYNC" })

			expect(newState.totals).toBe(state.totals)
			expect(newState.buckets).toBe(state.buckets)
			expect(newState.tasks).toBe(state.tasks)
		})
	})

	describe("REPLACE_SUBSCRIPTION", () => {
		it("should set new subscription identity", () => {
			const state = connectedState()
			const newSub = makeSubscription({ requestId: "sub-002" })
			const newState = dashboardStreamReducer(state, { type: "REPLACE_SUBSCRIPTION", subscription: newSub })

			expect(newState.subscriptionId).toBe("sub-002")
		})

		it("should NOT set isLoading when prior data exists", () => {
			const state = connectedState()
			const newSub = makeSubscription({ requestId: "sub-002" })
			const newState = dashboardStreamReducer(state, { type: "REPLACE_SUBSCRIPTION", subscription: newSub })

			expect(newState.isLoading).toBe(false)
		})

		it("should set isLoading when no prior data exists", () => {
			const state = initialDashboardStreamState
			const newSub = makeSubscription({ requestId: "sub-002" })
			const newState = dashboardStreamReducer(state, { type: "REPLACE_SUBSCRIPTION", subscription: newSub })

			expect(newState.isLoading).toBe(true)
		})

		it("should preserve old data for stale-while-revalidate", () => {
			const state = connectedState()
			const newSub = makeSubscription({ requestId: "sub-002" })
			const newState = dashboardStreamReducer(state, { type: "REPLACE_SUBSCRIPTION", subscription: newSub })

			expect(newState.totals).toBe(state.totals)
			expect(newState.buckets).toBe(state.buckets)
			expect(newState.tasks).toBe(state.tasks)
			expect(newState.heatmapValues).toBe(state.heatmapValues)
		})

		it("should reset generation and sequence for new epoch", () => {
			const state = connectedState({ generation: 5, sequence: 200 })
			const newSub = makeSubscription({ requestId: "sub-002" })
			const newState = dashboardStreamReducer(state, { type: "REPLACE_SUBSCRIPTION", subscription: newSub })

			expect(newState.generation).toBeNull()
			expect(newState.sequence).toBe(0)
			expect(newState.pendingResync).toBe(false)
		})
	})

	describe("RESET", () => {
		it("should return to initial state", () => {
			const state = connectedState()
			const newState = dashboardStreamReducer(state, { type: "RESET" })

			expect(newState).toEqual(initialDashboardStreamState)
		})
	})

	describe("default case", () => {
		it("should return the current state for an unknown action type", () => {
			const state = connectedState()
			const newState = dashboardStreamReducer(state, { type: "UNKNOWN_ACTION" } as unknown as Parameters<
				typeof dashboardStreamReducer
			>[1])

			expect(newState).toBe(state)
		})
	})

	describe("Ordering matrix", () => {
		it("should handle snapshot → delta → delta → snapshot (resync) → delta", () => {
			let state = dashboardStreamReducer(initialDashboardStreamState, {
				type: "SUBSCRIBE",
				subscription: makeSubscription(),
			})

			// Snapshot
			state = dashboardStreamReducer(state, { type: "SNAPSHOT", snapshot: makeSnapshot({ sequence: 100 }) })
			expect(state.sequence).toBe(100)

			// Delta 1
			state = dashboardStreamReducer(state, { type: "DELTA", delta: makeDelta({ sequence: 101 }) })
			expect(state.sequence).toBe(101)
			expect(state.totals!.events).toBe(11)

			// Delta 2
			state = dashboardStreamReducer(state, { type: "DELTA", delta: makeDelta({ sequence: 102 }) })
			expect(state.sequence).toBe(102)
			expect(state.totals!.events).toBe(12)

			// Generation mismatch → resync
			state = dashboardStreamReducer(state, { type: "DELTA", delta: makeDelta({ generation: 2, sequence: 200 }) })
			expect(state.pendingResync).toBe(true)

			// Delta ignored while pendingResync
			state = dashboardStreamReducer(state, { type: "DELTA", delta: makeDelta({ generation: 2, sequence: 201 }) })
			expect(state.sequence).toBe(102) // Unchanged

			// Resync snapshot
			state = dashboardStreamReducer(state, {
				type: "SNAPSHOT",
				snapshot: makeSnapshot({ generation: 2, sequence: 200 }),
			})
			expect(state.pendingResync).toBe(false)
			expect(state.generation).toBe(2)
			expect(state.sequence).toBe(200)
			expect(state.totals!.events).toBe(10) // Reset by snapshot

			// Delta after resync
			state = dashboardStreamReducer(state, { type: "DELTA", delta: makeDelta({ generation: 2, sequence: 201 }) })
			expect(state.sequence).toBe(201)
			expect(state.totals!.events).toBe(11)
		})

		it("should handle error → snapshot recovery", () => {
			let state = connectedState()

			// Error
			state = dashboardStreamReducer(state, { type: "ERROR", error: makeError() })
			expect(state.status).toBe("error")
			expect(state.backgroundError).not.toBeNull()
			// Data preserved
			expect(state.totals).not.toBeNull()

			// Snapshot recovery
			state = dashboardStreamReducer(state, { type: "SNAPSHOT", snapshot: makeSnapshot() })
			expect(state.status).toBe("connected")
			expect(state.backgroundError).toBeNull()
		})

		it("should handle replace → stale delta rejection → new snapshot", () => {
			let state = connectedState({ requestId: "sub-001" })

			// Replace subscription
			state = dashboardStreamReducer(state, {
				type: "REPLACE_SUBSCRIPTION",
				subscription: makeSubscription({ requestId: "sub-002" }),
			})
			expect(state.subscriptionId).toBe("sub-002")

			// Stale delta from old epoch — rejected because requestId doesn't match new subscription
			state = dashboardStreamReducer(state, { type: "DELTA", delta: makeDelta({ requestId: "sub-001" }) })
			expect(state.sequence).toBe(0) // Reset by REPLACE_SUBSCRIPTION, unchanged by stale delta

			// New snapshot for new epoch
			state = dashboardStreamReducer(state, {
				type: "SNAPSHOT",
				snapshot: makeSnapshot({ requestId: "sub-002", sequence: 150 }),
			})
			expect(state.sequence).toBe(150)
			expect(state.subscriptionId).toBe("sub-002")
		})
	})
})
