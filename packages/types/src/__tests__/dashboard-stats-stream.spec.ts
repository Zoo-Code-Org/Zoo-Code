import {
	DashboardStatsSubscription,
	DashboardStatsSnapshot,
	DashboardStatsDelta,
	DashboardSessionPage,
	DashboardStatsError,
	DashboardSessionSummary,
	DashboardSessionPageRequest,
	DashboardSessionUpsert,
	DashboardTaskSummary,
	DashboardTaskPage,
	DashboardTaskUpsert,
	DashboardTaskDetail,
	DashboardTaskStatsSnapshot,
	DashboardTaskStatsDelta,
	HeatmapSnapshot,
	StatsBucketDelta,
} from "../usage-stats.js"
import { providerIdentifiers } from "../provider-identifiers.js"

// ── Helpers ────────────────────────────────────────────────────────────────

const validStatsQuery = {
	timezone: "Asia/Seoul",
	groupBy: ["day"],
}

const validBucket = {
	key: { day: "2026-07-29" },
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
	costUsd: 0.075,
	unknownEventCount: 0,
}

const validStatsSnapshot = {
	query: validStatsQuery,
	generatedAt: "2026-07-29T12:00:00.000Z",
	buckets: [validBucket],
	totals: validBucket,
	coverage: {
		firstEventAt: "2026-07-01T00:00:00.000Z",
		lastEventAt: "2026-07-29T12:00:00.000Z",
		recordingPaused: false,
		backfilledEventCount: 0,
	},
}

const validSessionSummary: DashboardSessionSummary = {
	rootTaskId: "root-task-001",
	title: "Fix authentication bug",
	totalCost: 0.15,
	totalTokens: 12000,
	model: "claude-sonnet-4-20250514",
	provider: providerIdentifiers.anthropic,
	lastActivity: 1722259200000,
	eventCount: 5,
}

const validTaskSummary: DashboardTaskSummary = {
	taskId: "task-001",
	rootTaskId: "root-task-001",
	parentTaskId: "parent-task-001",
	title: "Fix task projection",
	taskTimestamp: 1722259100000,
	lastUsageAt: 1722259200000,
	totalCost: 0.15,
	totalTokens: 12000,
	inputTokens: 8000,
	outputTokens: 4000,
	model: "claude-sonnet-4-20250514",
	provider: providerIdentifiers.anthropic,
	models: ["claude-sonnet-4-20250514"],
	modes: ["code"],
	eventCount: 5,
	childTaskIds: [],
}

// ── DashboardSessionPageRequest ─────────────────────────────────────────────

describe("DashboardSessionPageRequest", () => {
	it("should parse a valid request with limit and cursor", () => {
		const result = DashboardSessionPageRequest.parse({ limit: 50, cursor: "abc123" })
		expect(result.limit).toBe(50)
		expect(result.cursor).toBe("abc123")
	})

	it("should default limit to 50 when omitted", () => {
		const result = DashboardSessionPageRequest.parse({})
		expect(result.limit).toBe(50)
	})

	it("should accept limit of 1 (minimum)", () => {
		const result = DashboardSessionPageRequest.parse({ limit: 1 })
		expect(result.limit).toBe(1)
	})

	it("should accept limit of 100 (maximum)", () => {
		const result = DashboardSessionPageRequest.parse({ limit: 100 })
		expect(result.limit).toBe(100)
	})

	it("should reject limit of 0 (below minimum)", () => {
		expect(() => DashboardSessionPageRequest.parse({ limit: 0 })).toThrow()
	})

	it("should reject limit of 101 (above maximum)", () => {
		expect(() => DashboardSessionPageRequest.parse({ limit: 101 })).toThrow()
	})

	it("should reject non-integer limit", () => {
		expect(() => DashboardSessionPageRequest.parse({ limit: 50.5 })).toThrow()
	})

	it("should work without cursor (first page)", () => {
		const result = DashboardSessionPageRequest.parse({ limit: 25 })
		expect(result.cursor).toBeUndefined()
	})
})

// ── DashboardStatsSubscription ──────────────────────────────────────────────

