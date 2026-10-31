import type { HistoryItem } from "@roo-code/types"

/**
 * Pure aggregation over locally persisted task history for the Usage tab.
 *
 * Notes on correctness:
 * - `HistoryItem.totalCost` is a task's *own* spend; subtasks are separate
 *   history items. Summing every item therefore counts each dollar once.
 * - Provider and model come from `HistoryItem.usageByModel`, recorded when each
 *   request was made. They are never derived from the *current* profile, so
 *   switching providers does not relabel past usage. Tasks created before this
 *   was recorded have no such data and are bucketed as `UNRECORDED`.
 */

/** Bucket key for usage whose provider/model was not recorded (older tasks). */
export const UNRECORDED = "__unrecorded__"

/** Cost below this (in dollars) is float noise, not unattributed spend. */
const REMAINDER_EPSILON = 1e-6

export const USAGE_RANGES = ["today", "7d", "30d", "all"] as const
export type UsageRange = (typeof USAGE_RANGES)[number]

export interface UsageBucket {
	key: string
	cost: number
	tokens: number
	/** Tasks that contributed to this bucket (a task using two models counts once in each). */
	tasks: number
	/** For model buckets: the provider that served it (undefined when unrecorded). */
	apiProvider?: string
	/**
	 * True when this bucket has any cost > 0. When the tab is showing cost, a bucket
	 * with `priced: false` (e.g. GitHub Copilot, billed by subscription) must not be
	 * shown as "$0.00 · 0%": it has no price, not zero spend.
	 */
	priced: boolean
}

export interface DailyUsage {
	/** Local-midnight timestamp of the day. */
	day: number
	cost: number
	tokens: number
}

/**
 * Which metric the Usage tab should chart. Subscription-backed providers
 * (e.g. GitHub Copilot via the VS Code LM API) report no per-token price, so
 * their tasks persist `totalCost: 0`. Charting cost would show flat zeros.
 */
export type UsageMetric = "cost" | "tokens"

export function pickMetric(summary: Pick<UsageSummary, "totalCost" | "totalTokens">): UsageMetric {
	return summary.totalCost > 0 || summary.totalTokens === 0 ? "cost" : "tokens"
}

/**
 * What a breakdown row (provider / model / mode) should display for a bucket.
 *
 * Pure so the "priced vs unpriced" rule lives in one tested place instead of
 * being re-derived by the component:
 * - tokens mode:              value = tokens
 * - cost mode, priced bucket: value = cost, share of total cost
 * - cost mode, unpriced:      a subscription bucket (e.g. Copilot) has no price,
 *                             not zero spend → value = tokens, `unpriced: true`,
 *                             and no share (so no "$0.00 · 0%")
 */
export interface BucketView {
	/** Numeric value the bar/share is computed from. */
	value: number
	/** True when the bucket should be shown as tokens with a "no price" tag and no share. */
	unpriced: boolean
	/** Whole-number share of the total, 0 for unpriced rows. */
	percent: number
}

export function bucketView(
	bucket: Pick<UsageBucket, "cost" | "tokens" | "priced">,
	metric: UsageMetric,
	total: number,
): BucketView {
	const unpriced = metric === "cost" && !bucket.priced
	const value = metric === "cost" ? bucket.cost : bucket.tokens
	return { value, unpriced, percent: unpriced || total <= 0 ? 0 : Math.round((value / total) * 100) }
}

/** The metric's headline value for a summary (cost or tokens). */
export function metricTotal(summary: Pick<UsageSummary, "totalCost" | "totalTokens">, metric: UsageMetric): number {
	return metric === "cost" ? summary.totalCost : summary.totalTokens
}

export interface UsageSummary {
	totalCost: number
	tokensIn: number
	tokensOut: number
	cacheReads: number
	cacheWrites: number
	totalTokens: number
	/** Share of input-side tokens served from cache, 0–1. */
	cacheHitRate: number
	taskCount: number
	byProvider: UsageBucket[]
	byModel: UsageBucket[]
	byMode: UsageBucket[]
	daily: DailyUsage[]
	topTasks: HistoryItem[]
}

export interface UsageOptions {
	range: UsageRange
	/** When set, only tasks from this workspace are included. */
	workspace?: string
	now?: number
	topTaskLimit?: number
}

/**
 * The provider+model that did most of a task's work (by tokens), for labelling
 * a task row. Undefined when nothing was recorded.
 */
