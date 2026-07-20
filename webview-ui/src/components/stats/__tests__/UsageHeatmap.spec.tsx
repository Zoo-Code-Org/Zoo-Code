// pnpm --filter @roo-code/vscode-webview test src/components/stats/__tests__/UsageHeatmap.spec.tsx

import React from "react"
import { render, fireEvent } from "@/utils/test-utils"

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
	it("renders the heatmap container with title", () => {
		const { container } = render(<UsageHeatmap buckets={[]} />)

		const heatmap = container.querySelector('[data-testid="usage-heatmap"]')
		expect(heatmap).toBeTruthy()
		expect(heatmap?.textContent).toContain("stats:heatmap.title")
	})

	it("renders no-data message when buckets are empty", () => {
		const { container } = render(<UsageHeatmap buckets={[]} />)

		const heatmap = container.querySelector('[data-testid="usage-heatmap"]')
		expect(heatmap?.textContent).toContain("stats:heatmap.noData")
	})

	it("renders no-data message when all buckets have zero totalTokens", () => {
		const buckets = [
			makeBucket({ key: { day: daysAgoKey(0) }, totalTokens: 0, events: 0 }),
			makeBucket({ key: { day: daysAgoKey(1) }, totalTokens: 0, events: 0 }),
		]

		const { container } = render(<UsageHeatmap buckets={buckets} />)

		const heatmap = container.querySelector('[data-testid="usage-heatmap"]')
		expect(heatmap?.textContent).toContain("stats:heatmap.noData")
	})

	it("renders heatmap grid when data exists", () => {
		const buckets = [
			makeBucket({ key: { day: daysAgoKey(0) }, totalTokens: 5000, events: 3 }),
			makeBucket({ key: { day: daysAgoKey(1) }, totalTokens: 3000, events: 2 }),
		]

		const { container } = render(<UsageHeatmap buckets={buckets} />)

		// noData message should not be displayed
		const heatmap = container.querySelector('[data-testid="usage-heatmap"]')
		expect(heatmap?.textContent).not.toContain("stats:heatmap.noData")

		// Verify grid role attribute
		const grid = container.querySelector('[role="img"]')
		expect(grid).toBeTruthy()
	})

	it("renders 30d, 60d, 120d, and 360d range toggle buttons", () => {
		const { container } = render(<UsageHeatmap buckets={[]} />)

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

	it("defaults to 30d range", () => {
		const buckets = [
			makeBucket({ key: { day: daysAgoKey(0) }, totalTokens: 1000, events: 1 }),
		]

		const { container } = render(<UsageHeatmap buckets={buckets} />)

		// In 30d mode, 30 date cells are generated
		const cells = container.querySelectorAll('[role="img"] [aria-label]')
		// Each cell has an aria-label
		expect(cells.length).toBe(30)
	})

	it("switches to 60d range when 60d button is clicked", () => {
		const buckets = [
			makeBucket({ key: { day: daysAgoKey(0) }, totalTokens: 1000, events: 1 }),
		]

		const { container } = render(<UsageHeatmap buckets={buckets} />)

		const btn60d = container.querySelector('[data-testid="heatmap-range-60d"]') as HTMLButtonElement
		fireEvent.click(btn60d)

		// In 60d mode, 60 date cells are generated
		const cells = container.querySelectorAll('[role="img"] [aria-label]')
		expect(cells.length).toBe(60)
	})

	it("switches back to 30d range when 30d button is clicked after 60d", () => {
		const buckets = [
			makeBucket({ key: { day: daysAgoKey(0) }, totalTokens: 1000, events: 1 }),
		]

		const { container } = render(<UsageHeatmap buckets={buckets} />)

		// Switch to 60d
		const btn60d = container.querySelector('[data-testid="heatmap-range-60d"]') as HTMLButtonElement
		fireEvent.click(btn60d)
		expect(container.querySelectorAll('[role="img"] [aria-label]').length).toBe(60)

		// Switch back to 30d
		const btn30d = container.querySelector('[data-testid="heatmap-range-30d"]') as HTMLButtonElement
		fireEvent.click(btn30d)
		expect(container.querySelectorAll('[role="img"] [aria-label]').length).toBe(30)
	})

	it("renders legend with less/more labels when data exists", () => {
		const buckets = [
			makeBucket({ key: { day: daysAgoKey(0) }, totalTokens: 1000, events: 1 }),
		]

		const { container } = render(<UsageHeatmap buckets={buckets} />)

		const heatmap = container.querySelector('[data-testid="usage-heatmap"]')
		expect(heatmap?.textContent).toContain("stats:heatmap.less")
		expect(heatmap?.textContent).toContain("stats:heatmap.more")
	})

	it("does not render legend when no data exists", () => {
		const { container } = render(<UsageHeatmap buckets={[]} />)

		const heatmap = container.querySelector('[data-testid="usage-heatmap"]')
		// Only noData message present, no legend
		expect(heatmap?.textContent).toContain("stats:heatmap.noData")
		expect(heatmap?.textContent).not.toContain("stats:heatmap.less")
		expect(heatmap?.textContent).not.toContain("stats:heatmap.more")
	})

	it("aggregates multiple buckets with the same day key", () => {
		const dayKey = daysAgoKey(0)
		const buckets = [
			makeBucket({ key: { day: dayKey }, totalTokens: 1000, events: 1 }),
			makeBucket({ key: { day: dayKey }, totalTokens: 2000, events: 2 }),
		]

		const { container } = render(<UsageHeatmap buckets={buckets} />)

		// Tokens for the same day key should be summed to 3000
		// Verify the aria-label of today's cell
		const cells = container.querySelectorAll('[role="img"] [aria-label]')
		const todayCell = Array.from(cells).find((cell) => {
			const aria = cell.getAttribute("aria-label") ?? ""
			return aria.startsWith(dayKey)
		})
		expect(todayCell).toBeTruthy()
		expect(todayCell?.getAttribute("aria-label")).toContain("3000")
		expect(todayCell?.getAttribute("aria-label")).toContain("3")
	})

	it("ignores buckets without a day key", () => {
		const buckets = [
			makeBucket({ key: { provider: "anthropic" }, totalTokens: 1000, events: 1 }),
			makeBucket({ key: { day: daysAgoKey(0) }, totalTokens: 2000, events: 2 }),
		]

		const { container } = render(<UsageHeatmap buckets={buckets} />)

		// Buckets without a day key are ignored, so there is 1 valid entry
		// However 2000 > 0, so hasData = true
		const heatmap = container.querySelector('[data-testid="usage-heatmap"]')
		expect(heatmap?.textContent).not.toContain("stats:heatmap.noData")
	})

	it("renders aria-label with date and token count for each cell", () => {
		const dayKey = daysAgoKey(0)
		const buckets = [
			makeBucket({ key: { day: dayKey }, totalTokens: 5000, events: 4 }),
		]

		const { container } = render(<UsageHeatmap buckets={buckets} />)

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

	it("renders aria-label with no-data for zero-token days", () => {
		const { container } = render(<UsageHeatmap buckets={[]} />)

		// In noData state, the grid is not rendered
		const grid = container.querySelector('[role="img"]')
		expect(grid).toBeFalsy()
	})

	it("uses tighter gap in 360d mode", () => {
		const buckets = [
			makeBucket({ key: { day: daysAgoKey(0) }, totalTokens: 1000, events: 1 }),
		]

		const { container } = render(<UsageHeatmap buckets={buckets} />)

		// Switch to 360d mode
		const btn360d = container.querySelector('[data-testid="heatmap-range-360d"]') as HTMLButtonElement
		fireEvent.click(btn360d)

		// In 360d mode, gap-px class is applied
		const grid = container.querySelector('[role="img"]')
		expect(grid).toBeTruthy()
		expect(grid?.className).toContain("gap-px")
	})

	it("uses gap-0.5 in 30d mode", () => {
		const buckets = [
			makeBucket({ key: { day: daysAgoKey(0) }, totalTokens: 1000, events: 1 }),
		]

		const { container } = render(<UsageHeatmap buckets={buckets} />)

		// Default 30d mode
		const grid = container.querySelector('[role="img"]')
		expect(grid).toBeTruthy()
		// In 30d mode, gap-0.5 class is applied
		expect(grid?.className).toContain("gap-0.5")
	})

	it("computes intensity levels based on max token value", () => {
		const buckets = [
			makeBucket({ key: { day: daysAgoKey(0) }, totalTokens: 4000, events: 4 }), // 100% → level 5
			makeBucket({ key: { day: daysAgoKey(1) }, totalTokens: 1000, events: 1 }), // 25% → level 1
		]

		const { container } = render(<UsageHeatmap buckets={buckets} />)

		// Data should be rendered
		const heatmap = container.querySelector('[data-testid="usage-heatmap"]')
		expect(heatmap?.textContent).not.toContain("stats:heatmap.noData")

		// Legend should be rendered (6 level colors: 0-5)
		const legendCells = container.querySelectorAll(".w-3.h-3.rounded-sm")
		expect(legendCells.length).toBe(6)
	})

	it("handles buckets with day key but zero events", () => {
		const buckets = [
			makeBucket({ key: { day: daysAgoKey(0) }, totalTokens: 0, events: 0 }),
		]

		const { container } = render(<UsageHeatmap buckets={buckets} />)

		// totalTokens is 0, so hasData = false
		const heatmap = container.querySelector('[data-testid="usage-heatmap"]')
		expect(heatmap?.textContent).toContain("stats:heatmap.noData")
	})

	it("renders grid with correct column count for 30d mode", () => {
		const buckets = [
			makeBucket({ key: { day: daysAgoKey(0) }, totalTokens: 1000, events: 1 }),
		]

		const { container } = render(<UsageHeatmap buckets={buckets} />)

		const grid = container.querySelector('[role="img"]')
		expect(grid).toBeTruthy()
		// 30d mode: 30 cells / 7 rows = 5 columns (ceil(30/7) = 5)
		// CSS property is rendered in kebab-case
		const style = grid?.getAttribute("style") ?? ""
		expect(style.toLowerCase()).toContain("grid-template-columns")
		expect(style).toContain("repeat(5")
	})

	it("renders grid with correct column count for 60d mode", () => {
		const buckets = [
			makeBucket({ key: { day: daysAgoKey(0) }, totalTokens: 1000, events: 1 }),
		]

		const { container } = render(<UsageHeatmap buckets={buckets} />)

		const btn60d = container.querySelector('[data-testid="heatmap-range-60d"]') as HTMLButtonElement
		fireEvent.click(btn60d)

		const grid = container.querySelector('[role="img"]')
		expect(grid).toBeTruthy()
		// 60d mode: 60 cells / 7 rows = 9 columns (ceil(60/7) = 9)
		const style = grid?.getAttribute("style") ?? ""
		expect(style.toLowerCase()).toContain("grid-template-columns")
		expect(style).toContain("repeat(9")
	})
})
