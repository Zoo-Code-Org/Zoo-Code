import {
	providerIdentifiers,
	type ProviderQuota,
	type ProviderQuotaWindow,
	type ProviderSettings,
	type ProviderSettingsWithId,
} from "@roo-code/types"

import { getGitHubCopilotQuota } from "./copilotQuota"
import {
	QuotaHttpError,
	asRecord,
	clampPercent,
	formatCredits,
	formatMoney,
	safeErrorMessage,
	toEpochMs,
	toNumber,
} from "./quotaUtils"

/**
 * Live limits/balances for every connected provider that exposes a usage API,
 * for the Usage tab's "Provider limits" section.
 *
 * Endpoints are each provider's own usage API. Credentials come from the
 * user's saved Zoo profiles and are sent only to that provider's own host.
 * Providers without a usage API are simply not listed.
 */

const REQUEST_TIMEOUT_MS = 15_000
const CACHE_TTL_MS = 60_000

// Parsers (pure; unit-tested) ----------------------------------------------------------------------

/** OpenRouter `GET /api/v1/key` → key limit, or monthly spend when unlimited. */
export function parseOpenRouterKey(payload: unknown): ProviderQuotaWindow[] | undefined {
	const data = asRecord(asRecord(payload)?.data)
	if (!data) return undefined

	const limit = toNumber(data.limit)
	const remaining = toNumber(data.limit_remaining)

	if (limit !== undefined && limit > 0 && remaining !== undefined) {
		const used = Math.max(0, limit - remaining)
		return [
			{
				id: "key_limit",
				valueLabel: `${formatMoney(used)} / ${formatMoney(limit)} used`,
				usedPercent: clampPercent((used / limit) * 100),
			},
		]
	}

	const monthly = toNumber(data.usage_monthly)
	if (monthly !== undefined) return [{ id: "spend", valueLabel: `${formatMoney(monthly)} spent this month` }]

	// OpenRouter documents `usage` as all-time credit use, so it must not be shown as this month's spend.
	const total = toNumber(data.usage)
	return total === undefined ? undefined : [{ id: "spend", valueLabel: `${formatMoney(total)} spent in total` }]
}

/** DeepSeek `GET /user/balance` → prepaid balance (prefers a positive USD balance). */
export function parseDeepSeekBalance(payload: unknown): ProviderQuotaWindow[] | undefined {
	const infos = asRecord(payload)?.balance_infos
	if (!Array.isArray(infos) || infos.length === 0) return undefined

	const rows = infos.map(asRecord).filter((r): r is Record<string, unknown> => !!r)
	const pick =
		rows.find((r) => r.currency === "USD" && (toNumber(r.total_balance) ?? 0) > 0) ??
		rows.find((r) => r.currency === "CNY" && (toNumber(r.total_balance) ?? 0) > 0) ??
		rows.find((r) => r.currency === "USD") ??
		rows[0]

	const balance = toNumber(pick?.total_balance)
	if (balance === undefined) return undefined
	return [{ id: "balance", valueLabel: `${formatMoney(balance, pick?.currency === "CNY" ? "¥" : "$")} left` }]
}

/** Moonshot `GET /v1/users/me/balance` → available balance. */
export function parseMoonshotBalance(payload: unknown): ProviderQuotaWindow[] | undefined {
	const balance = toNumber(asRecord(asRecord(payload)?.data)?.available_balance)
	return balance === undefined ? undefined : [{ id: "balance", valueLabel: `${formatMoney(balance)} left` }]
}

/** "5-hour", "Weekly", "3d", … for a rolling window of the given length. */
export function windowLabel(seconds: number | undefined, fallback: string): string {
	if (!seconds || seconds <= 0) return fallback
	if (seconds === 7 * 86400) return "Weekly"
	if (seconds % 86400 === 0) return `${seconds / 86400}-day`
	if (seconds % 3600 === 0) return `${seconds / 3600}-hour`
	return fallback
}

