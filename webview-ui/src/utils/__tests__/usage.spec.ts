import { providerIdentifiers, type HistoryItem } from "@roo-code/types"

import {
	UNRECORDED,
	bucketView,
	metricTotal,
	modelIdFromKey,
	pickMetric,
	primaryUsage,
	rangeStart,
	summarizeUsage,
	usageToCsv,
} from "../usage"

// Fixed "now": Wed 2026-10-14 15:00 local time.
const NOW = new Date(2026, 9, 14, 15, 0, 0).getTime()
const DAY = 24 * 60 * 60 * 1000

let counter = 0
const item = (overrides: Partial<HistoryItem>): HistoryItem => ({
	id: `t${++counter}`,
	number: counter,
	ts: NOW,
	task: `task ${counter}`,
	tokensIn: 0,
	tokensOut: 0,
	totalCost: 0,
	workspace: "/ws/a",
	...overrides,
})

describe("rangeStart", () => {
	it("returns local midnight for today", () => {
		expect(rangeStart("today", NOW)).toBe(new Date(2026, 9, 14).getTime())
	})

	it("includes today in 7d / 30d windows", () => {
		expect(rangeStart("7d", NOW)).toBe(new Date(2026, 9, 8).getTime())
		expect(rangeStart("30d", NOW)).toBe(new Date(2026, 8, 15).getTime())
	})

	it("is unbounded for all", () => {
		expect(rangeStart("all", NOW)).toBeUndefined()
	})
})

