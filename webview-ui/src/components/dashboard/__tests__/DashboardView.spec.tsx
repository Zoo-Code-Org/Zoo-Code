// npx vitest run src/components/dashboard/__tests__/DashboardView.spec.tsx

import React, { useSyncExternalStore } from "react"
import { render, fireEvent, waitFor, act } from "@/utils/test-utils"

import type { StatsBucket } from "@roo-code/types"

import DashboardView from "../DashboardView"

// ── Mock i18n ───────────────────────────────────────────────────────────────

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

// ── Mock useDashboardStatsStream ─────────────────────────────────────────────
// Use useSyncExternalStore so external state changes trigger React re-renders.

const { streamStore, replaceSubscriptionMock, requestTaskPageMock } = vi.hoisted(() => {
	const initialState = {
		status: "idle" as string,
		subscriptionId: null as string | null,
		generation: null as number | null,
		sequence: 0,
		isLoading: true,
		pendingResync: false,
		backgroundError: null as { code: string; message: string } | null,
		query: null,
		generatedAt: null,
		totals: null as StatsBucket | null,
		buckets: {} as Record<string, StatsBucket>,
		bucketOrder: [] as string[],
		coverage: null as Record<string, unknown> | null,
		heatmapRangeDays: null as number | null,
		heatmapValues: [] as number[],
		tasks: {} as Record<string, unknown>,
		taskOrder: [] as string[],
		taskCursor: undefined as string | undefined,
		taskTotalEstimate: 0,
	}

	type State = typeof initialState
	let currentState: State = initialState
	const listeners = new Set<() => void>()

	return {
		streamStore: {
			getSnapshot: () => currentState,
			subscribe: (listener: () => void) => {
				listeners.add(listener)
				return () => listeners.delete(listener)
			},
			setState: (next: State) => {
				currentState = next
				listeners.forEach((l) => l())
			},
			getInitialState: () => initialState,
		},
		replaceSubscriptionMock: vi.fn(),
		requestTaskPageMock: vi.fn(),
	}
})

vi.mock("@/components/dashboard/useDashboardStatsStream", () => ({
	useDashboardStatsStream: () => {
		const state = useSyncExternalStore(streamStore.subscribe, streamStore.getSnapshot)
		return {
			state,
			requestTaskPage: requestTaskPageMock,
			isTaskPageLoading: false,
			replaceSubscription: replaceSubscriptionMock,
		}
	},
}))

// ── Mock child components to avoid deep rendering ────────────────────────────

vi.mock("../DashboardSummary", () => ({
	default: () => <div data-testid="dashboard-summary" />,
}))

vi.mock("@/components/dashboard/TaskList", () => ({
	default: ({
		tasks,
		taskDetails,
		onToggleTask,
	}: {
		tasks: Array<{ taskId: string }>
		taskDetails: Record<string, { title: string } | null>
		onToggleTask: (taskId: string) => void
	}) => (
		<div data-testid="task-list">
			{tasks.map((task) => (
				<button key={task.taskId} onClick={() => onToggleTask(task.taskId)}>
					{task.taskId}
				</button>
			))}
			{Object.entries(taskDetails).map(([taskId, detail]) => (
				<div key={taskId} data-testid={`task-detail-${taskId}`}>
					{detail?.title}
				</div>
			))}
		</div>
	),
}))

vi.mock("../UsageHeatmap", () => ({
	default: () => <div data-testid="usage-heatmap" />,
}))

// ── Mock common/Tab ────────────────────────────────────────────────────────

vi.mock("@/components/common/Tab", () => ({
	Tab: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
	TabHeader: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
	TabContent: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
}))

// ── Mock AlertDialog ────────────────────────────────────────────────────────

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
	AlertDialogCancel: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => {
		const { onOpenChange } = React.useContext(AlertDialogContext)
		return (
			<button
				{...props}
				onClick={(e) => {
					onOpenChange?.(false)
					props.onClick?.(e)
				}}>
				{children}
			</button>
		)
	},
	AlertDialogAction: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
		<button {...props}>{children}</button>
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