const FIXED_WINDOW_NAMES: Record<string, NonNullable<ProviderQuotaWindow["name"]>> = {
	Weekly: { key: "weekly" },
	Daily: { key: "daily" },
	Monthly: { key: "monthly" },
	Unlimited: { key: "unlimited" },
}

/** The structured name of a window whose label is only its name, so it can be translated. Anything else is left as is. */
function windowName(label: string): ProviderQuotaWindow["name"] {
	const fixed = FIXED_WINDOW_NAMES[label]
	if (fixed) return fixed
	const rolling = /^(\d+)-(hour|day)$/.exec(label)
	return rolling ? { key: rolling[2] === "hour" ? "hours" : "days", count: Number(rolling[1]) } : undefined
}

const withNames = (windows: ProviderQuotaWindow[]): ProviderQuotaWindow[] =>
	windows.map((w) => {
		const name = windowName(w.valueLabel)
		return name ? { ...w, name } : w
	})

/** Kimi Code `GET /coding/v1/usages` → 5-hour / weekly / monthly usage. */
export function parseKimiCodeUsage(payload: unknown): ProviderQuotaWindow[] | undefined {
	const root = asRecord(payload)
	if (!root) return undefined
	const windows: ProviderQuotaWindow[] = []

	const usages = asRecord(root.usages)
	if (usages) {
		// `used_ratio` is a 0-1 fraction, in the order Kimi's own CLI renders it.
		for (const [key, label] of [
			["limit_5h", "5-hour"],
			["limit_7d", "Weekly"],
			["limit_month_total", "Monthly"],
		] as const) {
			const entry = asRecord(usages[key])
			const ratio = toNumber(entry?.used_ratio)
			if (ratio === undefined) continue
			windows.push({
				id: key,
				valueLabel: label,
				usedPercent: clampPercent(ratio * 100),
				resetAt: toEpochMs(entry?.reset_time),
			})
		}
		return windows.length ? windows : undefined
	}

	// Pre-ratio payload: one counted weekly `usage` block.
	const usage = asRecord(root.usage)
	const limit = toNumber(usage?.limit)
	if (usage && limit && limit > 0) {
		const used = toNumber(usage.used)
		const remaining = toNumber(usage.remaining)
		const usedAmount = used ?? (remaining !== undefined ? limit - remaining : undefined)
		if (usedAmount !== undefined) {
			windows.push({
				id: "weekly",
				valueLabel: "Weekly",
				usedPercent: clampPercent((usedAmount / limit) * 100),
				resetAt: toEpochMs(usage.resetTime),
			})
		}
	}
	return windows.length ? windows : undefined
}

/**
 * z.ai / Zhipu `GET /api/monitor/usage/quota/limit`. Business failures arrive
 * as HTTP 200 with `{ code, msg, success: false }`, so the envelope is checked
 * first. TOKENS_LIMIT / CREDIT_LIMIT entries are the 5-hour and weekly windows.
 */
export function parseZaiQuota(payload: unknown): ProviderQuotaWindow[] | undefined {
	const root = asRecord(payload)
	if (!root) return undefined
	const code = root.code
	if (root.success === false || (code !== undefined && code !== null && code !== 200)) return undefined

	const limits = asRecord(root.data)?.limits
	if (!Array.isArray(limits)) return undefined

	const windows: ProviderQuotaWindow[] = []
	for (const raw of limits) {
		const limit = asRecord(raw)
		if (!limit || (limit.type !== "TOKENS_LIMIT" && limit.type !== "CREDIT_LIMIT")) continue

		// unit 3 = hours, unit 6 = weeks.
		const number = toNumber(limit.number)
		const unitSeconds = limit.unit === 3 ? 3600 : limit.unit === 6 ? 7 * 86400 : undefined
		const seconds = number && unitSeconds ? number * unitSeconds : undefined

		const total = toNumber(limit.usage)
		const consumed = toNumber(limit.currentValue)
		const percentage = toNumber(limit.percentage)
		const usedPercent =
			percentage !== undefined
				? clampPercent(percentage)
				: total && total > 0 && consumed !== undefined
					? clampPercent((consumed / total) * 100)
					: undefined

		windows.push({
			id: `limit_${windows.length}`,
			valueLabel:
				limit.type === "CREDIT_LIMIT" && total !== undefined && consumed !== undefined
					? `${windowLabel(seconds, "Credits")}: ${formatCredits(consumed)} / ${formatCredits(total)} credits`
					: windowLabel(seconds, "Tokens"),
			usedPercent,
			resetAt: toEpochMs(limit.nextResetTime),
		})
	}
	return windows.length ? windows : undefined
}