describe("summarizeUsage", () => {
	const used = (apiProvider: string, modelId: string, tokensIn: number, tokensOut: number, cost: number) => [
		{ apiProvider, modelId, requests: 1, tokensIn, tokensOut, cost },
	]
	const history = [
		item({
			totalCost: 1.5,
			tokensIn: 1000,
			tokensOut: 200,
			cacheReads: 3000,
			mode: "code",
			usageByModel: used(providerIdentifiers.anthropic, "opus", 1000, 200, 1.5),
		}),
		item({
			totalCost: 0.5,
			tokensIn: 500,
			tokensOut: 100,
			mode: "architect",
			ts: NOW - DAY,
			usageByModel: used(providerIdentifiers.githubCopilot, "gpt-5", 500, 100, 0.5),
		}),
		item({
			totalCost: 2,
			tokensIn: 10,
			tokensOut: 10,
			mode: "code",
			workspace: "/ws/b",
			usageByModel: used(providerIdentifiers.anthropic, "opus", 10, 10, 2),
		}),
		// Outside 7d window
		item({
			totalCost: 99,
			mode: "code",
			ts: NOW - 10 * DAY,
			usageByModel: used(providerIdentifiers.anthropic, "opus", 0, 0, 99),
		}),
	]

	it("totals only items inside the range", () => {
		const s = summarizeUsage(history, { range: "7d", now: NOW })
		expect(s.taskCount).toBe(3)
		expect(s.totalCost).toBeCloseTo(4)
		expect(s.totalTokens).toBe(1000 + 200 + 500 + 100 + 20)
	})

	it("filters by workspace", () => {
		const s = summarizeUsage(history, { range: "7d", now: NOW, workspace: "/ws/a" })
		expect(s.taskCount).toBe(2)
		expect(s.totalCost).toBeCloseTo(2)
	})

	it("groups by recorded provider and by model, sorted by cost desc", () => {
		const s = summarizeUsage(history, { range: "7d", now: NOW })
		expect(s.byProvider.map((b) => [b.key, b.tasks])).toEqual([
			[providerIdentifiers.anthropic, 2],
			[providerIdentifiers.githubCopilot, 1],
		])
		expect(s.byProvider[0].cost).toBeCloseTo(3.5)
		expect(s.byModel.map((b) => [modelIdFromKey(b.key), b.apiProvider])).toEqual([
			["opus", providerIdentifiers.anthropic],
			["gpt-5", providerIdentifiers.githubCopilot],
		])
		expect(s.byMode.map((b) => b.key)).toEqual(["code", "architect"])
	})

	it("REGRESSION: provider/model come from what was recorded, not from any current profile", () => {
		// The bug: usage was attributed via the *currently selected* profile, so
		// switching providers relabelled past Copilot work as the new provider.
		// Aggregation now takes no profile information at all.
		const copilotTask = item({
			tokensIn: 16_700_000,
			tokensOut: 83_400,
			usageByModel: used(providerIdentifiers.githubCopilot, "claude-opus-5.5", 16_700_000, 83_400, 0),
			apiConfigName: "default", // the profile name is irrelevant to attribution
		})
		const before = summarizeUsage([copilotTask], { range: "all", now: NOW })

		// "Switch provider": same history, but the user's profile now points at Gemini.
		const after = summarizeUsage([{ ...copilotTask, apiConfigName: "gemini-profile" }], { range: "all", now: NOW })

		for (const s of [before, after]) {
			expect(s.byProvider.map((b) => b.key)).toEqual([providerIdentifiers.githubCopilot])
			expect(modelIdFromKey(s.byModel[0].key)).toBe("claude-opus-5.5")
		}
	})

	it("attributes a task that switched providers mid-way to each provider by its own tokens", () => {
		const s = summarizeUsage(
			[
				item({
					tokensIn: 400,
					tokensOut: 0,
					usageByModel: [
						{
							apiProvider: providerIdentifiers.githubCopilot,
							modelId: "claude-opus-5.5",
							requests: 1,
							tokensIn: 100,
							tokensOut: 0,
							cost: 0,
						},
						{
							apiProvider: providerIdentifiers.gemini,
							modelId: "gemini-pro",
							requests: 1,
							tokensIn: 300,
							tokensOut: 0,
							cost: 0,
						},
					],
				}),
			],
			{ range: "all", now: NOW },
		)
		expect(s.byProvider.map((b) => [b.key, b.tokens])).toEqual([
			[providerIdentifiers.gemini, 300],
			[providerIdentifiers.githubCopilot, 100],
		])
		expect(s.byProvider.every((b) => b.tasks === 1)).toBe(true)
	})

	it("buckets tasks with no recorded provider/model as unrecorded instead of guessing", () => {
		const s = summarizeUsage([item({ totalCost: 1, tokensIn: 10, tokensOut: 5 })], { range: "all", now: NOW })
		expect(s.byProvider.map((b) => b.key)).toEqual([UNRECORDED])
		expect(s.byModel.map((b) => b.key)).toEqual([UNRECORDED])
		expect(modelIdFromKey(UNRECORDED)).toBeUndefined()
		expect(s.byMode[0].key).toBe("unknown")
	})

	it("computes the cache hit rate against tokensIn, which already counts the cached tokens", () => {
		const s = summarizeUsage(
			[item({ tokensIn: 4000, cacheReads: 3000 }), item({ tokensIn: 1000, cacheReads: 0 })],
			{ range: "all", now: NOW },
		)
		// 3000 of 5000 input tokens came from the cache: 60%, not 3000 / (5000 + 3000).
		expect(s.cacheHitRate).toBeCloseTo(0.6)
	})

	it("never reports more than 100%, and 0 with no input", () => {
		expect(
			summarizeUsage([item({ tokensIn: 100, cacheReads: 250 })], { range: "all", now: NOW }).cacheHitRate,
		).toBe(1)
		expect(summarizeUsage([item({ tokensIn: 0, cacheReads: 0 })], { range: "all", now: NOW }).cacheHitRate).toBe(0)
	})

	it("produces a dense daily series for bounded ranges", () => {
		const s = summarizeUsage(history, { range: "7d", now: NOW })
		expect(s.daily).toHaveLength(7)
		expect(s.daily.at(-1)!.cost).toBeCloseTo(3.5)
		expect(s.daily.at(-2)!.cost).toBeCloseTo(0.5)
		expect(s.daily[0].cost).toBe(0)
	})

	it("returns top tasks by cost, limited", () => {
		const s = summarizeUsage(history, { range: "all", now: NOW, topTaskLimit: 2 })
		expect(s.topTasks.map((t) => t.totalCost)).toEqual([99, 2])
	})

	it("breaks cost ties by tokens so equal-priced tasks still rank meaningfully", () => {
		const s = summarizeUsage(
			[item({ id: "few", totalCost: 1, tokensIn: 10 }), item({ id: "many", totalCost: 1, tokensIn: 9_000 })],
			{ range: "all", now: NOW },
		)
		expect(s.topTasks.map((t) => t.id)).toEqual(["many", "few"])
	})

	it("is safe on empty history", () => {
		const s = summarizeUsage([], { range: "7d", now: NOW })
		expect(s.taskCount).toBe(0)
		expect(s.totalCost).toBe(0)
		expect(s.cacheHitRate).toBe(0)
	})

	it("tracks tokens per day alongside cost", () => {
		const s = summarizeUsage(history, { range: "7d", now: NOW })
		expect(s.daily.at(-1)!.tokens).toBe(1000 + 200 + 20)
	})

	it("ranks zero-cost tasks by tokens (subscription providers)", () => {
		const s = summarizeUsage([item({ id: "small", tokensIn: 10 }), item({ id: "big", tokensIn: 5_000_000 })], {
			range: "all",
			now: NOW,
		})
		expect(s.topTasks.map((t) => t.id)).toEqual(["big", "small"])
	})

	it("ignores non-finite costs", () => {
		const s = summarizeUsage([item({ totalCost: NaN })], { range: "all", now: NOW })
		expect(s.totalCost).toBe(0)
	})
})