function setStreamState(overrides: Record<string, unknown>) {
	const next = { ...streamStore.getSnapshot(), ...overrides }
	act(() => {
		streamStore.setState(next)
	})
}

function resetStreamState() {
	act(() => {
		streamStore.setState(streamStore.getInitialState())
	})
}

function setConnectedState(overrides: Record<string, unknown> = {}) {
	setStreamState({
		isLoading: false,
		status: "connected",
		totals: makeBucket({ events: 10, totalTokens: 7500 }),
		bucketOrder: ["key-1"],
		buckets: { "key-1": makeBucket({ key: { model: "gpt-4" } }) },
		heatmapRangeDays: 30,
		heatmapValues: [1000],
		coverage: { recordingPaused: false, backfilledEventCount: 0 },
		...overrides,
	})
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("DashboardView (streaming)", () => {
	beforeEach(() => {
		postMessageMock.mockClear()
		replaceSubscriptionMock.mockClear()
		requestTaskPageMock.mockClear()
		resetStreamState()
	})

	describe("task detail responses", () => {
		it("stores a synchronous detail response for the task that initiated the request", async () => {
			postMessageMock.mockImplementationOnce((message: { type: string; requestId: string }) => {
				if (message.type !== "getDashboardTaskDetail") return
				window.dispatchEvent(
					new MessageEvent("message", {
						data: {
							type: "dashboardTaskDetailResponse",
							requestId: message.requestId,
							dashboardTaskDetail: { title: "Loaded before render" },
						},
					}),
				)
			})

			const { getByTestId, findByRole } = render(<DashboardView onDone={() => {}} />)
			act(() => {
				setConnectedState({
					tasks: {
						"task-race": {
							taskId: "task-race",
							rootTaskId: "task-race",
							title: "Race task",
							taskTimestamp: 0,
							totalCost: 0,
							totalTokens: 1,
							model: "model",
							provider: "provider",
							lastUsageAt: 0,
							eventCount: 1,
						},
					},
					taskOrder: ["task-race"],
				})
			})
			fireEvent.click(await findByRole("button", { name: "task-race" }))

			await waitFor(() => expect(getByTestId("task-detail-task-race").textContent).toBe("Loaded before render"))
		})
	})

	// ── 1. Initial mount ──────────────────────────────────────────────────

	describe("initial mount", () => {
		it("renders loading state before first snapshot", () => {
			const { container } = render(<DashboardView onDone={() => {}} />)
			expect(container.querySelector('[data-testid="dashboard-loading"]')).toBeTruthy()
		})

		it("renders the dashboard view container", () => {
			const { container } = render(<DashboardView onDone={() => {}} />)
			expect(container.querySelector('[data-testid="dashboard-view"]')).toBeTruthy()
		})

		it("renders the done button", () => {
			const { container } = render(<DashboardView onDone={() => {}} />)
			expect(container.querySelector('[data-testid="dashboard-done-button"]')).toBeTruthy()
		})

		it("renders all range preset buttons", () => {
			const { container } = render(<DashboardView onDone={() => {}} />)
			expect(container.querySelector('[data-testid="dashboard-range-today"]')).toBeTruthy()
			expect(container.querySelector('[data-testid="dashboard-range-7d"]')).toBeTruthy()
			expect(container.querySelector('[data-testid="dashboard-range-30d"]')).toBeTruthy()
			expect(container.querySelector('[data-testid="dashboard-range-custom"]')).toBeTruthy()
			expect(container.querySelector('[data-testid="dashboard-range-all"]')).toBeTruthy()
		})
	})

	// ── 2. No loading spinner after first snapshot ─────────────────────────

	describe("no loading spinner after first snapshot", () => {
		it("does not show loading spinner after first snapshot arrives", async () => {
			const { container, rerender } = render(<DashboardView onDone={() => {}} />)

			// Initially loading
			expect(container.querySelector('[data-testid="dashboard-loading"]')).toBeTruthy()

			// Simulate first snapshot arriving
			setConnectedState()
			rerender(<DashboardView onDone={() => {}} />)

			await waitFor(() => {
				expect(container.querySelector('[data-testid="dashboard-loading"]')).toBeFalsy()
				expect(container.querySelector('[data-testid="dashboard-breakdown"]')).toBeTruthy()
			})
		})

		it("does not show loading spinner during background resync (replaceSubscription)", async () => {
			const { container, rerender } = render(<DashboardView onDone={() => {}} />)

			// First snapshot
			setConnectedState()
			rerender(<DashboardView onDone={() => {}} />)

			await waitFor(() => {
				expect(container.querySelector('[data-testid="dashboard-breakdown"]')).toBeTruthy()
			})

			// Simulate a replace subscription — isLoading stays false (stale-while-revalidate)
			setStreamState({
				isLoading: false,
				status: "connected",
			})
			rerender(<DashboardView onDone={() => {}} />)

			// No loading spinner should appear
			expect(container.querySelector('[data-testid="dashboard-loading"]')).toBeFalsy()
			expect(container.querySelector('[data-testid="dashboard-breakdown"]')).toBeTruthy()
		})
	})

	// ── 3. Preset change triggers replaceSubscription ─────────────────────

	describe("handlePresetChange", () => {
		it("triggers replaceSubscription when preset changes to 7d", async () => {
			const { container, rerender } = render(<DashboardView onDone={() => {}} />)

			setConnectedState()
			rerender(<DashboardView onDone={() => {}} />)

			await waitFor(() => {
				expect(container.querySelector('[data-testid="dashboard-breakdown"]')).toBeTruthy()
			})

			replaceSubscriptionMock.mockClear()

			const btn7d = container.querySelector('[data-testid="dashboard-range-7d"]') as HTMLButtonElement
			fireEvent.click(btn7d)

			await waitFor(() => {
				expect(replaceSubscriptionMock).toHaveBeenCalledTimes(1)
			})

			const call = replaceSubscriptionMock.mock.calls[0]
			expect(call[0]).toBeTruthy()
			expect(call[1]).toBe(30) // heatmapRangeDays for 30d
			expect(call[2]).toBe(50) // sessionPageSize
		})

		it("does not re-arm the resync indicator when the active preset is clicked again", async () => {
			const { container, rerender } = render(<DashboardView onDone={() => {}} />)

			setConnectedState({ generatedAt: "2026-08-01T00:00:00Z" })
			rerender(<DashboardView onDone={() => {}} />)

			await waitFor(() => {
				expect(container.querySelector('[data-testid="dashboard-breakdown"]')).toBeTruthy()
			})

			// First click on a different preset: indicator shows, replace fires.
			const btn7d = container.querySelector('[data-testid="dashboard-range-7d"]') as HTMLButtonElement
			fireEvent.click(btn7d)
			expect(container.querySelector('[data-testid="dashboard-resyncing"]')).toBeTruthy()

			// New snapshot arrives -> indicator clears.
			setStreamState({ generatedAt: "2026-08-02T00:00:00Z" })
			await waitFor(() => {
				expect(container.querySelector('[data-testid="dashboard-resyncing"]')).toBeFalsy()
			})

			// Clicking the now-active preset again must not re-arm the indicator:
			// no resubscription happens, so no snapshot would ever clear it.
			replaceSubscriptionMock.mockClear()
			fireEvent.click(btn7d)
			expect(replaceSubscriptionMock).not.toHaveBeenCalled()
			expect(container.querySelector('[data-testid="dashboard-resyncing"]')).toBeFalsy()
		})
	})

	// ── 4. GroupBy change triggers replaceSubscription ─────────────────────

	describe("handleGroupByChange", () => {
		it("triggers replaceSubscription when groupBy changes", async () => {
			const { container, rerender } = render(<DashboardView onDone={() => {}} />)

			setConnectedState()
			rerender(<DashboardView onDone={() => {}} />)

			await waitFor(() => {
				expect(container.querySelector('[data-testid="dashboard-breakdown"]')).toBeTruthy()
			})

			replaceSubscriptionMock.mockClear()

			const btnProvider = container.querySelector(
				'[data-testid="dashboard-groupby-provider"]',
			) as HTMLButtonElement
			fireEvent.click(btnProvider)

			await waitFor(() => {
				expect(replaceSubscriptionMock).toHaveBeenCalledTimes(1)
			})
		})
	})

	// ── 5. Refresh triggers replaceSubscription ────────────────────────────

	describe("handleRefresh", () => {
		it("triggers replaceSubscription on refresh click", async () => {
			const { container, rerender } = render(<DashboardView onDone={() => {}} />)

			setConnectedState()
			rerender(<DashboardView onDone={() => {}} />)

			await waitFor(() => {
				expect(container.querySelector('[data-testid="dashboard-breakdown"]')).toBeTruthy()
			})

			replaceSubscriptionMock.mockClear()

			const refreshBtn = container.querySelector('[data-testid="dashboard-refresh-button"]') as HTMLButtonElement
			fireEvent.click(refreshBtn)

			expect(replaceSubscriptionMock).toHaveBeenCalledTimes(1)
		})
	})

	// ── 6. Empty and error states ──────────────────────────────────────────

	describe("UI rendering states", () => {
		it("renders empty state when no data", async () => {
			const { container, rerender } = render(<DashboardView onDone={() => {}} />)

			setStreamState({
				isLoading: false,
				status: "connected",
				totals: makeBucket({ events: 0, totalTokens: 0 }),
				bucketOrder: [],
				buckets: {},
				heatmapRangeDays: 30,
				heatmapValues: [],
				coverage: null,
			})
			rerender(<DashboardView onDone={() => {}} />)

			await waitFor(() => {
				expect(container.querySelector('[data-testid="dashboard-empty"]')).toBeTruthy()
			})
		})

		it("renders data state with breakdown table when data exists", async () => {
			const { container, rerender } = render(<DashboardView onDone={() => {}} />)

			setStreamState({
				isLoading: false,
				status: "connected",
				totals: makeBucket({ events: 8, totalTokens: 8000 }),
				bucketOrder: ["key-1", "key-2"],
				buckets: {
					"key-1": makeBucket({ key: { model: "gpt-4" }, totalTokens: 5000, events: 5 }),
					"key-2": makeBucket({ key: { model: "claude-3" }, totalTokens: 3000, events: 3 }),
				},
				heatmapRangeDays: 30,
				heatmapValues: [1000],
				coverage: { recordingPaused: false, backfilledEventCount: 0 },
			})
			rerender(<DashboardView onDone={() => {}} />)

			await waitFor(() => {
				expect(container.querySelector('[data-testid="dashboard-breakdown"]')).toBeTruthy()
			})

			const rows = container.querySelectorAll("tbody tr")
			expect(rows.length).toBe(2)
		})

		it("renders DashboardSummary and UsageHeatmap when data exists", async () => {
			const { container, rerender } = render(<DashboardView onDone={() => {}} />)

			setConnectedState()
			rerender(<DashboardView onDone={() => {}} />)

			await waitFor(() => {
				expect(container.querySelector('[data-testid="dashboard-summary"]')).toBeTruthy()
				expect(container.querySelector('[data-testid="usage-heatmap"]')).toBeTruthy()
			})
		})

		it("renders coverage section when snapshot has coverage", async () => {
			const { container, rerender } = render(<DashboardView onDone={() => {}} />)

			setConnectedState({
				coverage: {
					firstEventAt: "2026-01-01T00:00:00Z",
					lastEventAt: "2026-07-01T00:00:00Z",
					recordingPaused: false,
					backfilledEventCount: 5,
				},
			})
			rerender(<DashboardView onDone={() => {}} />)

			await waitFor(() => {
				expect(container.querySelector('[data-testid="dashboard-coverage"]')).toBeTruthy()
			})
		})

		it("renders coverage with recordingPaused indicator", async () => {
			const { container, rerender } = render(<DashboardView onDone={() => {}} />)

			setConnectedState({
				coverage: {
					recordingPaused: true,
					backfilledEventCount: 0,
				},
			})
			rerender(<DashboardView onDone={() => {}} />)

			await waitFor(() => {
				const coverage = container.querySelector('[data-testid="dashboard-coverage"]')
				expect(coverage).toBeTruthy()
				expect(coverage?.textContent).toContain("dashboard:coverage.paused")
			})
		})

		it("renders background error banner when backgroundError exists and data is visible", async () => {
			const { container, rerender } = render(<DashboardView onDone={() => {}} />)

			setConnectedState({
				status: "error",
				backgroundError: { code: "STATS_STREAM/query/001", message: "Background error" },
			})
			rerender(<DashboardView onDone={() => {}} />)

			await waitFor(() => {
				expect(container.querySelector('[data-testid="dashboard-background-error"]')).toBeTruthy()
			})
		})
	})

	// ── 7. Custom date range ──────────────────────────────────────────────

	describe("custom date range", () => {
		it("shows custom date range inputs when custom preset is selected", async () => {
			const { container, rerender } = render(<DashboardView onDone={() => {}} />)

			setConnectedState()
			rerender(<DashboardView onDone={() => {}} />)

			await waitFor(() => {
				expect(container.querySelector('[data-testid="dashboard-breakdown"]')).toBeTruthy()
			})

			const btnCustom = container.querySelector('[data-testid="dashboard-range-custom"]') as HTMLButtonElement
			fireEvent.click(btnCustom)

			expect(container.querySelector('[data-testid="dashboard-custom-range"]')).toBeTruthy()
			expect(container.querySelector('[data-testid="dashboard-custom-from"]')).toBeTruthy()
			expect(container.querySelector('[data-testid="dashboard-custom-to"]')).toBeTruthy()
		})

		it("triggers replaceSubscription on apply custom range", async () => {
			const { container, rerender } = render(<DashboardView onDone={() => {}} />)

			setConnectedState()
			rerender(<DashboardView onDone={() => {}} />)

			await waitFor(() => {
				expect(container.querySelector('[data-testid="dashboard-breakdown"]')).toBeTruthy()
			})

			// Select custom
			const btnCustom = container.querySelector('[data-testid="dashboard-range-custom"]') as HTMLButtonElement
			fireEvent.click(btnCustom)

			// Change dates
			const fromInput = container.querySelector('[data-testid="dashboard-custom-from"]') as HTMLInputElement
			fireEvent.change(fromInput, { target: { value: "2026-01-01" } })
			const toInput = container.querySelector('[data-testid="dashboard-custom-to"]') as HTMLInputElement
			fireEvent.change(toInput, { target: { value: "2026-01-31" } })

			replaceSubscriptionMock.mockClear()

			const applyBtn = container.querySelector('[data-testid="dashboard-custom-apply"]') as HTMLButtonElement
			fireEvent.click(applyBtn)

			await waitFor(() => {
				expect(replaceSubscriptionMock).toHaveBeenCalledTimes(1)
			})
		})
	})

	// ── 8. Export ─────────────────────────────────────────────────────────

	describe("handleExport", () => {
		it("sends exportUsageStats message with csv format", async () => {
			const { container, rerender } = render(<DashboardView onDone={() => {}} />)

			setConnectedState()
			rerender(<DashboardView onDone={() => {}} />)

			await waitFor(() => {
				expect(container.querySelector('[data-testid="dashboard-breakdown"]')).toBeTruthy()
			})

			postMessageMock.mockClear()

			const exportBtn = container.querySelector('[data-testid="dashboard-export-csv"]') as HTMLButtonElement
			fireEvent.click(exportBtn)

			expect(postMessageMock).toHaveBeenCalledTimes(1)
			const msg = postMessageMock.mock.calls[0][0] as { type: string; exportUsageStatsFormat: string }
			expect(msg.type).toBe("exportUsageStats")
			expect(msg.exportUsageStatsFormat).toBe("csv")
		})

		it("disables export button when no data", async () => {
			const { container, rerender } = render(<DashboardView onDone={() => {}} />)

			setStreamState({
				isLoading: false,
				status: "connected",
				totals: makeBucket({ events: 0, totalTokens: 0 }),
				bucketOrder: [],
				buckets: {},
				heatmapRangeDays: 30,
				heatmapValues: [],
				coverage: null,
			})
			rerender(<DashboardView onDone={() => {}} />)

			await waitFor(() => {
				const exportCsv = container.querySelector('[data-testid="dashboard-export-csv"]') as HTMLButtonElement
				expect(exportCsv.disabled).toBe(true)
			})
		})
	})

	// ── 9. Clear flow ──────────────────────────────────────────────────────

	describe("clear flow", () => {
		it("sends requestClearNonce on clear button click", async () => {
			const { container, rerender } = render(<DashboardView onDone={() => {}} />)

			setConnectedState()
			rerender(<DashboardView onDone={() => {}} />)

			await waitFor(() => {
				expect(container.querySelector('[data-testid="dashboard-breakdown"]')).toBeTruthy()
			})

			postMessageMock.mockClear()

			const clearBtn = container.querySelector('[data-testid="dashboard-clear-button"]') as HTMLButtonElement
			fireEvent.click(clearBtn)

			expect(postMessageMock).toHaveBeenCalledTimes(1)
			const msg = postMessageMock.mock.calls[0][0] as { type: string }
			expect(msg.type).toBe("requestClearNonce")
		})

		it("opens clear dialog when nonce is received", async () => {
			const { container, rerender } = render(<DashboardView onDone={() => {}} />)

			setConnectedState()
			rerender(<DashboardView onDone={() => {}} />)

			await waitFor(() => {
				expect(container.querySelector('[data-testid="dashboard-breakdown"]')).toBeTruthy()
			})

			const clearBtn = container.querySelector('[data-testid="dashboard-clear-button"]') as HTMLButtonElement
			fireEvent.click(clearBtn)

			await waitFor(() => {
				expect(
					postMessageMock.mock.calls.some((c) => (c[0] as { type: string }).type === "requestClearNonce"),
				).toBe(true)
			})

			// Simulate nonce response
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "requestClearNonceResponse",
						requestId: "test-nonce-req",
						clearNonce: "nonce-123",
					},
				}),
			)

			await waitFor(() => {
				expect(container.querySelector('[data-testid="dashboard-clear-dialog"]')).toBeTruthy()
			})
		})

		it("sends clearUsageStats with nonce on confirm", async () => {
			const { container, rerender } = render(<DashboardView onDone={() => {}} />)

			setConnectedState()
			rerender(<DashboardView onDone={() => {}} />)

			await waitFor(() => {
				expect(container.querySelector('[data-testid="dashboard-breakdown"]')).toBeTruthy()
			})

			const clearBtn = container.querySelector('[data-testid="dashboard-clear-button"]') as HTMLButtonElement
			fireEvent.click(clearBtn)

			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "requestClearNonceResponse",
						requestId: "test-nonce-req",
						clearNonce: "my-nonce-123",
					},
				}),
			)

			await waitFor(() => {
				expect(container.querySelector('[data-testid="dashboard-clear-dialog"]')).toBeTruthy()
			})

			postMessageMock.mockClear()

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
			const { container, rerender } = render(<DashboardView onDone={() => {}} />)

			setConnectedState()
			rerender(<DashboardView onDone={() => {}} />)

			await waitFor(() => {
				expect(container.querySelector('[data-testid="dashboard-breakdown"]')).toBeTruthy()
			})

			const clearBtn = container.querySelector('[data-testid="dashboard-clear-button"]') as HTMLButtonElement
			fireEvent.click(clearBtn)

			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "requestClearNonceResponse",
						requestId: "test-nonce-req",
						clearNonce: "nonce-cancel",
					},
				}),
			)

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

	// ── 10. Rebuild Stats ────────────────────────────────────────────────

	describe("handleRebuildStats", () => {
		it("sends rebuildUsageStats message on rebuild button click", async () => {
			const { container, rerender } = render(<DashboardView onDone={() => {}} />)

			setConnectedState()
			rerender(<DashboardView onDone={() => {}} />)

			await waitFor(() => {
				expect(container.querySelector('[data-testid="dashboard-breakdown"]')).toBeTruthy()
			})

			postMessageMock.mockClear()

			const rebuildBtn = container.querySelector('[data-testid="dashboard-rebuild-button"]') as HTMLButtonElement
			fireEvent.click(rebuildBtn)

			expect(postMessageMock).toHaveBeenCalledTimes(1)
			const msg = postMessageMock.mock.calls[0][0] as { type: string; requestId: string }
			expect(msg.type).toBe("rebuildUsageStats")
			expect(msg.requestId).toContain("dashboard-rebuild-")
		})

		it("disables rebuild button when no data", async () => {
			const { container, rerender } = render(<DashboardView onDone={() => {}} />)

			setStreamState({
				isLoading: false,
				status: "connected",
				totals: makeBucket({ events: 0, totalTokens: 0 }),
				bucketOrder: [],
				buckets: {},
				heatmapRangeDays: 30,
				heatmapValues: [],
				coverage: null,
			})
			rerender(<DashboardView onDone={() => {}} />)

			await waitFor(() => {
				const rebuildBtn = container.querySelector(
					'[data-testid="dashboard-rebuild-button"]',
				) as HTMLButtonElement
				expect(rebuildBtn.disabled).toBe(true)
			})
		})

		it("triggers replaceSubscription on rebuildUsageStatsResponse success", async () => {
			const { container, rerender } = render(<DashboardView onDone={() => {}} />)

			setConnectedState()
			rerender(<DashboardView onDone={() => {}} />)

			await waitFor(() => {
				expect(container.querySelector('[data-testid="dashboard-breakdown"]')).toBeTruthy()
			})

			replaceSubscriptionMock.mockClear()

			// Simulate rebuild response message
			const messageEvent = new MessageEvent("message", {
				data: {
					type: "rebuildUsageStatsResponse",
					rebuildUsageStatsResult: { success: true },
				},
			})
			window.dispatchEvent(messageEvent)

			expect(replaceSubscriptionMock).toHaveBeenCalledTimes(1)
		})

		it("sets error on rebuildUsageStatsResponse failure", async () => {
			const { container, rerender } = render(<DashboardView onDone={() => {}} />)

			setConnectedState()
			rerender(<DashboardView onDone={() => {}} />)

			await waitFor(() => {
				expect(container.querySelector('[data-testid="dashboard-breakdown"]')).toBeTruthy()
			})

			// Simulate rebuild failure response
			const messageEvent = new MessageEvent("message", {
				data: {
					type: "rebuildUsageStatsResponse",
					rebuildUsageStatsResult: { success: false, error: "Rebuild failed" },
				},
			})
			window.dispatchEvent(messageEvent)

			// setError is called, which renders dashboard-error-banner when hasData is true
			await waitFor(() => {
				expect(container.querySelector('[data-testid="dashboard-error-banner"]')).toBeTruthy()
			})
		})
	})

	// ── 11. onDone ────────────────────────────────────────────────────────

	describe("onDone", () => {
		it("calls onDone when done button is clicked", () => {
			const onDone = vi.fn()
			const { container } = render(<DashboardView onDone={onDone} />)

			const doneBtn = container.querySelector('[data-testid="dashboard-done-button"]') as HTMLButtonElement
			fireEvent.click(doneBtn)

			expect(onDone).toHaveBeenCalledTimes(1)
		})
	})
})