/**
 * MiniMax `GET /v1/token_plan/remains` (or the legacy coding-plan endpoint) →
 * 5-hour interval and, when the plan has one, weekly usage for the chat model.
 */
export function parseMiniMaxRemains(payload: unknown, isTokenPlan = true): ProviderQuotaWindow[] | undefined {
	const root = asRecord(payload)
	const base = asRecord(root?.base_resp)
	if (base && base.status_code !== 0) return undefined
	const remains = root?.model_remains
	if (!Array.isArray(remains) || remains.length === 0) return undefined

	const rows = remains.map(asRecord).filter((r): r is Record<string, unknown> => !!r)
	const name = (r: Record<string, unknown>) => (typeof r.model_name === "string" ? r.model_name : "")
	const model =
		rows.find(
			(r) =>
				/^minimax-m/i.test(name(r)) &&
				((toNumber(r.current_interval_total_count) ?? 0) > 0 ||
					typeof r.current_interval_remaining_percent === "number"),
		) ??
		rows.find((r) => ["general", "chat", "text"].includes(name(r).toLowerCase())) ??
		rows.find((r) => typeof r.current_interval_remaining_percent === "number") ??
		rows[0]
	if (!model) return undefined

	const usedPercentOf = (prefix: "interval" | "weekly"): number | undefined => {
		const remainingPercent = toNumber(model[`current_${prefix}_remaining_percent`])
		if (remainingPercent !== undefined) return clampPercent(100 - clampPercent(remainingPercent))
		const total = toNumber(model[`current_${prefix}_total_count`])
		const raw = toNumber(model[`current_${prefix}_usage_count`])
		if (!total || total <= 0 || raw === undefined) return undefined
		// Token-plan counters report what is left; coding-plan counters report what is used.
		const used = isTokenPlan ? Math.max(0, total - raw) : raw
		return clampPercent((used / total) * 100)
	}

	const windows: ProviderQuotaWindow[] = []

	// A window with neither a figure nor a reset time would show a label with no value.
	const intervalPercent = usedPercentOf("interval")
	const intervalReset = toEpochMs(model.end_time)
	if (intervalPercent !== undefined || intervalReset !== undefined) {
		windows.push({ id: "5h", valueLabel: "5-hour", usedPercent: intervalPercent, resetAt: intervalReset })
	}

	// Status 3 = the window does not apply to this plan tier.
	const weeklyApplies = toNumber(model.current_weekly_status) !== 3
	const weeklyPercent = usedPercentOf("weekly")
	if (weeklyApplies && weeklyPercent !== undefined) {
		windows.push({
			id: "weekly",
			valueLabel: "Weekly",
			usedPercent: weeklyPercent,
			resetAt: toEpochMs(model.weekly_end_time),
		})
	}
	return windows.length ? windows : undefined
}