describe("mixed priced and unpriced providers", () => {
	const mixed = () => {
		const mk = (provider: string, model: string, tokens: number, cost: number) =>
			item({
				tokensIn: tokens,
				tokensOut: 0,
				totalCost: cost,
				usageByModel: [
					{ apiProvider: provider, modelId: model, requests: 1, tokensIn: tokens, tokensOut: 0, cost },
				],
			})
		return summarizeUsage(
			[
				mk(providerIdentifiers.githubCopilot, "claude-opus-5.5", 16_000_000, 0),
				mk(providerIdentifiers.anthropic, "claude-sonnet-5", 200_000, 1.2),
			],
			{ range: "all", now: NOW },
		)
	}

	it("prioritises cost as soon as any usage in the range is priced", () => {
		expect(pickMetric(mixed())).toBe("cost")
	})

	it("flags each bucket as priced or not so subscription usage isn't shown as $0.00", () => {
		const s = mixed()
		const byKey = Object.fromEntries(s.byProvider.map((b) => [b.key, b]))
		expect(byKey[providerIdentifiers.anthropic].priced).toBe(true)
		expect(byKey[providerIdentifiers.githubCopilot].priced).toBe(false)
		expect(s.byModel.find((b) => modelIdFromKey(b.key) === "claude-opus-5.5")!.priced).toBe(false)
	})

	it("keeps all-unpriced ranges on tokens and all-priced ranges on cost", () => {
		const unpriced = summarizeUsage([item({ tokensIn: 5, usageByModel: [] })], { range: "all", now: NOW })
		expect(pickMetric(unpriced)).toBe("tokens")
	})
})

describe("bucketView", () => {
	const priced = { cost: 3, tokens: 1000, priced: true }
	const unpriced = { cost: 0, tokens: 16_000_000, priced: false }

	it("cost mode: a priced bucket is its cost and its share of total cost", () => {
		expect(bucketView(priced, "cost", 12)).toEqual({ value: 3, unpriced: false, percent: 25 })
	})

	it("cost mode: an unpriced bucket carries tokens, is flagged, and has no share (never 0%)", () => {
		expect(bucketView(unpriced, "cost", 12)).toEqual({ value: 0, unpriced: true, percent: 0 })
	})

	it("tokens mode: everything is tokens and nothing is flagged unpriced", () => {
		expect(bucketView(unpriced, "tokens", 32_000_000)).toEqual({ value: 16_000_000, unpriced: false, percent: 50 })
		expect(bucketView(priced, "tokens", 2000)).toEqual({ value: 1000, unpriced: false, percent: 50 })
	})

	it("guards division by zero", () => {
		expect(bucketView(priced, "cost", 0).percent).toBe(0)
	})

	it("rounds shares to whole numbers", () => {
		expect(bucketView({ cost: 1, tokens: 0, priced: true }, "cost", 3).percent).toBe(33)
	})
})

