import { fireEvent, render, screen, within } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { providerIdentifiers, type HistoryItem } from "@roo-code/types"

import { UsageSettings } from "../UsageSettings"

const post = vi.hoisted(() => vi.fn())
vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: post } }))

const state = vi.hoisted(() => ({ taskHistory: [] as HistoryItem[], cwd: "/ws/a" }))
vi.mock("@/context/ExtensionStateContext", () => ({ useExtensionState: () => state }))

// The provider-limits section talks to the extension host; it has its own spec.
vi.mock("../ProviderLimits", () => ({ ProviderLimits: () => <div data-testid="provider-limits-stub" /> }))

const NOW = Date.now()

let n = 0
const task = (overrides: Partial<HistoryItem> = {}): HistoryItem => ({
	id: `t${++n}`,
	number: n,
	ts: NOW - 60_000,
	task: `Task ${n}`,
	tokensIn: 1000,
	tokensOut: 100,
	totalCost: 0,
	workspace: "/ws/a",
	mode: "code",
	...overrides,
})

const priced = (cost: number, overrides: Partial<HistoryItem> = {}) =>
	task({
		totalCost: cost,
		usageByModel: [
			{
				apiProvider: providerIdentifiers.anthropic,
				modelId: "claude-sonnet-5",
				requests: 1,
				tokensIn: 1000,
				tokensOut: 100,
				cost,
			},
		],
		...overrides,
	})

const copilot = (overrides: Partial<HistoryItem> = {}) =>
	task({
		usageByModel: [
			{
				apiProvider: providerIdentifiers.githubCopilot,
				modelId: "claude-opus-5.5",
				requests: 1,
				tokensIn: 1000,
				tokensOut: 100,
				cost: 0,
			},
		],
		...overrides,
	})