/** NanoGPT `GET /api/subscription/v1/usage` → daily / weekly / monthly allowance. */
export function parseNanoGptUsage(payload: unknown): ProviderQuotaWindow[] | undefined {
	const root = asRecord(payload)
	if (!root) return undefined

	const state = typeof root.state === "string" ? root.state : "active"
	const limits = asRecord(root.limits)
	const dailyQuota = root.dailyInputTokens !== undefined ? root.dailyInputTokens : root.daily
	const monthly = asRecord(root.monthly)

	const entries: { id: string; label: string; quota: unknown; limit: unknown; resetAt: unknown }[] = [
		{
			id: "daily",
			label: "Daily",
			quota: dailyQuota,
			limit:
				root.dailyInputTokens !== undefined
					? limits?.dailyInputTokens
					: (asRecord(dailyQuota)?.limit ?? asRecord(asRecord(dailyQuota)?.limits)?.daily),
			resetAt: asRecord(dailyQuota)?.resetAt,
		},
		{
			id: "weekly",
			label: "Weekly",
			quota: root.weeklyInputTokens,
			limit: limits?.weeklyInputTokens,
			resetAt: asRecord(root.weeklyInputTokens)?.resetAt,
		},
		{
			id: "monthly",
			label: "Monthly",
			quota: monthly,
			limit: monthly?.limit ?? asRecord(monthly?.limits)?.monthly,
			resetAt: monthly?.resetAt ?? asRecord(root.period)?.currentPeriodEnd,
		},
	]

	const windows: ProviderQuotaWindow[] = []
	for (const { id, label, quota, limit, resetAt } of entries) {
		const q = asRecord(quota)
		if (!q) continue
		let usedPercent: number | undefined
		if (!q.degraded) {
			const fraction = toNumber(q.percentUsed)
			const used = toNumber(q.used)
			const cap = toNumber(limit)
			if (fraction !== undefined) usedPercent = clampPercent(fraction * 100)
			else if (used !== undefined && cap !== undefined && cap > 0) usedPercent = clampPercent((used / cap) * 100)
		}
		windows.push({
			id,
			valueLabel: state !== "active" ? `${label} (${state})` : label,
			usedPercent,
			resetAt: toEpochMs(resetAt),
		})
	}
	return windows.length ? windows : undefined
}

/** OpenCode Go `GET /zen/go/v1/usage` (API key) → rolling 5-hour, weekly, monthly percent used. */
export function parseOpenCodeGoUsage(payload: unknown): ProviderQuotaWindow[] | undefined {
	const usage = asRecord(asRecord(payload)?.usage)
	if (!usage) return undefined

	const windows: ProviderQuotaWindow[] = []
	for (const [id, field, label] of [
		["5h", "rolling", "5-hour"],
		["weekly", "weekly", "Weekly"],
		["monthly", "monthly", "Monthly"],
	] as const) {
		const entry = asRecord(usage[field])
		const percent = toNumber(entry?.percent)
		const resetAt = toEpochMs(entry?.resetsAt)
		if (percent === undefined || resetAt === undefined) continue
		windows.push({ id, valueLabel: label, usedPercent: clampPercent(percent), resetAt })
	}
	return windows.length ? windows : undefined
}

// Fetchers ----------------------------------------------------------------------------------------

type Fetch = typeof fetch

async function getJson(fetchImpl: Fetch, url: string, apiKey: string, signal: AbortSignal): Promise<unknown> {
	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
	const response = await fetchImpl(url, {
		method: "GET",
		headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
		signal: AbortSignal.any([signal, timeout]),
	})
	if (response.status === 401 || response.status === 403) throw new AuthError()
	if (!response.ok) throw new QuotaHttpError(response.status)
	return response.json()
}

class AuthError extends Error {
	constructor() {
		super("Invalid or expired API key")
	}
}

interface KeyedProvider {
	providerId: string
	/**
	 * Returns the API key and the usage URLs to try, in order. `urls` is
	 * undefined when the profile targets a host we must not send the key to
	 * (a custom gateway); the provider is then reported as unsupported.
	 */
	credentials: (s: ProviderSettings) => { apiKey?: string; urls?: string[] }
	parse: (payload: unknown, urlIndex: number) => ProviderQuotaWindow[] | undefined
}