describe("metricTotal", () => {
	it("selects the headline value for the metric", () => {
		const s = { totalCost: 2.5, totalTokens: 900 }
		expect(metricTotal(s, "cost")).toBe(2.5)
		expect(metricTotal(s, "tokens")).toBe(900)
	})
})

describe("primaryUsage", () => {
	it("returns the provider+model that used the most tokens", () => {
		const task = item({
			usageByModel: [
				{ apiProvider: "a", modelId: "small", requests: 1, tokensIn: 10, tokensOut: 0, cost: 0 },
				{ apiProvider: "b", modelId: "big", requests: 1, tokensIn: 900, tokensOut: 0, cost: 0 },
			],
		})
		expect(primaryUsage(task)).toEqual({ apiProvider: "b", modelId: "big" })
	})

	it("is undefined when nothing was recorded", () => {
		expect(primaryUsage(item({}))).toBeUndefined()
		expect(
			primaryUsage(item({ usageByModel: [{ requests: 1, tokensIn: 1, tokensOut: 1, cost: 0 }] })),
		).toBeUndefined()
	})
})

describe("pickMetric", () => {
	it("uses cost when any cost was recorded", () => {
		expect(pickMetric({ totalCost: 0.01, totalTokens: 10 })).toBe("cost")
	})

	it("falls back to tokens when tokens exist but cost is zero (e.g. GitHub Copilot)", () => {
		expect(pickMetric({ totalCost: 0, totalTokens: 6_200_000 })).toBe("tokens")
	})

	it("stays on cost when there is no usage at all", () => {
		expect(pickMetric({ totalCost: 0, totalTokens: 0 })).toBe("cost")
	})
})

describe("spend that has no provider or model (context condensing)", () => {
	const entry = (cost: number) => ({
		apiProvider: providerIdentifiers.anthropic,
		modelId: "claude-sonnet-5",
		requests: 1,
		tokensIn: 100,
		tokensOut: 10,
		cost,
	})

	it("puts the unattributed remainder in the 'not recorded' rows so the rows add up to the total", () => {
		// The task cost 5.00, but its recorded requests only account for 4.00: 1.00 was condensing.
		const s = summarizeUsage([item({ totalCost: 5, usageByModel: [entry(4)] })], { range: "all", now: NOW })

		expect(s.totalCost).toBe(5)
		expect(s.byProvider.reduce((sum, b) => sum + b.cost, 0)).toBeCloseTo(5)
		expect(s.byModel.reduce((sum, b) => sum + b.cost, 0)).toBeCloseTo(5)
		expect(s.byProvider.find((b) => b.key === UNRECORDED)?.cost).toBeCloseTo(1)
		expect(s.byModel.find((b) => b.key === UNRECORDED)?.cost).toBeCloseTo(1)
	})

	it("does not add a token count or a task to the 'not recorded' rows for that remainder", () => {
		const s = summarizeUsage([item({ totalCost: 5, usageByModel: [entry(4)] })], { range: "all", now: NOW })
		const unrecorded = s.byProvider.find((b) => b.key === UNRECORDED)!
		expect(unrecorded.tokens).toBe(0)
		// The one task is counted under its real provider; the remainder is a cost line, not another task.
		expect(s.byProvider.find((b) => b.key === providerIdentifiers.anthropic)?.tasks).toBe(1)
	})

	it("ignores float noise: no spurious 'not recorded' row when the costs agree", () => {
		const s = summarizeUsage([item({ totalCost: 0.1 + 0.2, usageByModel: [entry(0.1), entry(0.2)] })], {
			range: "all",
			now: NOW,
		})
		expect(s.byProvider.find((b) => b.key === UNRECORDED)).toBeUndefined()
		expect(s.byModel.find((b) => b.key === UNRECORDED)).toBeUndefined()
	})

	it("adds nothing when the recorded requests cost more than the task total", () => {
		const s = summarizeUsage([item({ totalCost: 3, usageByModel: [entry(4)] })], { range: "all", now: NOW })
		expect(s.byProvider.find((b) => b.key === UNRECORDED)).toBeUndefined()
	})

	it("leaves tasks with no usage record exactly as before", () => {
		const s = summarizeUsage([item({ totalCost: 2, tokensIn: 50 })], { range: "all", now: NOW })
		expect(s.byProvider).toHaveLength(1)
		expect(s.byProvider[0]).toMatchObject({ key: UNRECORDED, cost: 2 })
	})
})