describe("DashboardStatsSubscription", () => {
	const validSubscription = {
		requestId: "sub-001",
		range: validStatsQuery,
		sessionPageSize: 50,
		heatmapRangeDays: 30,
	}

	it("should parse a valid subscription", () => {
		const result = DashboardStatsSubscription.parse(validSubscription)
		expect(result.requestId).toBe("sub-001")
		expect(result.heatmapRangeDays).toBe(30)
	})

	it("should accept sessionPageSize of 1 (minimum)", () => {
		const result = DashboardStatsSubscription.parse({ ...validSubscription, sessionPageSize: 1 })
		expect(result.sessionPageSize).toBe(1)
	})

	it("should accept sessionPageSize of 100 (maximum)", () => {
		const result = DashboardStatsSubscription.parse({ ...validSubscription, sessionPageSize: 100 })
		expect(result.sessionPageSize).toBe(100)
	})

	it("should reject sessionPageSize of 0", () => {
		expect(() => DashboardStatsSubscription.parse({ ...validSubscription, sessionPageSize: 0 })).toThrow()
	})

	it("should reject sessionPageSize of 101", () => {
		expect(() => DashboardStatsSubscription.parse({ ...validSubscription, sessionPageSize: 101 })).toThrow()
	})

	it("should reject non-integer sessionPageSize", () => {
		expect(() => DashboardStatsSubscription.parse({ ...validSubscription, sessionPageSize: 50.5 })).toThrow()
	})

	it("should accept heatmapRangeDays of 1 (minimum)", () => {
		const result = DashboardStatsSubscription.parse({ ...validSubscription, heatmapRangeDays: 1 })
		expect(result.heatmapRangeDays).toBe(1)
	})

	it("should accept heatmapRangeDays of 365 (maximum)", () => {
		const result = DashboardStatsSubscription.parse({ ...validSubscription, heatmapRangeDays: 365 })
		expect(result.heatmapRangeDays).toBe(365)
	})

	it("should reject heatmapRangeDays of 0", () => {
		expect(() => DashboardStatsSubscription.parse({ ...validSubscription, heatmapRangeDays: 0 })).toThrow()
	})

	it("should reject heatmapRangeDays of 366", () => {
		expect(() => DashboardStatsSubscription.parse({ ...validSubscription, heatmapRangeDays: 366 })).toThrow()
	})

	it("should reject missing requestId", () => {
		const { requestId: _req, ...withoutId } = validSubscription
		expect(() => DashboardStatsSubscription.parse(withoutId)).toThrow()
	})

	it("should reject missing range", () => {
		const { range: _range, ...withoutRange } = validSubscription
		expect(() => DashboardStatsSubscription.parse(withoutRange)).toThrow()
	})
})

// ── DashboardSessionSummary ──────────────────────────────────────────────────

describe("DashboardSessionSummary", () => {
	it("should parse a valid session summary", () => {
		const result = DashboardSessionSummary.parse(validSessionSummary)
		expect(result.rootTaskId).toBe("root-task-001")
		expect(result.eventCount).toBe(5)
	})

	it("should reject missing rootTaskId", () => {
		const { rootTaskId: _id, ...withoutId } = validSessionSummary
		expect(() => DashboardSessionSummary.parse(withoutId)).toThrow()
	})

	it("should reject missing title", () => {
		const { title: _title, ...withoutTitle } = validSessionSummary
		expect(() => DashboardSessionSummary.parse(withoutTitle)).toThrow()
	})

	it("should reject missing totalCost", () => {
		const { totalCost: _cost, ...withoutCost } = validSessionSummary
		expect(() => DashboardSessionSummary.parse(withoutCost)).toThrow()
	})

	it("should reject missing lastActivity", () => {
		const { lastActivity: _act, ...withoutAct } = validSessionSummary
		expect(() => DashboardSessionSummary.parse(withoutAct)).toThrow()
	})
})

// ── DashboardSessionPage ────────────────────────────────────────────────────

