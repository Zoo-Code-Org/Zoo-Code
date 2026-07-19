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
 * 오늘 날짜 기준으로 N일 전의 YYYY-MM-DD 키를 반환한다.
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

		// noData 메시지가 표시되지 않아야 함
		const heatmap = container.querySelector('[data-testid="usage-heatmap"]')
		expect(heatmap?.textContent).not.toContain("stats:heatmap.noData")

		// grid role 속성 확인
		const grid = container.querySelector('[role="img"]')
		expect(grid).toBeTruthy()
	})

	it("renders 30d and 90d range toggle buttons", () => {
		const { container } = render(<UsageHeatmap buckets={[]} />)

		const btn30d = container.querySelector('[data-testid="heatmap-range-30d"]')
		const btn90d = container.querySelector('[data-testid="heatmap-range-90d"]')

		expect(btn30d).toBeTruthy()
		expect(btn90d).toBeTruthy()
		expect(btn30d?.textContent).toContain("stats:heatmap.30d")
		expect(btn90d?.textContent).toContain("stats:heatmap.90d")
	})

	it("defaults to 30d range", () => {
		const buckets = [makeBucket({ key: { day: daysAgoKey(0) }, totalTokens: 1000, events: 1 })]

		const { container } = render(<UsageHeatmap buckets={buckets} />)

		// 30d 모드에서는 30개의 날짜 셀이 생성됨
		const cells = container.querySelectorAll('[role="img"] [aria-label]')
		// 각 셀은 aria-label을 가짐
		expect(cells.length).toBe(30)
	})

	it("switches to 90d range when 90d button is clicked", () => {
		const buckets = [makeBucket({ key: { day: daysAgoKey(0) }, totalTokens: 1000, events: 1 })]

		const { container } = render(<UsageHeatmap buckets={buckets} />)

		const btn90d = container.querySelector('[data-testid="heatmap-range-90d"]') as HTMLButtonElement
		fireEvent.click(btn90d)

		// 90d 모드에서는 90개의 날짜 셀이 생성됨
		const cells = container.querySelectorAll('[role="img"] [aria-label]')
		expect(cells.length).toBe(90)
	})

	it("switches back to 30d range when 30d button is clicked after 90d", () => {
		const buckets = [makeBucket({ key: { day: daysAgoKey(0) }, totalTokens: 1000, events: 1 })]

		const { container } = render(<UsageHeatmap buckets={buckets} />)

		// 90d로 전환
		const btn90d = container.querySelector('[data-testid="heatmap-range-90d"]') as HTMLButtonElement
		fireEvent.click(btn90d)
		expect(container.querySelectorAll('[role="img"] [aria-label]').length).toBe(90)

		// 30d로 되돌림
		const btn30d = container.querySelector('[data-testid="heatmap-range-30d"]') as HTMLButtonElement
		fireEvent.click(btn30d)
		expect(container.querySelectorAll('[role="img"] [aria-label]').length).toBe(30)
	})

	it("renders legend with less/more labels when data exists", () => {
		const buckets = [makeBucket({ key: { day: daysAgoKey(0) }, totalTokens: 1000, events: 1 })]

		const { container } = render(<UsageHeatmap buckets={buckets} />)

		const heatmap = container.querySelector('[data-testid="usage-heatmap"]')
		expect(heatmap?.textContent).toContain("stats:heatmap.less")
		expect(heatmap?.textContent).toContain("stats:heatmap.more")
	})

	it("does not render legend when no data exists", () => {
		const { container } = render(<UsageHeatmap buckets={[]} />)

		const heatmap = container.querySelector('[data-testid="usage-heatmap"]')
		// noData 메시지만 있고 legend는 없음
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

		// 동일 day key의 토큰이 합산되어 3000이 되어야 함
		// 오늘 날짜 셀의 aria-label 확인
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

		// day key가 없는 bucket은 무시되므로, 유효한 데이터는 1개
		// 하지만 2000 > 0이므로 hasData = true
		const heatmap = container.querySelector('[data-testid="usage-heatmap"]')
		expect(heatmap?.textContent).not.toContain("stats:heatmap.noData")
	})

	it("renders aria-label with date and token count for each cell", () => {
		const dayKey = daysAgoKey(0)
		const buckets = [makeBucket({ key: { day: dayKey }, totalTokens: 5000, events: 4 })]

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

		// noData 상태에서는 grid가 렌더링되지 않음
		const grid = container.querySelector('[role="img"]')
		expect(grid).toBeFalsy()
	})

	it("uses smaller cell size in 90d mode", () => {
		const buckets = [makeBucket({ key: { day: daysAgoKey(0) }, totalTokens: 1000, events: 1 })]

		const { container } = render(<UsageHeatmap buckets={buckets} />)

		// 30d 모드의 셀 크기
		const btn90d = container.querySelector('[data-testid="heatmap-range-90d"]') as HTMLButtonElement
		fireEvent.click(btn90d)

		// 90d 모드에서는 더 작은 셀 클래스가 적용됨
		const grid = container.querySelector('[role="img"]')
		expect(grid).toBeTruthy()
		// 90d 모드에서는 gap-0.5 클래스가 적용됨
		expect(grid?.className).toContain("gap-0.5")
	})

	it("uses larger cell size in 30d mode", () => {
		const buckets = [makeBucket({ key: { day: daysAgoKey(0) }, totalTokens: 1000, events: 1 })]

		const { container } = render(<UsageHeatmap buckets={buckets} />)

		// 기본 30d 모드
		const grid = container.querySelector('[role="img"]')
		expect(grid).toBeTruthy()
		// 30d 모드에서는 gap-1 클래스가 적용됨
		expect(grid?.className).toContain("gap-1")
	})

	it("computes intensity levels based on max token value", () => {
		const buckets = [
			makeBucket({ key: { day: daysAgoKey(0) }, totalTokens: 4000, events: 4 }), // 100% → level 4
			makeBucket({ key: { day: daysAgoKey(1) }, totalTokens: 1000, events: 1 }), // 25% → level 1
		]

		const { container } = render(<UsageHeatmap buckets={buckets} />)

		// 데이터가 렌더링되어야 함
		const heatmap = container.querySelector('[data-testid="usage-heatmap"]')
		expect(heatmap?.textContent).not.toContain("stats:heatmap.noData")

		// legend가 렌더링되어야 함 (4개의 level 색상)
		const legendCells = container.querySelectorAll(".w-3.h-3.rounded-sm")
		expect(legendCells.length).toBe(4)
	})

	it("handles buckets with day key but zero events", () => {
		const buckets = [makeBucket({ key: { day: daysAgoKey(0) }, totalTokens: 0, events: 0 })]

		const { container } = render(<UsageHeatmap buckets={buckets} />)

		// totalTokens가 0이므로 hasData = false
		const heatmap = container.querySelector('[data-testid="usage-heatmap"]')
		expect(heatmap?.textContent).toContain("stats:heatmap.noData")
	})

	it("renders grid with correct column count for 30d mode", () => {
		const buckets = [makeBucket({ key: { day: daysAgoKey(0) }, totalTokens: 1000, events: 1 })]

		const { container } = render(<UsageHeatmap buckets={buckets} />)

		const grid = container.querySelector('[role="img"]')
		expect(grid).toBeTruthy()
		// 30d 모드: 30 cells / 7 rows = 5 columns (ceil(30/7) = 5)
		// CSS property는 kebab-case로 렌더링됨
		const style = grid?.getAttribute("style") ?? ""
		expect(style.toLowerCase()).toContain("grid-template-columns")
		expect(style).toContain("repeat(5")
	})

	it("renders grid with correct column count for 90d mode", () => {
		const buckets = [makeBucket({ key: { day: daysAgoKey(0) }, totalTokens: 1000, events: 1 })]

		const { container } = render(<UsageHeatmap buckets={buckets} />)

		const btn90d = container.querySelector('[data-testid="heatmap-range-90d"]') as HTMLButtonElement
		fireEvent.click(btn90d)

		const grid = container.querySelector('[role="img"]')
		expect(grid).toBeTruthy()
		// 90d 모드: 90 cells / 7 rows = 13 columns (ceil(90/7) = 13)
		const style = grid?.getAttribute("style") ?? ""
		expect(style.toLowerCase()).toContain("grid-template-columns")
		expect(style).toContain("repeat(13")
	})
})