describe("UsageSettings", () => {
	beforeEach(() => {
		post.mockClear()
		state.taskHistory = []
		state.cwd = "/ws/a"
	})

	it("always renders the provider limits section", () => {
		render(<UsageSettings />)
		expect(screen.getByTestId("provider-limits-stub")).toBeTruthy()
	})

	it("shows an empty state with no tasks", () => {
		render(<UsageSettings />)
		expect(screen.getByTestId("usage-empty")).toBeTruthy()
		expect(screen.queryByTestId("usage-stats")).toBeNull()
		expect(screen.queryByTestId("usage-export-csv")).toBeNull()
	})

	describe("when a provider reports a price", () => {
		beforeEach(() => {
			state.taskHistory = [priced(1.25), priced(0.5)]
		})

		it("shows cost first and tokens second", () => {
			render(<UsageSettings />)
			const stats = screen.getByTestId("usage-stats")
			expect(stats.textContent).toContain("$1.75")
			expect(stats.textContent).toContain("2.2") // 2 tasks x 1,100 tokens (suffix is a translation key in tests)
			expect(screen.queryByTestId("usage-no-pricing-note")).toBeNull()
		})

		it("charts and ranks by cost", () => {
			render(<UsageSettings />)
			const top = screen.getByTestId("usage-top-tasks")
			expect(top.textContent).toContain("$1.25")
			expect(within(screen.getByTestId("usage-by-provider")).getByText("settings:usage.byProvider")).toBeTruthy()
		})
	})

	describe("when no provider reports a price (e.g. GitHub Copilot)", () => {
		beforeEach(() => {
			state.taskHistory = [copilot()]
		})

		it("never shows a dollar figure and explains why", () => {
			render(<UsageSettings />)
			expect(screen.getByTestId("usage-stats").textContent).not.toContain("$")
			expect(screen.getByTestId("usage-no-pricing-note")).toBeTruthy()
		})

		it("leads with tokens and the in/out split", () => {
			render(<UsageSettings />)
			const stats = screen.getByTestId("usage-stats").textContent!
			expect(stats).toContain("1.1")
			expect(stats).toContain("settings:usage.stats.inOut".split(".").pop()!)
		})
	})

	describe("mixed priced and unpriced providers", () => {
		beforeEach(() => {
			state.taskHistory = [priced(1.5), copilot({ tokensIn: 16_000_000 })]
		})

		it("prioritises cost over tokens when any provider reports a price", () => {
			render(<UsageSettings />)
			const stats = screen.getByTestId("usage-stats").textContent!
			expect(stats).toContain("$1.50")
			expect(screen.queryByTestId("usage-no-pricing-note")).toBeNull()
		})

		it("shows subscription providers as tokens with a no-price tag, not $0.00 · 0%", () => {
			render(<UsageSettings />)
			const providers = screen.getByTestId("usage-by-provider")
			const unpriced = within(providers).getByTestId("usage-unpriced")
			expect(unpriced.textContent).toContain("noPrice")
			expect(unpriced.textContent).not.toContain("$0.00")
			// The unpriced row has no share: it shows "–", never "0%".
			const row = unpriced.parentElement!
			expect(row.textContent).toContain("–")
			expect(row.textContent).not.toMatch(/(^|\D)0%/)
			expect(row.querySelector("span[style*='width: 0%']")).not.toBeNull()
		})

		it("gives priced providers their cost and share", () => {
			render(<UsageSettings />)
			const providers = screen.getByTestId("usage-by-provider")
			expect(providers.textContent).toContain("$1.50")
			expect(providers.textContent).toContain("100%")
		})

		it("shows an unpriced top task by tokens rather than $0.00", () => {
			render(<UsageSettings />)
			expect(screen.getByTestId("usage-top-tasks").textContent).not.toContain("$0.00")
		})
	})

	describe("attribution", () => {
		it("lists the provider and model that were recorded", () => {
			state.taskHistory = [copilot()]
			render(<UsageSettings />)
			expect(screen.getByTestId("usage-by-provider").textContent).toContain("GitHub Copilot")
			expect(screen.getByTestId("usage-by-model").textContent).toContain("claude-opus-5.5")
		})

		it("labels tasks with no recorded provider as not recorded rather than guessing", () => {
			state.taskHistory = [task()]
			render(<UsageSettings />)
			expect(screen.getByTestId("usage-by-provider").textContent).toContain("notRecorded")
			expect(screen.getByTestId("usage-by-model").textContent).toContain("notRecorded")
		})

		it("shows provider · model under each top task", () => {
			state.taskHistory = [copilot()]
			render(<UsageSettings />)
			expect(screen.getByTestId("usage-top-tasks").textContent).toContain("GitHub Copilot · claude-opus-5.5")
		})

		it("summarises modes on a single line", () => {
			state.taskHistory = [priced(1, { mode: "code" }), priced(0.5, { mode: "architect" })]
			render(<UsageSettings />)
			const line = screen.getByTestId("usage-by-mode").textContent!
			expect(line).toContain("code $1.00")
			expect(line).toContain("architect $0.50")
		})
	})

	describe("modes with and without a price", () => {
		it("keeps 'no price' on an unpriced mode so it is not mistaken for a priced one", () => {
			state.taskHistory = [priced(1, { mode: "code" }), copilot({ mode: "debug" })]
			render(<UsageSettings />)
			const line = screen.getByTestId("usage-by-mode").textContent!
			expect(line).toContain("code $1.00")
			expect(line).toMatch(/debug .*settings:usage\.noPrice/)
		})
	})

	describe("filters", () => {
		it("defaults to this workspace and can widen to all", () => {
			state.taskHistory = [priced(1), priced(2, { workspace: "/ws/other" })]
			render(<UsageSettings />)
			expect(screen.getByTestId("usage-stats").textContent).toContain("$1.00")
			expect(screen.getByTestId("usage-stats").textContent).not.toContain("$3.00")
		})

		it("changes the range", () => {
			state.taskHistory = [priced(1), priced(5, { ts: NOW - 20 * 24 * 60 * 60 * 1000 })]
			render(<UsageSettings />)
			// default 7 days → only the recent task
			expect(screen.getByTestId("usage-stats").textContent).toContain("$1.00")
			fireEvent.click(screen.getByTestId("usage-range-30d"))
			expect(screen.getByTestId("usage-stats").textContent).toContain("$6.00")
			fireEvent.click(screen.getByTestId("usage-range-today"))
			expect(screen.getByTestId("usage-stats").textContent).toContain("$1.00")
		})

		it("includes everything for the all-time range", () => {
			state.taskHistory = [priced(1), priced(5, { ts: NOW - 200 * 24 * 60 * 60 * 1000 })]
			render(<UsageSettings />)
			fireEvent.click(screen.getByTestId("usage-range-all"))
			expect(screen.getByTestId("usage-stats").textContent).toContain("$6.00")
		})

		it("marks the active range for assistive tech", () => {
			render(<UsageSettings />)
			expect(screen.getByTestId("usage-range-7d").getAttribute("aria-checked")).toBe("true")
			expect(screen.getByTestId("usage-range-30d").getAttribute("aria-checked")).toBe("false")
		})
	})

	describe("interactions", () => {
		it("opens a task when its row is clicked", () => {
			const t = priced(1)
			state.taskHistory = [t]
			render(<UsageSettings />)
			fireEvent.click(within(screen.getByTestId("usage-top-tasks")).getByRole("button"))
			expect(post).toHaveBeenCalledWith({ type: "showTaskWithId", text: t.id })
		})

		it("exports a CSV of the filtered range", () => {
			state.taskHistory = [priced(1)]
			const createObjectURL = vi.fn(() => "blob:x")
			const revokeObjectURL = vi.fn()
			Object.assign(URL, { createObjectURL, revokeObjectURL })
			const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {})

			render(<UsageSettings />)
			fireEvent.click(screen.getByTestId("usage-export-csv"))

			expect(createObjectURL).toHaveBeenCalledTimes(1)
			expect(click).toHaveBeenCalled()
			expect(revokeObjectURL).toHaveBeenCalledWith("blob:x")
			click.mockRestore()
		})
	})

	it("exposes the chart to assistive tech as a single labelled image", () => {
		state.taskHistory = [priced(1)]
		render(<UsageSettings />)
		const chart = screen.getByTestId("usage-daily-chart")
		expect(chart.getAttribute("role")).toBe("img")
		expect(chart.getAttribute("aria-label")).toBeTruthy()
	})

	it("draws one chart bar per day for a bounded range", () => {
		state.taskHistory = [priced(1)]
		render(<UsageSettings />)
		expect(screen.getByTestId("usage-daily-chart").children).toHaveLength(7)
	})
})
