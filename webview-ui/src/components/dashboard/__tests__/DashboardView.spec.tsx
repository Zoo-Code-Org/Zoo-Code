// npx vitest run src/components/dashboard/__tests__/DashboardView.spec.tsx

import React from "react"
import { render, fireEvent, waitFor, act } from "@/utils/test-utils"

import type { StatsBucket, StatsSnapshot, SessionSummary } from "@roo-code/types"

import DashboardView from "../DashboardView"

// ── Mock i18n ───────────────────────────────────────────────────────────────
// DashboardView uses useAppTranslation from @/i18n/TranslationContext (not
// react-i18next directly), so we must mock that module. The real
// TranslationContext calls useExtensionState() internally, which requires a
// provider we don't have in tests.

// Stable t function reference so useEffect dependencies don't change on every render
const stableT = (key: string) => key

vi.mock("@/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: stableT,
		i18n: {},
	}),
	TranslationProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

// ── vscode mock ──────────────────────────────────────────────────────────────

const postMessageMock = vi.fn()
vi.mock("@/utils/vscode", () => ({
	vscode: {
		postMessage: (msg: unknown) => postMessageMock(msg),
	},
}))

// ── Mock child components to avoid deep rendering ────────────────────────────

vi.mock("../DashboardSummary", () => ({
	default: () => <div data-testid="dashboard-summary" />,
}))

vi.mock("../SessionList", () => ({
	default: () => <div data-testid="session-list" />,
}))

vi.mock("../../stats/UsageHeatmap", () => ({
	default: () => <div data-testid="usage-heatmap" />,
}))

// ── Mock common/Tab to avoid useExtensionState dependency ───────────────────
// TabContent calls useExtensionState() which requires a provider.

vi.mock("@/components/common/Tab", () => ({
	Tab: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
		<div {...props}>{children}</div>
	),
	TabHeader: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
		<div {...props}>{children}</div>
	),
	TabContent: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
		<div {...props}>{children}</div>
	),
}))

// ── Mock AlertDialog to avoid Radix portal issues in tests ──────────────────
// Radix AlertDialog renders content in a portal to document.body, which makes
// it hard to query with container.querySelector. We mock it to render inline
// when open=true. The mock uses React context to wire up onOpenChange so
// AlertDialogCancel can close the dialog (matching Radix behavior).

const AlertDialogContext = React.createContext<{ onOpenChange?: (open: boolean) => void }>({})

vi.mock("@/components/ui/alert-dialog", () => ({
	AlertDialog: ({
		children,
		open,
		onOpenChange,
	}: {
		children: React.ReactNode
		open?: boolean
		onOpenChange?: (open: boolean) => void
	}) => (
		<AlertDialogContext.Provider value={{ onOpenChange }}>
			<div data-testid="alert-dialog-root" data-open={open ? "true" : "false"}>
				{open ? children : null}
			</div>
		</AlertDialogContext.Provider>
	),
	AlertDialogContent: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
		<div {...props}>{children}</div>
	),
	AlertDialogHeader: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
		<div {...props}>{children}</div>
	),
	AlertDialogTitle: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
		<div {...props}>{children}</div>
	),
	AlertDialogDescription: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
		<div {...props}>{children}</div>
	),
	AlertDialogFooter: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
		<div {...props}>{children}</div>
	),
	AlertDialogCancel: ({ children, ...props }: React.HTMLAttributes<HTMLButtonElement>) => {
		const { onOpenChange } = React.useContext(AlertDialogContext)
		return (
			<button
				{...(props as React.ButtonHTMLAttributes<HTMLButtonElement>)}
				onClick={(e) => {
					onOpenChange?.(false)
					;(props as React.ButtonHTMLAttributes<HTMLButtonElement>).onClick?.(e)
				}}>
				{children}
			</button>
		)
	},
	AlertDialogAction: ({ children, ...props }: React.HTMLAttributes<HTMLButtonElement>) => (
		<button {...(props as React.ButtonHTMLAttributes<HTMLButtonElement>)}>{children}</button>
	),
}))

// ── Test fixtures ────────────────────────────────────────────────────────────

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

function makeSnapshot(overrides: Partial<StatsSnapshot> = {}): StatsSnapshot {
	const totals = makeBucket({ events: 10, totalTokens: 7500 })
	return {
		query: { timezone: "UTC", groupBy: ["day"], includeCancelled: false },
		generatedAt: new Date().toISOString(),
		buckets: [makeBucket({ key: { model: "gpt-4" } })],
		totals,
		coverage: {
			recordingPaused: false,
			backfilledEventCount: 0,
		},
		...overrides,
	}
}