describe("DashboardSessionPage", () => {
	const validPage = {
		requestId: "sub-001",
		sessions: [validSessionSummary],
		cursor: "next-page-cursor",
		totalEstimate: 100,
	}

	it("should parse a valid page with cursor", () => {
		const result = DashboardSessionPage.parse(validPage)
		expect(result.sessions).toHaveLength(1)
		expect(result.cursor).toBe("next-page-cursor")
		expect(result.totalEstimate).toBe(100)
	})

	it("should parse a valid page without cursor (last page)", () => {
		const { cursor: _cursor, ...withoutCursor } = validPage
		const result = DashboardSessionPage.parse(withoutCursor)
		expect(result.cursor).toBeUndefined()
	})

	it("should accept empty sessions array", () => {
		const result = DashboardSessionPage.parse({ ...validPage, sessions: [] })
		expect(result.sessions).toHaveLength(0)
	})

	it("should reject missing requestId", () => {
		const { requestId: _req, ...withoutReq } = validPage
		expect(() => DashboardSessionPage.parse(withoutReq)).toThrow()
	})

	it("should reject missing totalEstimate", () => {
		const { totalEstimate: _est, ...withoutEst } = validPage
		expect(() => DashboardSessionPage.parse(withoutEst)).toThrow()
	})
})

// ── DashboardTaskSummary / DashboardTaskPage ────────────────────────────────

describe("DashboardTaskSummary", () => {
	it("should parse a History-first task summary including zero-usage metadata", () => {
		const result = DashboardTaskSummary.parse(validTaskSummary)
		expect(result.taskId).toBe("task-001")
		expect(result.parentTaskId).toBe("parent-task-001")
		expect(result.lastUsageAt).toBe(1722259200000)
	})

	it("should accept a zero-usage task without lastUsageAt", () => {
		const { lastUsageAt: _lastUsageAt, ...zeroUsageTask } = validTaskSummary
		const result = DashboardTaskSummary.parse({
			...zeroUsageTask,
			totalCost: 0,
			totalTokens: 0,
			eventCount: 0,
			model: "",
			provider: "",
		})
		expect(result.lastUsageAt).toBeUndefined()
		expect(result.eventCount).toBe(0)
	})

	it("should reject a negative event count", () => {
		expect(() => DashboardTaskSummary.parse({ ...validTaskSummary, eventCount: -1 })).toThrow()
	})

	it("should carry direct child task ids", () => {
		const result = DashboardTaskSummary.parse({ ...validTaskSummary, childTaskIds: ["child-1", "child-2"] })
		expect(result.childTaskIds).toEqual(["child-1", "child-2"])
	})

	it("should reject a summary missing childTaskIds", () => {
		const { childTaskIds: _childTaskIds, ...withoutChildTaskIds } = validTaskSummary
		expect(() => DashboardTaskSummary.parse(withoutChildTaskIds)).toThrow()
	})
})

describe("DashboardTaskPage", () => {
	const validPage = {
		requestId: "sub-001",
		catalogRevision: 4,
		tasks: [validTaskSummary],
		cursor: "next-task-page",
		totalEstimate: 100,
	}

	it("should parse a revisioned task page", () => {
		const result = DashboardTaskPage.parse(validPage)
		expect(result.catalogRevision).toBe(4)
		expect(result.tasks).toHaveLength(1)
	})

	it("should accept direct children of the page's root tasks", () => {
		const child = { ...validTaskSummary, taskId: "child-1", childTaskIds: [] }
		const result = DashboardTaskPage.parse({ ...validPage, childTasks: [child] })
		expect(result.childTasks).toHaveLength(1)
		expect(result.childTasks?.[0]?.taskId).toBe("child-1")
	})

	it("should reject a negative catalog revision", () => {
		expect(() => DashboardTaskPage.parse({ ...validPage, catalogRevision: -1 })).toThrow()
	})
})

describe("DashboardTaskUpsert", () => {
	it("should use the full task summary shape so no client join is required", () => {
		const result = DashboardTaskUpsert.parse(validTaskSummary)
		expect(result.rootTaskId).toBe("root-task-001")
		expect(result.taskTimestamp).toBe(1722259100000)
	})
})

describe("DashboardTaskDetail", () => {
	it("should parse a successful empty detail for a known zero-usage task", () => {
		const result = DashboardTaskDetail.parse({
			taskId: "unused-task",
			title: "No API usage",
			taskTimestamp: 1234,
			models: [],
			modes: [],
			totalTokens: 0,
			totalCost: 0,
			callCount: 0,
			apiCalls: [],
		})
		expect(result.apiCalls).toEqual([])
	})
})

