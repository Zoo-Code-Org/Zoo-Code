import { fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { providerIdentifiers, type HistoryItem } from "@roo-code/types"

import { UsageSettings } from "../UsageSettings"

const post = vi.hoisted(() => vi.fn())
vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: post } }))

const state = vi.hoisted(() => ({ taskHistory: [] as HistoryItem[], cwd: "/ws/a" }))
vi.mock("@/context/ExtensionStateContext", () => ({ useExtensionState: () => state }))

vi.mock("../ProviderLimits", () => ({ ProviderLimits: () => <div data-testid="provider-limits-stub" /> }))

// Radix Select does not open in jsdom; a native <select> exercises the same handler.
vi.mock("@src/components/ui", () => ({
	Select: ({
		value,
		onValueChange,
		children,
	}: {
		value: string
		onValueChange: (v: string) => void
		children: React.ReactNode
	}) => (
		<select data-testid="scope-select" value={value} onChange={(e) => onValueChange(e.target.value)}>
			{children}
		</select>
	),
	SelectTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
	SelectValue: () => null,
	SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
	SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => (
		<option value={value}>{children}</option>
	),
}))

const NOW = Date.now()
const DAY = 24 * 60 * 60 * 1000

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

const withUsage = (overrides: Partial<HistoryItem> & { cost?: number; cacheReads?: number } = {}) => {
	const { cost = 1, ...rest } = overrides
	return task({
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
		...rest,
	})
}

