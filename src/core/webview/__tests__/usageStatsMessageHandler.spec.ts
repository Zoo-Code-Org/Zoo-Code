import type { WebviewMessage, StatsQuery, StatsSnapshot } from "@roo-code/types"
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

import * as vscode from "vscode"
import { resolveDefaultSaveUri, saveLastExportPath } from "../../../utils/export"
import {
	handleGetUsageStats,
	handleClearUsageStats,
	handleExportUsageStats,
	handleRequestClearNonce,
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
})
