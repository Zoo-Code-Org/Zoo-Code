import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { providerIdentifiers } from "@roo-code/types"

vi.mock("vscode", () => ({ version: "1.0.0", authentication: { getSession: vi.fn() } }))
vi.mock("../copilotQuota", () => ({
	getGitHubCopilotQuota: vi.fn(async () => ({
		ok: true,
		quota: {
			plan: "business",
			unlimited: false,
			entitlement: 140000,
			used: 39389.3,
			usedPercent: 28.1,
			resetAt: 1,
			fetchedAt: 2,
		},
	})),
}))

import {
	getProviderQuotas,
	loadProfilesWithActive,
	parseDeepSeekBalance,
	parseKimiCodeUsage,
	parseMiniMaxRemains,
	parseMoonshotBalance,
	parseNanoGptUsage,
	parseOpenCodeGoUsage,
	parseOpenRouterKey,
	parseZaiQuota,
	resetProviderQuotaCache,
	windowLabel,
} from "../providerQuotas"

describe("parseOpenRouterKey", () => {
	it("reports a bounded key limit as used / limit with a percent", () => {
		expect(parseOpenRouterKey({ data: { limit: 50, limit_remaining: 37.6 } })).toEqual([
			{ id: "key_limit", valueLabel: "$12.40 / $50.00 used", usedPercent: expect.closeTo(24.8, 5) },
		])
	})

	it("falls back to monthly spend for unlimited keys", () => {
		expect(parseOpenRouterKey({ data: { limit: null, usage_monthly: 3.2 } })).toEqual([
			{ id: "spend", valueLabel: "$3.20 spent this month" },
		])
	})

	it("labels the all-time usage as total spend, never as this month's", () => {
		expect(parseOpenRouterKey({ data: { limit: null, usage: 42 } })).toEqual([
			{ id: "spend", valueLabel: "$42.00 spent in total" },
		])
	})

	it("prefers the monthly figure when both are reported", () => {
		expect(parseOpenRouterKey({ data: { usage: 42, usage_monthly: 3.2 } })).toEqual([
			{ id: "spend", valueLabel: "$3.20 spent this month" },
		])
	})

	it("returns undefined without data", () => {
		expect(parseOpenRouterKey({})).toBeUndefined()
		expect(parseOpenRouterKey({ data: {} })).toBeUndefined()
	})
})

describe("parseDeepSeekBalance", () => {
	it("prefers a positive USD balance", () => {
		expect(
			parseDeepSeekBalance({
				balance_infos: [
					{ currency: "CNY", total_balance: "10.00" },
					{ currency: "USD", total_balance: "4.25" },
				],
			}),
		).toEqual([{ id: "balance", valueLabel: "$4.25 left" }])
	})

	it("uses ¥ for a CNY-only balance", () => {
		expect(parseDeepSeekBalance({ balance_infos: [{ currency: "CNY", total_balance: "8" }] })).toEqual([
			{ id: "balance", valueLabel: "¥8.00 left" },
		])
	})

	it("returns undefined for empty or malformed payloads", () => {
		expect(parseDeepSeekBalance({ balance_infos: [] })).toBeUndefined()
		expect(parseDeepSeekBalance(null)).toBeUndefined()
	})
})

describe("parseDeepSeekBalance – fallbacks", () => {
	it("treats a USD or CNY row without a balance as zero when choosing a row", () => {
		const result = parseDeepSeekBalance({
			balance_infos: [{ currency: "USD" }, { currency: "CNY" }, { currency: "CNY", total_balance: "5" }],
		})
		expect(result).toEqual([{ id: "balance", valueLabel: "¥5.00 left" }])
	})

	it("falls back to a zero USD balance, then to the first row", () => {
		expect(
			parseDeepSeekBalance({
				balance_infos: [
					{ currency: "EUR", total_balance: "0" },
					{ currency: "USD", total_balance: "0" },
				],
			}),
		).toEqual([{ id: "balance", valueLabel: "$0.00 left" }])
		expect(parseDeepSeekBalance({ balance_infos: [{ currency: "EUR", total_balance: "3" }] })).toEqual([
			{ id: "balance", valueLabel: "$3.00 left" },
		])
	})
})

describe("parseMoonshotBalance", () => {
	it("reads available_balance", () => {
		expect(parseMoonshotBalance({ data: { available_balance: 19.5 } })).toEqual([
			{ id: "balance", valueLabel: "$19.50 left" },
		])
	})
})

describe("windowLabel", () => {
	it("names rolling windows by length", () => {
		expect(windowLabel(5 * 3600, "x")).toBe("5-hour")
		expect(windowLabel(7 * 86400, "x")).toBe("Weekly")
		expect(windowLabel(3 * 86400, "x")).toBe("3-day")
		expect(windowLabel(undefined, "Tokens")).toBe("Tokens")
		expect(windowLabel(90, "Tokens")).toBe("Tokens")
	})
})

describe("parseKimiCodeUsage", () => {
	it("reads the ratio-based usages block in display order", () => {
		expect(
			parseKimiCodeUsage({
				usages: {
					limit_month_total: { used_ratio: 0.1 },
					limit_5h: { used_ratio: 0.25, reset_time: 1_800_000_000 },
					limit_7d: { used_ratio: 0.5 },
				},
			}),
		).toEqual([
			{ id: "limit_5h", valueLabel: "5-hour", usedPercent: 25, resetAt: 1_800_000_000_000 },
			{ id: "limit_7d", valueLabel: "Weekly", usedPercent: 50, resetAt: undefined },
			{ id: "limit_month_total", valueLabel: "Monthly", usedPercent: expect.closeTo(10, 5), resetAt: undefined },
		])
	})

	it("skips entries without a finite ratio", () => {
		expect(parseKimiCodeUsage({ usages: { limit_5h: {}, limit_7d: { used_ratio: "x" } } })).toBeUndefined()
	})

	it("falls back to the legacy weekly usage block, deriving used from remaining", () => {
		expect(parseKimiCodeUsage({ usage: { limit: 200, remaining: 150 } })).toEqual([
			{ id: "weekly", valueLabel: "Weekly", usedPercent: 25, resetAt: undefined },
		])
	})

	it("returns undefined for junk", () => {
		expect(parseKimiCodeUsage(null)).toBeUndefined()
		expect(parseKimiCodeUsage({})).toBeUndefined()
	})
})

describe("parseZaiQuota", () => {
	it("maps 5-hour and weekly limits, including credit counts", () => {
		expect(
			parseZaiQuota({
				code: 200,
				data: {
					limits: [
						{ type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 40, nextResetTime: 1_800_000_000_000 },
						{ type: "CREDIT_LIMIT", unit: 6, number: 1, usage: 2000, currentValue: 500 },
						{ type: "TIME_LIMIT", percentage: 99 },
					],
				},
			}),
		).toEqual([
			{ id: "limit_0", valueLabel: "5-hour", usedPercent: 40, resetAt: 1_800_000_000_000 },
			{ id: "limit_1", valueLabel: "Weekly: 500 / 2,000 credits", usedPercent: 25, resetAt: undefined },
		])
	})

	it("treats a business failure inside HTTP 200 as no data", () => {
		expect(parseZaiQuota({ success: false, code: 1001, msg: "expired", data: { limits: [] } })).toBeUndefined()
		expect(parseZaiQuota({ code: 1001, data: { limits: [{ type: "TOKENS_LIMIT" }] } })).toBeUndefined()
	})
})