const sameOrigin = (a: string, b: string) => {
	try {
		return new URL(a).origin === new URL(b).origin
	} catch {
		return false
	}
}

/** The provider's own default host, unless the profile points at a different one. */
const ownHost = (defaultBase: string, path: string, baseUrl?: string): string[] | undefined =>
	baseUrl && !sameOrigin(baseUrl, defaultBase) ? undefined : [defaultBase + path]

/** z.ai (international) and Zhipu (China) host the same monitor API on different origins. */
const ZAI_ORIGINS: Record<string, string> = {
	international_coding: "https://api.z.ai",
	international_api: "https://api.z.ai",
	china_coding: "https://open.bigmodel.cn",
	china_api: "https://open.bigmodel.cn",
}

const KEYED_PROVIDERS: KeyedProvider[] = [
	{
		providerId: providerIdentifiers.openrouter,
		credentials: (s) => ({
			apiKey: s.openRouterApiKey,
			urls: ownHost("https://openrouter.ai/api/v1", "/key", s.openRouterBaseUrl),
		}),
		parse: parseOpenRouterKey,
	},
	{
		providerId: providerIdentifiers.deepseek,
		credentials: (s) => ({
			apiKey: s.deepSeekApiKey,
			urls: ownHost("https://api.deepseek.com", "/user/balance", s.deepSeekBaseUrl),
		}),
		parse: parseDeepSeekBalance,
	},
	{
		providerId: providerIdentifiers.moonshot,
		credentials: (s) => ({
			apiKey: s.moonshotApiKey,
			urls: ownHost("https://api.moonshot.ai/v1", "/users/me/balance", s.moonshotBaseUrl),
		}),
		parse: parseMoonshotBalance,
	},
	{
		// Only API-key profiles are queried; OAuth sign-ins have no key to send.
		providerId: providerIdentifiers.kimiCode,
		credentials: (s) => ({
			// An OAuth sign-in has no API key to send, even if an old key is still in the profile.
			apiKey: s.kimiCodeAuthMethod === "oauth" ? undefined : s.kimiCodeApiKey,
			urls: ["https://api.kimi.com/coding/v1/usages"],
		}),
		parse: parseKimiCodeUsage,
	},
	{
		providerId: providerIdentifiers.zai,
		credentials: (s) => ({
			apiKey: s.zaiApiKey,
			urls: [`${ZAI_ORIGINS[s.zaiApiLine ?? "international_coding"]}/api/monitor/usage/quota/limit`],
		}),
		parse: parseZaiQuota,
	},
	{
		providerId: providerIdentifiers.minimax,
		credentials: (s) => {
			const base = s.minimaxBaseUrl || "https://api.minimax.io/anthropic"
			if (sameOrigin(base, "https://api.minimax.io")) {
				return {
					apiKey: s.minimaxApiKey,
					urls: [
						"https://api.minimax.io/v1/token_plan/remains",
						"https://api.minimax.io/v1/api/openplatform/coding_plan/remains",
					],
				}
			}
			if (sameOrigin(base, "https://api.minimaxi.com")) {
				return {
					apiKey: s.minimaxApiKey,
					urls: [
						"https://api.minimaxi.com/v1/token_plan/remains",
						"https://www.minimaxi.com/v1/api/openplatform/coding_plan/remains",
					],
				}
			}
			return { apiKey: s.minimaxApiKey }
		},
		// The first URL is the token plan, whose counters report what is left.
		parse: (payload, urlIndex) => parseMiniMaxRemains(payload, urlIndex === 0),
	},
	{
		providerId: providerIdentifiers.nanogpt,
		credentials: (s) => ({
			apiKey: s.nanoGptApiKey,
			urls: ["https://nano-gpt.com/api/subscription/v1/usage"],
		}),
		parse: parseNanoGptUsage,
	},
	{
		providerId: providerIdentifiers.opencodeGo,
		credentials: (s) => ({
			apiKey: s.opencodeGoApiKey,
			urls: ["https://opencode.ai/zen/go/v1/usage"],
		}),
		parse: parseOpenCodeGoUsage,
	},
]

