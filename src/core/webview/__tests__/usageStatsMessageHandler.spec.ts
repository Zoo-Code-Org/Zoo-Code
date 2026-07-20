import type { WebviewMessage, StatsQuery, StatsSnapshot, UsageEventV1 } from "@roo-code/types"
import type { ClineProvider } from "../ClineProvider"
import type { UsageStatsService, JsonExport } from "../../../services/stats"
import { StatsServiceError } from "../../../services/stats"

vi.mock("vscode", () => ({
	window: {
		showSaveDialog: vi.fn(),
		showErrorMessage: vi.fn(),
	},
	workspace: {
		fs: {
			writeFile: vi.fn(),
		},
	},
}))

vi.mock("../../../utils/export", () => ({
	resolveDefaultSaveUri: vi.fn(),
	saveLastExportPath: vi.fn(),
}))

vi.mock("../task-persistence/taskMessages", () => ({
	readTaskMessages: vi.fn().mockResolvedValue([]),
}))

vi.mock("../../../services/stats/costRecalculation", () => ({
	getEffectiveCost: vi.fn((event: UsageEventV1) => event.usage.costUsd?.value ?? 0),
}))

import * as vscode from "vscode"
import { resolveDefaultSaveUri, saveLastExportPath } from "../../../utils/export"
import { readTaskMessages } from "../task-persistence/taskMessages"
import { getEffectiveCost } from "../../../services/stats/costRecalculation"
import {
	handleGetUsageStats,
	handleClearUsageStats,
	handleExportUsageStats,
	handleRequestClearNonce,
	handleGetDashboardSessions,
	handleGetDashboardSessionDetail,
} from "../usageStatsMessageHandler"

// ── Test Fixtures ────────────────────────────────────────────────────────────

const validQuery: StatsQuery = {
	timezone: "UTC",
	groupBy: ["day"],
	includeCancelled: false,
}

const mockSnapshot: StatsSnapshot = {
	query: validQuery,
	generatedAt: "2026-07-19T00:00:00.000Z",
	buckets: [],
	totals: {
		key: {},
		events: 0,
		completedCalls: 0,
		failedCalls: 0,
		cancelledCalls: 0,
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		reasoningTokens: 0,
		totalTokens: 0,
		costUsd: 0,
		unknownEventCount: 0,
	},
	coverage: {
		recordingPaused: false,
		backfilledEventCount: 0,
	},
}

const mockJsonExport: JsonExport = {
	exportSchemaVersion: 1,
	exportedAt: "2026-07-19T00:00:00.000Z",
	query: validQuery,
	events: [],
}

// ── Mock Provider Factory ────────────────────────────────────────────────────