describe("parseMiniMaxRemains", () => {
	const row = {
		model_name: "MiniMax-M2",
		current_interval_total_count: 100,
		current_interval_remaining_percent: 80,
		end_time: 1_800_000_000_000,
		current_weekly_total_count: 1000,
		current_weekly_usage_count: 900,
		weekly_end_time: 1_900_000_000_000,
	}

	it("reports the 5-hour window and a weekly window when the plan has one", () => {
		expect(parseMiniMaxRemains({ model_remains: [{ model_name: "other" }, row] })).toEqual([
			{ id: "5h", valueLabel: "5-hour", usedPercent: 20, resetAt: 1_800_000_000_000 },
			{ id: "weekly", valueLabel: "Weekly", usedPercent: 10, resetAt: 1_900_000_000_000 },
		])
	})

	it("reads counters as used (not left) for the legacy coding plan", () => {
		const windows = parseMiniMaxRemains(
			{
				model_remains: [
					{
						model_name: "MiniMax-M2",
						current_interval_total_count: 100,
						current_interval_usage_count: 30,
						current_weekly_total_count: 1000,
						current_weekly_usage_count: 900,
					},
				],
			},
			false,
		)!
		expect(windows[0].usedPercent).toBe(30)
		expect(windows[1].usedPercent).toBe(90)
	})

	it("omits the weekly window when the plan tier does not apply it (status 3)", () => {
		const result = parseMiniMaxRemains({ model_remains: [{ ...row, current_weekly_status: 3 }] })
		expect(result?.map((w) => w.id)).toEqual(["5h"])
	})

	it("rejects an error envelope or an empty list", () => {
		expect(parseMiniMaxRemains({ base_resp: { status_code: 1004 }, model_remains: [row] })).toBeUndefined()
		expect(parseMiniMaxRemains({ model_remains: [] })).toBeUndefined()
	})
})

describe("parseNanoGptUsage", () => {
	it("derives percent from percentUsed or used/limit and keeps state in the label", () => {
		expect(
			parseNanoGptUsage({
				state: "grace",
				limits: { dailyInputTokens: 1000 },
				dailyInputTokens: { used: 250 },
				monthly: { percentUsed: 0.4, resetAt: 1_800_000_000 },
			}),
		).toEqual([
			{ id: "daily", valueLabel: "Daily (grace)", usedPercent: 25, resetAt: undefined },
			{ id: "monthly", valueLabel: "Monthly (grace)", usedPercent: 40, resetAt: 1_800_000_000_000 },
		])
	})

	it("shows no percent for a degraded window", () => {
		const daily = parseNanoGptUsage({ dailyInputTokens: { percentUsed: 0.9, degraded: true } })![0]
		expect(daily.usedPercent).toBeUndefined()
	})
})

describe("parseOpenCodeGoUsage", () => {
	it("maps rolling, weekly and monthly windows that carry a percent and a reset", () => {
		expect(
			parseOpenCodeGoUsage({
				usage: {
					rolling: { percent: 12, resetsAt: 1_800_000_000 },
					weekly: { percent: 140, resetsAt: 1_800_000_001 },
					monthly: { percent: 5 },
				},
			}),
		).toEqual([
			{ id: "5h", valueLabel: "5-hour", usedPercent: 12, resetAt: 1_800_000_000_000 },
			{ id: "weekly", valueLabel: "Weekly", usedPercent: 100, resetAt: 1_800_000_001_000 },
		])
	})
})

describe("balance parser edge cases", () => {
	it("DeepSeek: rejects non-object and empty payloads, and a row without a balance", () => {
		expect(parseDeepSeekBalance(null)).toBeUndefined()
		expect(parseDeepSeekBalance({ balance_infos: [] })).toBeUndefined()
		expect(parseDeepSeekBalance({ balance_infos: [{ currency: "USD" }] })).toBeUndefined()
		expect(parseDeepSeekBalance({ balance_infos: ["x", null] })).toBeUndefined()
	})

	it("DeepSeek: prefers a positive CNY balance over a zero USD one, then any USD row, then the first row", () => {
		expect(
			parseDeepSeekBalance({
				balance_infos: [
					{ currency: "USD", total_balance: "0" },
					{ currency: "CNY", total_balance: "12" },
				],
			}),
		).toEqual([{ id: "balance", valueLabel: "¥12.00 left" }])
		expect(
			parseDeepSeekBalance({
				balance_infos: [
					{ currency: "EUR", total_balance: "0" },
					{ currency: "USD", total_balance: "0" },
				],
			}),
		).toEqual([{ id: "balance", valueLabel: "$0.00 left" }])
		expect(parseDeepSeekBalance({ balance_infos: [{ currency: "EUR", total_balance: "3" }] })).toEqual([
			{ id: "balance", valueLabel: "$3.00 left" },
		])
	})

	it("Moonshot: returns undefined without an available_balance", () => {
		expect(parseMoonshotBalance({ data: {} })).toBeUndefined()
		expect(parseMoonshotBalance(null)).toBeUndefined()
	})
})

describe("parser edge cases", () => {
	it("Kimi Code: skips a legacy usage block with no limit, and derives used from `used`", () => {
		expect(parseKimiCodeUsage({ usage: { used: 5 } })).toBeUndefined()
		expect(parseKimiCodeUsage({ usage: { limit: 100, used: 40, resetTime: 1_800_000_000 } })).toEqual([
			{ id: "weekly", valueLabel: "Weekly", usedPercent: 40, resetAt: 1_800_000_000_000 },
		])
		expect(parseKimiCodeUsage({ usage: { limit: 100 } })).toBeUndefined()
	})

	it("z.ai: ignores non-object, wrong-type and unit-less limits; falls back to counts for percent", () => {
		expect(parseZaiQuota("nope")).toBeUndefined()
		expect(parseZaiQuota({ data: {} })).toBeUndefined()
		expect(parseZaiQuota({ data: { limits: [null, { type: "TIME_LIMIT" }] } })).toBeUndefined()
		expect(
			parseZaiQuota({
				data: { limits: [{ type: "TOKENS_LIMIT", unit: 9, number: 5, usage: 200, currentValue: 50 }] },
			}),
		).toEqual([{ id: "limit_0", valueLabel: "Tokens", usedPercent: 25, resetAt: undefined }])
		expect(parseZaiQuota({ data: { limits: [{ type: "CREDIT_LIMIT", usage: 0, currentValue: 0 }] } })).toEqual([
			{ id: "limit_0", valueLabel: "Credits: 0 / 0 credits", usedPercent: undefined, resetAt: undefined },
		])
	})

	it("MiniMax: picks a chat-named or percent-bearing model when no minimax-m model exists", () => {
		expect(parseMiniMaxRemains(null)).toBeUndefined()
		expect(parseMiniMaxRemains({ model_remains: ["x", null] })).toBeUndefined()

		const byName = parseMiniMaxRemains({
			model_remains: [
				{ model_name: "other", current_interval_remaining_percent: 10 },
				{ model_name: "Chat", current_interval_remaining_percent: 60 },
			],
		})
		expect(byName?.[0].usedPercent).toBe(40)

		const byPercent = parseMiniMaxRemains({
			model_remains: [{ model_name: "a" }, { model_name: "b", current_interval_remaining_percent: 75 }],
		})
		expect(byPercent?.[0].usedPercent).toBe(25)

		const first = parseMiniMaxRemains({ model_remains: [{ model_name: "only" }] })
		// A row with neither a figure nor a reset time has nothing to show.
		expect(first).toBeUndefined()
		expect(
			parseMiniMaxRemains({ model_remains: [{ current_interval_remaining_percent: 5 }] })?.[0].usedPercent,
		).toBe(95)
	})

	it("MiniMax: prefers a MiniMax-M row that reports a percentage over a chat row", () => {
		const windows = parseMiniMaxRemains({
			model_remains: [
				{ model_name: "chat", current_interval_remaining_percent: 10 },
				{ model_name: "MiniMax-M2", current_interval_remaining_percent: 80 },
			],
		})
		expect(windows?.[0].usedPercent).toBe(20) // the M row's 80% left, not the chat row's 10% left
	})

	it("MiniMax: shows the 5-hour window with only a reset time, and with only a figure", () => {
		expect(
			parseMiniMaxRemains({ model_remains: [{ model_name: "MiniMax-M2", end_time: 1_800_000_000_000 }] }),
		).toEqual([{ id: "5h", valueLabel: "5-hour", usedPercent: undefined, resetAt: 1_800_000_000_000 }])
		expect(
			parseMiniMaxRemains({
				model_remains: [{ model_name: "MiniMax-M2", current_interval_remaining_percent: 70 }],
			}),
		).toEqual([{ id: "5h", valueLabel: "5-hour", usedPercent: 30, resetAt: undefined }])
	})

	it("MiniMax: skips a weekly window with no data and clamps an out-of-range percent", () => {
		const [interval, weekly] = parseMiniMaxRemains({
			model_remains: [{ model_name: "MiniMax-M2", current_interval_remaining_percent: 150 }],
		})!
		expect(interval.usedPercent).toBe(0)
		expect(weekly).toBeUndefined()
	})

	it("NanoGPT: handles non-object input, legacy `daily`, nested limits and unusable windows", () => {
		expect(parseNanoGptUsage(null)).toBeUndefined()
		expect(parseNanoGptUsage({})).toBeUndefined()
		expect(
			parseNanoGptUsage({
				daily: { used: 30, limit: 120, resetAt: "2026-05-01T00:00:00Z" },
				monthly: { used: 10, limits: { monthly: 100 } },
				period: { currentPeriodEnd: 1_800_000_000 },
			}),
		).toEqual([
			{ id: "daily", valueLabel: "Daily", usedPercent: 25, resetAt: Date.parse("2026-05-01T00:00:00Z") },
			{ id: "monthly", valueLabel: "Monthly", usedPercent: 10, resetAt: 1_800_000_000_000 },
		])
		expect(parseNanoGptUsage({ daily: { used: 30, limits: { daily: 60 } } })?.[0].usedPercent).toBe(50)
		expect(parseNanoGptUsage({ monthly: { used: 5, limit: 0 } })?.[0].usedPercent).toBeUndefined()
		expect(parseNanoGptUsage({ monthly: {} })?.[0].usedPercent).toBeUndefined()
	})

	it("OpenCode Go: returns undefined without a usage block or with no usable window", () => {
		expect(parseOpenCodeGoUsage(null)).toBeUndefined()
		expect(parseOpenCodeGoUsage({})).toBeUndefined()
		expect(parseOpenCodeGoUsage({ usage: { rolling: { percent: 10 } } })).toBeUndefined()
	})
})

