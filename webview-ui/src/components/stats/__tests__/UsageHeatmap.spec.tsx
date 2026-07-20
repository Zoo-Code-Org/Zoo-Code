// pnpm --filter @roo-code/vscode-webview test src/components/stats/__tests__/UsageHeatmap.spec.tsx

import React from "react"
import { render, fireEvent, waitFor } from "@/utils/test-utils"

import type { StatsBucket } from "@roo-code/types"

import UsageHeatmap from "../UsageHeatmap"

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

// ── vscode mock ──────────────────────────────────────────────────────────────

// Captures postMessage calls so tests can inspect the query and simulate
// the extension host's response.
const postMessageMock = vi.fn()
vi.mock("@/utils/vscode", () => ({
	vscode: {
		postMessage: (msg: unknown) => postMessageMock(msg),
	},
}))

// ── Test helpers ─────────────────────────────────────────────────────────────

/**
 * Simulates the extension host responding to a getUsageStats request.
 * Finds the latest requestId from the captured postMessage calls and
 * dispatches a matching getUsageStatsResponse MessageEvent on window.
 */
function simulateStatsResponse(buckets: StatsBucket[]) {
	const calls = postMessageMock.mock.calls
	expect(calls.length).toBeGreaterThan(0)

	const lastCall = calls[calls.length - 1][0] as { requestId: string }
	const requestId = lastCall.requestId

	const snapshot = {
		query: { from: new Date().toISOString(), timezone: "UTC", groupBy: ["day"], includeCancelled: false },
		generatedAt: new Date().toISOString(),
		buckets,
		totals: buckets.reduce(
			(acc, b) => {
				acc.totalTokens += b.totalTokens
				acc.events += b.events
				return acc
			},
			{ totalTokens: 0, events: 0 } as Record<string, number>,
		),
		coverage: { firstEventAt: undefined, lastEventAt: undefined },
	}

	window.dispatchEvent(
		new MessageEvent("message", {
			data: {
				type: "getUsageStatsResponse",
				requestId,
				usageStatsSnapshot: snapshot,
			},
		}),
	)
}

// ── Test fixtures ────────────────────────────────────────────────────────────

/**
 * Returns a YYYY-MM-DD key for N days ago relative to today.
 */
function daysAgoKey(daysAgo: number): string {
	const date = new Date()
	date.setHours(0, 0, 0, 0)
	date.setDate(date.getDate() - daysAgo)
	const year = date.getFullYear()
	const month = String(date.getMonth() + 1).padStart(2, "0")
	const day = String(date.getDate()).padStart(2, "0")
	return `${year}-${month}-${day}`
}