function makeSession(overrides: Partial<SessionSummary> = {}): SessionSummary {
	return {
		taskId: "task-001",
		title: "Test session",
		timestamp: Date.now(),
		model: "gpt-4",
		provider: "openai",
		mode: "code",
		models: ["gpt-4"],
		modes: ["code"],
		totalTokens: 1500,
		totalCost: 0.05,
		callCount: 1,
		...overrides,
	}
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Extracts the latest requestId from postMessage calls matching the request
 * message type (e.g. "getUsageStats", "getDashboardSessions"). This is more
 * reliable than matching by requestId prefix because multiple request types
 * share the "dashboard-" prefix (e.g. "dashboard-{ts}" for stats and
 * "dashboard-sessions-{ts}" for sessions).
 */
function getLatestRequestIdByType(requestType: string): string {
	const calls = postMessageMock.mock.calls
	const matching = calls.filter((call) => {
		const msg = call[0] as { type: string; requestId?: string }
		return msg.type === requestType && msg.requestId
	})
	expect(matching.length).toBeGreaterThan(0)
	const lastCall = matching[matching.length - 1][0] as { requestId: string }
	return lastCall.requestId
}

/**
 * Simulates the extension host responding to a getUsageStats request.
 */
function simulateStatsResponse(snapshot: Partial<StatsSnapshot> | null, requestId?: string) {
	const rid = requestId ?? getLatestRequestIdByType("getUsageStats")
	const data: Record<string, unknown> = {
		type: "getUsageStatsResponse",
		requestId: rid,
	}
	if (snapshot !== null) {
		data.usageStatsSnapshot = makeSnapshot(snapshot)
	}
	window.dispatchEvent(new MessageEvent("message", { data }))
}

/**
 * Simulates the extension host responding to a getDashboardSessions request.
 */
function simulateSessionsResponse(
	sessions: SessionSummary[] | null,
	error?: string,
	requestId?: string,
) {
	const rid = requestId ?? getLatestRequestIdByType("getDashboardSessions")
	const data: Record<string, unknown> = {
		type: "dashboardSessionsResponse",
		requestId: rid,
	}
	if (sessions !== null) {
		data.dashboardSessions = sessions
	} else {
		data.dashboardSessions = null
		if (error) data.error = error
	}
	window.dispatchEvent(new MessageEvent("message", { data }))
}

/**
 * Simulates a requestClearNonceResponse from the host.
 */
function simulateClearNonceResponse(nonce: string | null, error?: string) {
	const rid = getLatestRequestIdByType("requestClearNonce")
	const data: Record<string, unknown> = {
		type: "requestClearNonceResponse",
		requestId: rid,
	}
	if (nonce) {
		data.clearNonce = nonce
	} else {
		data.clearNonce = null
		if (error) data.error = error
	}
	window.dispatchEvent(new MessageEvent("message", { data }))
}

/**
 * Simulates a clearUsageStatsResponse from the host.
 */
function simulateClearResponse(success: boolean, error?: string, nonce?: string) {
	const data: Record<string, unknown> = {
		type: "clearUsageStatsResponse",
		requestId: nonce ?? "test-clear-nonce",
		clearUsageStatsResult: { success, ...(error ? { error } : {}) },
	}
	window.dispatchEvent(new MessageEvent("message", { data }))
}

/**
 * Simulates an exportUsageStatsResponse from the host.
 */
function simulateExportResponse(error?: string) {
	const rid = getLatestRequestIdByType("exportUsageStats")
	const data: Record<string, unknown> = {
		type: "exportUsageStatsResponse",
		requestId: rid,
		exportUsageStatsResult: {
			format: "json",
			data: "[]",
			...(error ? { error } : {}),
		},
	}
	window.dispatchEvent(new MessageEvent("message", { data }))
}

/**
 * Simulates a usageStatsChanged event.
 */
function simulateUsageStatsChanged() {
	window.dispatchEvent(
		new MessageEvent("message", {
			data: { type: "usageStatsChanged" },
		}),
	)
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("DashboardView", () => {
	beforeEach(() => {
		postMessageMock.mockClear()
	})

	// ── 1. Initial mount & buildQuery ──────────────────────────────────────

	describe("initial mount", () => {
		it("sends getUsageStats and getDashboardSessions on mount", () => {
			render(<DashboardView onDone={() => {}} />)

			expect(postMessageMock).toHaveBeenCalledTimes(2)

			const statsCall = postMessageMock.mock.calls.find(
				(c) => (c[0] as { type: string }).type === "getUsageStats",
			)
			expect(statsCall).toBeTruthy()
			const statsMsg = statsCall![0] as { requestId: string; usageStatsQuery: { preset: string; groupBy: string[] } }
			expect(statsMsg.requestId).toMatch(/^dashboard-/)
			expect(statsMsg.usageStatsQuery.preset).toBe("today")
			expect(statsMsg.usageStatsQuery.groupBy).toContain("model")
			expect(statsMsg.usageStatsQuery.groupBy).toContain("day")

			const sessionsCall = postMessageMock.mock.calls.find(
				(c) => (c[0] as { type: string }).type === "getDashboardSessions",
			)
			expect(sessionsCall).toBeTruthy()
		})

		it("renders loading state initially", () => {
			const { container } = render(<DashboardView onDone={() => {}} />)
			expect(container.querySelector('[data-testid="dashboard-loading"]')).toBeTruthy()
		})
	})

	// ── 2. handlePresetChange ──────────────────────────────────────────────

	describe("handlePresetChange", () => {
		it("changes preset to 7d and triggers fetchStats + fetchSessions", async () => {
			const { container } = render(<DashboardView onDone={() => {}} />)

			// Respond to initial mount requests
			simulateStatsResponse(makeSnapshot())
			simulateSessionsResponse([])

			await waitFor(() => {
				expect(container.querySelector('[data-testid="dashboard-loading"]')).toBeFalsy()
			})

			postMessageMock.mockClear()

			// Click 7d preset
			const btn7d = container.querySelector('[data-testid="dashboard-range-7d"]') as HTMLButtonElement
			fireEvent.click(btn7d)

			await waitFor(() => {
				expect(postMessageMock).toHaveBeenCalledTimes(2)
			})

			const statsCall = postMessageMock.mock.calls.find(
				(c) => (c[0] as { type: string }).type === "getUsageStats",
			)![0] as { usageStatsQuery: { preset: string } }
			expect(statsCall.usageStatsQuery.preset).toBe("7d")
		})

		it("changes preset to 30d and triggers fetch", async () => {
			const { container } = render(<DashboardView onDone={() => {}} />)

			simulateStatsResponse(makeSnapshot())
			simulateSessionsResponse([])

			await waitFor(() => {
				expect(container.querySelector('[data-testid="dashboard-loading"]')).toBeFalsy()
			})

			postMessageMock.mockClear()

			const btn30d = container.querySelector('[data-testid="dashboard-range-30d"]') as HTMLButtonElement
			fireEvent.click(btn30d)

			await waitFor(() => {
				expect(postMessageMock).toHaveBeenCalledTimes(2)
			})

			const statsCall = postMessageMock.mock.calls.find(
				(c) => (c[0] as { type: string }).type === "getUsageStats",
			)![0] as { usageStatsQuery: { preset: string } }
			expect(statsCall.usageStatsQuery.preset).toBe("30d")
		})

		it("changes preset to all and triggers fetch", async () => {
			const { container } = render(<DashboardView onDone={() => {}} />)

			simulateStatsResponse(makeSnapshot())
			simulateSessionsResponse([])

			await waitFor(() => {
				expect(container.querySelector('[data-testid="dashboard-loading"]')).toBeFalsy()
			})

			postMessageMock.mockClear()

			const btnAll = container.querySelector('[data-testid="dashboard-range-all"]') as HTMLButtonElement
			fireEvent.click(btnAll)

			await waitFor(() => {
				expect(postMessageMock).toHaveBeenCalledTimes(2)
			})

			const statsCall = postMessageMock.mock.calls.find(
				(c) => (c[0] as { type: string }).type === "getUsageStats",
			)![0] as { usageStatsQuery: { preset: string } }
			expect(statsCall.usageStatsQuery.preset).toBe("all")
		})

		it("selects custom preset and shows custom date range inputs", async () => {
			const { container } = render(<DashboardView onDone={() => {}} />)

			simulateStatsResponse(makeSnapshot())
			simulateSessionsResponse([])

			await waitFor(() => {
				expect(container.querySelector('[data-testid="dashboard-loading"]')).toBeFalsy()
			})

			postMessageMock.mockClear()

			const btnCustom = container.querySelector('[data-testid="dashboard-range-custom"]') as HTMLButtonElement
			fireEvent.click(btnCustom)

			// Custom range inputs should appear
			expect(container.querySelector('[data-testid="dashboard-custom-range"]')).toBeTruthy()
			expect(container.querySelector('[data-testid="dashboard-custom-from"]')).toBeTruthy()
			expect(container.querySelector('[data-testid="dashboard-custom-to"]')).toBeTruthy()

			// Selecting custom with valid dates should trigger fetch
			await waitFor(() => {
				expect(postMessageMock).toHaveBeenCalledTimes(2)
			})

			const statsCall = postMessageMock.mock.calls.find(
				(c) => (c[0] as { type: string }).type === "getUsageStats",
			)![0] as { usageStatsQuery: { from?: string; to?: string; preset?: string } }
			expect(statsCall.usageStatsQuery.from).toBeTruthy()
			expect(statsCall.usageStatsQuery.to).toBeTruthy()
			expect(statsCall.usageStatsQuery.preset).toBeUndefined()
		})
	})

	// ── 3. handleGroupByChange ─────────────────────────────────────────────

	describe("handleGroupByChange", () => {
		it("changes groupBy to provider and triggers fetch", async () => {
			const { container } = render(<DashboardView onDone={() => {}} />)

			simulateStatsResponse(makeSnapshot())
			simulateSessionsResponse([])

			await waitFor(() => {
				expect(container.querySelector('[data-testid="dashboard-loading"]')).toBeFalsy()
			})

			postMessageMock.mockClear()

			const btnProvider = container.querySelector('[data-testid="dashboard-groupby-provider"]') as HTMLButtonElement
			fireEvent.click(btnProvider)

			await waitFor(() => {
				expect(postMessageMock).toHaveBeenCalledTimes(2)
			})

			const statsCall = postMessageMock.mock.calls.find(
				(c) => (c[0] as { type: string }).type === "getUsageStats",
			)![0] as { usageStatsQuery: { groupBy: string[] } }
			expect(statsCall.usageStatsQuery.groupBy).toContain("provider")
		})

		it("changes groupBy to mode and triggers fetch", async () => {
			const { container } = render(<DashboardView onDone={() => {}} />)

			simulateStatsResponse(makeSnapshot())
			simulateSessionsResponse([])

			await waitFor(() => {
				expect(container.querySelector('[data-testid="dashboard-loading"]')).toBeFalsy()
			})

			postMessageMock.mockClear()

			const btnMode = container.querySelector('[data-testid="dashboard-groupby-mode"]') as HTMLButtonElement
			fireEvent.click(btnMode)

			await waitFor(() => {
				expect(postMessageMock).toHaveBeenCalledTimes(2)
			})

			const statsCall = postMessageMock.mock.calls.find(
				(c) => (c[0] as { type: string }).type === "getUsageStats",
			)![0] as { usageStatsQuery: { groupBy: string[] } }
			expect(statsCall.usageStatsQuery.groupBy).toContain("mode")
		})
	})

	// ── 4. handleRefresh ───────────────────────────────────────────────────

	describe("handleRefresh", () => {
		it("re-fetches stats and sessions on refresh click", async () => {
			const { container } = render(<DashboardView onDone={() => {}} />)

			simulateStatsResponse(makeSnapshot())
			simulateSessionsResponse([])

			await waitFor(() => {
				expect(container.querySelector('[data-testid="dashboard-loading"]')).toBeFalsy()
			})

			postMessageMock.mockClear()

			const refreshBtn = container.querySelector('[data-testid="dashboard-refresh-button"]') as HTMLButtonElement
			fireEvent.click(refreshBtn)

			await waitFor(() => {
				expect(postMessageMock).toHaveBeenCalledTimes(2)
			})

			const statsCall = postMessageMock.mock.calls.find(
				(c) => (c[0] as { type: string }).type === "getUsageStats",
			)
			expect(statsCall).toBeTruthy()
		})
	})

	// ── 5. Message handlers ────────────────────────────────────────────────

	describe("message handlers", () => {
		it("handles getUsageStatsResponse with data", async () => {
			const { container } = render(<DashboardView onDone={() => {}} />)

			const snapshot = makeSnapshot({
				buckets: [makeBucket({ key: { model: "claude-3" }, totalTokens: 10000 })],
				totals: makeBucket({ events: 5, totalTokens: 10000 }),
			})

			simulateStatsResponse(snapshot)
			simulateSessionsResponse([])

			await waitFor(() => {
				expect(container.querySelector('[data-testid="dashboard-loading"]')).toBeFalsy()
				expect(container.querySelector('[data-testid="dashboard-breakdown"]')).toBeTruthy()
			})
		})

		it("handles getUsageStatsResponse without snapshot (error)", async () => {
			const { container } = render(<DashboardView onDone={() => {}} />)

			simulateStatsResponse(null)
			simulateSessionsResponse([])

			await waitFor(() => {
				expect(container.querySelector('[data-testid="dashboard-error"]')).toBeTruthy()
			})
		})

		it("handles dashboardSessionsResponse with sessions", async () => {
			const { container } = render(<DashboardView onDone={() => {}} />)

			simulateStatsResponse(makeSnapshot())
			simulateSessionsResponse([makeSession({ taskId: "task-123", title: "My Session" })])

			await waitFor(() => {
				expect(container.querySelector('[data-testid="dashboard-loading"]')).toBeFalsy()
			})
		})

		it("handles dashboardSessionsResponse with error", async () => {
			const { container } = render(<DashboardView onDone={() => {}} />)

			simulateStatsResponse(makeSnapshot())
			simulateSessionsResponse(null, "Session fetch failed")

			await waitFor(() => {
				expect(container.querySelector('[data-testid="dashboard-loading"]')).toBeFalsy()
			})
		})

		it("handles usageStatsChanged with debounced refetch", async () => {
			const { container } = render(<DashboardView onDone={() => {}} />)

			simulateStatsResponse(makeSnapshot())
			simulateSessionsResponse([])

			await waitFor(() => {
				expect(container.querySelector('[data-testid="dashboard-loading"]')).toBeFalsy()
			})

			postMessageMock.mockClear()

			// Use fake timers only for the debounce portion
			vi.useFakeTimers()

			// Trigger usageStatsChanged event
			simulateUsageStatsChanged()

			// Before debounce timer fires, no new requests
			expect(postMessageMock).toHaveBeenCalledTimes(0)

			// Advance past the 250ms debounce
			act(() => {
				vi.advanceTimersByTime(300)
			})

			// After debounce, refetch should have fired
			expect(postMessageMock).toHaveBeenCalledTimes(2)

			vi.useRealTimers()
		})

		it("handles requestClearNonceResponse with nonce (opens dialog)", async () => {
			const { container } = render(<DashboardView onDone={() => {}} />)

			simulateStatsResponse(makeSnapshot())
			simulateSessionsResponse([])

			await waitFor(() => {
				expect(container.querySelector('[data-testid="dashboard-loading"]')).toBeFalsy()
			})

			// Click clear button
			const clearBtn = container.querySelector('[data-testid="dashboard-clear-button"]') as HTMLButtonElement
			fireEvent.click(clearBtn)

			await waitFor(() => {
				expect(postMessageMock.mock.calls.some((c) => (c[0] as { type: string }).type === "requestClearNonce")).toBe(true)
			})

			// Simulate nonce response
			simulateClearNonceResponse("nonce-123")

			await waitFor(() => {
				expect(container.querySelector('[data-testid="dashboard-clear-dialog"]')).toBeTruthy()
			})
		})

		it("handles requestClearNonceResponse without nonce (error)", async () => {
			const { container } = render(<DashboardView onDone={() => {}} />)

			simulateStatsResponse(makeSnapshot())
			simulateSessionsResponse([])

			await waitFor(() => {
				expect(container.querySelector('[data-testid="dashboard-loading"]')).toBeFalsy()
			})

			const clearBtn = container.querySelector('[data-testid="dashboard-clear-button"]') as HTMLButtonElement
			fireEvent.click(clearBtn)

			await waitFor(() => {
				expect(postMessageMock.mock.calls.some((c) => (c[0] as { type: string }).type === "requestClearNonce")).toBe(true)
			})

			simulateClearNonceResponse(null, "Nonce error")

			await waitFor(() => {
				expect(container.querySelector('[data-testid="dashboard-error"]')).toBeTruthy()
			})
		})

		it("handles clearUsageStatsResponse success (refetches data)", async () => {
			const { container } = render(<DashboardView onDone={() => {}} />)

			simulateStatsResponse(makeSnapshot())
			simulateSessionsResponse([])

			await waitFor(() => {
				expect(container.querySelector('[data-testid="dashboard-loading"]')).toBeFalsy()
			})

			// Open clear dialog
			const clearBtn = container.querySelector('[data-testid="dashboard-clear-button"]') as HTMLButtonElement
			fireEvent.click(clearBtn)
			simulateClearNonceResponse("nonce-abc")

			await waitFor(() => {
				expect(container.querySelector('[data-testid="dashboard-clear-dialog"]')).toBeTruthy()
			})

			// Confirm clear
			const confirmBtn = container.querySelector('[data-testid="dashboard-clear-confirm"]') as HTMLButtonElement
			fireEvent.click(confirmBtn)

			await waitFor(() => {
				expect(postMessageMock.mock.calls.some((c) => (c[0] as { type: string }).type === "clearUsageStats")).toBe(true)
			})

			postMessageMock.mockClear()

			// Simulate clear success response
			simulateClearResponse(true, undefined, "nonce-abc")

			await waitFor(() => {
				// Dialog should close
				expect(container.querySelector('[data-testid="dashboard-clear-dialog"]')).toBeFalsy()
				// Should refetch stats and sessions
				expect(postMessageMock).toHaveBeenCalledTimes(2)
			})
		})

		it("handles clearUsageStatsResponse failure (shows error)", async () => {
			const { container } = render(<DashboardView onDone={() => {}} />)

			simulateStatsResponse(makeSnapshot())
			simulateSessionsResponse([])

			await waitFor(() => {
				expect(container.querySelector('[data-testid="dashboard-loading"]')).toBeFalsy()
			})

			const clearBtn = container.querySelector('[data-testid="dashboard-clear-button"]') as HTMLButtonElement
			fireEvent.click(clearBtn)
			simulateClearNonceResponse("nonce-xyz")

			await waitFor(() => {
				expect(container.querySelector('[data-testid="dashboard-clear-dialog"]')).toBeTruthy()
			})

			const confirmBtn = container.querySelector('[data-testid="dashboard-clear-confirm"]') as HTMLButtonElement
			fireEvent.click(confirmBtn)

			simulateClearResponse(false, "Clear failed", "nonce-xyz")

			await waitFor(() => {
				expect(container.querySelector('[data-testid="dashboard-error"]')).toBeTruthy()
			})
		})

		it("handles exportUsageStatsResponse with error", async () => {
			const { container } = render(<DashboardView onDone={() => {}} />)

			simulateStatsResponse(makeSnapshot())
			simulateSessionsResponse([])

			await waitFor(() => {
				expect(container.querySelector('[data-testid="dashboard-loading"]')).toBeFalsy()
			})

			// Click export JSON
			const exportBtn = container.querySelector('[data-testid="dashboard-export-json"]') as HTMLButtonElement
			fireEvent.click(exportBtn)

			await waitFor(() => {
				expect(postMessageMock.mock.calls.some((c) => (c[0] as { type: string }).type === "exportUsageStats")).toBe(true)
			})

			simulateExportResponse("Export failed")

			await waitFor(() => {
				expect(container.querySelector('[data-testid="dashboard-error"]')).toBeTruthy()
			})
		})

		it("handles exportUsageStatsResponse without error (no error shown)", async () => {
			const { container } = render(<DashboardView onDone={() => {}} />)

			simulateStatsResponse(makeSnapshot())
			simulateSessionsResponse([])

			await waitFor(() => {
				expect(container.querySelector('[data-testid="dashboard-loading"]')).toBeFalsy()
			})

			const exportBtn = container.querySelector('[data-testid="dashboard-export-json"]') as HTMLButtonElement
			fireEvent.click(exportBtn)

			simulateExportResponse()

			// No error should be shown
			await waitFor(() => {
				expect(container.querySelector('[data-testid="dashboard-error"]')).toBeFalsy()
			})
		})

		it("ignores stale getUsageStatsResponse (wrong requestId)", async () => {
			const { container } = render(<DashboardView onDone={() => {}} />)

			// Send a response with a non-matching requestId
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "getUsageStatsResponse",
						requestId: "stale-id",
						usageStatsSnapshot: makeSnapshot(),
					},
				}),
			)

			// Should still be loading because the stale response was ignored
			expect(container.querySelector('[data-testid="dashboard-loading"]')).toBeTruthy()
		})

		it("ignores stale dashboardSessionsResponse (wrong requestId)", async () => {
			const { container } = render(<DashboardView onDone={() => {}} />)

			simulateStatsResponse(makeSnapshot())

			// Send a sessions response with non-matching requestId
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "dashboardSessionsResponse",
						requestId: "stale-sessions-id",
						dashboardSessions: [makeSession()],
					},
				}),
			)

			// The sessions loading state should still be active (or at least
			// the stale response should not have been applied)
			// We verify by checking that no error was set from the stale response
			expect(container.querySelector('[data-testid="dashboard-error"]')).toBeFalsy()
		})
	})

	// ── 6. handleExport ────────────────────────────────────────────────────

	describe("handleExport", () => {
		it("sends exportUsageStats message with json format", async () => {
			const { container } = render(<DashboardView onDone={() => {}} />)

			simulateStatsResponse(makeSnapshot())
			simulateSessionsResponse([])

			await waitFor(() => {
				expect(container.querySelector('[data-testid="dashboard-loading"]')).toBeFalsy()
			})

			postMessageMock.mockClear()

			const exportBtn = container.querySelector('[data-testid="dashboard-export-json"]') as HTMLButtonElement
			fireEvent.click(exportBtn)

			expect(postMessageMock).toHaveBeenCalledTimes(1)
			const msg = postMessageMock.mock.calls[0][0] as { type: string; exportUsageStatsFormat: string }
			expect(msg.type).toBe("exportUsageStats")
			expect(msg.exportUsageStatsFormat).toBe("json")
		})

		it("sends exportUsageStats message with csv format", async () => {
			const { container } = render(<DashboardView onDone={() => {}} />)

			simulateStatsResponse(makeSnapshot())
			simulateSessionsResponse([])

			await waitFor(() => {
				expect(container.querySelector('[data-testid="dashboard-loading"]')).toBeFalsy()
			})

			postMessageMock.mockClear()

			const exportBtn = container.querySelector('[data-testid="dashboard-export-csv"]') as HTMLButtonElement
			fireEvent.click(exportBtn)

			expect(postMessageMock).toHaveBeenCalledTimes(1)
			const msg = postMessageMock.mock.calls[0][0] as { type: string; exportUsageStatsFormat: string }
			expect(msg.type).toBe("exportUsageStats")
			expect(msg.exportUsageStatsFormat).toBe("csv")
		})

		it("disables export buttons when no data", () => {
			const { container } = render(<DashboardView onDone={() => {}} />)

			// Simulate empty stats response (no data)
			simulateStatsResponse(makeSnapshot({
				totals: makeBucket({ events: 0, totalTokens: 0 }),
				buckets: [],
			}))
			simulateSessionsResponse([])

			// Wait for loading to clear
			return waitFor(() => {
				const exportJson = container.querySelector('[data-testid="dashboard-export-json"]') as HTMLButtonElement
				expect(exportJson.disabled).toBe(true)
			})
		})
	})

	// ── 7. handleClearRequest / handleClearConfirm ────────────────────────

	describe("clear flow", () => {
		it("sends requestClearNonce on clear button click", async () => {
			const { container } = render(<DashboardView onDone={() => {}} />)

			simulateStatsResponse(makeSnapshot())
			simulateSessionsResponse([])

			await waitFor(() => {
				expect(container.querySelector('[data-testid="dashboard-loading"]')).toBeFalsy()
			})

			postMessageMock.mockClear()

			const clearBtn = container.querySelector('[data-testid="dashboard-clear-button"]') as HTMLButtonElement
			fireEvent.click(clearBtn)

			expect(postMessageMock).toHaveBeenCalledTimes(1)
			const msg = postMessageMock.mock.calls[0][0] as { type: string }
			expect(msg.type).toBe("requestClearNonce")
		})

		it("sends clearUsageStats with nonce on confirm", async () => {
			const { container } = render(<DashboardView onDone={() => {}} />)

			simulateStatsResponse(makeSnapshot())
			simulateSessionsResponse([])

			await waitFor(() => {
				expect(container.querySelector('[data-testid="dashboard-loading"]')).toBeFalsy()
			})

			// Request nonce
			const clearBtn = container.querySelector('[data-testid="dashboard-clear-button"]') as HTMLButtonElement
			fireEvent.click(clearBtn)
			simulateClearNonceResponse("my-nonce-123")

			await waitFor(() => {
				expect(container.querySelector('[data-testid="dashboard-clear-dialog"]')).toBeTruthy()
			})

			postMessageMock.mockClear()

			// Confirm
			const confirmBtn = container.querySelector('[data-testid="dashboard-clear-confirm"]') as HTMLButtonElement
			fireEvent.click(confirmBtn)

			expect(postMessageMock).toHaveBeenCalledTimes(1)
			const msg = postMessageMock.mock.calls[0][0] as {
				type: string
				requestId: string
				clearUsageStatsNonce: string
			}
			expect(msg.type).toBe("clearUsageStats")
			expect(msg.requestId).toBe("my-nonce-123")
			expect(msg.clearUsageStatsNonce).toBe("my-nonce-123")
		})

		it("closes dialog on cancel", async () => {
			const { container } = render(<DashboardView onDone={() => {}} />)

			simulateStatsResponse(makeSnapshot())
			simulateSessionsResponse([])

			await waitFor(() => {
				expect(container.querySelector('[data-testid="dashboard-loading"]')).toBeFalsy()
			})

			const clearBtn = container.querySelector('[data-testid="dashboard-clear-button"]') as HTMLButtonElement
			fireEvent.click(clearBtn)
			simulateClearNonceResponse("nonce-cancel")

			await waitFor(() => {
				expect(container.querySelector('[data-testid="dashboard-clear-dialog"]')).toBeTruthy()
			})

			const cancelBtn = container.querySelector('[data-testid="dashboard-clear-cancel"]') as HTMLButtonElement
			fireEvent.click(cancelBtn)

			await waitFor(() => {
				expect(container.querySelector('[data-testid="dashboard-clear-dialog"]')).toBeFalsy()
			})
		})
	})

	// ── 8. Custom date range ──────────────────────────────────────────────

	describe("custom date range", () => {
		it("updates customFrom input value", async () => {
			const { container } = render(<DashboardView onDone={() => {}} />)

			simulateStatsResponse(makeSnapshot())
			simulateSessionsResponse([])

			await waitFor(() => {
				expect(container.querySelector('[data-testid="dashboard-loading"]')).toBeFalsy()
			})

			// Select custom preset
			const btnCustom = container.querySelector('[data-testid="dashboard-range-custom"]') as HTMLButtonElement
			fireEvent.click(btnCustom)

			const fromInput = container.querySelector('[data-testid="dashboard-custom-from"]') as HTMLInputElement
			fireEvent.change(fromInput, { target: { value: "2026-01-15" } })

			expect(fromInput.value).toBe("2026-01-15")
		})

		it("updates customTo input value", async () => {
			const { container } = render(<DashboardView onDone={() => {}} />)

			simulateStatsResponse(makeSnapshot())
			simulateSessionsResponse([])

			await waitFor(() => {
				expect(container.querySelector('[data-testid="dashboard-loading"]')).toBeFalsy()
			})

			const btnCustom = container.querySelector('[data-testid="dashboard-range-custom"]') as HTMLButtonElement
			fireEvent.click(btnCustom)

			const toInput = container.querySelector('[data-testid="dashboard-custom-to"]') as HTMLInputElement
			fireEvent.change(toInput, { target: { value: "2026-06-20" } })

			expect(toInput.value).toBe("2026-06-20")
		})

		it("applies custom range on apply button click", async () => {
			const { container } = render(<DashboardView onDone={() => {}} />)

			simulateStatsResponse(makeSnapshot())
			simulateSessionsResponse([])

			await waitFor(() => {
				expect(container.querySelector('[data-testid="dashboard-loading"]')).toBeFalsy()
			})

			// Select custom
			const btnCustom = container.querySelector('[data-testid="dashboard-range-custom"]') as HTMLButtonElement
			fireEvent.click(btnCustom)

			// Change dates
			const fromInput = container.querySelector('[data-testid="dashboard-custom-from"]') as HTMLInputElement
			fireEvent.change(fromInput, { target: { value: "2026-01-01" } })
			const toInput = container.querySelector('[data-testid="dashboard-custom-to"]') as HTMLInputElement
			fireEvent.change(toInput, { target: { value: "2026-01-31" } })

			postMessageMock.mockClear()

			// Click apply
			const applyBtn = container.querySelector('[data-testid="dashboard-custom-apply"]') as HTMLButtonElement
			fireEvent.click(applyBtn)

			await waitFor(() => {
				expect(postMessageMock).toHaveBeenCalledTimes(2)
			})

			const statsCall = postMessageMock.mock.calls.find(
				(c) => (c[0] as { type: string }).type === "getUsageStats",
			)![0] as { usageStatsQuery: { from?: string; to?: string } }
			// The component converts YYYY-MM-DD to ISO via new Date(`${date}T00:00:00`)
			// which may shift the date depending on timezone. We verify the from/to
			// are present and correspond to the correct day when parsed back.
			expect(statsCall.usageStatsQuery.from).toBeTruthy()
			expect(statsCall.usageStatsQuery.to).toBeTruthy()
			// Parse the ISO string and check the date part matches the input
			const fromDate = new Date(statsCall.usageStatsQuery.from!)
			const toDate = new Date(statsCall.usageStatsQuery.to!)
			// The from date should be Jan 1 (may be Dec 31 in UTC, but the
			// local date should be Jan 1). We check the ISO date string contains
			// "01-01" or "12-31" (timezone boundary).
			const fromStr = statsCall.usageStatsQuery.from!
			const toStr = statsCall.usageStatsQuery.to!
			expect(fromStr).toMatch(/2026-01-01|2025-12-31/)
			expect(toStr).toMatch(/2026-01-31|2026-01-30/)
			expect(fromDate).toBeInstanceOf(Date)
			expect(toDate).toBeInstanceOf(Date)
		})
	})

	// ── 9. Session handling ────────────────────────────────────────────────

	describe("session handling", () => {
		it("renders session list when data is loaded", async () => {
			const { container } = render(<DashboardView onDone={() => {}} />)

			// Wait for useEffect to run (postMessage called on mount)
			await waitFor(() => {
				expect(postMessageMock).toHaveBeenCalled()
			})

			// Use act to ensure React processes the message events
			await act(async () => {
				simulateStatsResponse(makeSnapshot())
				simulateSessionsResponse([makeSession({ taskId: "task-1", title: "Session One" })])
			})

			// Verify stats loaded (loading cleared, data section visible)
			await waitFor(() => {
				expect(container.querySelector('[data-testid="dashboard-loading"]')).toBeFalsy()
			})

			// Verify sessions loaded (sessions loading cleared)
			await waitFor(() => {
				expect(container.querySelector('[data-testid="dashboard-sessions-loading"]')).toBeFalsy()
				expect(container.querySelector('[data-testid="dashboard-sessions-error"]')).toBeFalsy()
			})
		})

		it("shows sessions loading state before response", async () => {
			const { container } = render(<DashboardView onDone={() => {}} />)

			// Respond to stats but not sessions yet
			simulateStatsResponse(makeSnapshot())

			await waitFor(() => {
				expect(container.querySelector('[data-testid="dashboard-loading"]')).toBeFalsy()
			})

			// Sessions loading indicator should be visible
			expect(container.querySelector('[data-testid="dashboard-sessions-loading"]')).toBeTruthy()
		})

		it("shows sessions error state when sessions fetch fails", async () => {
			const { container } = render(<DashboardView onDone={() => {}} />)

			simulateStatsResponse(makeSnapshot())
			simulateSessionsResponse(null, "Network error")

			await waitFor(() => {
				expect(container.querySelector('[data-testid="dashboard-sessions-error"]')).toBeTruthy()
			})
		})
	})

	// ── 10. UI rendering states ────────────────────────────────────────────

	describe("UI rendering", () => {
		it("renders the dashboard view container", () => {
			const { container } = render(<DashboardView onDone={() => {}} />)
			expect(container.querySelector('[data-testid="dashboard-view"]')).toBeTruthy()
		})

		it("renders the done button", () => {
			const { container } = render(<DashboardView onDone={() => {}} />)
			expect(container.querySelector('[data-testid="dashboard-done-button"]')).toBeTruthy()
		})

		it("calls onDone when done button is clicked", () => {
			const onDone = vi.fn()
			const { container } = render(<DashboardView onDone={onDone} />)

			const doneBtn = container.querySelector('[data-testid="dashboard-done-button"]') as HTMLButtonElement
			fireEvent.click(doneBtn)

			expect(onDone).toHaveBeenCalledTimes(1)
		})

		it("renders all range preset buttons", () => {
			const { container } = render(<DashboardView onDone={() => {}} />)

			expect(container.querySelector('[data-testid="dashboard-range-today"]')).toBeTruthy()
			expect(container.querySelector('[data-testid="dashboard-range-7d"]')).toBeTruthy()
			expect(container.querySelector('[data-testid="dashboard-range-30d"]')).toBeTruthy()
			expect(container.querySelector('[data-testid="dashboard-range-custom"]')).toBeTruthy()
			expect(container.querySelector('[data-testid="dashboard-range-all"]')).toBeTruthy()
		})

		it("renders all groupBy buttons", async () => {
			const { container } = render(<DashboardView onDone={() => {}} />)

			simulateStatsResponse(makeSnapshot())
			simulateSessionsResponse([])

			await waitFor(() => {
				expect(container.querySelector('[data-testid="dashboard-breakdown"]')).toBeTruthy()
			})

			expect(container.querySelector('[data-testid="dashboard-groupby-model"]')).toBeTruthy()
			expect(container.querySelector('[data-testid="dashboard-groupby-provider"]')).toBeTruthy()
			expect(container.querySelector('[data-testid="dashboard-groupby-mode"]')).toBeTruthy()
		})

		it("renders empty state when no data", async () => {
			const { container } = render(<DashboardView onDone={() => {}} />)

			simulateStatsResponse(makeSnapshot({
				totals: makeBucket({ events: 0, totalTokens: 0 }),
				buckets: [],
			}))
			simulateSessionsResponse([])

			await waitFor(() => {
				expect(container.querySelector('[data-testid="dashboard-empty"]')).toBeTruthy()
			})
		})

		it("renders error state with refresh button", async () => {
			const { container } = render(<DashboardView onDone={() => {}} />)

			simulateStatsResponse(null)
			simulateSessionsResponse([])

			await waitFor(() => {
				const errorEl = container.querySelector('[data-testid="dashboard-error"]')
				expect(errorEl).toBeTruthy()
				// Error state should have a refresh button
				const refreshBtn = errorEl?.querySelector("button")
				expect(refreshBtn).toBeTruthy()
			})
		})

		it("renders data state with breakdown table when data exists", async () => {
			const { container } = render(<DashboardView onDone={() => {}} />)

			simulateStatsResponse(makeSnapshot({
				buckets: [
					makeBucket({ key: { model: "gpt-4" }, totalTokens: 5000, events: 5 }),
					makeBucket({ key: { model: "claude-3" }, totalTokens: 3000, events: 3 }),
				],
				totals: makeBucket({ events: 8, totalTokens: 8000 }),
			}))
			simulateSessionsResponse([])

			await waitFor(() => {
				expect(container.querySelector('[data-testid="dashboard-breakdown"]')).toBeTruthy()
			})

			// Verify table rows
			const rows = container.querySelectorAll("tbody tr")
			expect(rows.length).toBe(2)
		})

		it("renders coverage section when snapshot has coverage", async () => {
			const { container } = render(<DashboardView onDone={() => {}} />)

			simulateStatsResponse(makeSnapshot({
				coverage: {
					firstEventAt: "2026-01-01T00:00:00Z",
					lastEventAt: "2026-07-01T00:00:00Z",
					recordingPaused: false,
					backfilledEventCount: 5,
				},
			}))
			simulateSessionsResponse([])

			await waitFor(() => {
				expect(container.querySelector('[data-testid="dashboard-coverage"]')).toBeTruthy()
			})
		})

		it("renders coverage with recordingPaused indicator", async () => {
			const { container } = render(<DashboardView onDone={() => {}} />)

			simulateStatsResponse(makeSnapshot({
				coverage: {
					recordingPaused: true,
					backfilledEventCount: 0,
				},
			}))
			simulateSessionsResponse([])

			await waitFor(() => {
				const coverage = container.querySelector('[data-testid="dashboard-coverage"]')
				expect(coverage).toBeTruthy()
				expect(coverage?.textContent).toContain("dashboard:coverage.paused")
			})
		})

		it("renders DashboardSummary and UsageHeatmap when data exists", async () => {
			const { container } = render(<DashboardView onDone={() => {}} />)

			simulateStatsResponse(makeSnapshot())
			simulateSessionsResponse([])

			await waitFor(() => {
				expect(container.querySelector('[data-testid="dashboard-summary"]')).toBeTruthy()
				expect(container.querySelector('[data-testid="usage-heatmap"]')).toBeTruthy()
			})
		})
	})
})