describe("getProviderQuotas – Copilot window and misc", () => {
	beforeEach(() => resetProviderQuotaCache())

	it("shows a percent-only Copilot window, and 'Unlimited' for unlimited plans", async () => {
		const { getGitHubCopilotQuota } = await import("../copilotQuota")
		const mocked = vi.mocked(getGitHubCopilotQuota)

		mocked.mockResolvedValueOnce({ ok: true, quota: { unlimited: false, usedPercent: 41.6, fetchedAt: 1 } })
		const [pct] = await getProviderQuotas([{ apiProvider: providerIdentifiers.githubCopilot } as never])
		expect(pct).toMatchObject({ ok: true, windows: [{ valueLabel: "42% used", usedPercent: 41.6 }] })

		resetProviderQuotaCache()
		mocked.mockResolvedValueOnce({ ok: true, quota: { unlimited: false, fetchedAt: 1 } })
		const [none] = await getProviderQuotas([{ apiProvider: providerIdentifiers.githubCopilot } as never])
		// Unknown usage is reported as unknown (no bar), never as a measured 0%.
		expect(none).toMatchObject({ ok: true, windows: [{ valueLabel: "Usage not reported" }] })
		expect((none as { windows: Array<{ usedPercent?: number }> }).windows[0].usedPercent).toBeUndefined()

		resetProviderQuotaCache()
		mocked.mockResolvedValueOnce({ ok: true, quota: { unlimited: true, resetAt: 7, fetchedAt: 1 } })
		const [unl] = await getProviderQuotas([{ apiProvider: providerIdentifiers.githubCopilot } as never])
		expect(unl).toMatchObject({ ok: true, windows: [{ valueLabel: "Unlimited", resetAt: 7 }] })
	})

	it("hands the caller's abort signal to the Copilot lookup", async () => {
		const { getGitHubCopilotQuota } = await import("../copilotQuota")
		const mocked = vi.mocked(getGitHubCopilotQuota)
		mocked.mockResolvedValueOnce({ ok: true, quota: { unlimited: true, fetchedAt: 1 } })
		const controller = new AbortController()
		await getProviderQuotas([{ apiProvider: providerIdentifiers.githubCopilot } as never], {
			signal: controller.signal,
		})
		expect(mocked).toHaveBeenLastCalledWith({ force: false, signal: controller.signal })
	})

	it("passes Copilot failures through with their reason and message", async () => {
		const { getGitHubCopilotQuota } = await import("../copilotQuota")
		vi.mocked(getGitHubCopilotQuota).mockResolvedValueOnce({ ok: false, reason: "error", message: "boom" })
		const [q] = await getProviderQuotas([{ apiProvider: providerIdentifiers.githubCopilot } as never])
		expect(q).toMatchObject({ ok: false, reason: "error", message: "boom" })
	})

	it("uses the default z.ai line when the profile sets none", async () => {
		const fetchSpy = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response("{}"))
		await getProviderQuotas([{ apiProvider: providerIdentifiers.zai, zaiApiKey: "k" } as never], {}, fetchSpy)
		expect(fetchSpy.mock.calls[0][0]).toBe("https://api.z.ai/api/monitor/usage/quota/limit")
	})

	it("reports an error when a keyed provider answers with no usable data, and surfaces the last failure", async () => {
		const [empty] = await getProviderQuotas(
			[{ apiProvider: providerIdentifiers.nanogpt, nanoGptApiKey: "k" } as never],
			{},
			vi.fn(async () => new Response("{}")),
		)
		expect(empty).toMatchObject({ ok: false, reason: "error", message: "No usage data" })

		resetProviderQuotaCache()
		const [failed] = await getProviderQuotas(
			[{ apiProvider: providerIdentifiers.minimax, minimaxApiKey: "k" } as never],
			{},
			vi.fn(async () => new Response("", { status: 500 })),
		)
		expect(failed).toMatchObject({ ok: false, reason: "error", message: "HTTP 500" })
	})

	it("treats an auth failure on the first MiniMax URL as a missing/invalid key without trying the fallback", async () => {
		const fetchSpy = vi.fn(
			async (_url: RequestInfo | URL, _init?: RequestInit) => new Response("", { status: 401 }),
		)
		const [q] = await getProviderQuotas(
			[{ apiProvider: providerIdentifiers.minimax, minimaxApiKey: "k" } as never],
			{},
			fetchSpy,
		)
		expect(q).toMatchObject({ ok: false, reason: "noKey" })
		expect(fetchSpy).toHaveBeenCalledTimes(1)
	})
})

describe("Kimi Code authentication", () => {
	beforeEach(() => resetProviderQuotaCache())

	it("does not query an OAuth profile, even when an old API key is still stored in it", async () => {
		const fetchSpy = vi.fn()
		const [q] = await getProviderQuotas(
			[
				{
					apiProvider: providerIdentifiers.kimiCode,
					kimiCodeAuthMethod: "oauth",
					kimiCodeApiKey: "stale-key",
				} as never,
			],
			{},
			fetchSpy,
		)
		expect(q).toMatchObject({ ok: false, reason: "noKey" })
		expect(fetchSpy).not.toHaveBeenCalled()
	})

	it("queries an API-key profile with its key", async () => {
		const fetchSpy = vi.fn(
			async (_url: RequestInfo | URL, _init?: RequestInit) =>
				new Response(JSON.stringify({ usage: { limit: 100, used: 10 } })),
		)
		await getProviderQuotas(
			[
				{
					apiProvider: providerIdentifiers.kimiCode,
					kimiCodeAuthMethod: "api-key",
					kimiCodeApiKey: "real-key",
				} as never,
			],
			{},
			fetchSpy,
		)
		expect((fetchSpy.mock.calls[0][1]?.headers as Record<string, string>).Authorization).toBe("Bearer real-key")
	})

	it("treats a profile with no recorded method as an API-key profile", async () => {
		const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ usage: { limit: 100, used: 10 } })))
		await getProviderQuotas(
			[{ apiProvider: providerIdentifiers.kimiCode, kimiCodeApiKey: "k" } as never],
			{},
			fetchSpy,
		)
		expect(fetchSpy).toHaveBeenCalledTimes(1)
	})
})

