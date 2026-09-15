// npx vitest run src/components/dashboard/__tests__/UsageHeatmap.spec.tsx

import { render, fireEvent } from "@/utils/test-utils"

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

// ── Test helpers ─────────────────────────────────────────────────────────────

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

/**
 * Builds a values array (oldest-first) for the given range, with the
 * specified day having the given token count.
 */
function makeValues(rangeDays: number, dayIndex: number, tokens: number): number[] {
	const values = new Array(rangeDays).fill(0)
	values[dayIndex] = tokens
	return values
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("UsageHeatmap (controlled)", () => {
	it("renders the heatmap container with title", () => {
		const { container } = render(
			<UsageHeatmap values={[]} rangeDays={30} selectedRange="30d" onRangeChange={vi.fn()} />,
		)

		const heatmap = container.querySelector('[data-testid="usage-heatmap"]')
		expect(heatmap).toBeTruthy()
		expect(heatmap?.textContent).toContain("stats:heatmap.title")
	})

	it("renders no-data message when values are empty", () => {
		const { container } = render(
			<UsageHeatmap values={[]} rangeDays={30} selectedRange="30d" onRangeChange={vi.fn()} />,
		)

		const heatmap = container.querySelector('[data-testid="usage-heatmap"]')
		expect(heatmap?.textContent).toContain("stats:heatmap.noData")
	})

	it("renders no-data message when all values are zero", () => {
		const values = new Array(30).fill(0)
		const { container } = render(
			<UsageHeatmap values={values} rangeDays={30} selectedRange="30d" onRangeChange={vi.fn()} />,
		)

		const heatmap = container.querySelector('[data-testid="usage-heatmap"]')
		expect(heatmap?.textContent).toContain("stats:heatmap.noData")
	})

	it("renders heatmap grid when data exists", () => {
		// 30 days, day index 29 = today, 5000 tokens
		const values = makeValues(30, 29, 5000)
		const { container } = render(
			<UsageHeatmap values={values} rangeDays={30} selectedRange="30d" onRangeChange={vi.fn()} />,
		)

		const heatmap = container.querySelector('[data-testid="usage-heatmap"]')
		expect(heatmap?.textContent).not.toContain("stats:heatmap.noData")
		const grid = container.querySelector('[role="img"]')
		expect(grid).toBeTruthy()
	})

	it("renders 30d, 60d, 120d, and 360d range toggle buttons", () => {
		const { container } = render(
			<UsageHeatmap values={[]} rangeDays={30} selectedRange="30d" onRangeChange={vi.fn()} />,
		)

		expect(container.querySelector('[data-testid="heatmap-range-30d"]')).toBeTruthy()
		expect(container.querySelector('[data-testid="heatmap-range-60d"]')).toBeTruthy()
		expect(container.querySelector('[data-testid="heatmap-range-120d"]')).toBeTruthy()
		expect(container.querySelector('[data-testid="heatmap-range-360d"]')).toBeTruthy()
	})

	it("highlights the selected range button", () => {
		const { container } = render(
			<UsageHeatmap values={[]} rangeDays={60} selectedRange="60d" onRangeChange={vi.fn()} />,
		)

		const btn60d = container.querySelector('[data-testid="heatmap-range-60d"]')
		expect(btn60d?.className).toContain("primary")
	})

	it("calls onRangeChange when a range button is clicked", () => {
		const onRangeChange = vi.fn()
		const { container } = render(
			<UsageHeatmap values={[]} rangeDays={30} selectedRange="30d" onRangeChange={onRangeChange} />,
		)

		const btn60d = container.querySelector('[data-testid="heatmap-range-60d"]') as HTMLButtonElement
		fireEvent.click(btn60d)

		expect(onRangeChange).toHaveBeenCalledWith("60d")
	})

	it("renders 30 cells in 30d mode", () => {
		const values = makeValues(30, 29, 1000)
		const { container } = render(
			<UsageHeatmap values={values} rangeDays={30} selectedRange="30d" onRangeChange={vi.fn()} />,
		)

		const cells = container.querySelectorAll('[role="img"] [aria-label]')
		expect(cells.length).toBe(30)
	})

	it("renders 60 cells in 60d mode", () => {
		const values = makeValues(60, 59, 1000)
		const { container } = render(
			<UsageHeatmap values={values} rangeDays={60} selectedRange="60d" onRangeChange={vi.fn()} />,
		)

		const cells = container.querySelectorAll('[role="img"] [aria-label]')
		expect(cells.length).toBe(60)
	})

	it("renders 120 cells in 120d mode", () => {
		const values = makeValues(120, 119, 1000)
		const { container } = render(
			<UsageHeatmap values={values} rangeDays={120} selectedRange="120d" onRangeChange={vi.fn()} />,
		)

		const cells = container.querySelectorAll('[role="img"] [aria-label]')
		expect(cells.length).toBe(120)
	})

	it("renders 360 cells in 360d mode", () => {
		const values = makeValues(360, 359, 1000)
		const { container } = render(
			<UsageHeatmap values={values} rangeDays={360} selectedRange="360d" onRangeChange={vi.fn()} />,
		)

		const cells = container.querySelectorAll('[role="img"] [aria-label]')
		expect(cells.length).toBe(360)
	})

	it("renders legend with less/more labels when data exists", () => {
		const values = makeValues(30, 29, 1000)
		const { container } = render(
			<UsageHeatmap values={values} rangeDays={30} selectedRange="30d" onRangeChange={vi.fn()} />,
		)

		const heatmap = container.querySelector('[data-testid="usage-heatmap"]')
		expect(heatmap?.textContent).toContain("stats:heatmap.less")
		expect(heatmap?.textContent).toContain("stats:heatmap.more")
	})

	it("does not render legend when no data exists", () => {
		const { container } = render(
			<UsageHeatmap values={[]} rangeDays={30} selectedRange="30d" onRangeChange={vi.fn()} />,
		)

		const heatmap = container.querySelector('[data-testid="usage-heatmap"]')
		expect(heatmap?.textContent).toContain("stats:heatmap.noData")
		expect(heatmap?.textContent).not.toContain("stats:heatmap.less")
		expect(heatmap?.textContent).not.toContain("stats:heatmap.more")
	})

	it("renders aria-label with date and token count for each cell", () => {
		const values = makeValues(30, 29, 5000)
		const { container } = render(
			<UsageHeatmap values={values} rangeDays={30} selectedRange="30d" onRangeChange={vi.fn()} />,
		)

		const cells = container.querySelectorAll('[role="img"] [aria-label]')
		const todayCell = Array.from(cells).find((cell) => {
			const aria = cell.getAttribute("aria-label") ?? ""
			return aria.startsWith(daysAgoKey(0))
		})
		expect(todayCell).toBeTruthy()
		const aria = todayCell?.getAttribute("aria-label") ?? ""
		expect(aria).toContain(daysAgoKey(0))
		expect(aria).toContain("5000")
	})

	it("renders aria-label with no-data for zero-token days", () => {
		// Only one day has data, the rest should have 0 tokens
		const values = makeValues(30, 29, 1000)
		const { container } = render(
			<UsageHeatmap values={values} rangeDays={30} selectedRange="30d" onRangeChange={vi.fn()} />,
		)

		const cells = container.querySelectorAll('[role="img"] [aria-label]')
		// Find a zero-token day (yesterday)
		const yesterdayCell = Array.from(cells).find((cell) => {
			const aria = cell.getAttribute("aria-label") ?? ""
			return aria.startsWith(daysAgoKey(1))
		})
		expect(yesterdayCell).toBeTruthy()
		expect(yesterdayCell?.getAttribute("aria-label")).toContain("0")
	})

	it("uses tighter gap in 360d mode", () => {
		const values = makeValues(360, 359, 1000)
		const { container } = render(
			<UsageHeatmap values={values} rangeDays={360} selectedRange="360d" onRangeChange={vi.fn()} />,
		)

		const grid = container.querySelector('[role="img"]')
		expect(grid?.className).toContain("gap-px")
	})

	it("uses gap-0.5 in 30d mode", () => {
		const values = makeValues(30, 29, 1000)
		const { container } = render(
			<UsageHeatmap values={values} rangeDays={30} selectedRange="30d" onRangeChange={vi.fn()} />,
		)

		const grid = container.querySelector('[role="img"]')
		expect(grid?.className).toContain("gap-0.5")
	})

	it("computes intensity levels based on max token value", () => {
		const values = makeValues(30, 29, 4000)
		values[28] = 1000 // yesterday = 25% → level 1
		const { container } = render(
			<UsageHeatmap values={values} rangeDays={30} selectedRange="30d" onRangeChange={vi.fn()} />,
		)

		const heatmap = container.querySelector('[data-testid="usage-heatmap"]')
		expect(heatmap?.textContent).not.toContain("stats:heatmap.noData")

		const legendCells = container.querySelectorAll(".w-3.h-3.rounded-sm")
		expect(legendCells.length).toBe(6)
	})

	it("renders grid with correct column count for 30d mode", () => {
		const values = makeValues(30, 29, 1000)
		const { container } = render(
			<UsageHeatmap values={values} rangeDays={30} selectedRange="30d" onRangeChange={vi.fn()} />,
		)

		const grid = container.querySelector('[role="img"]')
		expect(grid).toBeTruthy()
		const style = grid?.getAttribute("style") ?? ""
		expect(style.toLowerCase()).toContain("grid-template-columns")
		expect(style).toContain("repeat(5")
	})

	it("renders grid with correct column count for 60d mode", () => {
		const values = makeValues(60, 59, 1000)
		const { container } = render(
			<UsageHeatmap values={values} rangeDays={60} selectedRange="60d" onRangeChange={vi.fn()} />,
		)

		const grid = container.querySelector('[role="img"]')
		expect(grid).toBeTruthy()
		const style = grid?.getAttribute("style") ?? ""
		expect(style.toLowerCase()).toContain("grid-template-columns")
		expect(style).toContain("repeat(9")
	})
})
