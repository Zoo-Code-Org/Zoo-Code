// npx vitest run src/components/dashboard/__tests__/useDashboardStatsStream.spec.tsx

import { renderHook, act } from "@/utils/test-utils"

import type {
	DashboardTaskStatsDelta,
	DashboardTaskStatsSnapshot,
	DashboardStatsError,
	DashboardTaskPage,
	StatsQuery,
} from "@roo-code/types"

import { useDashboardStatsStream } from "../useDashboardStatsStream"

// ── vscode mock ──────────────────────────────────────────────────────────────

const postMessageMock = vi.fn()
vi.mock("@/utils/vscode", () => ({
	vscode: {
		postMessage: (msg: unknown) => postMessageMock(msg),
	},
}))

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makeQuery(overrides: Partial<StatsQuery> = {}): StatsQuery {
	return {
		timezone: "UTC",
		groupBy: ["day"],
		includeCancelled: false,
		...overrides,
	}
}

function makeSnapshot(overrides: Partial<DashboardTaskStatsSnapshot> = {}): DashboardTaskStatsSnapshot {
	return {
		requestId: "test-sub",
		generation: 1,
		sequence: 100,
		stats: {
			query: makeQuery(),
			generatedAt: "2026-01-01T00:00:00Z",
			buckets: [
				{
					key: { model: "gpt-4" },
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
				},
			],
			totals: {
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
			},
			coverage: {
				recordingPaused: false,
				backfilledEventCount: 0,
			},
		},
		tasks: {
			requestId: "test-sub",
			catalogRevision: 1,
			tasks: [
				{
					taskId: "task-001",
					rootTaskId: "root-001",
					title: "Test task",
					taskTimestamp: Date.now(),
					totalCost: 0.05,
					totalTokens: 1500,
					model: "gpt-4",
					provider: "openai",
					eventCount: 1,
					childTaskIds: [],
				},
			],
			totalEstimate: 1,
		},
		heatmap: {
			rangeDays: 30,
			values: new Array(30).fill(0.1),
		},
		...overrides,
	}
}