describe("getProviderQuotas – coding-plan providers", () => {
	beforeEach(() => resetProviderQuotaCache())

	it("queries z.ai on the host matching the profile's API line", async () => {
		const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ code: 200, data: { limits: [] } })))
		await getProviderQuotas(
			[{ apiProvider: providerIdentifiers.zai, zaiApiKey: "k", zaiApiLine: "china_coding" } as never],
			{},
			fetchSpy,
		)
		expect(fetchSpy).toHaveBeenCalledWith(
			"https://open.bigmodel.cn/api/monitor/usage/quota/limit",
			expect.anything(),
		)
	})

	it("falls back to the coding-plan endpoint for MiniMax and reads its counters as used", async () => {
		const body = {
			model_remains: [
				{
					model_name: "MiniMax-M2",
					current_interval_total_count: 100,
					current_interval_usage_count: 30,
				},
			],
		}
		const fetchSpy = vi
			.fn()
			.mockResolvedValueOnce(new Response("", { status: 404 }))
			.mockResolvedValueOnce(new Response(JSON.stringify(body)))
		const [q] = await getProviderQuotas(
			[{ apiProvider: providerIdentifiers.minimax, minimaxApiKey: "k" } as never],
			{},
			fetchSpy,
		)
		expect(fetchSpy.mock.calls.map((c) => c[0])).toEqual([
			"https://api.minimax.io/v1/token_plan/remains",
			"https://api.minimax.io/v1/api/openplatform/coding_plan/remains",
		])
		expect(q).toMatchObject({ ok: true, windows: [{ id: "5h", usedPercent: 30 }] })
	})

	it("uses the China MiniMax hosts for a minimaxi.com base URL", async () => {
		const fetchSpy = vi.fn(
			async (_url: RequestInfo | URL, _init?: RequestInit) => new Response("", { status: 404 }),
		)
		await getProviderQuotas(
			[
				{
					apiProvider: providerIdentifiers.minimax,
					minimaxApiKey: "k",
					minimaxBaseUrl: "https://api.minimaxi.com/anthropic",
				} as never,
			],
			{},
			fetchSpy,
		)
		expect(fetchSpy.mock.calls.map((c) => c[0])).toEqual([
			"https://api.minimaxi.com/v1/token_plan/remains",
			"https://www.minimaxi.com/v1/api/openplatform/coding_plan/remains",
		])
	})

	it("never sends a MiniMax key to an unknown base URL", async () => {
		const fetchSpy = vi.fn()
		const [q] = await getProviderQuotas(
			[
				{
					apiProvider: providerIdentifiers.minimax,
					minimaxApiKey: "k",
					minimaxBaseUrl: "https://gateway.example/anthropic",
				} as never,
			],
			{},
			fetchSpy,
		)
		expect(q).toMatchObject({ ok: false, reason: "unsupported" })
		expect(fetchSpy).not.toHaveBeenCalled()
	})

	it("reports noKey for a Kimi Code profile signed in with OAuth (no API key)", async () => {
		const fetchSpy = vi.fn()
		const [q] = await getProviderQuotas([{ apiProvider: providerIdentifiers.kimiCode } as never], {}, fetchSpy)
		expect(q).toMatchObject({ ok: false, reason: "noKey" })
		expect(fetchSpy).not.toHaveBeenCalled()
	})

	it("calls NanoGPT, Kimi Code and OpenCode Go on their own hosts only", async () => {
		const fetchSpy = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({})))
		await getProviderQuotas(
			[
				{ apiProvider: providerIdentifiers.nanogpt, nanoGptApiKey: "k" } as never,
				{ apiProvider: providerIdentifiers.kimiCode, kimiCodeApiKey: "k" } as never,
				{ apiProvider: providerIdentifiers.opencodeGo, opencodeGoApiKey: "k" } as never,
			],
			{},
			fetchSpy,
		)
		expect(fetchSpy.mock.calls.map((c) => c[0]).sort()).toEqual([
			"https://api.kimi.com/coding/v1/usages",
			"https://nano-gpt.com/api/subscription/v1/usage",
			"https://opencode.ai/zen/go/v1/usage",
		])
	})
})