type KeyedCredentials = ReturnType<KeyedProvider["credentials"]>

/**
 * The credentials to query with: a profile whose host is safe to query wins over
 * one pointed at a custom gateway, which is only a fallback (reported as
 * unsupported when nothing better exists).
 */
function pickCredentials(
	provider: KeyedProvider,
	profiles: ProviderSettings[],
	activeProfileId?: string,
): KeyedCredentials | undefined {
	// The active profile of this provider is the account the requests use: take its credentials as they are, so a
	// keyless one is reported as no key and a custom gateway as unsupported, not replaced by a sibling profile.
	const active = activeProfileId
		? (profiles as ProviderSettingsWithId[]).find(
				(p) => p.id === activeProfileId && p.apiProvider === provider.providerId,
			)
		: undefined
	if (active) return provider.credentials(active)

	const withKey = profiles
		.filter((p) => p.apiProvider === provider.providerId)
		.map(provider.credentials)
		.filter((c) => !!c.apiKey)
	return withKey.find((c) => c.urls?.length) ?? withKey[0]
}

/** Resolves without any network call when there is nothing to query. */
function unqueryable(provider: KeyedProvider, creds: KeyedCredentials | undefined): ProviderQuota | undefined {
	const base = { providerId: provider.providerId, ok: false, fetchedAt: Date.now() } as const
	if (!creds?.apiKey) return { ...base, reason: "noKey" }
	// SAFETY: never send a key to a host other than the provider's own API. A
	// profile pointed at a custom gateway is reported as unsupported instead.
	if (!creds.urls?.length) return { ...base, reason: "unsupported" }
	return undefined
}

async function fetchKeyed(
	provider: KeyedProvider,
	apiKey: string,
	urls: string[],
	fetchImpl: Fetch,
	signal: AbortSignal,
): Promise<ProviderQuota> {
	const now = Date.now()

	try {
		// Try each URL in order; a failing fallback only matters if no URL yields data.
		let windows: ProviderQuotaWindow[] | undefined
		let lastError: unknown
		for (const [index, url] of urls.entries()) {
			try {
				windows = provider.parse(await getJson(fetchImpl, url, apiKey, signal), index)
				if (windows?.length) break
			} catch (error) {
				if (error instanceof AuthError) throw error
				lastError = error
			}
		}
		if (!windows?.length && lastError) throw lastError
		return windows?.length
			? { providerId: provider.providerId, ok: true, windows: withNames(windows), fetchedAt: now }
			: { providerId: provider.providerId, ok: false, reason: "error", message: "No usage data", fetchedAt: now }
	} catch (error) {
		return {
			providerId: provider.providerId,
			ok: false,
			reason: error instanceof AuthError ? "noKey" : "error",
			message: error instanceof AuthError ? undefined : safeErrorMessage(error),
			fetchedAt: now,
		}
	}
}

async function fetchCopilot(force: boolean, signal?: AbortSignal): Promise<ProviderQuota> {
	const result = await getGitHubCopilotQuota({ force, signal })
	const providerId = providerIdentifiers.githubCopilot
	if (!result.ok)
		return { providerId, ok: false, reason: result.reason, message: result.message, fetchedAt: Date.now() }

	const q = result.quota
	const window: ProviderQuotaWindow = q.unlimited
		? { id: "premium", valueLabel: "Unlimited", resetAt: q.resetAt }
		: {
				id: "premium",
				valueLabel:
					q.used !== undefined && q.entitlement !== undefined
						? `${formatCredits(q.used)} / ${formatCredits(q.entitlement)} used`
						: q.usedPercent !== undefined
							? `${Math.round(q.usedPercent)}% used`
							: // Neither counts nor a percentage were reported: that is unknown, not a measured zero.
								"Usage not reported",
				usedPercent: q.usedPercent,
				resetAt: q.resetAt,
			}
	return { providerId, ok: true, plan: q.plan, windows: withNames([window]), fetchedAt: q.fetchedAt }
}

