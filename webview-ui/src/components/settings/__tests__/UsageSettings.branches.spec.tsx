import { fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { providerIdentifiers, type HistoryItem } from "@roo-code/types"

import { UsageSettings } from "../UsageSettings"

const post = vi.hoisted(() => vi.fn())
vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: post } }))

const state = vi.hoisted(() => ({ taskHistory: [] as HistoryItem[], cwd: "/ws/a" }))
vi.mock("@/context/ExtensionStateContext", () => ({ useExtensionState: () => state }))

// The language of the application, as the translation context reports it; keys come back as they are.
const translation = vi.hoisted(() => ({ language: undefined as string | undefined }))
vi.mock("@/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key, i18n: { language: translation.language } }),
}))

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

// A fixed local time, so the tests do not depend on when they run, on the time zone, or on a change of daylight saving
// time (a local day is 23 or 25 hours long on that day, so "24 hours ago" can skip a calendar day).
const NOW = new Date(2026, 5, 15, 12, 0, 0).getTime()

/** The same time of day, `days` local calendar days before NOW. */
const daysBefore = (days: number) => {
	const day = new Date(NOW)
	day.setDate(day.getDate() - days)
	return day.getTime()
}

/** The text under each bar of a chart. */
const labelsUnder = (chart: HTMLElement) =>
	Array.from(chart.nextElementSibling?.children ?? []).map((label) => label.textContent)

/** The last `count` local days, oldest first, formatted the way the chart is expected to label them. */
const lastDays = (count: number, format: Intl.DateTimeFormat) =>
	Array.from({ length: count }, (_, i) => {
		const day = new Date()
		day.setHours(0, 0, 0, 0)
		day.setDate(day.getDate() - (count - 1 - i))
		return format.format(day)
	})

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
		translation.language = undefined
		// Only the date is frozen: the view reads "now" from it, the timers stay real.
		vi.useFakeTimers({ toFake: ["Date"] })
		vi.setSystemTime(NOW)
		post.mockClear()
		state.taskHistory = []
		state.cwd = "/ws/a"
	})

	afterEach(() => {
		vi.useRealTimers()
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

	it("labels the bars of a week by weekday, and draws no labels under a 30-day chart", () => {
		state.taskHistory = [withUsage()]
		render(<UsageSettings />)

		const chart = screen.getByTestId("usage-daily-chart")
		expect(labelsUnder(chart)).toEqual(lastDays(7, new Intl.DateTimeFormat(undefined, { weekday: "narrow" })))

		fireEvent.click(screen.getByTestId("usage-range-30d"))
		const monthChart = screen.getByTestId("usage-daily-chart")
		expect(monthChart.children).toHaveLength(30)
		expect(monthChart.nextElementSibling).toBeNull() // too many bars to label
	})

	describe("the language of the dates", () => {
		const weekdayLabels = (locale?: string) => lastDays(7, new Intl.DateTimeFormat(locale, { weekday: "narrow" }))
		const lastBarTitle = () => {
			const chart = screen.getByTestId("usage-daily-chart")
			return chart.children[chart.children.length - 1].getAttribute("title")
		}

		it("formats the labels and the tooltips of the chart in the language of the application, not the browser's", () => {
			state.taskHistory = [withUsage()]
			// A language that the runtime's own locale does not share, whichever that is: the labels and the dates differ.
			const language = ["de", "ja"].find(
				(candidate) =>
					weekdayLabels(candidate).join() !== weekdayLabels().join() &&
					new Intl.DateTimeFormat(candidate).format(NOW) !== new Intl.DateTimeFormat().format(NOW),
			)
			expect(language).toBeDefined()
			translation.language = language
			render(<UsageSettings />)

			expect(labelsUnder(screen.getByTestId("usage-daily-chart"))).toEqual(weekdayLabels(language))
			expect(lastBarTitle()).toMatch(new RegExp(`^${new Intl.DateTimeFormat(language).format(NOW)} · `))
		})

		it("follows a change of the language", () => {
			state.taskHistory = [withUsage()]
			translation.language = "de"
			const { rerender } = render(<UsageSettings />)
			expect(labelsUnder(screen.getByTestId("usage-daily-chart"))).toEqual(weekdayLabels("de"))

			translation.language = "ja"
			rerender(<UsageSettings />)

			expect(labelsUnder(screen.getByTestId("usage-daily-chart"))).toEqual(weekdayLabels("ja"))
			expect(lastBarTitle()).toMatch(new RegExp(`^${new Intl.DateTimeFormat("ja").format(NOW)} · `))
		})

		it.each([["cimode"], ["en_US"], [""], [undefined]])(
			"falls back to the browser's formats for the language %j, which the platform cannot use",
			(language) => {
				state.taskHistory = [withUsage()]
				translation.language = language
				render(<UsageSettings />)

				expect(labelsUnder(screen.getByTestId("usage-daily-chart"))).toEqual(weekdayLabels())
				expect(lastBarTitle()).toMatch(new RegExp(`^${new Intl.DateTimeFormat().format(NOW)} · `))
			},
		)
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
		state.taskHistory = Array.from({ length: 9 }, (_, i) => withUsage({ ts: daysBefore(i) }))
		render(<UsageSettings />)
		fireEvent.click(screen.getByTestId("usage-range-all"))
		const chart = screen.getByTestId("usage-daily-chart")
		expect(chart.children.length).toBeGreaterThan(7)
		expect(chart.children.length).toBeLessThanOrEqual(14)
		// One day number per bar, for the days that were charted: not weekday letters.
		expect(labelsUnder(chart)).toEqual(
			lastDays(chart.children.length, new Intl.DateTimeFormat(undefined, { day: "numeric" })),
		)
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

	it("treats a task with no cost as zero when ranking by tokens, and lists the tasks from the largest down", () => {
		const unpriced = (title: string, tokensIn: number, tokensOut: number) =>
			task({
				task: title,
				totalCost: undefined as never,
				tokensIn,
				tokensOut,
				usageByModel: [
					{
						apiProvider: providerIdentifiers.githubCopilot,
						modelId: "gpt-5",
						requests: 1,
						tokensIn,
						tokensOut,
						cost: 0,
					},
				],
			})
		// Not in the order of their sizes, so that only the ranking can put them in order.
		state.taskHistory = [
			unpriced("medium task", 1000, 100),
			unpriced("small task", 100, 10),
			unpriced("large task", 5000, 500),
		]

		render(<UsageSettings />)

		const rows = within(screen.getByTestId("usage-top-tasks")).getAllByRole("button")
		expect(rows).toHaveLength(3)
		expect(rows.map((row) => /(large|medium|small) task/.exec(row.textContent ?? "")?.[1])).toEqual([
			"large",
			"medium",
			"small",
		])
		// Each is shown by its tokens (input and output together): there is no price to show.
		expect(rows.map((row) => /gpt-5(5\.5|1\.1|110)/.exec(row.textContent ?? "")?.[1])).toEqual([
			"5.5",
			"1.1",
			"110",
		])
		expect(screen.getByTestId("usage-top-tasks").textContent).not.toContain("$")
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
		state.taskHistory = [withUsage({ cost: 1 }), withUsage({ cost: 9, ts: daysBefore(20) })]
		render(<UsageSettings />)
		expect(screen.getByTestId("usage-stats").textContent).not.toContain("$10.00")
	})
})