describe("getProviderQuotas", () => {
	beforeEach(() => resetProviderQuotaCache())

	const okFetch = vi.fn(async () => new Response(JSON.stringify({ data: { limit: 10, limit_remaining: 5 } })))

	it("only queries providers that are connected", async () => {
		const result = await getProviderQuotas([{ apiProvider: providerIdentifiers.anthropic } as never], {}, okFetch)
		expect(result).toEqual([])
		expect(okFetch).not.toHaveBeenCalled()
	})

	it("returns Copilot credits formatted for display", async () => {
		const [copilot] = await getProviderQuotas([{ apiProvider: providerIdentifiers.githubCopilot } as never])
		expect(copilot).toMatchObject({
			providerId: providerIdentifiers.githubCopilot,
			ok: true,
			plan: "business",
			windows: [{ id: "premium", valueLabel: "39,389.3 / 140,000 used", usedPercent: 28.1, resetAt: 1 }],
		})
	})

	it("reports noKey when the profile has no API key", async () => {
		const [q] = await getProviderQuotas([{ apiProvider: providerIdentifiers.openrouter } as never], {}, okFetch)
		expect(q).toMatchObject({ providerId: providerIdentifiers.openrouter, ok: false, reason: "noKey" })
		expect(okFetch).not.toHaveBeenCalled()
	})

	it("treats a malformed custom base URL as a different host and never sends the key", async () => {
		const fetchSpy = vi.fn(okFetch)
		const [q] = await getProviderQuotas(
			[
				{
					apiProvider: providerIdentifiers.openrouter,
					openRouterApiKey: "sk",
					openRouterBaseUrl: "not a url",
				} as never,
			],
			{},
			fetchSpy,
		)
		expect(q).toMatchObject({ ok: false, reason: "unsupported" })
		expect(fetchSpy).not.toHaveBeenCalled()
	})

	it("accepts the provider's own host written with a trailing path or slash", async () => {
		const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ data: { limit: 10, limit_remaining: 5 } })))
		const [q] = await getProviderQuotas(
			[
				{
					apiProvider: providerIdentifiers.openrouter,
					openRouterApiKey: "sk",
					openRouterBaseUrl: "https://openrouter.ai/api/v1/",
				} as never,
			],
			{},
			fetchSpy,
		)
		expect(q).toMatchObject({ ok: true })
	})

	describe("never sends a key to a base URL that is not the provider's own host", () => {
		const providers = [
			{
				id: providerIdentifiers.openrouter,
				host: "openrouter.ai",
				own: "https://openrouter.ai/api/v1",
				settings: { openRouterApiKey: "sk" },
				urlKey: "openRouterBaseUrl",
			},
			{
				id: providerIdentifiers.deepseek,
				host: "api.deepseek.com",
				own: "https://api.deepseek.com",
				settings: { deepSeekApiKey: "sk" },
				urlKey: "deepSeekBaseUrl",
			},
			{
				id: providerIdentifiers.moonshot,
				host: "api.moonshot.ai",
				own: "https://api.moonshot.ai/v1",
				settings: { moonshotApiKey: "sk" },
				urlKey: "moonshotBaseUrl",
			},
		] as const

		const hostile = (host: string) => [
			"https://evil.example/api/v1",
			`https://${host}.evil.com`,
			`https://user@${host}.evil.com`,
			`http://${host}`,
			`https://${host}:8443`,
		]

		const cases = providers.flatMap((p) => hostile(p.host).map((url) => [p.id, url, p] as const))

		it.each(cases)("%s: %s", async (_id, url, p) => {
			const fetchSpy = vi.fn(okFetch)
			const [q] = await getProviderQuotas(
				[{ apiProvider: p.id, ...p.settings, [p.urlKey]: url } as never],
				{},
				fetchSpy,
			)
			expect(q).toMatchObject({ ok: false, reason: "unsupported" })
			expect(fetchSpy).not.toHaveBeenCalled()
		})

		it.each(providers.map((p) => [p.id, p] as const))("%s: still queries its own host", async (_id, p) => {
			const fetchSpy = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => okFetch())
			await getProviderQuotas([{ apiProvider: p.id, ...p.settings, [p.urlKey]: p.own } as never], {}, fetchSpy)
			expect(fetchSpy).toHaveBeenCalled()
			for (const [url] of fetchSpy.mock.calls) expect(String(url).startsWith(p.own)).toBe(true)
		})
	})

	it("calls the provider's own host with the saved key", async () => {
		const fetchSpy = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => okFetch())
		const [q] = await getProviderQuotas(
			[{ apiProvider: providerIdentifiers.openrouter, openRouterApiKey: "sk-test" } as never],
			{},
			fetchSpy,
		)
		expect(fetchSpy).toHaveBeenCalledWith(
			"https://openrouter.ai/api/v1/key",
			expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer sk-test" }) }),
		)
		expect(q).toMatchObject({ ok: true, windows: [{ valueLabel: "$5.00 / $10.00 used" }] })
	})

	it("maps 401 to noKey", async () => {
		const [q] = await getProviderQuotas(
			[{ apiProvider: providerIdentifiers.deepseek, deepSeekApiKey: "bad" } as never],
			{},
			vi.fn(async () => new Response("", { status: 401 })),
		)
		expect(q).toMatchObject({ providerId: providerIdentifiers.deepseek, ok: false, reason: "noKey" })
	})

	it("queries a profile on the provider's own host even when an earlier profile uses a custom gateway", async () => {
		const fetchSpy = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => {
			return new Response(JSON.stringify({ balance_infos: [{ currency: "USD", total_balance: "7.5" }] }))
		})
		const [q] = await getProviderQuotas(
			[
				{
					apiProvider: providerIdentifiers.deepseek,
					deepSeekApiKey: "gateway-key",
					deepSeekBaseUrl: "https://gateway.example.com/v1",
				} as never,
				{ apiProvider: providerIdentifiers.deepseek, deepSeekApiKey: "real-key" } as never,
			],
			{},
			fetchSpy,
		)
		expect(q).toMatchObject({ ok: true, windows: [{ valueLabel: "$7.50 left" }] })
		expect(String(fetchSpy.mock.calls[0][0])).toContain("api.deepseek.com")
		// The gateway profile's key is never sent anywhere.
		expect(JSON.stringify(fetchSpy.mock.calls)).not.toContain("gateway-key")
	})

	it("reports unsupported only when every keyed profile uses a custom gateway", async () => {
		const [q] = await getProviderQuotas(
			[
				{
					apiProvider: providerIdentifiers.deepseek,
					deepSeekApiKey: "k",
					deepSeekBaseUrl: "https://gateway.example.com/v1",
				} as never,
			],
			{},
			vi.fn(),
		)
		expect(q).toMatchObject({ ok: false, reason: "unsupported" })
	})

	it("does not cache a missing key: adding one shows up on the next call", async () => {
		const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ data: { limit: 10, limit_remaining: 5 } })))
		const [before] = await getProviderQuotas(
			[{ apiProvider: providerIdentifiers.openrouter } as never],
			{},
			fetchSpy,
		)
		expect(before).toMatchObject({ ok: false, reason: "noKey" })

		const [after] = await getProviderQuotas(
			[{ apiProvider: providerIdentifiers.openrouter, openRouterApiKey: "sk" } as never],
			{},
			fetchSpy,
		)
		expect(after).toMatchObject({ ok: true })
	})

	it("does not cache a failure: a retry within the TTL is fetched again", async () => {
		const fetchSpy = vi
			.fn()
			.mockResolvedValueOnce(new Response("", { status: 500 }))
			.mockResolvedValueOnce(new Response(JSON.stringify({ data: { limit: 10, limit_remaining: 5 } })))
		const profiles = [{ apiProvider: providerIdentifiers.openrouter, openRouterApiKey: "sk" } as never]

		const [first] = await getProviderQuotas(profiles, {}, fetchSpy)
		expect(first).toMatchObject({ ok: false, reason: "error" })
		const [second] = await getProviderQuotas(profiles, {}, fetchSpy)
		expect(second).toMatchObject({ ok: true })
		expect(fetchSpy).toHaveBeenCalledTimes(2)
	})

	it("refetches when the API key changes", async () => {
		const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ data: { limit: 10, limit_remaining: 5 } })))
		await getProviderQuotas(
			[{ apiProvider: providerIdentifiers.openrouter, openRouterApiKey: "sk-one" } as never],
			{},
			fetchSpy,
		)
		await getProviderQuotas(
			[{ apiProvider: providerIdentifiers.openrouter, openRouterApiKey: "sk-two" } as never],
			{},
			fetchSpy,
		)
		expect(fetchSpy).toHaveBeenCalledTimes(2)
	})

	it("does not hand a result fetched with one key to a caller using another, even while the first is in flight", async () => {
		const pending = new Map<string, (r: Response) => void>()
		const fetchSpy = vi.fn(
			(_url: RequestInfo | URL, init?: RequestInit) =>
				new Promise<Response>((resolve) => {
					pending.set(String((init?.headers as Record<string, string>).Authorization), resolve)
				}),
		)
		const body = (remaining: number) =>
			new Response(JSON.stringify({ data: { limit: 10, limit_remaining: remaining } }))

		const first = getProviderQuotas(
			[{ apiProvider: providerIdentifiers.openrouter, openRouterApiKey: "sk-one" } as never],
			{},
			fetchSpy,
		)
		const second = getProviderQuotas(
			[{ apiProvider: providerIdentifiers.openrouter, openRouterApiKey: "sk-two" } as never],
			{},
			fetchSpy,
		)
		await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2))
		// Each request went out with its own key, and nothing else.
		expect([...pending.keys()].sort()).toEqual(["Bearer sk-one", "Bearer sk-two"])

		// Answer them with different data, in the opposite order, so a mix-up would show.
		pending.get("Bearer sk-two")!(body(2))
		pending.get("Bearer sk-one")!(body(9))

		const [[a], [b]] = await Promise.all([first, second])
		expect(a).toMatchObject({ ok: true, windows: [{ usedPercent: 10 }] })
		expect(b).toMatchObject({ ok: true, windows: [{ usedPercent: 80 }] })
	})

	it("drops a cached success when a forced refresh fails, so the next normal call retries", async () => {
		const ok = () => new Response(JSON.stringify({ data: { limit: 10, limit_remaining: 5 } }))
		const fetchSpy = vi
			.fn()
			.mockResolvedValueOnce(ok())
			.mockResolvedValueOnce(new Response("", { status: 500 }))
			.mockResolvedValueOnce(ok())
		const profiles = [{ apiProvider: providerIdentifiers.openrouter, openRouterApiKey: "sk" } as never]

		await getProviderQuotas(profiles, {}, fetchSpy)
		const [failed] = await getProviderQuotas(profiles, { force: true }, fetchSpy)
		expect(failed).toMatchObject({ ok: false, reason: "error" })

		// The old success must not be served as if it were current.
		const [retry] = await getProviderQuotas(profiles, {}, fetchSpy)
		expect(retry).toMatchObject({ ok: true })
		expect(fetchSpy).toHaveBeenCalledTimes(3)
	})

	it("aborts the network request when the only caller goes away", async () => {
		let seen: AbortSignal | undefined
		const fetchSpy = vi.fn(
			(_url: RequestInfo | URL, init?: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					seen = init?.signal ?? undefined
					seen?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")))
				}),
		)
		const controller = new AbortController()
		const result = getProviderQuotas(
			[{ apiProvider: providerIdentifiers.openrouter, openRouterApiKey: "sk" } as never],
			{ signal: controller.signal },
			fetchSpy,
		)
		await vi.waitFor(() => expect(seen).toBeDefined())
		expect(seen!.aborted).toBe(false)

		controller.abort()
		await expect(result).rejects.toMatchObject({ name: "AbortError" })
		expect(seen!.aborted).toBe(true)
	})

	it("keeps the shared request running until its last caller leaves", async () => {
		let seen: AbortSignal | undefined
		let release: (r: Response) => void = () => {}
		const fetchSpy = vi.fn(
			(_url: RequestInfo | URL, init?: RequestInit) =>
				new Promise<Response>((resolve) => {
					seen = init?.signal ?? undefined
					release = resolve
				}),
		)
		const profiles = [{ apiProvider: providerIdentifiers.openrouter, openRouterApiKey: "sk" } as never]
		const leaver = new AbortController()

		const staying = getProviderQuotas(profiles, {}, fetchSpy)
		const leaving = getProviderQuotas(profiles, { signal: leaver.signal }, fetchSpy)
		await vi.waitFor(() => expect(seen).toBeDefined())

		leaver.abort()
		await expect(leaving).rejects.toMatchObject({ name: "AbortError" })
		// Someone is still waiting, so the shared fetch must keep going.
		expect(seen!.aborted).toBe(false)

		release(new Response(JSON.stringify({ data: { limit: 10, limit_remaining: 5 } })))
		const [quota] = await staying
		expect(quota).toMatchObject({ ok: true })
		expect(fetchSpy).toHaveBeenCalledTimes(1)
	})

	it("rejects at once with an already-aborted signal, without keeping a request alive", async () => {
		const fetchSpy = vi.fn(() => new Promise<Response>(() => {}))
		const controller = new AbortController()
		controller.abort()
		await expect(
			getProviderQuotas(
				[{ apiProvider: providerIdentifiers.openrouter, openRouterApiKey: "sk" } as never],
				{ signal: controller.signal },
				fetchSpy,
			),
		).rejects.toMatchObject({ name: "AbortError" })
	})

	it("shares one request between concurrent callers for the same credentials", async () => {
		let release: (r: Response) => void = () => {}
		const fetchSpy = vi.fn(() => new Promise<Response>((resolve) => (release = resolve)))
		const profiles = [{ apiProvider: providerIdentifiers.openrouter, openRouterApiKey: "sk" } as never]

		const a = getProviderQuotas(profiles, {}, fetchSpy)
		const b = getProviderQuotas(profiles, { force: true }, fetchSpy)
		await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalled())
		release(new Response(JSON.stringify({ data: { limit: 10, limit_remaining: 5 } })))

		const [ra, rb] = await Promise.all([a, b])
		expect(fetchSpy).toHaveBeenCalledTimes(1)
		expect(ra).toEqual(rb)
	})

	it("starts a new request instead of joining one whose last caller already left", async () => {
		const body = () => new Response(JSON.stringify({ data: { limit: 10, limit_remaining: 5 } }))
		// A host that ignores cancellation: the first request is still pending after its caller left.
		let finishFirst: () => void = () => {}
		const fetchSpy = vi
			.fn<typeof fetch>()
			.mockImplementationOnce(() => new Promise<Response>((resolve) => (finishFirst = () => resolve(body()))))
			.mockImplementation(async () => body())
		const profiles = [{ apiProvider: providerIdentifiers.openrouter, openRouterApiKey: "sk" } as never]
		const controller = new AbortController()

		const first = getProviderQuotas(profiles, { signal: controller.signal }, fetchSpy)
		await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1))
		controller.abort()
		await expect(first).rejects.toMatchObject({ name: "AbortError" })

		// A new caller must get its own fetch, not join the cancelled one.
		const [q] = await getProviderQuotas(profiles, {}, fetchSpy)
		expect(fetchSpy).toHaveBeenCalledTimes(2)
		expect(q).toMatchObject({ providerId: providerIdentifiers.openrouter, ok: true })
		finishFirst()
	})

	it("does not let a cancelled request wipe a cached success", async () => {
		const ok = vi.fn(async () => new Response(JSON.stringify({ data: { limit: 10, limit_remaining: 5 } })))
		const profiles = [{ apiProvider: providerIdentifiers.openrouter, openRouterApiKey: "sk" } as never]
		await getProviderQuotas(profiles, {}, ok)

		const hanging = vi.fn(
			(_input: RequestInfo | URL, init?: RequestInit) =>
				new Promise<Response>((_resolve, reject) =>
					(init?.signal as AbortSignal).addEventListener("abort", () =>
						reject(new DOMException("Aborted", "AbortError")),
					),
				),
		)
		const controller = new AbortController()
		const refresh = getProviderQuotas(profiles, { force: true, signal: controller.signal }, hanging)
		await vi.waitFor(() => expect(hanging).toHaveBeenCalled())
		controller.abort()
		await expect(refresh).rejects.toMatchObject({ name: "AbortError" })
		await new Promise((resolve) => setTimeout(resolve, 0))

		// The earlier success is still served from the cache.
		await getProviderQuotas(profiles, {}, ok)
		expect(ok).toHaveBeenCalledTimes(1)
	})

	describe("the cache lifetime", () => {
		afterEach(() => vi.useRealTimers())

		it.each([
			[59_999, 1],
			[60_000, 2],
		])("a result %i ms old gives %i request(s) in total", async (age, requests) => {
			vi.useFakeTimers()
			vi.setSystemTime(1_000_000)
			const fetchSpy = vi.fn(
				async () => new Response(JSON.stringify({ data: { limit: 10, limit_remaining: 5 } })),
			)
			const profiles = [{ apiProvider: providerIdentifiers.openrouter, openRouterApiKey: "sk" } as never]
			await getProviderQuotas(profiles, {}, fetchSpy)

			vi.setSystemTime(1_000_000 + age)
			await getProviderQuotas(profiles, {}, fetchSpy)

			expect(fetchSpy).toHaveBeenCalledTimes(requests)
		})
	})

	it("a failed request for one key does not remove the cached success of another key", async () => {
		const ok = () => new Response(JSON.stringify({ data: { limit: 10, limit_remaining: 5 } }))
		const fetchSpy = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) =>
			String((init?.headers as Record<string, string>)?.Authorization).includes("sk-two")
				? new Response("", { status: 500 })
				: ok(),
		)
		const one = [{ apiProvider: providerIdentifiers.openrouter, openRouterApiKey: "sk-one" } as never]
		const two = [{ apiProvider: providerIdentifiers.openrouter, openRouterApiKey: "sk-two" } as never]

		await getProviderQuotas(one, {}, fetchSpy) // cached for sk-one
		const [failed] = await getProviderQuotas(two, {}, fetchSpy) // fails for sk-two
		expect(failed).toMatchObject({ ok: false })
		const [again] = await getProviderQuotas(one, {}, fetchSpy)

		expect(again).toMatchObject({ ok: true })
		expect(fetchSpy).toHaveBeenCalledTimes(2) // the third call came from the cache
	})

	it("caches results for the same set of providers unless forced", async () => {
		const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ data: { limit: 10, limit_remaining: 5 } })))
		const profiles = [{ apiProvider: providerIdentifiers.openrouter, openRouterApiKey: "sk" } as never]
		await getProviderQuotas(profiles, {}, fetchSpy)
		await getProviderQuotas(profiles, {}, fetchSpy)
		expect(fetchSpy).toHaveBeenCalledTimes(1)
		await getProviderQuotas(profiles, { force: true }, fetchSpy)
		expect(fetchSpy).toHaveBeenCalledTimes(2)
	})
})