// ── HeatmapSnapshot ────────────────────────────────────────────────────────

describe("HeatmapSnapshot", () => {
	it("should parse a valid heatmap", () => {
		const result = HeatmapSnapshot.parse({ rangeDays: 30, values: [0.1, 0.2, 0.3] })
		expect(result.rangeDays).toBe(30)
		expect(result.values).toHaveLength(3)
	})

	it("should accept empty values array", () => {
		const result = HeatmapSnapshot.parse({ rangeDays: 30, values: [] })
		expect(result.values).toHaveLength(0)
	})

	it("should reject rangeDays of 0", () => {
		expect(() => HeatmapSnapshot.parse({ rangeDays: 0, values: [] })).toThrow()
	})

	it("should reject missing values", () => {
		const { values: _v, ...withoutValues } = { rangeDays: 30, values: [1] }
		expect(() => HeatmapSnapshot.parse(withoutValues)).toThrow()
	})
})

// ── StatsBucketDelta ────────────────────────────────────────────────────────

describe("StatsBucketDelta", () => {
	const validDelta = {
		key: { day: "2026-07-29" },
		events: 1,
		completedCalls: 1,
		failedCalls: 0,
		cancelledCalls: 0,
		inputTokens: 500,
		outputTokens: 200,
		cacheReadTokens: 100,
		cacheWriteTokens: 50,
		reasoningTokens: 0,
		totalTokens: 700,
		costUsd: 0.01,
		unknownEventCount: 0,
	}

	it("should parse a valid delta with positive values", () => {
		const result = StatsBucketDelta.parse(validDelta)
		expect(result.events).toBe(1)
		expect(result.costUsd).toBe(0.01)
	})

	it("should accept negative values (correction/reset)", () => {
		const result = StatsBucketDelta.parse({
			...validDelta,
			events: -1,
			costUsd: -0.01,
			inputTokens: -500,
		})
		expect(result.events).toBe(-1)
		expect(result.costUsd).toBe(-0.01)
		expect(result.inputTokens).toBe(-500)
	})

	it("should accept zero values", () => {
		const result = StatsBucketDelta.parse({
			...validDelta,
			events: 0,
			costUsd: 0,
		})
		expect(result.events).toBe(0)
	})

	it("should reject missing key", () => {
		const { key: _key, ...withoutKey } = validDelta
		expect(() => StatsBucketDelta.parse(withoutKey)).toThrow()
	})

	it("should reject missing costUsd", () => {
		const { costUsd: _cost, ...withoutCost } = validDelta
		expect(() => StatsBucketDelta.parse(withoutCost)).toThrow()
	})
})

// ── DashboardSessionUpsert ──────────────────────────────────────────────────

describe("DashboardSessionUpsert", () => {
	it("should parse a valid upsert", () => {
		const result = DashboardSessionUpsert.parse(validSessionSummary)
		expect(result.rootTaskId).toBe("root-task-001")
		expect(result.eventCount).toBe(5)
	})

	it("should reject missing rootTaskId", () => {
		const { rootTaskId: _id, ...withoutId } = validSessionSummary
		expect(() => DashboardSessionUpsert.parse(withoutId)).toThrow()
	})

	it("should reject missing eventCount", () => {
		const { eventCount: _count, ...withoutCount } = validSessionSummary
		expect(() => DashboardSessionUpsert.parse(withoutCount)).toThrow()
	})
})

// ── DashboardStatsSnapshot ──────────────────────────────────────────────────