function makeDelta(overrides: Partial<DashboardTaskStatsDelta> = {}): DashboardTaskStatsDelta {
	return {
		requestId: "test-sub",
		generation: 1,
		sequence: 101,
		totalDelta: {
			key: {},
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
		},
		breakdownDelta: [
			{
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
			},
		],
		heatmapDayDelta: { dayIndex: 29, delta: 0.01 },
		taskUpsert: [],
		...overrides,
	}
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Extract the subscription requestId from the subscribeDashboardStats postMessage call.
 */
function getSubscriptionId(): string {
	const calls = postMessageMock.mock.calls
	for (let i = calls.length - 1; i >= 0; i--) {
		const msg = calls[i][0] as { type?: string; dashboardStatsSubscription?: { requestId?: string } }
		if (msg?.type === "subscribeDashboardStats" && msg.dashboardStatsSubscription?.requestId) {
			return msg.dashboardStatsSubscription.requestId
		}
	}
	throw new Error("No subscribeDashboardStats message found")
}

/**
 * Simulate the extension host posting a message to the webview.
 */
function postExtensionMessage(data: Record<string, unknown>) {
	act(() => {
		window.dispatchEvent(new MessageEvent("message", { data }))
	})
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("useDashboardStatsStream", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.useFakeTimers()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	describe("subscription lifecycle", () => {
		it("should send subscribeDashboardStats on mount", () => {
			renderHook(() =>
				useDashboardStatsStream({
					range: makeQuery(),
					heatmapRangeDays: 30,
				}),
			)

			expect(postMessageMock).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "subscribeDashboardStats",
					dashboardStatsSubscription: expect.objectContaining({
						range: expect.any(Object),
						sessionPageSize: 50,
						heatmapRangeDays: 30,
					}),
				}),
			)
		})

		it("should send unsubscribeDashboardStats on unmount", () => {
			const { unmount } = renderHook(() =>
				useDashboardStatsStream({
					range: makeQuery(),
					heatmapRangeDays: 30,
				}),
			)

			const subId = getSubscriptionId()
			postMessageMock.mockClear()

			unmount()

			expect(postMessageMock).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "unsubscribeDashboardStats",
					requestId: subId,
				}),
			)
		})

		it("should send exactly one subscribe on mount", () => {
			renderHook(() =>
				useDashboardStatsStream({
					range: makeQuery(),
					heatmapRangeDays: 30,
				}),
			)

			const subscribeCalls = postMessageMock.mock.calls.filter(
				(c) => (c[0] as { type: string }).type === "subscribeDashboardStats",
			)
			expect(subscribeCalls).toHaveLength(1)
		})
	})

	describe("message handling", () => {
		it("should apply snapshot to state", () => {
			const { result } = renderHook(() =>
				useDashboardStatsStream({
					range: makeQuery(),
					heatmapRangeDays: 30,
				}),
			)

			expect(result.current.state.status).toBe("loading")

			const subId = getSubscriptionId()
			const snapshot = makeSnapshot({ requestId: subId })
			postExtensionMessage({
				type: "dashboardStatsStreamSnapshot",
				dashboardStatsStreamSnapshot: snapshot,
			})

			expect(result.current.state.status).toBe("connected")
			expect(result.current.state.isLoading).toBe(false)
			expect(result.current.state.totals).not.toBeNull()
			expect(result.current.state.totals!.events).toBe(10)
		})

		it("should apply delta to state after snapshot", () => {
			const { result } = renderHook(() =>
				useDashboardStatsStream({
					range: makeQuery(),
					heatmapRangeDays: 30,
				}),
			)

			const subId = getSubscriptionId()
			postExtensionMessage({
				type: "dashboardStatsStreamSnapshot",
				dashboardStatsStreamSnapshot: makeSnapshot({ requestId: subId }),
			})

			postExtensionMessage({
				type: "dashboardStatsStreamDelta",
				dashboardStatsStreamDelta: makeDelta({ requestId: subId }),
			})

			expect(result.current.state.sequence).toBe(101)
			expect(result.current.state.totals!.events).toBe(11)
		})

		it("should apply error to state while preserving data", () => {
			const { result } = renderHook(() =>
				useDashboardStatsStream({
					range: makeQuery(),
					heatmapRangeDays: 30,
				}),
			)

			const subId = getSubscriptionId()
			postExtensionMessage({
				type: "dashboardStatsStreamSnapshot",
				dashboardStatsStreamSnapshot: makeSnapshot({ requestId: subId }),
			})

			postExtensionMessage({
				type: "dashboardStatsStreamError",
				dashboardStatsStreamError: {
					requestId: subId,
					code: "STATS_STREAM/query/001",
					message: "Query failed",
				} as DashboardStatsError,
			})

			expect(result.current.state.status).toBe("error")
			expect(result.current.state.backgroundError).not.toBeNull()
			expect(result.current.state.totals).not.toBeNull() // Data preserved
		})

		it("should apply task page to state", () => {
			const { result } = renderHook(() =>
				useDashboardStatsStream({
					range: makeQuery(),
					heatmapRangeDays: 30,
				}),
			)

			const subId = getSubscriptionId()
			postExtensionMessage({
				type: "dashboardStatsStreamSnapshot",
				dashboardStatsStreamSnapshot: makeSnapshot({ requestId: subId }),
			})

			const page: DashboardTaskPage = {
				requestId: subId,
				catalogRevision: 1,
				tasks: [
					{
						taskId: "task-002",
						rootTaskId: "root-002",
						title: "Second task",
						taskTimestamp: Date.now(),
						totalCost: 0.03,
						totalTokens: 800,
						model: "claude",
						provider: "anthropic",
						eventCount: 1,
						childTaskIds: [],
					},
				],
				totalEstimate: 2,
			}

			postExtensionMessage({
				type: "dashboardTaskPageResponse",
				dashboardTaskPage: page,
			})

			expect(result.current.state.tasks["task-002"]).toBeDefined()
			expect(result.current.state.taskOrder).toEqual(["task-001", "task-002"])
		})

		it("should reject stale-epoch snapshot", () => {
			const { result } = renderHook(() =>
				useDashboardStatsStream({
					range: makeQuery(),
					heatmapRangeDays: 30,
				}),
			)

			const subId = getSubscriptionId()
			// Send snapshot with wrong requestId
			postExtensionMessage({
				type: "dashboardStatsStreamSnapshot",
				dashboardStatsStreamSnapshot: makeSnapshot({ requestId: "wrong-epoch" }),
			})

			expect(result.current.state.status).toBe("loading")
			expect(result.current.state.totals).toBeNull()

			// Correct snapshot should work
			postExtensionMessage({
				type: "dashboardStatsStreamSnapshot",
				dashboardStatsStreamSnapshot: makeSnapshot({ requestId: subId }),
			})
			expect(result.current.state.status).toBe("connected")
		})

		it("should reject stale-epoch delta", () => {
			const { result } = renderHook(() =>
				useDashboardStatsStream({
					range: makeQuery(),
					heatmapRangeDays: 30,
				}),
			)

			const subId = getSubscriptionId()
			postExtensionMessage({
				type: "dashboardStatsStreamSnapshot",
				dashboardStatsStreamSnapshot: makeSnapshot({ requestId: subId }),
			})

			// Stale delta
			postExtensionMessage({
				type: "dashboardStatsStreamDelta",
				dashboardStatsStreamDelta: makeDelta({ requestId: "wrong-epoch" }),
			})
			expect(result.current.state.sequence).toBe(100) // Unchanged

			// Correct delta
			postExtensionMessage({
				type: "dashboardStatsStreamDelta",
				dashboardStatsStreamDelta: makeDelta({ requestId: subId }),
			})
			expect(result.current.state.sequence).toBe(101)
		})

		it("should set pendingResync on generation mismatch and ignore subsequent deltas", () => {
			const { result } = renderHook(() =>
				useDashboardStatsStream({
					range: makeQuery(),
					heatmapRangeDays: 30,
				}),
			)

			const subId = getSubscriptionId()
			postExtensionMessage({
				type: "dashboardStatsStreamSnapshot",
				dashboardStatsStreamSnapshot: makeSnapshot({ requestId: subId, generation: 1 }),
			})

			// Generation mismatch delta
			postExtensionMessage({
				type: "dashboardStatsStreamDelta",
				dashboardStatsStreamDelta: makeDelta({ requestId: subId, generation: 2, sequence: 200 }),
			})
			expect(result.current.state.pendingResync).toBe(true)

			// Subsequent delta ignored
			postExtensionMessage({
				type: "dashboardStatsStreamDelta",
				dashboardStatsStreamDelta: makeDelta({ requestId: subId, generation: 2, sequence: 201 }),
			})
			expect(result.current.state.sequence).toBe(100) // Still old sequence

			// Resync snapshot clears flag
			postExtensionMessage({
				type: "dashboardStatsStreamSnapshot",
				dashboardStatsStreamSnapshot: makeSnapshot({ requestId: subId, generation: 2, sequence: 200 }),
			})
			expect(result.current.state.pendingResync).toBe(false)
			expect(result.current.state.generation).toBe(2)
		})

		it("should ignore malformed messages", () => {
			const { result } = renderHook(() =>
				useDashboardStatsStream({
					range: makeQuery(),
					heatmapRangeDays: 30,
				}),
			)

			// Missing type field should be ignored without throwing.
			expect(() => {
				postExtensionMessage({ dashboardStatsStreamSnapshot: makeSnapshot() })
			}).not.toThrow()

			// Non-string type should be ignored.
			expect(() => {
				postExtensionMessage({ type: 123, dashboardStatsStreamSnapshot: makeSnapshot() })
			}).not.toThrow()

			// Null/undefined message data should be ignored.
			expect(() => {
				postExtensionMessage(null as unknown as Record<string, unknown>)
			}).not.toThrow()

			expect(result.current.state.status).toBe("loading")
		})

		it("should set an error when loading times out", () => {
			const { result } = renderHook(() =>
				useDashboardStatsStream({
					range: makeQuery(),
					heatmapRangeDays: 30,
				}),
			)

			expect(result.current.state.status).toBe("loading")
			expect(result.current.state.isLoading).toBe(true)

			act(() => {
				vi.advanceTimersByTime(10000)
			})

			expect(result.current.state.status).toBe("error")
			expect(result.current.state.isLoading).toBe(false)
			expect(result.current.state.backgroundError).not.toBeNull()
			expect(result.current.state.backgroundError?.code).toBe("STATS_HANDLER/stream/timeout")
		})

		it("should ignore duplicate sequence delta", () => {
			const { result } = renderHook(() =>
				useDashboardStatsStream({
					range: makeQuery(),
					heatmapRangeDays: 30,
				}),
			)

			const subId = getSubscriptionId()
			postExtensionMessage({
				type: "dashboardStatsStreamSnapshot",
				dashboardStatsStreamSnapshot: makeSnapshot({ requestId: subId, sequence: 100 }),
			})

			// Duplicate sequence
			postExtensionMessage({
				type: "dashboardStatsStreamDelta",
				dashboardStatsStreamDelta: makeDelta({ requestId: subId, sequence: 100 }),
			})
			expect(result.current.state.sequence).toBe(100) // Unchanged
			expect(result.current.state.totals!.events).toBe(10) // Unchanged
		})
	})

	describe("pause/resume on visibility", () => {
		it("should send pauseDashboardStats when visible becomes false", () => {
			const { rerender } = renderHook(
				({ visible }) =>
					useDashboardStatsStream({
						range: makeQuery(),
						heatmapRangeDays: 30,
						visible,
					}),
				{ initialProps: { visible: true } },
			)

			const subId = getSubscriptionId()
			postMessageMock.mockClear()

			rerender({ visible: false })

			expect(postMessageMock).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "pauseDashboardStats",
					requestId: subId,
				}),
			)
		})

		it("should send resumeDashboardStats when visible becomes true", () => {
			const { rerender } = renderHook(
				({ visible }) =>
					useDashboardStatsStream({
						range: makeQuery(),
						heatmapRangeDays: 30,
						visible,
					}),
				{ initialProps: { visible: true } },
			)

			const subId = getSubscriptionId()
			rerender({ visible: false })
			postMessageMock.mockClear()

			rerender({ visible: true })

			expect(postMessageMock).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "resumeDashboardStats",
					requestId: subId,
				}),
			)
		})
	})

	describe("replaceSubscription", () => {
		it("should send replaceDashboardStatsSubscription with new epoch", () => {
			const { result } = renderHook(() =>
				useDashboardStatsStream({
					range: makeQuery(),
					heatmapRangeDays: 30,
				}),
			)

			postMessageMock.mockClear()

			const newRange = makeQuery({ preset: "7d" })
			act(() => {
				result.current.replaceSubscription(newRange, 60)
			})

			expect(postMessageMock).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "replaceDashboardStatsSubscription",
					dashboardStatsSubscription: expect.objectContaining({
						range: newRange,
						heatmapRangeDays: 60,
					}),
				}),
			)
		})

		it("should reject old-epoch responses after replace", () => {
			const { result } = renderHook(() =>
				useDashboardStatsStream({
					range: makeQuery(),
					heatmapRangeDays: 30,
				}),
			)

			const oldSubId = getSubscriptionId()
			postExtensionMessage({
				type: "dashboardStatsStreamSnapshot",
				dashboardStatsStreamSnapshot: makeSnapshot({ requestId: oldSubId }),
			})
			expect(result.current.state.totals).not.toBeNull()

			// Replace subscription
			act(() => {
				result.current.replaceSubscription(makeQuery({ preset: "7d" }), 60)
			})

			// Old-epoch snapshot should be rejected
			postExtensionMessage({
				type: "dashboardStatsStreamSnapshot",
				dashboardStatsStreamSnapshot: makeSnapshot({ requestId: oldSubId }),
			})

			// State should still have old data (stale-while-revalidate) but new subscriptionId
			expect(result.current.state.totals).not.toBeNull()
		})
	})

	describe("requestTaskPage", () => {
		it("should send getDashboardTaskPage with cursor", () => {
			const { result } = renderHook(() =>
				useDashboardStatsStream({
					range: makeQuery(),
					heatmapRangeDays: 30,
				}),
			)

			const subId = getSubscriptionId()
			postMessageMock.mockClear()

			act(() => {
				result.current.requestTaskPage("cursor-123")
			})

			expect(postMessageMock).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "getDashboardTaskPage",
					requestId: subId,
					dashboardTaskCursor: "cursor-123",
					dashboardTaskLimit: 50,
				}),
			)
		})

		it("should use state taskCursor when no cursor provided", () => {
			const { result } = renderHook(() =>
				useDashboardStatsStream({
					range: makeQuery(),
					heatmapRangeDays: 30,
				}),
			)

			const subId = getSubscriptionId()
			postExtensionMessage({
				type: "dashboardStatsStreamSnapshot",
				dashboardStatsStreamSnapshot: makeSnapshot({
					requestId: subId,
					tasks: {
						requestId: subId,
						catalogRevision: 1,
						tasks: [],
						cursor: "state-cursor",
						totalEstimate: 0,
					},
				}),
			})

			postMessageMock.mockClear()

			act(() => {
				result.current.requestTaskPage()
			})

			expect(postMessageMock).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "getDashboardTaskPage",
					dashboardTaskCursor: "state-cursor",
				}),
			)
		})
	})

	describe("no post-unmount state update", () => {
		it("should not update state after unmount", () => {
			const { result, unmount } = renderHook(() =>
				useDashboardStatsStream({
					range: makeQuery(),
					heatmapRangeDays: 30,
				}),
			)

			const subId = getSubscriptionId()
			unmount()

			// Dispatch message after unmount — should not throw
			expect(() => {
				postExtensionMessage({
					type: "dashboardStatsStreamSnapshot",
					dashboardStatsStreamSnapshot: makeSnapshot({ requestId: subId }),
				})
			}).not.toThrow()

			// State should remain as it was at unmount
			expect(result.current.state.status).toBe("loading")
		})
	})

	describe("didBecomeVisible action", () => {
		it("should handle didBecomeVisible action message", () => {
			const { result: _result } = renderHook(() =>
				useDashboardStatsStream({
					range: makeQuery(),
					heatmapRangeDays: 30,
					visible: false,
				}),
			)

			const subId = getSubscriptionId()
			postMessageMock.mockClear()

			// Simulate host sending didBecomeVisible
			postExtensionMessage({
				type: "action",
				action: "didBecomeVisible",
			})

			// Should send resumeDashboardStats
			expect(postMessageMock).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "resumeDashboardStats",
					requestId: subId,
				}),
			)
		})
	})
})