describe("the active profile decides which account is queried", () => {
	beforeEach(() => resetProviderQuotaCache())

	const okSpend = () => vi.fn(async () => new Response(JSON.stringify({ data: { limit: 10, limit_remaining: 5 } })))

	it("reports no key for an active profile without one, instead of using a sibling's key", async () => {
		const fetchSpy = okSpend()
		const [q] = await getProviderQuotas(
			[
				{ id: "active", apiProvider: providerIdentifiers.openrouter } as never,
				{ id: "other", apiProvider: providerIdentifiers.openrouter, openRouterApiKey: "sibling-key" } as never,
			],
			{ activeProfileId: "active" },
			fetchSpy,
		)

		expect(q).toMatchObject({ ok: false, reason: "noKey" })
		expect(fetchSpy).not.toHaveBeenCalled()
	})

	it("reports a custom gateway as unsupported when the active profile uses one, not a sibling on the default host", async () => {
		const fetchSpy = okSpend()
		const [q] = await getProviderQuotas(
			[
				{
					id: "active",
					apiProvider: providerIdentifiers.deepseek,
					deepSeekApiKey: "k1",
					deepSeekBaseUrl: "https://gateway.example/v1",
				} as never,
				{ id: "other", apiProvider: providerIdentifiers.deepseek, deepSeekApiKey: "k2" } as never,
			],
			{ activeProfileId: "active" },
			fetchSpy,
		)

		expect(q).toMatchObject({ ok: false, reason: "unsupported" })
		expect(fetchSpy).not.toHaveBeenCalled()
	})

	it("queries with the active profile's key when a sibling also has one", async () => {
		const fetchSpy = okSpend()
		await getProviderQuotas(
			[
				{ id: "other", apiProvider: providerIdentifiers.openrouter, openRouterApiKey: "sibling-key" } as never,
				{ id: "active", apiProvider: providerIdentifiers.openrouter, openRouterApiKey: "active-key" } as never,
			],
			{ activeProfileId: "active" },
			fetchSpy,
		)

		expect(fetchSpy).toHaveBeenCalledWith(
			"https://openrouter.ai/api/v1/key",
			expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer active-key" }) }),
		)
	})

	it.each([
		["there is no active profile", undefined],
		["the active profile is for another provider", "elsewhere"],
		["the active profile is not among the loaded ones", "gone"],
	])("keeps the usual choice of profile when %s", async (_name, activeProfileId) => {
		const fetchSpy = okSpend()
		await getProviderQuotas(
			[
				{ id: "elsewhere", apiProvider: providerIdentifiers.anthropic } as never,
				{ id: "keyless", apiProvider: providerIdentifiers.openrouter } as never,
				{ id: "keyed", apiProvider: providerIdentifiers.openrouter, openRouterApiKey: "the-key" } as never,
			],
			{ activeProfileId },
			fetchSpy,
		)

		expect(fetchSpy).toHaveBeenCalledWith(
			"https://openrouter.ai/api/v1/key",
			expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer the-key" }) }),
		)
	})
})