describe("DashboardStatsSnapshot", () => {
	const validSessionPage = {
		requestId: "sub-001",
		sessions: [validSessionSummary],
		cursor: "next-cursor",
		totalEstimate: 50,
	}

	const validHeatmap = {
		rangeDays: 30,
		values: [0.1, 0.2, 0.3],
	}

	const validSnapshot = {
		requestId: "sub-001",
		generation: 1,
		sequence: 100,
		stats: validStatsSnapshot,
		sessions: validSessionPage,
		cursor: "next-cursor",
		heatmap: validHeatmap,
	}

	it("should parse a valid snapshot", () => {
		const result = DashboardStatsSnapshot.parse(validSnapshot)
		expect(result.requestId).toBe("sub-001")
		expect(result.generation).toBe(1)
		expect(result.sequence).toBe(100)
		expect(result.stats.buckets).toHaveLength(1)
		expect(result.sessions.sessions).toHaveLength(1)
		expect(result.heatmap.values).toHaveLength(3)
	})

	it("should accept snapshot without cursor (last page)", () => {
		const { cursor: _cursor, ...withoutCursor } = validSnapshot
		const result = DashboardStatsSnapshot.parse(withoutCursor)
		expect(result.cursor).toBeUndefined()
	})

	it("should reject missing generation", () => {
		const { generation: _gen, ...withoutGen } = validSnapshot
		expect(() => DashboardStatsSnapshot.parse(withoutGen)).toThrow()
	})

	it("should reject missing sequence", () => {
		const { sequence: _seq, ...withoutSeq } = validSnapshot
		expect(() => DashboardStatsSnapshot.parse(withoutSeq)).toThrow()
	})

	it("should reject non-integer generation", () => {
		expect(() => DashboardStatsSnapshot.parse({ ...validSnapshot, generation: 1.5 })).toThrow()
	})

	it("should reject non-integer sequence", () => {
		expect(() => DashboardStatsSnapshot.parse({ ...validSnapshot, sequence: 100.5 })).toThrow()
	})

	it("should reject missing stats", () => {
		const { stats: _stats, ...withoutStats } = validSnapshot
		expect(() => DashboardStatsSnapshot.parse(withoutStats)).toThrow()
	})

	it("should reject missing heatmap", () => {
		const { heatmap: _heatmap, ...withoutHeatmap } = validSnapshot
		expect(() => DashboardStatsSnapshot.parse(withoutHeatmap)).toThrow()
	})

	it("should reject missing sessions", () => {
		const { sessions: _sessions, ...withoutSessions } = validSnapshot
		expect(() => DashboardStatsSnapshot.parse(withoutSessions)).toThrow()
	})
})

// ── DashboardStatsDelta ─────────────────────────────────────────────────────

describe("DashboardStatsDelta", () => {
	const validBucketDelta = {
		key: { day: "2026-07-29" },
		events: 1,
		completedCalls: 1,
		failedCalls: 0,
		cancelledCalls: 0,
		inputTokens: 500,
		outputTokens: 200,
		cacheReadTokens: 100,
		cacheWriteTokens: 50,
		reasoningTokens: 0,
		totalTokens: 700,
		costUsd: 0.01,
		unknownEventCount: 0,
	}

	const validDelta = {
		requestId: "sub-001",
		generation: 1,
		sequence: 101,
		totalDelta: validBucketDelta,
		breakdownDelta: [validBucketDelta],
		heatmapDayDelta: {
			dayIndex: 28,
			delta: 0.01,
		},
		sessionUpsert: [validSessionSummary],
	}

	it("should parse a valid delta with all fields", () => {
		const result = DashboardStatsDelta.parse(validDelta)
		expect(result.requestId).toBe("sub-001")
		expect(result.generation).toBe(1)
		expect(result.sequence).toBe(101)
		expect(result.totalDelta.events).toBe(1)
		expect(result.breakdownDelta).toHaveLength(1)
		expect(result.heatmapDayDelta?.dayIndex).toBe(28)
		expect(result.sessionUpsert).toHaveLength(1)
	})

	it("should parse a delta without heatmapDayDelta", () => {
		const { heatmapDayDelta: _h, ...withoutHeatmap } = validDelta
		const result = DashboardStatsDelta.parse(withoutHeatmap)
		expect(result.heatmapDayDelta).toBeUndefined()
	})

	it("should parse a delta with empty breakdownDelta", () => {
		const result = DashboardStatsDelta.parse({ ...validDelta, breakdownDelta: [] })
		expect(result.breakdownDelta).toHaveLength(0)
	})

	it("should parse a delta with empty sessionUpsert", () => {
		const result = DashboardStatsDelta.parse({ ...validDelta, sessionUpsert: [] })
		expect(result.sessionUpsert).toHaveLength(0)
	})

	it("should accept negative delta values (correction)", () => {
		const result = DashboardStatsDelta.parse({
			...validDelta,
			totalDelta: { ...validBucketDelta, events: -1, costUsd: -0.01 },
		})
		expect(result.totalDelta.events).toBe(-1)
		expect(result.totalDelta.costUsd).toBe(-0.01)
	})

	it("should reject missing generation", () => {
		const { generation: _gen, ...withoutGen } = validDelta
		expect(() => DashboardStatsDelta.parse(withoutGen)).toThrow()
	})

	it("should reject missing sequence", () => {
		const { sequence: _seq, ...withoutSeq } = validDelta
		expect(() => DashboardStatsDelta.parse(withoutSeq)).toThrow()
	})

	it("should reject non-integer generation", () => {
		expect(() => DashboardStatsDelta.parse({ ...validDelta, generation: 1.5 })).toThrow()
	})

	it("should reject non-integer sequence", () => {
		expect(() => DashboardStatsDelta.parse({ ...validDelta, sequence: 101.5 })).toThrow()
	})

	it("should reject missing totalDelta", () => {
		const { totalDelta: _td, ...withoutTotal } = validDelta
		expect(() => DashboardStatsDelta.parse(withoutTotal)).toThrow()
	})

	it("should reject missing breakdownDelta", () => {
		const { breakdownDelta: _bd, ...withoutBreakdown } = validDelta
		expect(() => DashboardStatsDelta.parse(withoutBreakdown)).toThrow()
	})

	it("should reject missing sessionUpsert", () => {
		const { sessionUpsert: _su, ...withoutUpsert } = validDelta
		expect(() => DashboardStatsDelta.parse(withoutUpsert)).toThrow()
	})

	it("should reject negative dayIndex in heatmapDayDelta", () => {
		expect(() =>
			DashboardStatsDelta.parse({
				...validDelta,
				heatmapDayDelta: { dayIndex: -1, delta: 0.01 },
			}),
		).toThrow()
	})

	it("should reject non-integer dayIndex in heatmapDayDelta", () => {
		expect(() =>
			DashboardStatsDelta.parse({
				...validDelta,
				heatmapDayDelta: { dayIndex: 1.5, delta: 0.01 },
			}),
		).toThrow()
	})
})