// Entry point -------------------------------------------------------------------------------------

/** The slice of `ProviderSettingsManager` this service needs (keeps it testable without the manager). */
export interface ProfileSource {
	listConfig(): Promise<{ id: string; name?: string }[]>
	getProfile(params: { id: string }): Promise<ProviderSettings>
}

/** How long one profile read may take. A read that never settles is skipped, so the others still produce a response. */
const PROFILE_READ_TIMEOUT_MS = 10_000

/** Rejects with `message` if `work` has not settled within `ms`. */
function withDeadline<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(message)), ms)
		work.then(
			(value) => {
				clearTimeout(timer)
				resolve(value)
			},
			(error: unknown) => {
				clearTimeout(timer)
				reject(error)
			},
		)
	})
}

function readProfile(source: ProfileSource, id: string): Promise<ProviderSettings | undefined> {
	return new Promise((resolve) => {
		const timer = setTimeout(() => resolve(undefined), PROFILE_READ_TIMEOUT_MS)
		source.getProfile({ id }).then(
			(profile) => {
				clearTimeout(timer)
				resolve(profile)
			},
			() => {
				clearTimeout(timer)
				resolve(undefined)
			},
		)
	})
}

/**
 * Loads full profiles (including API keys) host-side. A profile that fails to load, or takes too long, is skipped
 * rather than failing the whole refresh, but if none of the saved profiles can be read that is a failure, not "no
 * connected providers". The active profile (`activeName`) comes first, and its id is returned so that its own
 * credentials are the ones queried for its provider. Keys never leave the extension host: only formatted quota rows
 * are posted to the webview.
 */
export async function loadProfilesWithActive(
	source: ProfileSource,
	signal?: AbortSignal,
	activeName?: string,
): Promise<{ profiles: ProviderSettings[]; activeProfileId?: string }> {
	// Stops waiting as soon as `signal` aborts. The reads themselves cannot be cancelled, but the profile reads
	// are not started once the list wait has been abandoned.
	const listed = await until(
		withDeadline(source.listConfig(), PROFILE_READ_TIMEOUT_MS, "Reading the saved profiles timed out"),
		signal,
		() => {},
	)
	const entries = activeName
		? [
				...listed.filter((entry) => entry.name === activeName),
				...listed.filter((entry) => entry.name !== activeName),
			]
		: listed
	const profiles = await until(Promise.all(entries.map((entry) => readProfile(source, entry.id))), signal, () => {})
	const loaded = profiles.filter((p): p is ProviderSettings => !!p)
	if (entries.length > 0 && loaded.length === 0) throw new Error("None of the saved profiles could be read")

	const activeEntry = activeName ? listed.find((entry) => entry.name === activeName) : undefined
	return { profiles: loaded, activeProfileId: activeEntry?.id }
}

// Successful results only, per provider and URL set. A missing key, a sign-out or a
// transient error is never pinned, so fixing it shows up on the next open instead of
// after the TTL. An entry is reused only for the exact key it was fetched with, so
// switching keys refetches. The key is compared, never hashed or used in a map key.
const cache = new Map<string, { at: number; apiKey: string; result: ProviderQuota }>()
interface Inflight {
	apiKey: string
	request: Promise<ProviderQuota>
	/** Callers still waiting on this request. The shared fetch is aborted only when the last one leaves. */
	waiters: number
	controller: AbortController
}
const inflight = new Map<string, Inflight>()

/** Identifies a provider and the URLs it is queried at (the credential itself is not part of it). */
function cacheKey(provider: KeyedProvider, urls: string[]): string {
	return `${provider.providerId}|${urls.join(",")}`
}