describe("window names", () => {
	beforeEach(() => resetProviderQuotaCache())

	const quotaFrom = async (profile: Record<string, unknown>, body: unknown) => {
		const [q] = await getProviderQuotas(
			[profile as never],
			{},
			vi.fn(async () => new Response(JSON.stringify(body))),
		)
		return q
	}

	it("gives the fixed windows of OpenCode Go a structured name next to the English text", async () => {
		const q = await quotaFrom(
			{ apiProvider: providerIdentifiers.opencodeGo, opencodeGoApiKey: "sk" },
			{
				usage: {
					rolling: { percent: 10, resetsAt: 1_800_000_000 },
					weekly: { percent: 20, resetsAt: 1_800_000_000 },
					monthly: { percent: 30, resetsAt: 1_800_000_000 },
				},
			},
		)
		expect(q).toMatchObject({
			ok: true,
			windows: [
				{ valueLabel: "5-hour", name: { key: "hours", count: 5 } },
				{ valueLabel: "Weekly", name: { key: "weekly" } },
				{ valueLabel: "Monthly", name: { key: "monthly" } },
			],
		})
	})

	it("names a rolling window of whole days by its count", async () => {
		const q = await quotaFrom(
			{ apiProvider: providerIdentifiers.zai, zaiApiKey: "sk" },
			{ code: 200, data: { limits: [{ type: "TOKENS_LIMIT", unit: 6, number: 2, percentage: 10 }] } },
		)
		expect(q).toMatchObject({ ok: true, windows: [{ valueLabel: "14-day", name: { key: "days", count: 14 } }] })
	})

	it("names a Copilot unlimited plan, and leaves a figure without a name", async () => {
		const copilot = await import("../copilotQuota")
		vi.mocked(copilot.getGitHubCopilotQuota).mockResolvedValueOnce({
			ok: true,
			quota: { unlimited: true, resetAt: 7, fetchedAt: 1 },
		})
		const [unlimited] = await getProviderQuotas([{ apiProvider: providerIdentifiers.githubCopilot } as never], {})
		expect(unlimited).toMatchObject({ windows: [{ valueLabel: "Unlimited", name: { key: "unlimited" } }] })

		resetProviderQuotaCache()
		const [counted] = await getProviderQuotas([{ apiProvider: providerIdentifiers.githubCopilot } as never], {})
		expect(counted).toMatchObject({ ok: true, windows: [{ valueLabel: "39,389.3 / 140,000 used" }] })
		expect(counted.ok && counted.windows[0]).not.toHaveProperty("name")
	})
})

/** The profiles only: most of these tests do not look at the active profile's id. */
const loadProfiles = async (...args: Parameters<typeof loadProfilesWithActive>) =>
	(await loadProfilesWithActive(...args)).profiles