describe("modelIdFromKey", () => {
	it("returns undefined for the unrecorded bucket, the id after the provider separator, or a bare key", () => {
		expect(modelIdFromKey(UNRECORDED)).toBeUndefined()
		expect(modelIdFromKey("anthropic\u0000claude-sonnet-5")).toBe("claude-sonnet-5")
		expect(modelIdFromKey("plain-model")).toBe("plain-model")
	})
})

describe("usage attribution edge cases", () => {
	const entry = (overrides: Record<string, unknown>) => ({
		requests: 1,
		tokensIn: 10,
		tokensOut: 0,
		cost: 0,
		...overrides,
	})

	it("keeps the first entry when two entries used the same number of tokens", () => {
		const task = item({
			usageByModel: [
				entry({ apiProvider: "a", modelId: "first", tokensIn: 50 }),
				entry({ apiProvider: "b", modelId: "second", tokensIn: 50 }),
			],
		})
		expect(primaryUsage(task)).toEqual({ apiProvider: "a", modelId: "first" })
	})

	it("buckets a model with no provider under an empty provider key, and a provider with no model as unrecorded", () => {
		const s = summarizeUsage(
			[
				item({
					totalCost: 1,
					usageByModel: [entry({ modelId: "orphan", cost: 1 }), entry({ apiProvider: "p", cost: 0 })],
				}),
			],
			{ range: "all", now: NOW },
		)
		expect(new Set(s.byModel.map((b) => modelIdFromKey(b.key)))).toEqual(new Set([undefined, "orphan"]))
		expect(new Set(s.byProvider.map((b) => b.key))).toEqual(new Set([UNRECORDED, "p"]))
	})

	it("counts a task once per bucket even when several of its requests land in it", () => {
		const s = summarizeUsage(
			[
				item({
					usageByModel: [
						entry({ apiProvider: "p", modelId: "m", tokensIn: 1 }),
						entry({ apiProvider: "p", modelId: "m", tokensIn: 2 }),
					],
				}),
			],
			{ range: "all", now: NOW },
		)
		expect(s.byProvider[0].tasks).toBe(1)
		expect(s.byModel[0].tasks).toBe(1)
		expect(s.byProvider[0].tokens).toBe(3)
	})

	it("orders top tasks by cost, then by tokens, and treats missing numbers as zero", () => {
		const cheapBig = item({ id: "cheap-big", totalCost: 1, tokensIn: 900, tokensOut: 100 })
		const cheapSmall = item({ id: "cheap-small", totalCost: 1, tokensIn: 10, tokensOut: 0 })
		const pricey = item({ id: "pricey", totalCost: 5, tokensIn: 1, tokensOut: 0 })
		const bare = (id: string) =>
			item({ id, totalCost: undefined as never, tokensIn: undefined as never, tokensOut: undefined as never })
		const s = summarizeUsage([cheapSmall, bare("bare-1"), cheapBig, pricey, bare("bare-2")], {
			range: "all",
			now: NOW,
		})
		expect(s.topTasks.map((t) => t.id).slice(0, 3)).toEqual(["pricey", "cheap-big", "cheap-small"])
		expect(
			s.topTasks
				.map((t) => t.id)
				.slice(3)
				.sort(),
		).toEqual(["bare-1", "bare-2"])
	})
})