const createMockProvider = (service?: Partial<UsageStatsService>): ClineProvider => {
	const mockLog = vi.fn()
	const mockPostMessageToWebview = vi.fn()
	const mockContextProxy = {
		getValue: vi.fn(),
		setValue: vi.fn(),
		globalStorageUri: { fsPath: "/tmp/globalStorage" } as vscode.Uri,
	}

	const mockService = service
		? (service as UsageStatsService)
		: undefined

	return {
		log: mockLog,
		postMessageToWebview: mockPostMessageToWebview,
		getUsageStatsService: vi.fn(() => mockService),
		contextProxy: mockContextProxy,
	} as unknown as ClineProvider
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("usageStatsMessageHandler", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.mocked(resolveDefaultSaveUri).mockResolvedValue(undefined as unknown as vscode.Uri)
		vi.mocked(saveLastExportPath).mockResolvedValue(undefined)
		vi.mocked(vscode.workspace.fs.writeFile).mockResolvedValue(undefined)
	})

	// ── handleGetUsageStats ──────────────────────────────────────────────────

	describe("handleGetUsageStats", () => {
		it("posts snapshot on valid query", async () => {
			const queryStats = vi.fn().mockResolvedValue(mockSnapshot)
			const isCapped = vi.fn(() => false)
			const provider = createMockProvider({ queryStats, isCapped })

			const message: WebviewMessage = {
				type: "getUsageStats",
				requestId: "req-1",
				usageStatsQuery: validQuery,
			}

			await handleGetUsageStats(provider, message)

			expect(queryStats).toHaveBeenCalledWith(validQuery, { recordingPaused: false })
			expect(provider.postMessageToWebview).toHaveBeenCalledWith({
				type: "getUsageStatsResponse",
				requestId: "req-1",
				usageStatsSnapshot: mockSnapshot,
			})
		})

		it("returns error when service is unavailable", async () => {
			const provider = createMockProvider(undefined)

			const message: WebviewMessage = {
				type: "getUsageStats",
				requestId: "req-2",
				usageStatsQuery: validQuery,
			}

			await handleGetUsageStats(provider, message)

			expect(provider.postMessageToWebview).toHaveBeenCalledWith({
				type: "getUsageStatsResponse",
				requestId: "req-2",
				error: expect.stringContaining("STATS_HANDLER/query/002"),
			})
		})

		it("rejects invalid payload (missing timezone)", async () => {
			const queryStats = vi.fn()
			const provider = createMockProvider({ queryStats })

			const message: WebviewMessage = {
				type: "getUsageStats",
				requestId: "req-3",
				usageStatsQuery: {
					groupBy: ["day"],
				} as StatsQuery, // missing timezone
			}

			await handleGetUsageStats(provider, message)

			expect(queryStats).not.toHaveBeenCalled()
			expect(provider.postMessageToWebview).toHaveBeenCalledWith({
				type: "getUsageStatsResponse",
				requestId: "req-3",
				error: expect.stringContaining("STATS_HANDLER/query/001"),
			})
		})

		it("rejects invalid payload (missing groupBy)", async () => {
			const queryStats = vi.fn()
			const provider = createMockProvider({ queryStats })

			const message: WebviewMessage = {
				type: "getUsageStats",
				requestId: "req-4",
				usageStatsQuery: {
					timezone: "UTC",
				} as StatsQuery, // missing groupBy
			}

			await handleGetUsageStats(provider, message)

			expect(queryStats).not.toHaveBeenCalled()
			expect(provider.postMessageToWebview).toHaveBeenCalledWith({
				type: "getUsageStatsResponse",
				requestId: "req-4",
				error: expect.stringContaining("STATS_HANDLER/query/001"),
			})
		})

		it("returns error on service exception", async () => {
			const queryStats = vi.fn().mockRejectedValue(new Error("store read failed"))
			const isCapped = vi.fn(() => false)
			const provider = createMockProvider({ queryStats, isCapped })

			const message: WebviewMessage = {
				type: "getUsageStats",
				requestId: "req-5",
				usageStatsQuery: validQuery,
			}

			await handleGetUsageStats(provider, message)

			expect(provider.postMessageToWebview).toHaveBeenCalledWith({
				type: "getUsageStatsResponse",
				requestId: "req-5",
				error: expect.stringContaining("STATS_HANDLER/query/003"),
			})
		})

		it("passes recordingPaused=true when service is capped", async () => {
			const queryStats = vi.fn().mockResolvedValue(mockSnapshot)
			const isCapped = vi.fn(() => true)
			const provider = createMockProvider({ queryStats, isCapped })

			const message: WebviewMessage = {
				type: "getUsageStats",
				requestId: "req-6",
				usageStatsQuery: validQuery,
			}

			await handleGetUsageStats(provider, message)

			expect(queryStats).toHaveBeenCalledWith(validQuery, { recordingPaused: true })
		})
	})

	// ── handleClearUsageStats ────────────────────────────────────────────────

	describe("handleClearUsageStats", () => {
		it("clears stats on valid nonce", async () => {
			const clearStats = vi.fn().mockResolvedValue(undefined)
			const provider = createMockProvider({ clearStats })

			const message: WebviewMessage = {
				type: "clearUsageStats",
				requestId: "req-clear-1",
				clearUsageStatsNonce: "valid-nonce-123",
			}

			await handleClearUsageStats(provider, message)

			expect(clearStats).toHaveBeenCalledWith("valid-nonce-123")
			expect(provider.postMessageToWebview).toHaveBeenCalledWith({
				type: "usageStatsChanged",
			})
			expect(provider.postMessageToWebview).toHaveBeenCalledWith({
				type: "clearUsageStatsResponse",
				requestId: "req-clear-1",
				clearUsageStatsResult: { success: true },
			})
		})

		it("rejects missing nonce", async () => {
			const clearStats = vi.fn()
			const provider = createMockProvider({ clearStats })

			const message: WebviewMessage = {
				type: "clearUsageStats",
				requestId: "req-clear-2",
				clearUsageStatsNonce: undefined,
			}

			await handleClearUsageStats(provider, message)

			expect(clearStats).not.toHaveBeenCalled()
			expect(provider.postMessageToWebview).toHaveBeenCalledWith({
				type: "clearUsageStatsResponse",
				requestId: "req-clear-2",
				clearUsageStatsResult: {
					success: false,
					error: expect.stringContaining("STATS_HANDLER/clear/001"),
				},
			})
		})

		it("rejects empty nonce", async () => {
			const clearStats = vi.fn()
			const provider = createMockProvider({ clearStats })

			const message: WebviewMessage = {
				type: "clearUsageStats",
				requestId: "req-clear-3",
				clearUsageStatsNonce: "",
			}

			await handleClearUsageStats(provider, message)

			expect(clearStats).not.toHaveBeenCalled()
			expect(provider.postMessageToWebview).toHaveBeenCalledWith({
				type: "clearUsageStatsResponse",
				requestId: "req-clear-3",
				clearUsageStatsResult: {
					success: false,
					error: expect.stringContaining("STATS_HANDLER/clear/001"),
				},
			})
		})

		it("returns error when service is unavailable", async () => {
			const provider = createMockProvider(undefined)

			const message: WebviewMessage = {
				type: "clearUsageStats",
				requestId: "req-clear-4",
				clearUsageStatsNonce: "some-nonce",
			}

			await handleClearUsageStats(provider, message)

			expect(provider.postMessageToWebview).toHaveBeenCalledWith({
				type: "clearUsageStatsResponse",
				requestId: "req-clear-4",
				clearUsageStatsResult: {
					success: false,
					error: expect.stringContaining("STATS_HANDLER/clear/002"),
				},
			})
		})

		it("returns error on expired nonce (StatsServiceError)", async () => {
			const clearStats = vi.fn().mockRejectedValue(
				new StatsServiceError("STATS_SERVICE/clear/001", "nonce expired"),
			)
			const provider = createMockProvider({ clearStats })

			const message: WebviewMessage = {
				type: "clearUsageStats",
				requestId: "req-clear-5",
				clearUsageStatsNonce: "expired-nonce",
			}

			await handleClearUsageStats(provider, message)

			expect(clearStats).toHaveBeenCalledWith("expired-nonce")
			expect(provider.postMessageToWebview).toHaveBeenCalledWith({
				type: "clearUsageStatsResponse",
				requestId: "req-clear-5",
				clearUsageStatsResult: {
					success: false,
					error: expect.stringContaining("STATS_HANDLER/clear/003"),
				},
			})
		})
	})

	// ── handleExportUsageStats ───────────────────────────────────────────────

	describe("handleExportUsageStats", () => {
		it("exports JSON and writes file", async () => {
			const exportStats = vi.fn().mockResolvedValue(mockJsonExport)
			const isCapped = vi.fn(() => false)
			const provider = createMockProvider({ exportStats, isCapped })

			const mockUri = { fsPath: "/tmp/usage-stats.json" } as vscode.Uri
			vi.mocked(vscode.window.showSaveDialog).mockResolvedValue(mockUri)

			const message: WebviewMessage = {
				type: "exportUsageStats",
				requestId: "req-export-1",
				exportUsageStatsFormat: "json",
				usageStatsQuery: validQuery,
			}

			await handleExportUsageStats(provider, message)

			expect(exportStats).toHaveBeenCalledWith(validQuery, "json")
			expect(vscode.workspace.fs.writeFile).toHaveBeenCalled()
			expect(saveLastExportPath).toHaveBeenCalled()
			expect(provider.postMessageToWebview).toHaveBeenCalledWith({
				type: "exportUsageStatsResponse",
				requestId: "req-export-1",
				exportUsageStatsResult: {
					format: "json",
					data: "usage-stats.json",
				},
			})
		})

		it("exports CSV and writes file", async () => {
			const csvContent = "eventId,status\nevt-1,completed"
			const exportStats = vi.fn().mockResolvedValue(csvContent)
			const isCapped = vi.fn(() => false)
			const provider = createMockProvider({ exportStats, isCapped })

			const mockUri = { fsPath: "/tmp/usage-stats.csv" } as vscode.Uri
			vi.mocked(vscode.window.showSaveDialog).mockResolvedValue(mockUri)

			const message: WebviewMessage = {
				type: "exportUsageStats",
				requestId: "req-export-2",
				exportUsageStatsFormat: "csv",
				usageStatsQuery: validQuery,
			}

			await handleExportUsageStats(provider, message)

			expect(exportStats).toHaveBeenCalledWith(validQuery, "csv")
			expect(vscode.workspace.fs.writeFile).toHaveBeenCalled()
			expect(provider.postMessageToWebview).toHaveBeenCalledWith({
				type: "exportUsageStatsResponse",
				requestId: "req-export-2",
				exportUsageStatsResult: {
					format: "csv",
					data: "usage-stats.csv",
				},
			})
		})

		it("handles save dialog cancel (not an error)", async () => {
			const exportStats = vi.fn().mockResolvedValue(mockJsonExport)
			const isCapped = vi.fn(() => false)
			const provider = createMockProvider({ exportStats, isCapped })

			vi.mocked(vscode.window.showSaveDialog).mockResolvedValue(undefined)

			const message: WebviewMessage = {
				type: "exportUsageStats",
				requestId: "req-export-3",
				exportUsageStatsFormat: "json",
				usageStatsQuery: validQuery,
			}

			await handleExportUsageStats(provider, message)

			expect(exportStats).toHaveBeenCalledWith(validQuery, "json")
			expect(vscode.workspace.fs.writeFile).not.toHaveBeenCalled()
			expect(provider.postMessageToWebview).toHaveBeenCalledWith({
				type: "exportUsageStatsResponse",
				requestId: "req-export-3",
				exportUsageStatsResult: {
					format: "json",
					data: "",
				},
			})
		})

		it("rejects unsupported format", async () => {
			const exportStats = vi.fn()
			const provider = createMockProvider({ exportStats })

			const message: WebviewMessage = {
				type: "exportUsageStats",
				requestId: "req-export-4",
				exportUsageStatsFormat: "xml" as "json",
				usageStatsQuery: validQuery,
			}

			await handleExportUsageStats(provider, message)

			expect(exportStats).not.toHaveBeenCalled()
			expect(provider.postMessageToWebview).toHaveBeenCalledWith({
				type: "exportUsageStatsResponse",
				requestId: "req-export-4",
				exportUsageStatsResult: {
					format: "json",
					data: "",
					error: expect.stringContaining("STATS_HANDLER/export/004"),
				},
			})
		})

		it("rejects invalid query", async () => {
			const exportStats = vi.fn()
			const provider = createMockProvider({ exportStats })

			const message: WebviewMessage = {
				type: "exportUsageStats",
				requestId: "req-export-5",
				exportUsageStatsFormat: "json",
				usageStatsQuery: {
					groupBy: ["day"],
				} as StatsQuery, // missing timezone
			}

			await handleExportUsageStats(provider, message)

			expect(exportStats).not.toHaveBeenCalled()
			expect(provider.postMessageToWebview).toHaveBeenCalledWith({
				type: "exportUsageStatsResponse",
				requestId: "req-export-5",
				exportUsageStatsResult: {
					format: "json",
					data: "",
					error: expect.stringContaining("STATS_HANDLER/export/001"),
				},
			})
		})

		it("returns error when service is unavailable", async () => {
			const provider = createMockProvider(undefined)

			const message: WebviewMessage = {
				type: "exportUsageStats",
				requestId: "req-export-6",
				exportUsageStatsFormat: "json",
				usageStatsQuery: validQuery,
			}

			await handleExportUsageStats(provider, message)

			expect(provider.postMessageToWebview).toHaveBeenCalledWith({
				type: "exportUsageStatsResponse",
				requestId: "req-export-6",
				exportUsageStatsResult: {
					format: "json",
					data: "",
					error: expect.stringContaining("STATS_HANDLER/export/002"),
				},
			})
		})

		it("returns error on service exception", async () => {
			const exportStats = vi.fn().mockRejectedValue(new Error("store read failed"))
			const isCapped = vi.fn(() => false)
			const provider = createMockProvider({ exportStats, isCapped })

			const message: WebviewMessage = {
				type: "exportUsageStats",
				requestId: "req-export-7",
				exportUsageStatsFormat: "json",
				usageStatsQuery: validQuery,
			}

			await handleExportUsageStats(provider, message)

			expect(provider.postMessageToWebview).toHaveBeenCalledWith({
				type: "exportUsageStatsResponse",
				requestId: "req-export-7",
				exportUsageStatsResult: {
					format: "json",
					data: "",
					error: expect.stringContaining("STATS_HANDLER/export/003"),
				},
			})
		})
	})

	// ── handleRequestClearNonce ──────────────────────────────────────────────

	describe("handleRequestClearNonce", () => {
		it("posts requestClearNonceResponse with nonce from service", async () => {
			const issueClearNonce = vi.fn(() => "test-nonce-abc")
			const provider = createMockProvider({ issueClearNonce })

			const message: WebviewMessage = {
				type: "requestClearNonce",
				requestId: "req-nonce-1",
			}

			await handleRequestClearNonce(provider, message)

			expect(issueClearNonce).toHaveBeenCalled()
			expect(provider.postMessageToWebview).toHaveBeenCalledWith({
				type: "requestClearNonceResponse",
				requestId: "req-nonce-1",
				clearNonce: "test-nonce-abc",
			})
		})

		it("posts error response when service is unavailable", async () => {
			const provider = createMockProvider(undefined)

			const message: WebviewMessage = {
				type: "requestClearNonce",
				requestId: "req-nonce-2",
			}

			await handleRequestClearNonce(provider, message)

			expect(provider.postMessageToWebview).toHaveBeenCalledWith({
				type: "requestClearNonceResponse",
				requestId: "req-nonce-2",
				clearNonce: null,
				error: expect.stringContaining("[STATS_HANDLER/clear/002]"),
			})
		})
	})

	// ── handleGetDashboardSessions ────────────────────────────────────────────

	describe("handleGetDashboardSessions", () => {
		const makeEvent = (overrides: Partial<UsageEventV1> = {}): UsageEventV1 => ({
			schemaVersion: 1,
			eventId: `evt-${Math.random().toString(36).slice(2)}`,
			idempotencyKey: `key-${Math.random().toString(36).slice(2)}`,
			occurredAt: "2026-07-19T10:00:00.000Z",
			timezoneOffsetMinutes: 0,
			status: "completed",
			attempt: 1,
			taskId: "task-001",
			provider: "openai",
			model: "gpt-4",
			mode: "code",
			usage: {
				inputTokens: { value: 100, source: "provider" },
				outputTokens: { value: 50, source: "provider" },
				totalTokens: { value: 150, source: "provider" },
				costUsd: { value: 0.05, source: "provider" },
			},
			semantics: {
				cacheReadInInput: "excluded",
				cacheWriteInInput: "excluded",
				reasoningInOutput: "excluded",
			},
			provenance: "live",
			...overrides,
		})

		it("returns empty sessions list when no events", async () => {
			const exportStats = vi.fn().mockResolvedValue(mockJsonExport)
			const provider = createMockProvider({ exportStats })

			const message: WebviewMessage = {
				type: "getDashboardSessions",
				requestId: "req-sessions-1",
				usageStatsQuery: validQuery,
			}

			await handleGetDashboardSessions(provider, message)

			expect(exportStats).toHaveBeenCalledWith(validQuery, "json")
			expect(provider.postMessageToWebview).toHaveBeenCalledWith({
				type: "dashboardSessionsResponse",
				requestId: "req-sessions-1",
				dashboardSessions: [],
			})
		})

		it("groups events by root taskId and returns summaries", async () => {
			const events: UsageEventV1[] = [
				makeEvent({
					taskId: "task-A",
					occurredAt: "2026-07-19T10:00:00.000Z",
					model: "gpt-4",
					mode: "code",
					provider: "openai",
					usage: {
						inputTokens: { value: 100, source: "provider" },
						outputTokens: { value: 50, source: "provider" },
						totalTokens: { value: 150, source: "provider" },
						costUsd: { value: 0.05, source: "provider" },
					},
				}),
				makeEvent({
					taskId: "task-B",
					occurredAt: "2026-07-19T11:00:00.000Z",
					model: "claude-3",
					mode: "architect",
					provider: "anthropic",
					usage: {
						inputTokens: { value: 200, source: "provider" },
						outputTokens: { value: 100, source: "provider" },
						totalTokens: { value: 300, source: "provider" },
						costUsd: { value: 0.10, source: "provider" },
					},
				}),
			]

			const exportData: JsonExport = {
				...mockJsonExport,
				events,
			}
			const exportStats = vi.fn().mockResolvedValue(exportData)
			const provider = createMockProvider({ exportStats })

			const message: WebviewMessage = {
				type: "getDashboardSessions",
				requestId: "req-sessions-2",
				usageStatsQuery: validQuery,
			}

			await handleGetDashboardSessions(provider, message)

			const response = vi.mocked(provider.postMessageToWebview).mock.calls.find(
				(c) => c[0]?.type === "dashboardSessionsResponse",
			)

			expect(response).toBeDefined()
			expect(response?.[0].dashboardSessions).toHaveLength(2)

			// Sessions should be sorted by timestamp descending (task-B is later)
			const sessions = response?.[0].dashboardSessions
			expect(sessions?.[0].taskId).toBe("task-B")
			expect(sessions?.[1].taskId).toBe("task-A")

			// Verify summary fields
			expect(sessions?.[0]).toMatchObject({
				taskId: "task-B",
				model: "claude-3",
				provider: "anthropic",
				mode: "architect",
				models: ["claude-3"],
				modes: ["architect"],
				totalTokens: 300,
				totalCost: 0.10,
				callCount: 1,
			})
		})

		it("groups subtask events under root task via parentTaskId", async () => {
			const events: UsageEventV1[] = [
				makeEvent({
					taskId: "task-root",
					occurredAt: "2026-07-19T10:00:00.000Z",
					parentTaskId: undefined,
				}),
				makeEvent({
					taskId: "task-sub-1",
					occurredAt: "2026-07-19T10:30:00.000Z",
					parentTaskId: "task-root",
				}),
				makeEvent({
					taskId: "task-sub-2",
					occurredAt: "2026-07-19T11:00:00.000Z",
					parentTaskId: "task-root",
				}),
			]

			const exportData: JsonExport = { ...mockJsonExport, events }
			const exportStats = vi.fn().mockResolvedValue(exportData)
			const provider = createMockProvider({ exportStats })

			const message: WebviewMessage = {
				type: "getDashboardSessions",
				requestId: "req-sessions-3",
				usageStatsQuery: validQuery,
			}

			await handleGetDashboardSessions(provider, message)

			const response = vi.mocked(provider.postMessageToWebview).mock.calls.find(
				(c) => c[0]?.type === "dashboardSessionsResponse",
			)

			expect(response?.[0].dashboardSessions).toHaveLength(1)
			expect(response?.[0].dashboardSessions?.[0].taskId).toBe("task-root")
			expect(response?.[0].dashboardSessions?.[0].callCount).toBe(3)
		})

		it("applies model filter post-grouping", async () => {
			const events: UsageEventV1[] = [
				makeEvent({
					taskId: "task-A",
					model: "gpt-4",
					occurredAt: "2026-07-19T10:00:00.000Z",
				}),
				makeEvent({
					taskId: "task-B",
					model: "claude-3",
					occurredAt: "2026-07-19T11:00:00.000Z",
				}),
			]

			const exportData: JsonExport = { ...mockJsonExport, events }
			const exportStats = vi.fn().mockResolvedValue(exportData)
			const provider = createMockProvider({ exportStats })

			const message: WebviewMessage = {
				type: "getDashboardSessions",
				requestId: "req-sessions-4",
				usageStatsQuery: validQuery,
				dashboardSessionFilters: { model: "gpt-4" },
			}

			await handleGetDashboardSessions(provider, message)

			const response = vi.mocked(provider.postMessageToWebview).mock.calls.find(
				(c) => c[0]?.type === "dashboardSessionsResponse",
			)

			expect(response?.[0].dashboardSessions).toHaveLength(1)
			expect(response?.[0].dashboardSessions?.[0].taskId).toBe("task-A")
		})

		it("applies provider filter post-grouping", async () => {
			const events: UsageEventV1[] = [
				makeEvent({
					taskId: "task-A",
					provider: "openai",
					occurredAt: "2026-07-19T10:00:00.000Z",
				}),
				makeEvent({
					taskId: "task-B",
					provider: "anthropic",
					occurredAt: "2026-07-19T11:00:00.000Z",
				}),
			]

			const exportData: JsonExport = { ...mockJsonExport, events }
			const exportStats = vi.fn().mockResolvedValue(exportData)
			const provider = createMockProvider({ exportStats })

			const message: WebviewMessage = {
				type: "getDashboardSessions",
				requestId: "req-sessions-5",
				usageStatsQuery: validQuery,
				dashboardSessionFilters: { provider: "anthropic" },
			}

			await handleGetDashboardSessions(provider, message)

			const response = vi.mocked(provider.postMessageToWebview).mock.calls.find(
				(c) => c[0]?.type === "dashboardSessionsResponse",
			)

			expect(response?.[0].dashboardSessions).toHaveLength(1)
			expect(response?.[0].dashboardSessions?.[0].taskId).toBe("task-B")
		})

		it("returns error when service is unavailable", async () => {
			const provider = createMockProvider(undefined)

			const message: WebviewMessage = {
				type: "getDashboardSessions",
				requestId: "req-sessions-6",
				usageStatsQuery: validQuery,
			}

			await handleGetDashboardSessions(provider, message)

			expect(provider.postMessageToWebview).toHaveBeenCalledWith({
				type: "dashboardSessionsResponse",
				requestId: "req-sessions-6",
				dashboardSessions: null,
				error: expect.stringContaining("STATS_HANDLER/sessions/002"),
			})
		})

		it("rejects invalid query", async () => {
			const exportStats = vi.fn()
			const provider = createMockProvider({ exportStats })

			const message: WebviewMessage = {
				type: "getDashboardSessions",
				requestId: "req-sessions-7",
				usageStatsQuery: {
					groupBy: ["day"],
				} as StatsQuery, // missing timezone
			}

			await handleGetDashboardSessions(provider, message)

			expect(exportStats).not.toHaveBeenCalled()
			expect(provider.postMessageToWebview).toHaveBeenCalledWith({
				type: "dashboardSessionsResponse",
				requestId: "req-sessions-7",
				dashboardSessions: null,
				error: expect.stringContaining("STATS_HANDLER/sessions/001"),
			})
		})

		it("returns error on service exception", async () => {
			const exportStats = vi.fn().mockRejectedValue(new Error("store read failed"))
			const provider = createMockProvider({ exportStats })

			const message: WebviewMessage = {
				type: "getDashboardSessions",
				requestId: "req-sessions-8",
				usageStatsQuery: validQuery,
			}

			await handleGetDashboardSessions(provider, message)

			expect(provider.postMessageToWebview).toHaveBeenCalledWith({
				type: "dashboardSessionsResponse",
				requestId: "req-sessions-8",
				dashboardSessions: null,
				error: expect.stringContaining("STATS_HANDLER/sessions/003"),
			})
		})

		it("uses getEffectiveCost for events without costUsd", async () => {
			vi.mocked(getEffectiveCost).mockReturnValue(0.15)

			const events: UsageEventV1[] = [
				makeEvent({
					taskId: "task-A",
					usage: {
						inputTokens: { value: 100, source: "provider" },
						outputTokens: { value: 50, source: "provider" },
						totalTokens: { value: 150, source: "provider" },
						// costUsd intentionally missing
					},
				}),
			]

			const exportData: JsonExport = { ...mockJsonExport, events }
			const exportStats = vi.fn().mockResolvedValue(exportData)
			const provider = createMockProvider({ exportStats })

			const message: WebviewMessage = {
				type: "getDashboardSessions",
				requestId: "req-sessions-9",
				usageStatsQuery: validQuery,
			}

			await handleGetDashboardSessions(provider, message)

			expect(getEffectiveCost).toHaveBeenCalled()
			const response = vi.mocked(provider.postMessageToWebview).mock.calls.find(
				(c) => c[0]?.type === "dashboardSessionsResponse",
			)
			expect(response?.[0].dashboardSessions?.[0].totalCost).toBe(0.15)

			// Reset mock to default
			vi.mocked(getEffectiveCost).mockImplementation(
				(event: UsageEventV1) => event.usage.costUsd?.value ?? 0,
			)
		})
	})

	// ── handleGetDashboardSessionDetail ───────────────────────────────────────

	describe("handleGetDashboardSessionDetail", () => {
		const makeEvent = (overrides: Partial<UsageEventV1> = {}): UsageEventV1 => ({
			schemaVersion: 1,
			eventId: `evt-${Math.random().toString(36).slice(2)}`,
			idempotencyKey: `key-${Math.random().toString(36).slice(2)}`,
			occurredAt: "2026-07-19T10:00:00.000Z",
			timezoneOffsetMinutes: 0,
			status: "completed",
			attempt: 1,
			taskId: "task-001",
			provider: "openai",
			model: "gpt-4",
			mode: "code",
			usage: {
				inputTokens: { value: 100, source: "provider" },
				outputTokens: { value: 50, source: "provider" },
				totalTokens: { value: 150, source: "provider" },
				costUsd: { value: 0.05, source: "provider" },
			},
			semantics: {
				cacheReadInInput: "excluded",
				cacheWriteInInput: "excluded",
				reasoningInOutput: "excluded",
			},
			provenance: "live",
			...overrides,
		})

		it("returns session detail with apiCalls for a valid taskId", async () => {
			const events: UsageEventV1[] = [
				makeEvent({
					taskId: "task-001",
					occurredAt: "2026-07-19T10:00:00.000Z",
					usage: {
						inputTokens: { value: 100, source: "provider" },
						outputTokens: { value: 50, source: "provider" },
						totalTokens: { value: 150, source: "provider" },
						costUsd: { value: 0.05, source: "provider" },
					},
				}),
				makeEvent({
					taskId: "task-001",
					occurredAt: "2026-07-19T10:30:00.000Z",
					usage: {
						inputTokens: { value: 200, source: "provider" },
						outputTokens: { value: 100, source: "provider" },
						totalTokens: { value: 300, source: "provider" },
						costUsd: { value: 0.10, source: "provider" },
					},
				}),
			]

			const exportData: JsonExport = { ...mockJsonExport, events }
			const exportStats = vi.fn().mockResolvedValue(exportData)
			const provider = createMockProvider({ exportStats })

			const message: WebviewMessage = {
				type: "getDashboardSessionDetail",
				requestId: "req-detail-1",
				taskId: "task-001",
			}

			await handleGetDashboardSessionDetail(provider, message)

			const response = vi.mocked(provider.postMessageToWebview).mock.calls.find(
				(c) => c[0]?.type === "dashboardSessionDetailResponse",
			)

			expect(response).toBeDefined()
			const detail = response?.[0].dashboardSessionDetail
			expect(detail).not.toBeNull()
			expect(detail?.taskId).toBe("task-001")
			expect(detail?.callCount).toBe(2)
			expect(detail?.totalTokens).toBe(450)
			expect(detail?.totalCost).toBeCloseTo(0.15, 10)
			expect(detail?.apiCalls).toHaveLength(2)
			expect(detail?.apiCalls?.[0]).toMatchObject({
				index: 1,
				mode: "code",
				inputTokens: 100,
				outputTokens: 50,
				costUsd: 0.05,
				status: "completed",
				model: "gpt-4",
			})
			expect(detail?.apiCalls?.[1]).toMatchObject({
				index: 2,
				inputTokens: 200,
				outputTokens: 100,
				costUsd: 0.10,
			})
		})

		it("includes subtask events via parentTaskId chain", async () => {
			const events: UsageEventV1[] = [
				makeEvent({
					taskId: "task-root",
					parentTaskId: undefined,
					occurredAt: "2026-07-19T10:00:00.000Z",
				}),
				makeEvent({
					taskId: "task-sub-1",
					parentTaskId: "task-root",
					occurredAt: "2026-07-19T10:30:00.000Z",
				}),
				makeEvent({
					taskId: "task-other",
					occurredAt: "2026-07-19T11:00:00.000Z",
				}),
			]

			const exportData: JsonExport = { ...mockJsonExport, events }
			const exportStats = vi.fn().mockResolvedValue(exportData)
			const provider = createMockProvider({ exportStats })

			const message: WebviewMessage = {
				type: "getDashboardSessionDetail",
				requestId: "req-detail-2",
				taskId: "task-root",
			}

			await handleGetDashboardSessionDetail(provider, message)

			const response = vi.mocked(provider.postMessageToWebview).mock.calls.find(
				(c) => c[0]?.type === "dashboardSessionDetailResponse",
			)

			expect(response?.[0].dashboardSessionDetail?.callCount).toBe(2)
			expect(response?.[0].dashboardSessionDetail?.apiCalls).toHaveLength(2)
		})

		it("returns empty detail when no events match taskId", async () => {
			const exportData: JsonExport = { ...mockJsonExport, events: [] }
			const exportStats = vi.fn().mockResolvedValue(exportData)
			const provider = createMockProvider({ exportStats })

			const message: WebviewMessage = {
				type: "getDashboardSessionDetail",
				requestId: "req-detail-3",
				taskId: "nonexistent-task",
			}

			await handleGetDashboardSessionDetail(provider, message)

			const response = vi.mocked(provider.postMessageToWebview).mock.calls.find(
				(c) => c[0]?.type === "dashboardSessionDetailResponse",
			)

			expect(response?.[0].dashboardSessionDetail).toMatchObject({
				taskId: "nonexistent-task",
				timestamp: 0,
				model: "",
				provider: "",
				mode: "",
				models: [],
				modes: [],
				totalTokens: 0,
				totalCost: 0,
				callCount: 0,
				apiCalls: [],
			})
		})

		it("accepts taskId via message.text field", async () => {
			const events: UsageEventV1[] = [
				makeEvent({ taskId: "task-from-text" }),
			]
			const exportData: JsonExport = { ...mockJsonExport, events }
			const exportStats = vi.fn().mockResolvedValue(exportData)
			const provider = createMockProvider({ exportStats })

			const message: WebviewMessage = {
				type: "getDashboardSessionDetail",
				requestId: "req-detail-4",
				text: "task-from-text",
			}

			await handleGetDashboardSessionDetail(provider, message)

			const response = vi.mocked(provider.postMessageToWebview).mock.calls.find(
				(c) => c[0]?.type === "dashboardSessionDetailResponse",
			)

			expect(response?.[0].dashboardSessionDetail?.taskId).toBe("task-from-text")
		})

		it("returns error when taskId is missing", async () => {
			const exportStats = vi.fn()
			const provider = createMockProvider({ exportStats })

			const message: WebviewMessage = {
				type: "getDashboardSessionDetail",
				requestId: "req-detail-5",
				// No taskId or text
			}

			await handleGetDashboardSessionDetail(provider, message)

			expect(exportStats).not.toHaveBeenCalled()
			expect(provider.postMessageToWebview).toHaveBeenCalledWith({
				type: "dashboardSessionDetailResponse",
				requestId: "req-detail-5",
				dashboardSessionDetail: null,
				error: expect.stringContaining("STATS_HANDLER/sessionDetail/001"),
			})
		})

		it("returns error when service is unavailable", async () => {
			const provider = createMockProvider(undefined)

			const message: WebviewMessage = {
				type: "getDashboardSessionDetail",
				requestId: "req-detail-6",
				taskId: "task-001",
			}

			await handleGetDashboardSessionDetail(provider, message)

			expect(provider.postMessageToWebview).toHaveBeenCalledWith({
				type: "dashboardSessionDetailResponse",
				requestId: "req-detail-6",
				dashboardSessionDetail: null,
				error: expect.stringContaining("STATS_HANDLER/sessionDetail/002"),
			})
		})

		it("returns error on service exception", async () => {
			const exportStats = vi.fn().mockRejectedValue(new Error("store read failed"))
			const provider = createMockProvider({ exportStats })

			const message: WebviewMessage = {
				type: "getDashboardSessionDetail",
				requestId: "req-detail-7",
				taskId: "task-001",
			}

			await handleGetDashboardSessionDetail(provider, message)

			expect(provider.postMessageToWebview).toHaveBeenCalledWith({
				type: "dashboardSessionDetailResponse",
				requestId: "req-detail-7",
				dashboardSessionDetail: null,
				error: expect.stringContaining("STATS_HANDLER/sessionDetail/003"),
			})
		})

		it("maps events with failed/cancelled status to apiCalls", async () => {
			const events: UsageEventV1[] = [
				makeEvent({
					taskId: "task-001",
					status: "completed",
					occurredAt: "2026-07-19T10:00:00.000Z",
				}),
				makeEvent({
					taskId: "task-001",
					status: "failed",
					occurredAt: "2026-07-19T10:30:00.000Z",
				}),
				makeEvent({
					taskId: "task-001",
					status: "cancelled",
					occurredAt: "2026-07-19T11:00:00.000Z",
				}),
			]

			const exportData: JsonExport = { ...mockJsonExport, events }
			const exportStats = vi.fn().mockResolvedValue(exportData)
			const provider = createMockProvider({ exportStats })

			const message: WebviewMessage = {
				type: "getDashboardSessionDetail",
				requestId: "req-detail-8",
				taskId: "task-001",
			}

			await handleGetDashboardSessionDetail(provider, message)

			const response = vi.mocked(provider.postMessageToWebview).mock.calls.find(
				(c) => c[0]?.type === "dashboardSessionDetailResponse",
			)

			const apiCalls = response?.[0].dashboardSessionDetail?.apiCalls
			expect(apiCalls?.[0].status).toBe("completed")
			expect(apiCalls?.[1].status).toBe("failed")
			expect(apiCalls?.[2].status).toBe("cancelled")
		})
	})
})
