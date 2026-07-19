// pnpm --filter @roo-code/vscode-webview test src/components/stats/__tests__/StatsView.spec.tsx

import React from "react"
import { render, waitFor, fireEvent, act } from "@/utils/test-utils"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

import { ExtensionStateContextProvider } from "@src/context/ExtensionStateContext"
import { vscode } from "@src/utils/vscode"
import type { StatsSnapshot } from "@roo-code/types"

import StatsView from "../StatsView"

// Mock vscode API
vi.mock("@src/utils/vscode", () => ({
	vscode: {
		postMessage: vi.fn(),
	},
}))

// Mock i18n
vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string) => key,
	}),
	initReactI18next: {
		type: "3rdParty",
		init: () => {},
	},
	Trans: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}))

// Mock lucide-react icons
vi.mock("lucide-react", () => ({
	ArrowLeft: () => <span data-testid="arrow-left" />,
	Download: () => <span data-testid="download" />,
	Trash2: () => <span data-testid="trash2" />,
	RefreshCw: ({ className }: { className?: string }) => (
		<span data-testid="refresh-cw" className={className} />
	),
}))

// ── Test fixtures ────────────────────────────────────────────────────────────

const mockEmptySnapshot: StatsSnapshot = {
	query: {
		timezone: "UTC",
		groupBy: ["model"],
		includeCancelled: false,
	},
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

const mockSnapshotWithData: StatsSnapshot = {
	query: {
		timezone: "UTC",
		groupBy: ["model"],
		includeCancelled: false,
	},
	generatedAt: "2026-07-19T00:00:00.000Z",
	buckets: [
		{
			key: { model: "claude-sonnet-4" },
			events: 5,
			completedCalls: 4,
			failedCalls: 1,
			cancelledCalls: 0,
			inputTokens: 50000,
			outputTokens: 12000,
			cacheReadTokens: 8000,
			cacheWriteTokens: 3000,
			reasoningTokens: 2000,
			totalTokens: 75000,
			costUsd: 0.45,
			unknownEventCount: 0,
		},
		{
			key: { model: "gpt-4o" },
			events: 3,
			completedCalls: 3,
			failedCalls: 0,
			cancelledCalls: 0,
			inputTokens: 30000,
			outputTokens: 8000,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			reasoningTokens: 0,
			totalTokens: 38000,
			costUsd: 0.12,
			unknownEventCount: 0,
		},
	],
	totals: {
		key: {},
		events: 8,
		completedCalls: 7,
		failedCalls: 1,
		cancelledCalls: 0,
		inputTokens: 80000,
		outputTokens: 20000,
		cacheReadTokens: 8000,
		cacheWriteTokens: 3000,
		reasoningTokens: 2000,
		totalTokens: 113000,
		costUsd: 0.57,
		unknownEventCount: 0,
	},
	coverage: {
		firstEventAt: "2026-07-18T10:00:00.000Z",
		lastEventAt: "2026-07-19T00:00:00.000Z",
		recordingPaused: false,
		backfilledEventCount: 0,
	},
}

// ── Test helpers ────────────────────────────────────────────────────────────

const queryClient = new QueryClient({
	defaultOptions: { queries: { retry: false } },
})

const mockHydrateState = () => {
	window.postMessage(
		{
			type: "state",
			state: {
				version: "1.0.0",
				clineMessages: [],
				taskHistory: [],
				shouldShowAnnouncement: false,
				allowedCommands: [],
				alwaysAllowExecute: false,
				cloudIsAuthenticated: false,
				telemetrySetting: "enabled",
				renderContext: "editor",
			},
		},
		"*",
	)
}

const renderStatsView = (props: { onDone?: () => void } = {}) => {
	const result = render(
		<ExtensionStateContextProvider>
			<QueryClientProvider client={queryClient}>
				<StatsView onDone={props.onDone ?? (() => {})} />
			</QueryClientProvider>
		</ExtensionStateContextProvider>,
	)
	mockHydrateState()
	return result
}

/**
 * Wait for the StatsView to mount and send its initial getUsageStats request,
 * then simulate a host response with the given snapshot.
 */
async function sendUsageStatsResponse(snapshot: StatsSnapshot) {
	// Wait for the loading state to appear (component mounted, initial fetch sent)
	await waitFor(() => {
		expect(document.querySelector('[data-testid="stats-loading"]')).toBeTruthy()
	})

	// Extract the requestId from the last getUsageStats call
	const calls = (vscode.postMessage as ReturnType<typeof vi.fn>).mock.calls
	const statsCall = calls.find((c) => c[0]?.type === "getUsageStats")
	const requestId = statsCall?.[0]?.requestId

	act(() => {
		window.postMessage(
			{
				type: "getUsageStatsResponse",
				requestId,
				usageStatsSnapshot: snapshot,
			},
			"*",
		)
	})
}

async function sendErrorResponse() {
	await waitFor(() => {
		expect(document.querySelector('[data-testid="stats-loading"]')).toBeTruthy()
	})

	const calls = (vscode.postMessage as ReturnType<typeof vi.fn>).mock.calls
	const statsCall = calls.find((c) => c[0]?.type === "getUsageStats")
	const requestId = statsCall?.[0]?.requestId

	act(() => {
		window.postMessage(
			{
				type: "getUsageStatsResponse",
				requestId,
				// No usageStatsSnapshot → triggers error
			},
			"*",
		)
	})
}

/** Count only getUsageStats calls */
const getStatsCallCount = () => {
	return (vscode.postMessage as ReturnType<typeof vi.fn>).mock.calls.filter(
		(c) => c[0]?.type === "getUsageStats",
	).length
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("StatsView", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("renders loading state initially", () => {
		renderStatsView()

		expect(vscode.postMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "getUsageStats",
			}),
		)
		expect(document.querySelector('[data-testid="stats-loading"]')).toBeTruthy()
	})

	it("renders empty state when no data", async () => {
		renderStatsView()

		await sendUsageStatsResponse(mockEmptySnapshot)

		await waitFor(() => {
			expect(document.querySelector('[data-testid="stats-empty"]')).toBeTruthy()
		})
	})

	it("renders summary cards and breakdown table when data exists", async () => {
		renderStatsView()

		await sendUsageStatsResponse(mockSnapshotWithData)

		await waitFor(() => {
			expect(document.querySelector('[data-testid="stats-summary"]')).toBeTruthy()
		})

		expect(document.querySelector('[data-testid="stats-breakdown"]')).toBeTruthy()
		expect(document.querySelector('[data-testid="stats-coverage"]')).toBeTruthy()

		const rows = document.querySelectorAll("tbody tr")
		expect(rows).toHaveLength(2)
	})

	it("sends getUsageStats message on mount with correct query", () => {
		renderStatsView()

		expect(vscode.postMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "getUsageStats",
				usageStatsQuery: expect.objectContaining({
					preset: "today",
					groupBy: ["model"],
					timezone: expect.any(String),
				}),
			}),
		)
	})

	it("calls onDone when back button is clicked", () => {
		const onDone = vi.fn()
		renderStatsView({ onDone })

		const doneButton = document.querySelector('[data-testid="stats-done-button"]') as HTMLButtonElement
		expect(doneButton).toBeTruthy()
		fireEvent.click(doneButton)
		expect(onDone).toHaveBeenCalledTimes(1)
	})

	it("refetches when range preset changes", async () => {
		renderStatsView()

		// Wait for initial fetch
		await waitFor(() => {
			expect(getStatsCallCount()).toBeGreaterThanOrEqual(1)
		})

		const range7d = document.querySelector('[data-testid="stats-range-7d"]') as HTMLButtonElement
		fireEvent.click(range7d)

		expect(getStatsCallCount()).toBeGreaterThanOrEqual(2)
		expect(vscode.postMessage).toHaveBeenLastCalledWith(
			expect.objectContaining({
				type: "getUsageStats",
				usageStatsQuery: expect.objectContaining({
					preset: "7d",
				}),
			}),
		)
	})

	it("refetches when groupBy changes", async () => {
		renderStatsView()

		// Load data first so the groupBy buttons are rendered
		await sendUsageStatsResponse(mockSnapshotWithData)

		await waitFor(() => {
			expect(document.querySelector('[data-testid="stats-groupby-provider"]')).toBeTruthy()
		})

		const groupByProvider = document.querySelector(
			'[data-testid="stats-groupby-provider"]',
		) as HTMLButtonElement
		fireEvent.click(groupByProvider)

		expect(vscode.postMessage).toHaveBeenLastCalledWith(
			expect.objectContaining({
				type: "getUsageStats",
				usageStatsQuery: expect.objectContaining({
					groupBy: ["provider"],
				}),
			}),
		)
	})

	it("sends export message when export JSON button is clicked", async () => {
		renderStatsView()

		await sendUsageStatsResponse(mockSnapshotWithData)

		await waitFor(() => {
			expect(document.querySelector('[data-testid="stats-export-json"]')).toBeTruthy()
		})

		const exportButton = document.querySelector(
			'[data-testid="stats-export-json"]',
		) as HTMLButtonElement
		fireEvent.click(exportButton)

		expect(vscode.postMessage).toHaveBeenLastCalledWith(
			expect.objectContaining({
				type: "exportUsageStats",
				exportUsageStatsFormat: "json",
			}),
		)
	})

	it("sends export message when export CSV button is clicked", async () => {
		renderStatsView()

		await sendUsageStatsResponse(mockSnapshotWithData)

		await waitFor(() => {
			expect(document.querySelector('[data-testid="stats-export-csv"]')).toBeTruthy()
		})

		const exportButton = document.querySelector(
			'[data-testid="stats-export-csv"]',
		) as HTMLButtonElement
		fireEvent.click(exportButton)

		expect(vscode.postMessage).toHaveBeenLastCalledWith(
			expect.objectContaining({
				type: "exportUsageStats",
				exportUsageStatsFormat: "csv",
			}),
		)
	})

	it("opens clear confirmation dialog when clear button is clicked and host issues nonce", async () => {
		renderStatsView()

		await sendUsageStatsResponse(mockSnapshotWithData)

		await waitFor(() => {
			expect(document.querySelector('[data-testid="stats-clear-button"]')).toBeTruthy()
		})

		const clearButton = document.querySelector(
			'[data-testid="stats-clear-button"]',
		) as HTMLButtonElement
		fireEvent.click(clearButton)

		// B2 fix: webview requests a nonce from the host; the dialog opens only
		// after the host responds with `requestClearNonceResponse`.
		expect(vscode.postMessage).toHaveBeenLastCalledWith(
			expect.objectContaining({
				type: "requestClearNonce",
			}),
		)

		// Simulate host issuing a nonce
		await act(async () => {
			window.postMessage(
				{
					type: "requestClearNonceResponse",
					requestId: "clear-nonce-test",
					clearNonce: "host-issued-nonce-123",
				},
				"*",
			)
		})

		await waitFor(() => {
			expect(document.querySelector('[data-testid="stats-clear-dialog"]')).toBeTruthy()
		})
	})

	it("sends clearUsageStats message with host-issued nonce when clear is confirmed", async () => {
		renderStatsView()

		await sendUsageStatsResponse(mockSnapshotWithData)

		await waitFor(() => {
			expect(document.querySelector('[data-testid="stats-clear-button"]')).toBeTruthy()
		})

		const clearButton = document.querySelector(
			'[data-testid="stats-clear-button"]',
		) as HTMLButtonElement
		fireEvent.click(clearButton)

		// Simulate host issuing a nonce
		await act(async () => {
			window.postMessage(
				{
					type: "requestClearNonceResponse",
					requestId: "clear-nonce-test",
					clearNonce: "host-issued-nonce-123",
				},
				"*",
			)
		})

		// Wait for the confirm button to appear after the dialog opens
		const confirmButton = await waitFor(() => {
			const el = document.querySelector(
				'[data-testid="stats-clear-confirm"]',
			) as HTMLButtonElement
			expect(el).toBeTruthy()
			return el
		})
		fireEvent.click(confirmButton)

		expect(vscode.postMessage).toHaveBeenLastCalledWith(
			expect.objectContaining({
				type: "clearUsageStats",
				clearUsageStatsNonce: "host-issued-nonce-123",
			}),
		)
	})

	it("renders error state when response has no snapshot", async () => {
		renderStatsView()

		await sendErrorResponse()

		await waitFor(() => {
			expect(document.querySelector('[data-testid="stats-error"]')).toBeTruthy()
		})
	})

	it("ignores stale responses with wrong requestId", async () => {
		renderStatsView()

		await waitFor(() => {
			expect(document.querySelector('[data-testid="stats-loading"]')).toBeTruthy()
		})

		act(() => {
			window.postMessage(
				{
					type: "getUsageStatsResponse",
					requestId: "wrong-id",
					usageStatsSnapshot: mockSnapshotWithData,
				},
				"*",
			)
		})

		// Should still be in loading state (stale response ignored)
		expect(document.querySelector('[data-testid="stats-loading"]')).toBeTruthy()
	})

	it("refetches on usageStatsChanged message", async () => {
		renderStatsView()

		await waitFor(() => {
			expect(getStatsCallCount()).toBeGreaterThanOrEqual(1)
		})

		const initialCount = getStatsCallCount()

		act(() => {
			window.postMessage(
				{
					type: "usageStatsChanged",
				},
				"*",
			)
		})

		// Should trigger a refetch (after debounce)
		await waitFor(() => {
			expect(getStatsCallCount()).toBeGreaterThan(initialCount)
		})
	})

	it("renders heatmap component when data exists", async () => {
		renderStatsView()
	
		await sendUsageStatsResponse(mockSnapshotWithData)
	
		await waitFor(() => {
			expect(document.querySelector('[data-testid="usage-heatmap"]')).toBeTruthy()
		})
	})

	// ── Additional coverage tests ───────────────────────────────────────────

	it("sends getUsageStats message when refresh button is clicked", async () => {
		renderStatsView()

		await sendUsageStatsResponse(mockSnapshotWithData)

		await waitFor(() => {
			expect(document.querySelector('[data-testid="stats-refresh-button"]')).toBeTruthy()
		})

		const initialCount = getStatsCallCount()

		const refreshButton = document.querySelector(
			'[data-testid="stats-refresh-button"]',
		) as HTMLButtonElement
		fireEvent.click(refreshButton)

		expect(getStatsCallCount()).toBeGreaterThan(initialCount)
	})

	it("renders all range preset buttons", () => {
		renderStatsView()

		expect(document.querySelector('[data-testid="stats-range-today"]')).toBeTruthy()
		expect(document.querySelector('[data-testid="stats-range-7d"]')).toBeTruthy()
		expect(document.querySelector('[data-testid="stats-range-30d"]')).toBeTruthy()
		expect(document.querySelector('[data-testid="stats-range-all"]')).toBeTruthy()
	})

	it("renders all groupBy buttons when data exists", async () => {
		renderStatsView()

		await sendUsageStatsResponse(mockSnapshotWithData)

		await waitFor(() => {
			expect(document.querySelector('[data-testid="stats-groupby-model"]')).toBeTruthy()
		})

		expect(document.querySelector('[data-testid="stats-groupby-provider"]')).toBeTruthy()
		expect(document.querySelector('[data-testid="stats-groupby-mode"]')).toBeTruthy()
		expect(document.querySelector('[data-testid="stats-groupby-status"]')).toBeTruthy()
		expect(document.querySelector('[data-testid="stats-groupby-day"]')).toBeTruthy()
		expect(document.querySelector('[data-testid="stats-groupby-week"]')).toBeTruthy()
		expect(document.querySelector('[data-testid="stats-groupby-month"]')).toBeTruthy()
	})

	it("disables export and clear buttons when no data exists", async () => {
		renderStatsView()

		await sendUsageStatsResponse(mockEmptySnapshot)

		await waitFor(() => {
			expect(document.querySelector('[data-testid="stats-empty"]')).toBeTruthy()
		})

		const exportJson = document.querySelector(
			'[data-testid="stats-export-json"]',
		) as HTMLButtonElement
		const exportCsv = document.querySelector(
			'[data-testid="stats-export-csv"]',
		) as HTMLButtonElement
		const clearButton = document.querySelector(
			'[data-testid="stats-clear-button"]',
		) as HTMLButtonElement

		expect(exportJson.disabled).toBe(true)
		expect(exportCsv.disabled).toBe(true)
		expect(clearButton.disabled).toBe(true)
	})

	it("enables export and clear buttons when data exists", async () => {
		renderStatsView()

		await sendUsageStatsResponse(mockSnapshotWithData)

		await waitFor(() => {
			expect(document.querySelector('[data-testid="stats-breakdown"]')).toBeTruthy()
		})

		const exportJson = document.querySelector(
			'[data-testid="stats-export-json"]',
		) as HTMLButtonElement
		const exportCsv = document.querySelector(
			'[data-testid="stats-export-csv"]',
		) as HTMLButtonElement
		const clearButton = document.querySelector(
			'[data-testid="stats-clear-button"]',
		) as HTMLButtonElement

		expect(exportJson.disabled).toBe(false)
		expect(exportCsv.disabled).toBe(false)
		expect(clearButton.disabled).toBe(false)
	})

	it("renders error state when host returns null nonce for clear request", async () => {
		renderStatsView()

		await sendUsageStatsResponse(mockSnapshotWithData)

		await waitFor(() => {
			expect(document.querySelector('[data-testid="stats-clear-button"]')).toBeTruthy()
		})

		const clearButton = document.querySelector(
			'[data-testid="stats-clear-button"]',
		) as HTMLButtonElement
		fireEvent.click(clearButton)

		// Host returns null nonce (error case)
		await act(async () => {
			window.postMessage(
				{
					type: "requestClearNonceResponse",
					requestId: "clear-nonce-test",
					clearNonce: null,
					error: "Host failed to issue nonce",
				},
				"*",
			)
		})

		await waitFor(() => {
			expect(document.querySelector('[data-testid="stats-error"]')).toBeTruthy()
		})

		// Dialog should NOT be open
		expect(document.querySelector('[data-testid="stats-clear-dialog"]')).toBeFalsy()
	})

	it("closes clear dialog when cancel button is clicked", async () => {
		renderStatsView()

		await sendUsageStatsResponse(mockSnapshotWithData)

		await waitFor(() => {
			expect(document.querySelector('[data-testid="stats-clear-button"]')).toBeTruthy()
		})

		const clearButton = document.querySelector(
			'[data-testid="stats-clear-button"]',
		) as HTMLButtonElement
		fireEvent.click(clearButton)

		// Simulate host issuing a nonce
		await act(async () => {
			window.postMessage(
				{
					type: "requestClearNonceResponse",
					requestId: "clear-nonce-test",
					clearNonce: "host-issued-nonce-123",
				},
				"*",
			)
		})

		await waitFor(() => {
			expect(document.querySelector('[data-testid="stats-clear-dialog"]')).toBeTruthy()
		})

		const cancelButton = document.querySelector(
			'[data-testid="stats-clear-cancel"]',
		) as HTMLButtonElement
		fireEvent.click(cancelButton)

		await waitFor(() => {
			expect(document.querySelector('[data-testid="stats-clear-dialog"]')).toBeFalsy()
		})
	})

	it("shows error when clearUsageStatsResponse indicates failure", async () => {
		renderStatsView()

		await sendUsageStatsResponse(mockSnapshotWithData)

		await waitFor(() => {
			expect(document.querySelector('[data-testid="stats-clear-button"]')).toBeTruthy()
		})

		// Request clear
		const clearButton = document.querySelector(
			'[data-testid="stats-clear-button"]',
		) as HTMLButtonElement
		fireEvent.click(clearButton)

		// Host issues nonce
		await act(async () => {
			window.postMessage(
				{
					type: "requestClearNonceResponse",
					requestId: "clear-nonce-test",
					clearNonce: "host-issued-nonce-123",
				},
				"*",
			)
		})

		// Confirm clear
		const confirmButton = await waitFor(() => {
			const el = document.querySelector(
				'[data-testid="stats-clear-confirm"]',
			) as HTMLButtonElement
			expect(el).toBeTruthy()
			return el
		})
		fireEvent.click(confirmButton)

		// Host returns failure
		await act(async () => {
			window.postMessage(
				{
					type: "clearUsageStatsResponse",
					clearUsageStatsResult: {
						success: false,
						error: "Clear operation failed on host",
					},
				},
				"*",
			)
		})

		await waitFor(() => {
			expect(document.querySelector('[data-testid="stats-error"]')).toBeTruthy()
		})

		// Dialog should be closed
		expect(document.querySelector('[data-testid="stats-clear-dialog"]')).toBeFalsy()
	})

	it("closes dialog and refetches when clearUsageStatsResponse indicates success", async () => {
		renderStatsView()

		await sendUsageStatsResponse(mockSnapshotWithData)

		await waitFor(() => {
			expect(document.querySelector('[data-testid="stats-clear-button"]')).toBeTruthy()
		})

		const clearButton = document.querySelector(
			'[data-testid="stats-clear-button"]',
		) as HTMLButtonElement
		fireEvent.click(clearButton)

		await act(async () => {
			window.postMessage(
				{
					type: "requestClearNonceResponse",
					requestId: "clear-nonce-test",
					clearNonce: "host-issued-nonce-123",
				},
				"*",
			)
		})

		const confirmButton = await waitFor(() => {
			const el = document.querySelector(
				'[data-testid="stats-clear-confirm"]',
			) as HTMLButtonElement
			expect(el).toBeTruthy()
			return el
		})
		fireEvent.click(confirmButton)

		const countBefore = getStatsCallCount()

		await act(async () => {
			window.postMessage(
				{
					type: "clearUsageStatsResponse",
					clearUsageStatsResult: { success: true },
				},
				"*",
			)
		})

		// Dialog should be closed
		await waitFor(() => {
			expect(document.querySelector('[data-testid="stats-clear-dialog"]')).toBeFalsy()
		})

		// Should trigger a refetch
		await waitFor(() => {
			expect(getStatsCallCount()).toBeGreaterThan(countBefore)
		})
	})

	it("shows error when exportUsageStatsResponse contains an error", async () => {
		renderStatsView()

		await sendUsageStatsResponse(mockSnapshotWithData)

		await waitFor(() => {
			expect(document.querySelector('[data-testid="stats-export-json"]')).toBeTruthy()
		})

		const exportButton = document.querySelector(
			'[data-testid="stats-export-json"]',
		) as HTMLButtonElement
		fireEvent.click(exportButton)

		await act(async () => {
			window.postMessage(
				{
					type: "exportUsageStatsResponse",
					exportUsageStatsResult: {
						error: "Failed to save export file",
					},
				},
				"*",
			)
		})

		await waitFor(() => {
			expect(document.querySelector('[data-testid="stats-error"]')).toBeTruthy()
		})
	})

	it("renders coverage section with firstEventAt when data exists", async () => {
		renderStatsView()

		await sendUsageStatsResponse(mockSnapshotWithData)

		await waitFor(() => {
			expect(document.querySelector('[data-testid="stats-coverage"]')).toBeTruthy()
		})

		const coverage = document.querySelector('[data-testid="stats-coverage"]')
		expect(coverage?.textContent).toContain("stats:coverage.title")
		expect(coverage?.textContent).toContain("stats:coverage.liveFrom")
	})

	it("renders coverage section with backfilledEventCount when > 0", async () => {
		const snapshotWithBackfill: StatsSnapshot = {
			...mockSnapshotWithData,
			coverage: {
				firstEventAt: "2026-07-18T10:00:00.000Z",
				lastEventAt: "2026-07-19T00:00:00.000Z",
				recordingPaused: false,
				backfilledEventCount: 42,
			},
		}

		renderStatsView()

		await sendUsageStatsResponse(snapshotWithBackfill)

		await waitFor(() => {
			expect(document.querySelector('[data-testid="stats-coverage"]')).toBeTruthy()
		})

		const coverage = document.querySelector('[data-testid="stats-coverage"]')
		expect(coverage?.textContent).toContain("stats:coverage.backfilledEvents")
		expect(coverage?.textContent).toContain("42")
	})

	it("renders coverage section with paused indicator when recordingPaused is true", async () => {
		const snapshotPaused: StatsSnapshot = {
			...mockSnapshotWithData,
			coverage: {
				firstEventAt: "2026-07-18T10:00:00.000Z",
				lastEventAt: "2026-07-19T00:00:00.000Z",
				recordingPaused: true,
				backfilledEventCount: 0,
			},
		}

		renderStatsView()

		await sendUsageStatsResponse(snapshotPaused)

		await waitFor(() => {
			expect(document.querySelector('[data-testid="stats-coverage"]')).toBeTruthy()
		})

		const coverage = document.querySelector('[data-testid="stats-coverage"]')
		expect(coverage?.textContent).toContain("stats:coverage.paused")
	})

	it("does not render coverage section when snapshot has no coverage", async () => {
		const snapshotNoCoverage: StatsSnapshot = {
			...mockSnapshotWithData,
			coverage: undefined as unknown as StatsSnapshot["coverage"],
		}

		renderStatsView()

		await sendUsageStatsResponse(snapshotNoCoverage)

		await waitFor(() => {
			expect(document.querySelector('[data-testid="stats-breakdown"]')).toBeTruthy()
		})

		expect(document.querySelector('[data-testid="stats-coverage"]')).toBeFalsy()
	})

	it("renders breakdown table headers correctly", async () => {
		renderStatsView()

		await sendUsageStatsResponse(mockSnapshotWithData)

		await waitFor(() => {
			expect(document.querySelector('[data-testid="stats-breakdown"]')).toBeTruthy()
		})

		const headers = document.querySelectorAll("thead th")
		expect(headers.length).toBe(9) // groupBy + 8 metric columns
		expect(headers[0].textContent).toContain("stats:breakdown.model")
		expect(headers[1].textContent).toContain("stats:breakdown.events")
		expect(headers[2].textContent).toContain("stats:breakdown.inputTokens")
		expect(headers[3].textContent).toContain("stats:breakdown.outputTokens")
		expect(headers[4].textContent).toContain("stats:breakdown.cacheReadTokens")
		expect(headers[5].textContent).toContain("stats:breakdown.cacheWriteTokens")
		expect(headers[6].textContent).toContain("stats:breakdown.reasoningTokens")
		expect(headers[7].textContent).toContain("stats:breakdown.totalTokens")
		expect(headers[8].textContent).toContain("stats:breakdown.costUsd")
	})

	it("changes groupBy header label when groupBy changes", async () => {
		renderStatsView()

		await sendUsageStatsResponse(mockSnapshotWithData)

		await waitFor(() => {
			expect(document.querySelector('[data-testid="stats-groupby-provider"]')).toBeTruthy()
		})

		const groupByProvider = document.querySelector(
			'[data-testid="stats-groupby-provider"]',
		) as HTMLButtonElement
		fireEvent.click(groupByProvider)

		// groupBy 변경 시 refetch가 발생하고, query에 groupBy: ["provider"]가 포함됨
		expect(vscode.postMessage).toHaveBeenLastCalledWith(
			expect.objectContaining({
				type: "getUsageStats",
				usageStatsQuery: expect.objectContaining({
					groupBy: ["provider"],
				}),
			}),
		)
	})

	it("renders loading spinner with animate-spin class when loading", () => {
		renderStatsView()

		const loading = document.querySelector('[data-testid="stats-loading"]')
		expect(loading).toBeTruthy()
		// The RefreshCw icon should have animate-spin class when loading
		const spinner = loading?.querySelector('[data-testid="refresh-cw"]')
		expect(spinner?.className).toContain("animate-spin")
	})

	it("sends getUsageStats with preset '30d' when 30d range is clicked", async () => {
		renderStatsView()

		await waitFor(() => {
			expect(getStatsCallCount()).toBeGreaterThanOrEqual(1)
		})

		const range30d = document.querySelector('[data-testid="stats-range-30d"]') as HTMLButtonElement
		fireEvent.click(range30d)

		expect(vscode.postMessage).toHaveBeenLastCalledWith(
			expect.objectContaining({
				type: "getUsageStats",
				usageStatsQuery: expect.objectContaining({
					preset: "30d",
				}),
			}),
		)
	})

	it("sends getUsageStats with preset 'all' when all range is clicked", async () => {
		renderStatsView()

		await waitFor(() => {
			expect(getStatsCallCount()).toBeGreaterThanOrEqual(1)
		})

		const rangeAll = document.querySelector('[data-testid="stats-range-all"]') as HTMLButtonElement
		fireEvent.click(rangeAll)

		expect(vscode.postMessage).toHaveBeenLastCalledWith(
			expect.objectContaining({
				type: "getUsageStats",
				usageStatsQuery: expect.objectContaining({
					preset: "all",
				}),
			}),
		)
	})

	it("sends getUsageStats with preset 'today' when today range is clicked", async () => {
		renderStatsView()

		await waitFor(() => {
			expect(getStatsCallCount()).toBeGreaterThanOrEqual(1)
		})

		const rangeToday = document.querySelector(
			'[data-testid="stats-range-today"]',
		) as HTMLButtonElement
		fireEvent.click(rangeToday)

		expect(vscode.postMessage).toHaveBeenLastCalledWith(
			expect.objectContaining({
				type: "getUsageStats",
				usageStatsQuery: expect.objectContaining({
					preset: "today",
				}),
			}),
		)
	})
})
