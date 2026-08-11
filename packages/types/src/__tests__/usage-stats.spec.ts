import {
	UsageEventStatus,
	UsageValueSource,
	InclusionRule,
	SourcedNumber,
	UsageEventV1,
	StatsQuery,
	StatsBucket,
	StatsSnapshot,
	DashboardTaskSummary,
} from "../usage-stats.js"

describe("usage-stats schemas", () => {
	// ── Enums ────────────────────────────────────────────────────────────

	describe("UsageEventStatus", () => {
		it("should accept all valid statuses", () => {
			expect(UsageEventStatus.parse("completed")).toBe("completed")
			expect(UsageEventStatus.parse("failed")).toBe("failed")
			expect(UsageEventStatus.parse("cancelled")).toBe("cancelled")
		})

		it("should reject invalid status", () => {
			expect(() => UsageEventStatus.parse("success")).toThrow()
		})
	})

	describe("UsageValueSource", () => {
		it("should accept all valid sources", () => {
			expect(UsageValueSource.parse("provider")).toBe("provider")
			expect(UsageValueSource.parse("estimated")).toBe("estimated")
			expect(UsageValueSource.parse("backfilled")).toBe("backfilled")
		})

		it("should reject invalid source", () => {
			expect(() => UsageValueSource.parse("guessed")).toThrow()
		})
	})

	describe("InclusionRule", () => {
		it("should accept all valid rules", () => {
			expect(InclusionRule.parse("included")).toBe("included")
			expect(InclusionRule.parse("excluded")).toBe("excluded")
			expect(InclusionRule.parse("unknown")).toBe("unknown")
		})
	})

	// ── SourcedNumber ─────────────────────────────────────────────────────

	describe("SourcedNumber", () => {
		it("should parse a valid SourcedNumber", () => {
			const result = SourcedNumber.parse({ value: 42, source: "provider" })
			expect(result).toEqual({ value: 42, source: "provider" })
		})

		it("should reject missing source", () => {
			expect(() => SourcedNumber.parse({ value: 42 })).toThrow()
		})

		it("should reject missing value", () => {
			expect(() => SourcedNumber.parse({ source: "estimated" })).toThrow()
		})
	})

	// ── UsageEventV1 ────────────────────────────────────────────────────────

	describe("UsageEventV1", () => {
		const validEvent = {
			schemaVersion: 1,
			eventId: "evt-001",
			idempotencyKey: "idem-001",
			occurredAt: "2026-07-18T12:00:00.000Z",
			timezoneOffsetMinutes: -540,
			status: "completed",
			attempt: 1,
			taskId: "task-001",
			provider: "anthropic",
			model: "claude-sonnet-4-20250514",
			mode: "code",
			usage: {
				inputTokens: { value: 1000, source: "provider" },
				outputTokens: { value: 500, source: "provider" },
				costUsd: { value: 0.015, source: "provider" },
			},
			semantics: {
				cacheReadInInput: "included",
				cacheWriteInInput: "included",
				reasoningInOutput: "excluded",
			},
			provenance: "live",
		}

		it("should parse a valid complete event", () => {
			const result = UsageEventV1.parse(validEvent)
			expect(result.eventId).toBe("evt-001")
			expect(result.schemaVersion).toBe(1)
			expect(result.usage.inputTokens?.value).toBe(1000)
		})

		it("should accept optional parentTaskId", () => {
			const result = UsageEventV1.parse({ ...validEvent, parentTaskId: "task-000" })
			expect(result.parentTaskId).toBe("task-000")
		})

		it("should work without optional usage fields", () => {
			const minimal = { ...validEvent, usage: {} }
			const result = UsageEventV1.parse(minimal)
			expect(result.usage.inputTokens).toBeUndefined()
		})

		it("should accept backfilled provenance", () => {
			const result = UsageEventV1.parse({ ...validEvent, provenance: "history-backfill" })
			expect(result.provenance).toBe("history-backfill")
		})

		it("should reject schemaVersion !== 1", () => {
			expect(() => UsageEventV1.parse({ ...validEvent, schemaVersion: 2 })).toThrow()
		})

		it("should reject missing semantics", () => {
			const { semantics: _semantics, ...withoutSemantics } = validEvent
			expect(() => UsageEventV1.parse(withoutSemantics)).toThrow()
		})

		it("should reject invalid provenance", () => {
			expect(() => UsageEventV1.parse({ ...validEvent, provenance: "imported" })).toThrow()
		})

		it("should reject missing required fields (eventId)", () => {
			const { eventId: _eventId, ...withoutEventId } = validEvent
			expect(() => UsageEventV1.parse(withoutEventId)).toThrow()
		})

		it("should accept attempt of 0 (no min constraint in V1)", () => {
			// z.number() accepts negatives, but attempt should be >= 0 logically
			// This test confirms the schema accepts any number (no min constraint in V1)
			const result = UsageEventV1.parse({ ...validEvent, attempt: 0 })
			expect(result.attempt).toBe(0)
		})

		it("should accept optional rootTaskId (dashboard streaming)", () => {
			const result = UsageEventV1.parse({ ...validEvent, rootTaskId: "root-task-001" })
			expect(result.rootTaskId).toBe("root-task-001")
		})

		it("should work without rootTaskId (backward compatible)", () => {
			const result = UsageEventV1.parse(validEvent)
			expect(result.rootTaskId).toBeUndefined()
		})
	})

	// ── StatsQuery ───────────────────────────────────────────────────────

	describe("StatsQuery", () => {
		it("should parse a valid query with preset", () => {
			const result = StatsQuery.parse({
				preset: "7d",
				timezone: "Asia/Seoul",
				groupBy: ["day"],
			})
			expect(result.preset).toBe("7d")
			expect(result.includeCancelled).toBe(false) // default
		})

		it("should parse a query with from/to range", () => {
			const result = StatsQuery.parse({
				from: "2026-07-01T00:00:00Z",
				to: "2026-07-18T00:00:00Z",
				timezone: "UTC",
				groupBy: ["provider", "model"],
			})
			expect(result.from).toBe("2026-07-01T00:00:00Z")
			expect(result.groupBy).toHaveLength(2)
		})

		it("should default includeCancelled to false", () => {
			const result = StatsQuery.parse({
				timezone: "UTC",
				groupBy: [],
			})
			expect(result.includeCancelled).toBe(false)
		})

		it("should accept includeCancelled: true", () => {
			const result = StatsQuery.parse({
				timezone: "UTC",
				groupBy: [],
				includeCancelled: true,
			})
			expect(result.includeCancelled).toBe(true)
		})

		it("should reject more than 3 groupBy dimensions", () => {
			expect(() =>
				StatsQuery.parse({
					timezone: "UTC",
					groupBy: ["day", "week", "month", "provider"],
				}),
			).toThrow()
		})

		it("should reject invalid preset", () => {
			expect(() =>
				StatsQuery.parse({
					preset: "90d",
					timezone: "UTC",
					groupBy: [],
				}),
			).toThrow()
		})

		it("should reject missing timezone", () => {
			expect(() =>
				StatsQuery.parse({
					groupBy: [],
				}),
			).toThrow()
		})

		it("should reject invalid groupBy dimension", () => {
			expect(() =>
				StatsQuery.parse({
					timezone: "UTC",
					groupBy: ["hour"],
				}),
			).toThrow()
		})
	})

	// ── StatsBucket ──────────────────────────────────────────────────────

	describe("StatsBucket", () => {
		const validBucket = {
			key: { day: "2026-07-18" },
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

		it("should parse a valid bucket", () => {
			const result = StatsBucket.parse(validBucket)
			expect(result.events).toBe(10)
			expect(result.key.day).toBe("2026-07-18")
		})

		it("should reject missing required numeric field", () => {
			const { costUsd: _costUsd, ...withoutCost } = validBucket
			expect(() => StatsBucket.parse(withoutCost)).toThrow()
		})

		it("should accept empty key record", () => {
			const result = StatsBucket.parse({ ...validBucket, key: {} })
			expect(Object.keys(result.key)).toHaveLength(0)
		})
	})

	// ── StatsSnapshot ─────────────────────────────────────────────────────

	describe("StatsSnapshot", () => {
		const validQuery = {
			timezone: "UTC",
			groupBy: ["day"],
		}
		const validBucket = {
			key: { day: "2026-07-18" },
			events: 5,
			completedCalls: 4,
			failedCalls: 1,
			cancelledCalls: 0,
			inputTokens: 2000,
			outputTokens: 1000,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			reasoningTokens: 0,
			totalTokens: 3000,
			costUsd: 0.03,
			unknownEventCount: 0,
		}
		const validSnapshot = {
			query: validQuery,
			generatedAt: "2026-07-18T12:00:00.000Z",
			buckets: [validBucket],
			totals: validBucket,
			coverage: {
				firstEventAt: "2026-07-01T00:00:00.000Z",
				lastEventAt: "2026-07-18T12:00:00.000Z",
				recordingPaused: false,
				backfilledEventCount: 0,
			},
		}

		it("should parse a valid snapshot", () => {
			const result = StatsSnapshot.parse(validSnapshot)
			expect(result.buckets).toHaveLength(1)
			expect(result.coverage.recordingPaused).toBe(false)
		})

		it("should accept empty buckets array", () => {
			const result = StatsSnapshot.parse({ ...validSnapshot, buckets: [] })
			expect(result.buckets).toHaveLength(0)
		})

		it("should accept optional firstEventAt/lastEventAt omitted", () => {
			const result = StatsSnapshot.parse({
				...validSnapshot,
				coverage: {
					recordingPaused: true,
					backfilledEventCount: 0,
				},
			})
			expect(result.coverage.firstEventAt).toBeUndefined()
			expect(result.coverage.lastEventAt).toBeUndefined()
		})

		it("should reject missing coverage", () => {
			const { coverage: _coverage, ...withoutCoverage } = validSnapshot
			expect(() => StatsSnapshot.parse(withoutCoverage)).toThrow()
		})

		it("should reject missing totals", () => {
			const { totals: _totals, ...withoutTotals } = validSnapshot
			expect(() => StatsSnapshot.parse(withoutTotals)).toThrow()
		})
	})

	// ── DashboardTaskSummary ──────────────────────────────────────────────

	describe("DashboardTaskSummary", () => {
		const validSummary = {
			taskId: "task-001",
			rootTaskId: "task-001",
			title: "Root task",
			taskTimestamp: 1722259100000,
			totalCost: 0.15,
			totalTokens: 12000,
			inputTokens: 8000,
			outputTokens: 4000,
			model: "claude-sonnet-4-20250514",
			provider: "anthropic",
			models: ["claude-sonnet-4-20250514", "gpt-4"],
			modes: ["code", "architect"],
			eventCount: 5,
			childTaskIds: [],
		}

		it("should accept the subtree identity aggregate fields", () => {
			const result = DashboardTaskSummary.parse(validSummary)
			expect(result.inputTokens).toBe(8000)
			expect(result.outputTokens).toBe(4000)
			expect(result.models).toEqual(["claude-sonnet-4-20250514", "gpt-4"])
			expect(result.modes).toEqual(["code", "architect"])
		})

		it("should accept zero tokens and empty model/mode lists for unused tasks", () => {
			const result = DashboardTaskSummary.parse({
				...validSummary,
				inputTokens: 0,
				outputTokens: 0,
				models: [],
				modes: [],
			})
			expect(result.inputTokens).toBe(0)
			expect(result.outputTokens).toBe(0)
			expect(result.models).toEqual([])
			expect(result.modes).toEqual([])
		})

		it.each(["inputTokens", "outputTokens", "models", "modes"] as const)("should reject a missing %s", (field) => {
			const without = { ...validSummary } as Record<string, unknown>
			delete without[field]
			expect(() => DashboardTaskSummary.parse(without)).toThrow()
		})
	})
})