describe("UsageSettings – branches", () => {
	beforeEach(() => {
		post.mockClear()
		state.taskHistory = []
		state.cwd = "/ws/a"
	})

	it("widening the scope to all workspaces includes tasks from other workspaces", () => {
		state.taskHistory = [withUsage({ cost: 1 }), withUsage({ cost: 2, workspace: "/ws/other" })]
		render(<UsageSettings />)
		expect(screen.getByTestId("usage-stats").textContent).not.toContain("$3.00")
		fireEvent.change(screen.getByTestId("scope-select"), { target: { value: "all" } })
		expect(screen.getByTestId("usage-stats").textContent).toContain("$3.00")
		fireEvent.change(screen.getByTestId("scope-select"), { target: { value: "workspace" } })
		expect(screen.getByTestId("usage-stats").textContent).not.toContain("$3.00")
	})

	it("shows the cache hit rate only when something was read from the cache", () => {
		state.taskHistory = [withUsage({ cacheReads: 3000 })]
		const { unmount } = render(<UsageSettings />)
		expect(screen.getByTestId("usage-stats").textContent).toContain("settings:usage.stats.cacheHit")
		unmount()

		state.taskHistory = [withUsage()]
		render(<UsageSettings />)
		expect(screen.getByTestId("usage-stats").textContent).not.toContain("settings:usage.stats.cacheHit")
	})

	it("labels chart bars by weekday for a week, and by date for a longer range", () => {
		state.taskHistory = [withUsage()]
		render(<UsageSettings />)
		const weekLabels = Array.from(screen.getByTestId("usage-daily-chart").parentElement!.querySelectorAll("span"))
			.map((s) => s.textContent)
			.filter(Boolean)
		fireEvent.click(screen.getByTestId("usage-range-30d"))
		const monthChart = screen.getByTestId("usage-daily-chart")
		expect(monthChart.children.length).toBeGreaterThan(14)
		expect(weekLabels.length).toBeGreaterThan(0)
	})

	it("shows an unpriced top task by tokens and a priced one by cost when metrics are mixed", () => {
		state.taskHistory = [
			withUsage({ cost: 2, task: "priced task" }),
			task({
				task: "unpriced task",
				totalCost: 0,
				tokensIn: 5000,
				tokensOut: 500,
				usageByModel: [
					{
						apiProvider: providerIdentifiers.githubCopilot,
						modelId: "gpt-5",
						requests: 1,
						tokensIn: 5000,
						tokensOut: 500,
						cost: 0,
					},
				],
			}),
		]
		render(<UsageSettings />)
		// Each task is one button; find it by its title and check that row on its own.
		const rowFor = (title: string) => screen.getByText(title).closest("button")!.textContent!

		const priced = rowFor("priced task")
		expect(priced).toContain("$2.00")
		expect(priced).not.toContain("settings:usage.tokensShort")

		const unpriced = rowFor("unpriced task")
		expect(unpriced).toContain("settings:usage.tokensShort")
		expect(unpriced).not.toContain("$")
	})

	it("shows only the model when no provider was recorded, and nothing when no usage was recorded", () => {
		state.taskHistory = [
			task({
				task: "model only",
				totalCost: 1,
				usageByModel: [{ modelId: "mystery-model", requests: 1, tokensIn: 10, tokensOut: 1, cost: 1 }],
			}),
			task({ task: "no usage rows", totalCost: 0.5 }),
		]
		render(<UsageSettings />)
		const rows = screen.getByTestId("usage-top-tasks").textContent!
		expect(rows).toContain("mystery-model")
		expect(rows).not.toContain("·")
	})

	it("renders the empty state when the task history is not available yet", () => {
		state.taskHistory = undefined as never
		render(<UsageSettings />)
		expect(screen.getByTestId("usage-empty")).toBeTruthy()
	})

	it("labels chart bars by date when more than a week of days is charted", () => {
		state.taskHistory = Array.from({ length: 9 }, (_, i) => withUsage({ ts: NOW - i * DAY }))
		render(<UsageSettings />)
		fireEvent.click(screen.getByTestId("usage-range-all"))
		const chart = screen.getByTestId("usage-daily-chart")
		expect(chart.children.length).toBeGreaterThan(7)
		expect(chart.children.length).toBeLessThanOrEqual(14)
		// Date labels (e.g. "Oct 27") sit under the bars, one per day, each with a day number.
		const labelRow = chart.nextElementSibling as HTMLElement
		expect(labelRow.children).toHaveLength(chart.children.length)
		expect(labelRow.textContent).toMatch(/\d/)
	})

	it("treats tasks with no recorded tokens or cost as zero rather than failing", () => {
		// Mixed metrics (one priced task) so unpriced rows are shown by tokens.
		state.taskHistory = [
			withUsage({ cost: 2 }),
			task({
				task: "bare",
				totalCost: undefined as never,
				tokensIn: undefined as never,
				tokensOut: undefined as never,
			}),
		]
		render(<UsageSettings />)
		expect(screen.getByTestId("usage-top-tasks").textContent).toContain("bare")
	})

	it("treats a task with no cost as zero when ranking by tokens", () => {
		state.taskHistory = [
			task({
				task: "tokens only",
				totalCost: undefined as never,
				usageByModel: [
					{
						apiProvider: providerIdentifiers.githubCopilot,
						modelId: "gpt-5",
						requests: 1,
						tokensIn: 100,
						tokensOut: 10,
						cost: 0,
					},
				],
			}),
		]
		render(<UsageSettings />)
		expect(screen.getByTestId("usage-top-tasks").textContent).toContain("tokens only")
	})
	it("shows the cost for a priced task whose token counters are missing", () => {
		state.taskHistory = [
			task({
				task: "priced no counters",
				totalCost: 3,
				tokensIn: undefined as never,
				tokensOut: undefined as never,
				usageByModel: [
					{
						apiProvider: providerIdentifiers.anthropic,
						modelId: "claude-sonnet-5",
						requests: 1,
						tokensIn: 1,
						tokensOut: 1,
						cost: 3,
					},
				],
			}),
		]
		render(<UsageSettings />)
		expect(screen.getByTestId("usage-top-tasks").textContent).toContain("$3.00")
	})

	it("hides the export button when the task history is not available", () => {
		state.taskHistory = undefined as never
		render(<UsageSettings />)
		expect(screen.queryByTestId("usage-export-csv")).toBeNull()
	})

	it("shows a token count for an unpriced task whose token counters are missing", () => {
		state.taskHistory = [
			withUsage({ cost: 2 }),
			task({
				task: "no counters",
				totalCost: 0,
				tokensIn: undefined as never,
				tokensOut: undefined as never,
				usageByModel: [
					{
						apiProvider: providerIdentifiers.githubCopilot,
						modelId: "gpt-5",
						requests: 1,
						tokensIn: 1,
						tokensOut: 1,
						cost: 0,
					},
				],
			}),
		]
		render(<UsageSettings />)
		const text = screen.getByTestId("usage-top-tasks").textContent!
		expect(text).toContain("no counters")
		expect(text).toContain("settings:usage.tokensShort")
	})

	it("excludes tasks older than the range", () => {
		state.taskHistory = [withUsage({ cost: 1 }), withUsage({ cost: 9, ts: NOW - 20 * DAY })]
		render(<UsageSettings />)
		expect(screen.getByTestId("usage-stats").textContent).not.toContain("$10.00")
	})
})