describe("usageToCsv formula safety", () => {
	it.each(['=HYPERLINK("http://x")', "+1+1", "-2+3", "@SUM(A1)", "\tcmd", "\rcmd"])(
		"neutralises a cell that starts with %j",
		(text) => {
			const csv = usageToCsv([item({ task: text, mode: text })], { range: "all", now: NOW })
			const row = csv.split("\n")[1]
			// Each text cell is quoted and prefixed with an apostrophe, so it cannot start with a trigger character.
			expect(row).toMatch(/^[^,]+,"'[=+\-@\t\r]/)
			expect(row).not.toMatch(/,"[=+\-@\t\r]/)
		},
	)

	it("leaves ordinary text and the numeric columns alone", () => {
		const csv = usageToCsv([item({ task: "Fix the = sign", totalCost: 1.5, tokensIn: 10 })], {
			range: "all",
			now: NOW,
		})
		const row = csv.split("\n")[1]
		expect(row).toContain('"Fix the = sign"')
		expect(row).not.toContain("'Fix")
		expect(row.endsWith(",1.5000")).toBe(true)
	})
})

describe("usageToCsv", () => {
	it("sorts oldest first and leaves provider, model and counters blank or zero when nothing was recorded", () => {
		const csv = usageToCsv(
			[
				item({ task: "later", ts: NOW }),
				item({
					task: "earlier",
					title: undefined,
					ts: NOW - DAY,
					tokensIn: undefined as never,
					tokensOut: undefined as never,
					totalCost: undefined as never,
					mode: undefined,
				}),
			],
			{ range: "all", now: NOW },
		)
		const lines = csv.split("\n")
		expect(lines[1]).toContain("earlier")
		expect(lines[1].endsWith(',"","","",0,0,0,0,0.0000')).toBe(true)
		expect(lines[2]).toContain("later")
	})

	it("exports a row for a task with neither a title nor a task text", () => {
		const csv = usageToCsv([item({ task: undefined as never, title: undefined })], { range: "all", now: NOW })
		expect(csv.split("\n")[1]).toContain(',"",')
	})

	it("filters to a workspace and ignores one that is not set", () => {
		const history = [item({ task: "in", workspace: "/ws/a" }), item({ task: "out", workspace: "/ws/b" })]
		expect(usageToCsv(history, { range: "all", now: NOW, workspace: "/ws/a" }).split("\n")).toHaveLength(2)
		expect(usageToCsv(history, { range: "all", now: NOW }).split("\n")).toHaveLength(3)
	})

	it("escapes quotes and newlines and respects the range", () => {
		const csv = usageToCsv(
			[
				item({ task: 'say "hi"\nthen go', totalCost: 0.12345, mode: "code" }),
				item({ task: "old", ts: NOW - 40 * DAY }),
			],
			{ range: "30d", now: NOW },
		)
		const lines = csv.split("\n")
		expect(lines[0]).toBe("date,task,mode,provider,model,tokensIn,tokensOut,cacheReads,cacheWrites,cost")
		expect(lines).toHaveLength(2)
		expect(lines[1]).toContain('"say ""hi"" then go"')
		expect(lines[1].endsWith(",0.1235")).toBe(true)
	})
})

describe("defaults and non-finite input", () => {
	afterEach(() => {
		vi.useRealTimers()
	})

	it("uses the current time when no `now` is given", () => {
		vi.useFakeTimers()
		vi.setSystemTime(NOW)
		const recent = item({ ts: NOW - 1000, totalCost: 1 })
		const old = item({ ts: NOW - 3 * DAY, totalCost: 2 })

		expect(summarizeUsage([recent, old], { range: "today" }).totalCost).toBe(1)
		expect(usageToCsv([recent, old], { range: "today" }).split("\n")).toHaveLength(2)
	})

	it("ignores a non-finite per-model cost when reconciling the task cost", () => {
		const summary = summarizeUsage(
			[
				item({
					totalCost: 3,
					usageByModel: [
						{
							apiProvider: providerIdentifiers.anthropic,
							modelId: "m",
							requests: 1,
							tokensIn: 1,
							tokensOut: 1,
							cost: Number.NaN,
						},
					],
				}),
			],
			{ range: "all", now: NOW },
		)

		// The whole task cost is unattributed because the recorded model cost is unusable.
		expect(summary.byProvider.find((b) => b.key === UNRECORDED)?.cost).toBe(3)
		// The unusable cost never reaches the recorded buckets as NaN.
		const recordedProvider = summary.byProvider.find((b) => b.key === providerIdentifiers.anthropic)
		expect(recordedProvider).toMatchObject({ cost: 0, tokens: 2, priced: false })
		expect(summary.byModel.find((b) => b.key !== UNRECORDED)).toMatchObject({ cost: 0, tokens: 2, priced: false })
		expect(summary.byProvider.reduce((sum, b) => sum + b.cost, 0)).toBe(3)
		expect(summary.byModel.reduce((sum, b) => sum + b.cost, 0)).toBe(3)
	})
})
