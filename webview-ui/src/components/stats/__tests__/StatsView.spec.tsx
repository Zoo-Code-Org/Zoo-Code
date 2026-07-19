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
})
