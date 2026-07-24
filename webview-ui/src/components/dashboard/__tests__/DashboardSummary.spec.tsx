// npx vitest run src/components/dashboard/__tests__/DashboardSummary.spec.tsx

import React from "react"
import { render } from "@/utils/test-utils"

import type { StatsBucket } from "@roo-code/types"

import DashboardSummary from "../DashboardSummary"

// Mock i18n — DashboardSummary uses useAppTranslation from TranslationContext,
// which wraps i18next's t(). We mock the context directly.
const mockT = (key: string, opts?: Record<string, unknown>) => {
	if (key === "dashboard:summary.unknownEventCount" && typeof opts?.count === "number") {
		return `${opts.count} uncertain`
	}
	return key
}

vi.mock("@/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: mockT,
		i18n: { language: "en" },
	}),
	TranslationProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
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

// ── Tests ────────────────────────────────────────────────────────────────────

describe("DashboardSummary", () => {
	it("renders the summary container", () => {
		const { container } = render(<DashboardSummary totals={makeBucket()} />)
		const summary = container.querySelector('[data-testid="dashboard-summary"]')
		expect(summary).toBeTruthy()
	})

	it("renders all five summary cards", () => {
		const { container } = render(<DashboardSummary totals={makeBucket()} />)
		const summary = container.querySelector('[data-testid="dashboard-summary"]')
		// Total tokens, input, output, cache, cost
		expect(summary?.textContent).toContain("dashboard:summary.totalTokens")
		expect(summary?.textContent).toContain("dashboard:summary.inputTokens")
		expect(summary?.textContent).toContain("dashboard:summary.outputTokens")
		expect(summary?.textContent).toContain("dashboard:summary.cacheTokens")
		expect(summary?.textContent).toContain("dashboard:summary.cost")
	})

	it("displays formatted total tokens", () => {
		const { container } = render(<DashboardSummary totals={makeBucket({ totalTokens: 1_500_000 })} />)
		const summary = container.querySelector('[data-testid="dashboard-summary"]')
		expect(summary?.textContent).toContain("1.50M")
	})

	it("displays formatted cost", () => {
		const { container } = render(<DashboardSummary totals={makeBucket({ costUsd: 1.23 })} />)
		const summary = container.querySelector('[data-testid="dashboard-summary"]')
		expect(summary?.textContent).toContain("$1.23")
	})

	it("displays zero values correctly", () => {
		const { container } = render(<DashboardSummary totals={makeBucket({
			totalTokens: 0,
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			costUsd: 0,
		})} />)
		const summary = container.querySelector('[data-testid="dashboard-summary"]')
		expect(summary?.textContent).toContain("0")
		expect(summary?.textContent).toContain("$0.00")
	})

	it("shows unknown event count when > 0", () => {
		const { container } = render(<DashboardSummary totals={makeBucket({ unknownEventCount: 3 })} />)
		const summary = container.querySelector('[data-testid="dashboard-summary"]')
		expect(summary?.textContent).toContain("3 uncertain")
	})

	it("does not show unknown event count when 0", () => {
		const { container } = render(<DashboardSummary totals={makeBucket({ unknownEventCount: 0 })} />)
		const summary = container.querySelector('[data-testid="dashboard-summary"]')
		expect(summary?.textContent).not.toContain("uncertain")
	})

	it("computes cache total from read + write", () => {
		const { container } = render(<DashboardSummary totals={makeBucket({
			cacheReadTokens: 2000,
			cacheWriteTokens: 3000,
		})} />)
		const summary = container.querySelector('[data-testid="dashboard-summary"]')
		// 2000 + 3000 = 5000 -> "5.0K"
		expect(summary?.textContent).toContain("5.0K")
	})
})