export function primaryUsage(item: HistoryItem): { apiProvider?: string; modelId?: string } | undefined {
	const entries = item.usageByModel?.filter((e) => e.apiProvider || e.modelId)
	if (!entries?.length) return undefined
	const top = entries.reduce((a, b) => (b.tokensIn + b.tokensOut > a.tokensIn + a.tokensOut ? b : a))
	return { apiProvider: top.apiProvider, modelId: top.modelId }
}

function startOfLocalDay(ts: number): number {
	const d = new Date(ts)
	d.setHours(0, 0, 0, 0)
	return d.getTime()
}

/** Local midnight `days` calendar days before `ts` (not `days * 24h`, which is off by an hour across a DST change). */
function startOfLocalDayMinus(ts: number, days: number): number {
	const d = new Date(ts)
	d.setHours(0, 0, 0, 0)
	d.setDate(d.getDate() - days)
	return d.getTime()
}

/** Inclusive lower bound for a range, or `undefined` for "all". */
export function rangeStart(range: UsageRange, now: number): number | undefined {
	switch (range) {
		case "today":
			return startOfLocalDay(now)
		case "7d":
			return startOfLocalDayMinus(now, 6)
		case "30d":
			return startOfLocalDayMinus(now, 29)
		default:
			return undefined
	}
}

function addTo(
	map: Map<string, UsageBucket>,
	key: string,
	cost: number,
	tokens: number,
	countedForTask: Set<string>,
	extra?: Partial<UsageBucket>,
) {
	const bucket = map.get(key) ?? { key, cost: 0, tokens: 0, tasks: 0, priced: false, ...extra }
	bucket.cost += cost
	bucket.tokens += tokens
	if (cost > 0) bucket.priced = true
	// Count the task once per bucket even if several of its requests land here.
	if (!countedForTask.has(key)) {
		countedForTask.add(key)
		bucket.tasks += 1
	}
	map.set(key, bucket)
}

const byCostDesc = (a: UsageBucket, b: UsageBucket) => b.cost - a.cost || b.tokens - a.tokens