// ── DashboardStatsError ─────────────────────────────────────────────────────

describe("DashboardStatsError", () => {
	const validError = {
		requestId: "sub-001",
		code: "STATS_STREAM/subscribe/001",
		message: "Invalid subscription payload",
	}

	it("should parse a valid error", () => {
		const result = DashboardStatsError.parse(validError)
		expect(result.code).toBe("STATS_STREAM/subscribe/001")
		expect(result.message).toBe("Invalid subscription payload")
	})

	it("should reject missing requestId", () => {
		const { requestId: _req, ...withoutReq } = validError
		expect(() => DashboardStatsError.parse(withoutReq)).toThrow()
	})

	it("should reject missing code", () => {
		const { code: _code, ...withoutCode } = validError
		expect(() => DashboardStatsError.parse(withoutCode)).toThrow()
	})

	it("should reject missing message", () => {
		const { message: _msg, ...withoutMsg } = validError
		expect(() => DashboardStatsError.parse(withoutMsg)).toThrow()
	})
})

// ── Serialization round-trip ────────────────────────────────────────────────

describe("serialization round trips", () => {
	it("should round-trip DashboardStatsSnapshot through JSON", () => {
		const validSessionPage = {
			requestId: "sub-001",
			sessions: [validSessionSummary],
			cursor: "next-cursor",
			totalEstimate: 50,
		}
		const snapshot = {
			requestId: "sub-001",
			generation: 1,
			sequence: 100,
			stats: validStatsSnapshot,
			sessions: validSessionPage,
			cursor: "next-cursor",
			heatmap: { rangeDays: 30, values: [0.1, 0.2] },
		}
		const json = JSON.stringify(snapshot)
		const parsed = JSON.parse(json)
		const result = DashboardStatsSnapshot.parse(parsed)
		expect(result.sequence).toBe(100)
		expect(result.heatmap.values).toHaveLength(2)
	})

	it("should round-trip DashboardStatsDelta through JSON", () => {
		const bucketDelta = {
			key: { day: "2026-07-29" },
			events: 1,
			completedCalls: 1,
			failedCalls: 0,
			cancelledCalls: 0,
			inputTokens: 500,
			outputTokens: 200,
			cacheReadTokens: 100,
			cacheWriteTokens: 50,
			reasoningTokens: 0,
			totalTokens: 700,
			costUsd: 0.01,
			unknownEventCount: 0,
		}
		const delta = {
			requestId: "sub-001",
			generation: 1,
			sequence: 101,
			totalDelta: bucketDelta,
			breakdownDelta: [bucketDelta],
			heatmapDayDelta: { dayIndex: 28, delta: 0.01 },
			sessionUpsert: [validSessionSummary],
		}
		const json = JSON.stringify(delta)
		const parsed = JSON.parse(json)
		const result = DashboardStatsDelta.parse(parsed)
		expect(result.sequence).toBe(101)
		expect(result.heatmapDayDelta?.delta).toBe(0.01)
	})

	it("should round-trip DashboardStatsError through JSON", () => {
		const error = {
			requestId: "sub-001",
			code: "STATS_STREAM/query/001",
			message: "Snapshot query failed",
		}
		const json = JSON.stringify(error)
		const parsed = JSON.parse(json)
		const result = DashboardStatsError.parse(parsed)
		expect(result.code).toBe("STATS_STREAM/query/001")
	})

	it("should round-trip DashboardSessionPage through JSON", () => {
		const page = {
			requestId: "sub-001",
			sessions: [validSessionSummary],
			cursor: "next-cursor",
			totalEstimate: 50,
		}
		const json = JSON.stringify(page)
		const parsed = JSON.parse(json)
		const result = DashboardSessionPage.parse(parsed)
		expect(result.sessions).toHaveLength(1)
		expect(result.totalEstimate).toBe(50)
	})

	it("should round-trip task snapshot, delta, page, and detail through JSON", () => {
		const taskPage = {
			requestId: "sub-001",
			catalogRevision: 7,
			tasks: [validTaskSummary],
			cursor: "next-task-cursor",
			totalEstimate: 50,
		}
		const bucketDelta = {
			key: { day: "2026-07-29" },
			events: 1,
			completedCalls: 1,
			failedCalls: 0,
			cancelledCalls: 0,
			inputTokens: 500,
			outputTokens: 200,
			cacheReadTokens: 100,
			cacheWriteTokens: 50,
			reasoningTokens: 0,
			totalTokens: 700,
			costUsd: 0.01,
			unknownEventCount: 0,
		}
		const snapshot = {
			requestId: "sub-001",
			generation: 1,
			sequence: 100,
			stats: validStatsSnapshot,
			tasks: taskPage,
			cursor: taskPage.cursor,
			heatmap: { rangeDays: 30, values: [0.1, 0.2] },
		}
		const delta = {
			requestId: "sub-001",
			generation: 1,
			sequence: 101,
			totalDelta: bucketDelta,
			breakdownDelta: [bucketDelta],
			taskUpsert: [validTaskSummary],
		}
		const detail = {
			taskId: "task-001",
			title: "Fix task projection",
			taskTimestamp: 1722259100000,
			models: ["claude-sonnet-4-20250514"],
			modes: ["code"],
			totalTokens: 12000,
			totalCost: 0.15,
			callCount: 1,
			apiCalls: [
				{
					index: 1,
					mode: "code",
					timestamp: 1722259200000,
					inputTokens: 5000,
					outputTokens: 2500,
					cacheReadTokens: 1000,
					cacheWriteTokens: 500,
					reasoningTokens: 200,
					costUsd: 0.15,
					status: "completed",
					model: "claude-sonnet-4-20250514",
				},
			],
		}

		expect(DashboardTaskPage.parse(JSON.parse(JSON.stringify(taskPage))).catalogRevision).toBe(7)
		expect(DashboardTaskStatsSnapshot.parse(JSON.parse(JSON.stringify(snapshot))).tasks.tasks).toHaveLength(1)
		expect(DashboardTaskStatsDelta.parse(JSON.parse(JSON.stringify(delta))).taskUpsert).toHaveLength(1)
		expect(DashboardTaskDetail.parse(JSON.parse(JSON.stringify(detail))).apiCalls).toHaveLength(1)
	})
})