describe("loadProfiles", () => {
	it("loads every saved profile through the manager, with keys", async () => {
		const source = {
			listConfig: vi.fn(async () => [{ id: "a" }, { id: "b" }]),
			getProfile: vi.fn(
				async ({ id }: { id: string }) => ({ apiProvider: "x", openRouterApiKey: `key-${id}` }) as never,
			),
		}
		const profiles = await loadProfiles(source)
		expect(profiles).toEqual([
			{ apiProvider: "x", openRouterApiKey: "key-a" },
			{ apiProvider: "x", openRouterApiKey: "key-b" },
		])
		expect(source.getProfile).toHaveBeenCalledWith({ id: "a" })
	})

	it("skips a profile that fails to load instead of failing the whole refresh", async () => {
		const source = {
			listConfig: vi.fn(async () => [{ id: "ok" }, { id: "broken" }]),
			getProfile: vi.fn(async ({ id }: { id: string }) => {
				if (id === "broken") throw new Error("corrupt secret storage")
				return { apiProvider: "x" } as never
			}),
		}
		expect(await loadProfiles(source)).toEqual([{ apiProvider: "x" }])
	})

	it("fails when none of the saved profiles can be read, instead of reporting no providers", async () => {
		const source = {
			listConfig: vi.fn(async () => [{ id: "a" }, { id: "b" }]),
			getProfile: vi.fn(async () => {
				throw new Error("corrupt secret storage")
			}),
		}
		await expect(loadProfiles(source)).rejects.toThrow("None of the saved profiles could be read")
	})

	it("returns an empty list when there are no saved profiles", async () => {
		const source = { listConfig: vi.fn(async () => []), getProfile: vi.fn() }
		expect(await loadProfiles(source)).toEqual([])
	})

	it("puts the active profile first, so a provider with several profiles shows the account in use", async () => {
		const source = {
			listConfig: vi.fn(async () => [
				{ id: "a", name: "work" },
				{ id: "b", name: "personal" },
				{ id: "c", name: "spare" },
			]),
			getProfile: vi.fn(async ({ id }: { id: string }) => ({ apiProvider: "x", id }) as never),
		}
		expect((await loadProfiles(source, undefined, "personal")).map((p) => (p as { id: string }).id)).toEqual([
			"b",
			"a",
			"c",
		])
		expect((await loadProfiles(source)).map((p) => (p as { id: string }).id)).toEqual(["a", "b", "c"])
	})

	it("keeps the list order when the active profile is not among the saved ones", async () => {
		const source = {
			listConfig: vi.fn(async () => [{ id: "a", name: "work" }]),
			getProfile: vi.fn(async () => ({ apiProvider: "x" }) as never),
		}
		expect(await loadProfiles(source, undefined, "gone")).toEqual([{ apiProvider: "x" }])
	})

	it("returns the id of the active profile with the profiles", async () => {
		const source = {
			listConfig: vi.fn(async () => [
				{ id: "a", name: "work" },
				{ id: "b", name: "personal" },
			]),
			getProfile: vi.fn(async ({ id }: { id: string }) => ({ apiProvider: "x", id }) as never),
		}

		expect(await loadProfilesWithActive(source, undefined, "personal")).toMatchObject({ activeProfileId: "b" })
		expect((await loadProfilesWithActive(source, undefined, "gone")).activeProfileId).toBeUndefined()
		expect((await loadProfilesWithActive(source)).activeProfileId).toBeUndefined()
	})

	describe("a profile read that never settles", () => {
		afterEach(() => vi.useRealTimers())

		it("is skipped after the deadline, so the profiles that were read still produce a response", async () => {
			vi.useFakeTimers()
			const source = {
				listConfig: vi.fn(async () => [{ id: "ok" }, { id: "stuck" }]),
				getProfile: vi.fn(({ id }: { id: string }) =>
					id === "stuck" ? new Promise<never>(() => {}) : Promise.resolve({ apiProvider: "x" } as never),
				),
			}

			const loading = loadProfiles(source)
			await vi.advanceTimersByTimeAsync(10_000)

			expect(await loading).toEqual([{ apiProvider: "x" }])
		})

		it("fails when every read is stuck, instead of waiting for ever", async () => {
			vi.useFakeTimers()
			const source = {
				listConfig: vi.fn(async () => [{ id: "a" }, { id: "b" }]),
				getProfile: vi.fn(() => new Promise<never>(() => {})),
			}

			const loading = loadProfiles(source)
			const settled = expect(loading).rejects.toThrow("None of the saved profiles could be read")
			await vi.advanceTimersByTimeAsync(10_000)

			await settled
		})

		it("fails when the list of saved profiles never arrives, instead of waiting for ever", async () => {
			vi.useFakeTimers()
			const source = { listConfig: vi.fn(() => new Promise<never>(() => {})), getProfile: vi.fn() }

			const loading = loadProfiles(source)
			const settled = expect(loading).rejects.toThrow("Reading the saved profiles timed out")
			await vi.advanceTimersByTimeAsync(10_000)

			await settled
			expect(source.getProfile).not.toHaveBeenCalled()
		})

		it("passes a failure of the list read on as it is, and clears its timer", async () => {
			vi.useFakeTimers()
			const source = {
				listConfig: vi.fn(async () => {
					throw new Error("storage unavailable")
				}),
				getProfile: vi.fn(),
			}

			await expect(loadProfiles(source)).rejects.toThrow("storage unavailable")
			expect(vi.getTimerCount()).toBe(0)
		})

		it("does not wait for the deadline when the reads finish", async () => {
			vi.useFakeTimers()
			const source = {
				listConfig: vi.fn(async () => [{ id: "a" }]),
				getProfile: vi.fn(async () => ({ apiProvider: "x" }) as never),
			}

			expect(await loadProfiles(source)).toEqual([{ apiProvider: "x" }])
			expect(vi.getTimerCount()).toBe(0)
		})
	})

	it("stops waiting for the profile list when the signal aborts, and reads no profile", async () => {
		const source = { listConfig: vi.fn(() => new Promise<never>(() => {})), getProfile: vi.fn() }
		const controller = new AbortController()
		const loading = loadProfiles(source, controller.signal)
		controller.abort()
		await expect(loading).rejects.toMatchObject({ name: "AbortError" })
		expect(source.getProfile).not.toHaveBeenCalled()
	})

	it("stops waiting for profile reads when the signal aborts", async () => {
		const source = {
			listConfig: vi.fn(async () => [{ id: "a" }]),
			getProfile: vi.fn(() => new Promise<never>(() => {})),
		}
		const controller = new AbortController()
		const loading = loadProfiles(source, controller.signal)
		await vi.waitFor(() => expect(source.getProfile).toHaveBeenCalled())
		controller.abort()
		await expect(loading).rejects.toMatchObject({ name: "AbortError" })
	})

	it("requests no profile once the signal has aborted while the list was loading", async () => {
		let release: (entries: { id: string }[]) => void = () => {}
		const source = {
			listConfig: vi.fn(() => new Promise<{ id: string }[]>((resolve) => (release = resolve))),
			getProfile: vi.fn(),
		}
		const controller = new AbortController()
		const loading = loadProfiles(source, controller.signal)
		controller.abort()
		release([{ id: "a" }])
		await expect(loading).rejects.toMatchObject({ name: "AbortError" })
		expect(source.getProfile).not.toHaveBeenCalled()
	})

	it("returns an empty list when there are no profiles", async () => {
		expect(await loadProfiles({ listConfig: async () => [], getProfile: vi.fn() })).toEqual([])
	})
})

describe("error handling never leaks credentials", () => {
	beforeEach(() => resetProviderQuotaCache())

	it("reports a generic message for network errors that embed the key", async () => {
		const [q] = await getProviderQuotas(
			[{ apiProvider: providerIdentifiers.deepseek, deepSeekApiKey: "sk-secret" } as never],
			{},
			vi.fn(async () => {
				throw new Error("connect ECONNREFUSED https://api.deepseek.com Authorization: Bearer sk-secret")
			}),
		)
		expect(q).toMatchObject({ ok: false, reason: "error", message: "Request failed" })
		expect(JSON.stringify(q)).not.toContain("sk-secret")
	})

	it("reports only the status for non-auth HTTP failures", async () => {
		const [q] = await getProviderQuotas(
			[{ apiProvider: providerIdentifiers.moonshot, moonshotApiKey: "sk" } as never],
			{},
			vi.fn(async () => new Response("<html>secret internal page</html>", { status: 502 })),
		)
		expect(q).toMatchObject({ ok: false, reason: "error", message: "HTTP 502" })
	})

	it("treats an empty payload as an error", async () => {
		const [q] = await getProviderQuotas(
			[{ apiProvider: providerIdentifiers.deepseek, deepSeekApiKey: "sk" } as never],
			{},
			vi.fn(async () => new Response(JSON.stringify({ balance_infos: [] }))),
		)
		expect(q).toMatchObject({ ok: false, reason: "error", message: "No usage data" })
	})

	it("surfaces Copilot failures with their reason", async () => {
		const copilotMod = await import("../copilotQuota")
		vi.mocked(copilotMod.getGitHubCopilotQuota).mockResolvedValueOnce({ ok: false, reason: "signedOut" })
		const [q] = await getProviderQuotas([{ apiProvider: providerIdentifiers.githubCopilot } as never], {
			force: true,
		})
		expect(q).toMatchObject({ ok: false, reason: "signedOut" })
	})

	it("shows Copilot unlimited plans without numbers", async () => {
		const copilotMod = await import("../copilotQuota")
		vi.mocked(copilotMod.getGitHubCopilotQuota).mockResolvedValueOnce({
			ok: true,
			quota: { plan: "enterprise", unlimited: true, fetchedAt: 1, resetAt: 2 },
		})
		const [q] = await getProviderQuotas([{ apiProvider: providerIdentifiers.githubCopilot } as never], {
			force: true,
		})
		expect(q).toMatchObject({ ok: true, windows: [{ id: "premium", valueLabel: "Unlimited", resetAt: 2 }] })
	})

	it("falls back to a percent label when counts are missing", async () => {
		const copilotMod = await import("../copilotQuota")
		vi.mocked(copilotMod.getGitHubCopilotQuota).mockResolvedValueOnce({
			ok: true,
			quota: { unlimited: false, usedPercent: 60, fetchedAt: 1 },
		})
		const [q] = await getProviderQuotas([{ apiProvider: providerIdentifiers.githubCopilot } as never], {
			force: true,
		})
		expect(q).toMatchObject({ ok: true, windows: [{ valueLabel: "60% used", usedPercent: 60 }] })
	})
})