function makeBucket(overrides: Partial<StatsBucket> = {}): StatsBucket {
	return {
		key: {},
		events: 1,
		completedCalls: 1,
		failedCalls: 0,
		cancelledCalls: 0,
		inputTokens: 1000,
		outputTokens: 500,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		reasoningTokens: 0,
		totalTokens: 1500,
		costUsd: 0.01,
		unknownEventCount: 0,
		...overrides,
	}
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("UsageHeatmap", () => {
	beforeEach(() => {
		postMessageMock.mockClear()
	})

	it("renders the heatmap container with title", () => {
		const { container } = render(<UsageHeatmap />)

		const heatmap = container.querySelector('[data-testid="usage-heatmap"]')
		expect(heatmap).toBeTruthy()
		expect(heatmap?.textContent).toContain("stats:heatmap.title")
	})

	it("renders no-data message when buckets are empty", async () => {
		const { container } = render(<UsageHeatmap />)

		simulateStatsResponse([])

		await waitFor(() => {
			const heatmap = container.querySelector('[data-testid="usage-heatmap"]')
			expect(heatmap?.textContent).toContain("stats:heatmap.noData")
		})
	})

	it("renders no-data message when all buckets have zero totalTokens", async () => {
		const buckets = [
			makeBucket({ key: { day: daysAgoKey(0) }, totalTokens: 0, events: 0 }),
			makeBucket({ key: { day: daysAgoKey(1) }, totalTokens: 0, events: 0 }),
		]

		const { container } = render(<UsageHeatmap />)

		simulateStatsResponse(buckets)

		await waitFor(() => {
			const heatmap = container.querySelector('[data-testid="usage-heatmap"]')
			expect(heatmap?.textContent).toContain("stats:heatmap.noData")
		})
	})

	it("renders heatmap grid when data exists", async () => {
		const buckets = [
			makeBucket({ key: { day: daysAgoKey(0) }, totalTokens: 5000, events: 3 }),
			makeBucket({ key: { day: daysAgoKey(1) }, totalTokens: 3000, events: 2 }),
		]

		const { container } = render(<UsageHeatmap />)

		simulateStatsResponse(buckets)

		await waitFor(() => {
			// noData message should not be displayed
			const heatmap = container.querySelector('[data-testid="usage-heatmap"]')
			expect(heatmap?.textContent).not.toContain("stats:heatmap.noData")

			// Verify grid role attribute
			const grid = container.querySelector('[role="img"]')
			expect(grid).toBeTruthy()
		})
	})

	it("renders 30d, 60d, 120d, and 360d range toggle buttons", () => {
		const { container } = render(<UsageHeatmap />)

		const btn30d = container.querySelector('[data-testid="heatmap-range-30d"]')
		const btn60d = container.querySelector('[data-testid="heatmap-range-60d"]')
		const btn120d = container.querySelector('[data-testid="heatmap-range-120d"]')
		const btn360d = container.querySelector('[data-testid="heatmap-range-360d"]')

		expect(btn30d).toBeTruthy()
		expect(btn60d).toBeTruthy()
		expect(btn120d).toBeTruthy()
		expect(btn360d).toBeTruthy()
		expect(btn30d?.textContent).toContain("stats:heatmap.30d")
		expect(btn60d?.textContent).toContain("stats:heatmap.60d")
		expect(btn120d?.textContent).toContain("stats:heatmap.120d")
		expect(btn360d?.textContent).toContain("stats:heatmap.360d")
	})

	it("defaults to 30d range", async () => {
		const buckets = [makeBucket({ key: { day: daysAgoKey(0) }, totalTokens: 1000, events: 1 })]

		const { container } = render(<UsageHeatmap />)

		simulateStatsResponse(buckets)

		// In 30d mode, 30 date cells are generated
		await waitFor(() => {
			const cells = container.querySelectorAll('[role="img"] [aria-label]')
			expect(cells.length).toBe(30)
		})
	})

	it("switches to 60d range when 60d button is clicked", async () => {
		const buckets = [makeBucket({ key: { day: daysAgoKey(0) }, totalTokens: 1000, events: 1 })]

		const { container } = render(<UsageHeatmap />)

		simulateStatsResponse(buckets)

		// Wait for initial data to load
		await waitFor(() => {
			expect(container.querySelectorAll('[role="img"] [aria-label]').length).toBe(30)
		})

		const btn60d = container.querySelector('[data-testid="heatmap-range-60d"]') as HTMLButtonElement
		fireEvent.click(btn60d)

		// Simulate response for the 60d request
		simulateStatsResponse(buckets)

		// In 60d mode, 60 date cells are generated
		await waitFor(() => {
			expect(container.querySelectorAll('[role="img"] [aria-label]').length).toBe(60)
		})
	})

	it("switches back to 30d range when 30d button is clicked after 60d", async () => {
		const buckets = [makeBucket({ key: { day: daysAgoKey(0) }, totalTokens: 1000, events: 1 })]

		const { container } = render(<UsageHeatmap />)

		simulateStatsResponse(buckets)

		// Wait for initial data to load
		await waitFor(() => {
			expect(container.querySelectorAll('[role="img"] [aria-label]').length).toBe(30)
		})

		// Switch to 60d
		const btn60d = container.querySelector('[data-testid="heatmap-range-60d"]') as HTMLButtonElement
		fireEvent.click(btn60d)
		simulateStatsResponse(buckets)

		await waitFor(() => {
			expect(container.querySelectorAll('[role="img"] [aria-label]').length).toBe(60)
		})

		// Switch back to 30d
		const btn30d = container.querySelector('[data-testid="heatmap-range-30d"]') as HTMLButtonElement
		fireEvent.click(btn30d)
		simulateStatsResponse(buckets)

		await waitFor(() => {
			expect(container.querySelectorAll('[role="img"] [aria-label]').length).toBe(30)
		})
	})

	it("renders legend with less/more labels when data exists", async () => {
		const buckets = [makeBucket({ key: { day: daysAgoKey(0) }, totalTokens: 1000, events: 1 })]

		const { container } = render(<UsageHeatmap />)

		simulateStatsResponse(buckets)

		await waitFor(() => {
			const heatmap = container.querySelector('[data-testid="usage-heatmap"]')
			expect(heatmap?.textContent).toContain("stats:heatmap.less")
			expect(heatmap?.textContent).toContain("stats:heatmap.more")
		})
	})

	it("does not render legend when no data exists", async () => {
		const { container } = render(<UsageHeatmap />)

		simulateStatsResponse([])

		await waitFor(() => {
			const heatmap = container.querySelector('[data-testid="usage-heatmap"]')
			// Only noData message present, no legend
			expect(heatmap?.textContent).toContain("stats:heatmap.noData")
			expect(heatmap?.textContent).not.toContain("stats:heatmap.less")
			expect(heatmap?.textContent).not.toContain("stats:heatmap.more")
		})
	})

	it("aggregates multiple buckets with the same day key", async () => {
		const dayKey = daysAgoKey(0)
		const buckets = [
			makeBucket({ key: { day: dayKey }, totalTokens: 1000, events: 1 }),
			makeBucket({ key: { day: dayKey }, totalTokens: 2000, events: 2 }),
		]

		const { container } = render(<UsageHeatmap />)

		simulateStatsResponse(buckets)

		// Tokens for the same day key should be summed to 3000
		// Verify the aria-label of today's cell
		await waitFor(() => {
			const cells = container.querySelectorAll('[role="img"] [aria-label]')
			const todayCell = Array.from(cells).find((cell) => {
				const aria = cell.getAttribute("aria-label") ?? ""
				return aria.startsWith(dayKey)
			})
			expect(todayCell).toBeTruthy()
			expect(todayCell?.getAttribute("aria-label")).toContain("3000")
			expect(todayCell?.getAttribute("aria-label")).toContain("3")
		})
	})

	it("ignores buckets without a day key", async () => {
		const buckets = [
			makeBucket({ key: { provider: "anthropic" }, totalTokens: 1000, events: 1 }),
			makeBucket({ key: { day: daysAgoKey(0) }, totalTokens: 2000, events: 2 }),
		]

		const { container } = render(<UsageHeatmap />)

		simulateStatsResponse(buckets)

		// Buckets without a day key are ignored, so there is 1 valid entry
		// However 2000 > 0, so hasData = true
		await waitFor(() => {
			const heatmap = container.querySelector('[data-testid="usage-heatmap"]')
			expect(heatmap?.textContent).not.toContain("stats:heatmap.noData")
		})
	})

	it("renders aria-label with date and token count for each cell", async () => {
		const dayKey = daysAgoKey(0)
		const buckets = [makeBucket({ key: { day: dayKey }, totalTokens: 5000, events: 4 })]

		const { container } = render(<UsageHeatmap />)

		simulateStatsResponse(buckets)

		await waitFor(() => {
			const cells = container.querySelectorAll('[role="img"] [aria-label]')
			const todayCell = Array.from(cells).find((cell) => {
				const aria = cell.getAttribute("aria-label") ?? ""
				return aria.startsWith(dayKey)
			})
			expect(todayCell).toBeTruthy()
			const aria = todayCell?.getAttribute("aria-label") ?? ""
			expect(aria).toContain(dayKey)
			expect(aria).toContain("5000")
		})
	})

	it("renders aria-label with no-data for zero-token days", async () => {
		const { container } = render(<UsageHeatmap />)

		simulateStatsResponse([])

		await waitFor(() => {
			// In noData state, the grid is not rendered
			const grid = container.querySelector('[role="img"]')
			expect(grid).toBeFalsy()
		})
	})

	it("uses tighter gap in 360d mode", async () => {
		const buckets = [makeBucket({ key: { day: daysAgoKey(0) }, totalTokens: 1000, events: 1 })]

		const { container } = render(<UsageHeatmap />)

		simulateStatsResponse(buckets)

		// Wait for initial data
		await waitFor(() => {
			expect(container.querySelector('[role="img"]')).toBeTruthy()
		})

		// Switch to 360d mode
		const btn360d = container.querySelector('[data-testid="heatmap-range-360d"]') as HTMLButtonElement
		fireEvent.click(btn360d)
		simulateStatsResponse(buckets)

		await waitFor(() => {
			// In 360d mode, gap-px class is applied
			const grid = container.querySelector('[role="img"]')
			expect(grid).toBeTruthy()
			expect(grid?.className).toContain("gap-px")
		})
	})

	it("uses gap-0.5 in 30d mode", async () => {
		const buckets = [makeBucket({ key: { day: daysAgoKey(0) }, totalTokens: 1000, events: 1 })]

		const { container } = render(<UsageHeatmap />)

		simulateStatsResponse(buckets)

		// Default 30d mode
		await waitFor(() => {
			const grid = container.querySelector('[role="img"]')
			expect(grid).toBeTruthy()
			// In 30d mode, gap-0.5 class is applied
			expect(grid?.className).toContain("gap-0.5")
		})
	})

	it("computes intensity levels based on max token value", async () => {
		const buckets = [
			makeBucket({ key: { day: daysAgoKey(0) }, totalTokens: 4000, events: 4 }), // 100% → level 5
			makeBucket({ key: { day: daysAgoKey(1) }, totalTokens: 1000, events: 1 }), // 25% → level 1
		]

		const { container } = render(<UsageHeatmap />)

		simulateStatsResponse(buckets)

		await waitFor(() => {
			// Data should be rendered
			const heatmap = container.querySelector('[data-testid="usage-heatmap"]')
			expect(heatmap?.textContent).not.toContain("stats:heatmap.noData")

			// Legend should be rendered (6 level colors: 0-5)
			const legendCells = container.querySelectorAll(".w-3.h-3.rounded-sm")
			expect(legendCells.length).toBe(6)
		})
	})

	it("handles buckets with day key but zero events", async () => {
		const buckets = [makeBucket({ key: { day: daysAgoKey(0) }, totalTokens: 0, events: 0 })]

		const { container } = render(<UsageHeatmap />)

		simulateStatsResponse(buckets)

		// totalTokens is 0, so hasData = false
		await waitFor(() => {
			const heatmap = container.querySelector('[data-testid="usage-heatmap"]')
			expect(heatmap?.textContent).toContain("stats:heatmap.noData")
		})
	})

	it("renders grid with correct column count for 30d mode", async () => {
		const buckets = [makeBucket({ key: { day: daysAgoKey(0) }, totalTokens: 1000, events: 1 })]

		const { container } = render(<UsageHeatmap />)

		simulateStatsResponse(buckets)

		await waitFor(() => {
			const grid = container.querySelector('[role="img"]')
			expect(grid).toBeTruthy()
			// 30d mode: 30 cells / 7 rows = 5 columns (ceil(30/7) = 5)
			// CSS property is rendered in kebab-case
			const style = grid?.getAttribute("style") ?? ""
			expect(style.toLowerCase()).toContain("grid-template-columns")
			expect(style).toContain("repeat(5")
		})
	})

	it("renders grid with correct column count for 60d mode", async () => {
		const buckets = [makeBucket({ key: { day: daysAgoKey(0) }, totalTokens: 1000, events: 1 })]

		const { container } = render(<UsageHeatmap />)

		simulateStatsResponse(buckets)

		// Wait for initial data
		await waitFor(() => {
			expect(container.querySelector('[role="img"]')).toBeTruthy()
		})

		const btn60d = container.querySelector('[data-testid="heatmap-range-60d"]') as HTMLButtonElement
		fireEvent.click(btn60d)
		simulateStatsResponse(buckets)

		await waitFor(() => {
			const grid = container.querySelector('[role="img"]')
			expect(grid).toBeTruthy()
			// 60d mode: 60 cells / 7 rows = 9 columns (ceil(60/7) = 9)
			const style = grid?.getAttribute("style") ?? ""
			expect(style.toLowerCase()).toContain("grid-template-columns")
			expect(style).toContain("repeat(9")
		})
	})

	it("sends getUsageStats message on mount with heatmap- requestId prefix", () => {
		render(<UsageHeatmap />)

		expect(postMessageMock).toHaveBeenCalledTimes(1)
		const msg = postMessageMock.mock.calls[0][0]
		expect(msg.type).toBe("getUsageStats")
		expect(msg.requestId).toMatch(/^heatmap-/)
		expect(msg.usageStatsQuery.groupBy).toEqual(["day"])
		expect(msg.usageStatsQuery.includeCancelled).toBe(false)
	})

	it("sends a new getUsageStats message when range changes", async () => {
		const buckets = [makeBucket({ key: { day: daysAgoKey(0) }, totalTokens: 1000, events: 1 })]

		const { container } = render(<UsageHeatmap />)

		simulateStatsResponse(buckets)

		await waitFor(() => {
			expect(container.querySelector('[role="img"]')).toBeTruthy()
		})

		// Clear mock to count only the new request
		postMessageMock.mockClear()

		const btn60d = container.querySelector('[data-testid="heatmap-range-60d"]') as HTMLButtonElement
		fireEvent.click(btn60d)

		expect(postMessageMock).toHaveBeenCalledTimes(1)
		const msg = postMessageMock.mock.calls[0][0]
		expect(msg.type).toBe("getUsageStats")
		expect(msg.requestId).toMatch(/^heatmap-/)
	})
})