/** Rejects as soon as `signal` aborts, without cancelling `work` (which other callers may still be using). */
function until<T>(work: Promise<T>, signal: AbortSignal | undefined, onAbort: () => void): Promise<T> {
	if (!signal) return work
	return new Promise<T>((resolve, reject) => {
		const abort = () => {
			onAbort()
			reject(new DOMException("Aborted", "AbortError"))
		}
		if (signal.aborted) return abort()
		signal.addEventListener("abort", abort, { once: true })
		work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort))
	})
}

function quotaForKeyedProvider(
	provider: KeyedProvider,
	profiles: ProviderSettings[],
	force: boolean,
	fetchImpl: Fetch,
	signal?: AbortSignal,
	activeProfileId?: string,
): Promise<ProviderQuota> {
	const creds = pickCredentials(provider, profiles, activeProfileId)
	const skipped = unqueryable(provider, creds)
	if (skipped) return Promise.resolve(skipped)

	// `unqueryable` returned early unless there is a key and at least one URL.
	const apiKey = creds?.apiKey as string
	const urls = creds?.urls as string[]
	const key = cacheKey(provider, urls)
	const hit = cache.get(key)
	if (!force && hit && hit.apiKey === apiKey && Date.now() - hit.at < CACHE_TTL_MS) return Promise.resolve(hit.result)

	// Concurrent callers (e.g. a refresh while the first load is still running) share one request.
	let entry = inflight.get(key)
	if (!entry || entry.apiKey !== apiKey) {
		const controller = new AbortController()
		const request: Promise<ProviderQuota> = fetchKeyed(provider, apiKey, urls, fetchImpl, controller.signal)
			.then((result) => {
				// A cancelled request says nothing about the account, so it leaves the cache as it is.
				if (!controller.signal.aborted) {
					if (result.ok) {
						cache.set(key, { at: Date.now(), apiKey, result })
					} else if (cache.get(key)?.apiKey === apiKey) {
						// A failed refresh must not leave an older success of this key to be served as if it were
						// current. A success cached for another key is not this request's to remove.
						cache.delete(key)
					}
				}
				return result
			})
			.finally(() => {
				if (inflight.get(key)?.request === request) inflight.delete(key)
			})
		entry = { apiKey, request, waiters: 0, controller }
		inflight.set(key, entry)
	}

	const shared = entry
	shared.waiters++
	let left = false
	const leave = () => {
		if (left) return
		left = true
		// Last one out cancels the network work; earlier leavers just stop waiting.
		if (--shared.waiters === 0) {
			shared.controller.abort()
			// Do not let a later caller join a request that is already cancelled.
			if (inflight.get(key) === shared) inflight.delete(key)
		}
	}
	return until(shared.request, signal, leave).finally(leave)
}

/**
 * Quotas for every *connected* provider with a usage API. `profiles` are the
 * user's saved provider settings; only providers present there are queried.
 */
export async function getProviderQuotas(
	profiles: ProviderSettings[],
	{
		force = false,
		signal,
		activeProfileId,
	}: { force?: boolean; signal?: AbortSignal; activeProfileId?: string } = {},
	fetchImpl: Fetch = fetch,
): Promise<ProviderQuota[]> {
	const connected = new Set(profiles.map((p) => p.apiProvider).filter(Boolean) as string[])

	const tasks: Promise<ProviderQuota>[] = []
	if (connected.has(providerIdentifiers.githubCopilot)) tasks.push(fetchCopilot(force, signal))
	for (const provider of KEYED_PROVIDERS) {
		if (connected.has(provider.providerId)) {
			tasks.push(quotaForKeyedProvider(provider, profiles, force, fetchImpl, signal, activeProfileId))
		}
	}

	return Promise.all(tasks)
}

/** @internal test hook */
export function resetProviderQuotaCache() {
	cache.clear()
	inflight.clear()
}