export function summarizeUsage(history: HistoryItem[], options: UsageOptions): UsageSummary {
	const now = options.now ?? Date.now()
	const start = rangeStart(options.range, now)
	const topTaskLimit = options.topTaskLimit ?? 5

	const items = history.filter(
		(item) =>
			typeof item.ts === "number" &&
			(start === undefined || item.ts >= start) &&
			(!options.workspace || item.workspace === options.workspace),
	)

	const providers = new Map<string, UsageBucket>()
	const models = new Map<string, UsageBucket>()
	const modes = new Map<string, UsageBucket>()
	const daily = new Map<number, { cost: number; tokens: number }>()

	let totalCost = 0
	let tokensIn = 0
	let tokensOut = 0
	let cacheReads = 0
	let cacheWrites = 0

	for (const item of items) {
		const cost = Number.isFinite(item.totalCost) ? item.totalCost : 0
		const tIn = item.tokensIn || 0
		const tOut = item.tokensOut || 0
		const tokens = tIn + tOut

		totalCost += cost
		tokensIn += tIn
		tokensOut += tOut
		cacheReads += item.cacheReads || 0
		cacheWrites += item.cacheWrites || 0

		// Provider/model from what was recorded per request. A task with no record
		// (created before this was tracked) goes to a single "unrecorded" bucket.
		const seenProviders = new Set<string>()
		const seenModels = new Set<string>()
		type Entry = NonNullable<HistoryItem["usageByModel"]>[number]
		const entries: Entry[] = item.usageByModel?.length
			? [...item.usageByModel]
			: [{ requests: 0, tokensIn: tIn, tokensOut: tOut, cost }]

		// The task's cost also covers work that has no provider or model of its own (condensing the context).
		// Without this, the provider and model rows would add up to less than the headline total. The
		// remainder goes to the "not recorded" rows. Below a cent-fraction it is rounding noise and is ignored,
		// so a float residue cannot create a spurious priced row.
		if (item.usageByModel?.length) {
			const attributed = item.usageByModel.reduce((sum, e) => sum + (Number.isFinite(e.cost) ? e.cost : 0), 0)
			const remainder = cost - attributed
			if (remainder > REMAINDER_EPSILON) entries.push({ requests: 0, tokensIn: 0, tokensOut: 0, cost: remainder })
		}

		for (const e of entries) {
			const entryTokens = e.tokensIn + e.tokensOut
			const entryCost = Number.isFinite(e.cost) ? e.cost : 0
			const providerKey = e.apiProvider || UNRECORDED
			const modelKey = e.modelId ? `${e.apiProvider ?? ""}\u0000${e.modelId}` : UNRECORDED
			addTo(providers, providerKey, entryCost, entryTokens, seenProviders)
			addTo(models, modelKey, entryCost, entryTokens, seenModels, { apiProvider: e.apiProvider })
		}

		const modeSeen = new Set<string>()
		addTo(modes, item.mode || "unknown", cost, tokens, modeSeen)

		const day = startOfLocalDay(item.ts)
		const entry = daily.get(day) ?? { cost: 0, tokens: 0 }
		entry.cost += cost
		entry.tokens += tokens
		daily.set(day, entry)
	}

	// Densify the daily series for bounded ranges so the chart has a bar per day
	// (including zero-spend days). "all" stays sparse to avoid huge arrays.
	const dailySeries: DailyUsage[] = []
	if (start !== undefined) {
		// Step by calendar date, not by 24h: a 23h or 25h day (DST) would otherwise drift the
		// cursor off local midnight and drop today's bar while today's tasks are still counted.
		const cursor = new Date(start)
		const last = startOfLocalDay(now)
		for (let day = cursor.getTime(); day <= last; day = cursor.getTime()) {
			const entry = daily.get(day)
			dailySeries.push({ day, cost: entry?.cost ?? 0, tokens: entry?.tokens ?? 0 })
			cursor.setDate(cursor.getDate() + 1)
			cursor.setHours(0, 0, 0, 0)
		}
	} else {
		for (const [day, entry] of [...daily.entries()].sort(([a], [b]) => a - b)) {
			dailySeries.push({ day, ...entry })
		}
	}

	return {
		totalCost,
		tokensIn,
		tokensOut,
		cacheReads,
		cacheWrites,
		totalTokens: tokensIn + tokensOut,
		// `tokensIn` already counts the cached tokens (the cost helpers store the total input), so it is the
		// whole input side. Adding the cache reads again would understate the rate.
		cacheHitRate: tokensIn > 0 ? Math.min(1, cacheReads / tokensIn) : 0,
		taskCount: items.length,
		byProvider: [...providers.values()].sort(byCostDesc),
		byModel: [...models.values()].sort(byCostDesc),
		byMode: [...modes.values()].sort(byCostDesc),
		daily: dailySeries,
		// Cost first, tokens as tie-breaker so zero-cost (subscription) usage still ranks meaningfully.
		topTasks: [...items]
			.sort(
				(a, b) =>
					(b.totalCost || 0) - (a.totalCost || 0) ||
					(b.tokensIn || 0) + (b.tokensOut || 0) - ((a.tokensIn || 0) + (a.tokensOut || 0)),
			)
			.slice(0, topTaskLimit),
	}
}

/** The model id from a `byModel` bucket key (or undefined for the unrecorded bucket). */
export function modelIdFromKey(key: string): string | undefined {
	if (key === UNRECORDED) return undefined
	const i = key.indexOf("\u0000")
	return i === -1 ? key : key.slice(i + 1)
}

/** Serialises the filtered usage rows as CSV (one row per task). */
export function usageToCsv(history: HistoryItem[], options: UsageOptions): string {
	const start = rangeStart(options.range, options.now ?? Date.now())
	const header = [
		"date",
		"task",
		"mode",
		"provider",
		"model",
		"tokensIn",
		"tokensOut",
		"cacheReads",
		"cacheWrites",
		"cost",
	]

	// Spreadsheet apps evaluate a quoted cell that starts with = + - @ (or tab/CR) as a formula, and the
	// task text is user- and model-controlled. A leading apostrophe makes the cell inert text.
	const escape = (value: string) => {
		const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value
		return `"${safe.replace(/"/g, '""').replace(/\r?\n/g, " ")}"`
	}

	const rows = history
		.filter(
			(item) =>
				(start === undefined || item.ts >= start) &&
				(!options.workspace || item.workspace === options.workspace),
		)
		.sort((a, b) => a.ts - b.ts)
		.map((item) =>
			[
				new Date(item.ts).toISOString(),
				escape(item.title || item.task || ""),
				escape(item.mode || ""),
				escape(primaryUsage(item)?.apiProvider ?? ""),
				escape(primaryUsage(item)?.modelId ?? ""),
				item.tokensIn || 0,
				item.tokensOut || 0,
				item.cacheReads || 0,
				item.cacheWrites || 0,
				(item.totalCost || 0).toFixed(4),
			].join(","),
		)

	return [header.join(","), ...rows].join("\n")
}
