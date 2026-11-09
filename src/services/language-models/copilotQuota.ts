import * as vscode from "vscode"

import { githubCopilotLanguageModel, type GitHubCopilotQuota, type GitHubCopilotQuotaResult } from "@roo-code/types"

import { asRecord, clampPercent, roundToTenth, safeErrorMessage, toNumber } from "./quotaUtils"

/**
 * GitHub Copilot premium-request allowance for the Usage tab.
 *
 * Source: `GET https://api.github.com/copilot_internal/user`, the endpoint
 * Copilot Chat's own usage panel reads. It returns
 * `quota_snapshots.premium_interactions` plus `quota_reset_date`.
 *
 * Auth reuses the GitHub session VS Code already holds for Copilot (silent:
 * never prompts). The token is only ever sent to api.github.com.
 */

const COPILOT_USER_URL = "https://api.github.com/copilot_internal/user"
const REQUEST_TIMEOUT_MS = 15_000
/** Avoid hammering the endpoint when the Usage tab is reopened repeatedly. */
const CACHE_TTL_MS = 60_000

/**
 * Parses the endpoint payload. Pure, so it is unit-tested against recorded
 * shapes. Returns undefined when the payload has no premium snapshot at all.
 *
 * Semantics mirror Copilot Chat (CopilotUserQuotaInfo):
 * - `quota_remaining` is the precise (fractional) twin of `remaining`; prefer it.
 * - used = entitlement - remaining, so the figure matches GitHub's own panel.
 * - `percent_remaining` is a server-computed fallback when counts are missing.
 */
export function parseCopilotQuota(payload: unknown, now = Date.now()): GitHubCopilotQuota | undefined {
	const root = asRecord(payload)
	const snapshot = asRecord(asRecord(root?.quota_snapshots)?.premium_interactions)
	if (!root || !snapshot) return undefined

	const plan = typeof root.copilot_plan === "string" ? root.copilot_plan : undefined
	const resetRaw = root.quota_reset_date_utc ?? root.quota_reset_date
	const resetAt =
		typeof resetRaw === "string" && !Number.isNaN(Date.parse(resetRaw)) ? Date.parse(resetRaw) : undefined

	if (snapshot.unlimited === true) {
		return { plan, unlimited: true, resetAt, fetchedAt: now }
	}

	const entitlement = toNumber(snapshot.entitlement)
	const remaining = toNumber(snapshot.quota_remaining) ?? toNumber(snapshot.remaining)

	let used: number | undefined
	let usedPercent: number | undefined

	if (entitlement !== undefined && entitlement > 0 && remaining !== undefined) {
		used = roundToTenth(Math.min(entitlement, Math.max(0, entitlement - remaining)))
		usedPercent = clampPercent((used / entitlement) * 100)
	} else {
		const percentRemaining = toNumber(snapshot.percent_remaining)
		if (percentRemaining !== undefined) usedPercent = clampPercent(100 - percentRemaining)
	}

	return {
		plan,
		unlimited: false,
		entitlement: entitlement !== undefined && entitlement > 0 ? entitlement : undefined,
		used,
		usedPercent,
		resetAt,
		fetchedAt: now,
	}
}

/** Rejects as soon as `signal` aborts. The pending work cannot be cancelled, but nobody waits for it any more. */
function raceAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
	// The caller has checked that `signal` is not aborted yet (an abort event does not fire again for a signal that
	// already is), and nothing can abort it between that check and this call.
	return new Promise<T>((resolve, reject) => {
		const abort = () => reject(signal.reason)
		signal.addEventListener("abort", abort, { once: true })
		work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort))
	})
}

/** Each lookup is bounded by `signal`, so a session request that never settles cannot hold the quota request open. */
async function getGitHubToken(signal: AbortSignal): Promise<string | undefined> {
	const { authProviderId, authScopeSets } = githubCopilotLanguageModel
	for (const scopes of authScopeSets) {
		// A lookup that has been cancelled is not started: the session request is made before it is raced.
		signal.throwIfAborted()
		const session = await raceAbort(
			Promise.resolve(vscode.authentication.getSession(authProviderId, scopes, { silent: true })),
			signal,
		)
		if (session) return session.accessToken
	}
	return undefined
}

/** The token that the cached quota was fetched with: a quota is only served to the session that it belongs to. */
let cache: { at: number; result: GitHubCopilotQuotaResult; token: string } | undefined
let inFlight:
	| {
			request: Promise<GitHubCopilotQuotaResult>
			/** Callers still waiting. The shared fetch is aborted only when the last one leaves. */
			waiters: number
			controller: AbortController
	  }
	| undefined

/** Rejects when `signal` aborts, without cancelling `work` (other callers may still be using it). */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal | undefined, onAbort: () => void): Promise<T> {
	if (!signal) return work
	return new Promise<T>((resolve, reject) => {
		const abort = () => {
			onAbort()
			reject(new DOMException("Aborted", "AbortError"))
		}
		signal.addEventListener("abort", abort, { once: true })
		work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort))
	})
}

/**
 * Fetches the quota. Concurrent callers share one request; successful results
 * are cached briefly unless `force` is set (the Refresh button). `signal` lets a caller stop waiting; the
 * network work itself stops when the last waiting caller has gone.
 */
export function getGitHubCopilotQuota(
	{ force = false, signal }: { force?: boolean; signal?: AbortSignal } = {},
	fetchImpl: typeof fetch = fetch,
): Promise<GitHubCopilotQuotaResult> {
	if (signal?.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"))
	const cached = cache
	if (!force && cached && Date.now() - cached.at < CACHE_TTL_MS) {
		// The cache does not know which account it was for: the session is looked up (silently, and locally) first, and
		// the cached quota is served only to the session that it was fetched with. After a sign-out or an account switch
		// it is dropped, and the quota is fetched for the session that is there now.
		const lookup = new AbortController()
		const sameSession = untilAborted(
			getGitHubToken(AbortSignal.any([lookup.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])),
			signal,
			() => lookup.abort(),
		).then(
			(token) => token === cached.token,
			(error: unknown) => {
				// A caller that left is not answered; a lookup that failed leaves the session unknown, so it is fetched again.
				if (signal?.aborted) throw error
				return false
			},
		)
		return sameSession.then((same) => {
			if (same) return cached.result
			cache = undefined
			return getGitHubCopilotQuota({ force: true, signal }, fetchImpl)
		})
	}

	if (!inFlight) {
		const controller = new AbortController()
		// The token of the session that this request is for (set as soon as it is known, and always before a success).
		let sessionToken = ""
		const fetchQuota = async (): Promise<GitHubCopilotQuotaResult> => {
			try {
				const token = await getGitHubToken(
					AbortSignal.any([controller.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
				)
				if (!token) return { ok: false, reason: "signedOut" }
				sessionToken = token

				const response = await fetchImpl(COPILOT_USER_URL, {
					method: "GET",
					headers: {
						Authorization: `token ${token}`,
						Accept: "application/json",
						"Editor-Version": `vscode/${vscode.version}`,
						"X-Github-Api-Version": "2025-04-01",
					},
					signal: AbortSignal.any([controller.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
				})

				if (response.status === 401) return { ok: false, reason: "signedOut" }
				if (response.status === 403 || response.status === 404) return { ok: false, reason: "noCopilot" }
				if (!response.ok) return { ok: false, reason: "error", message: `GitHub API error ${response.status}` }

				const quota = parseCopilotQuota(await response.json())
				// A 403 or 404 is how GitHub says there is no Copilot. A success without a premium snapshot is more likely
				// a changed payload on this undocumented endpoint, and must not be shown as "no Copilot".
				return quota
					? { ok: true, quota }
					: { ok: false, reason: "error", message: "GitHub returned no premium request quota" }
			} catch (error) {
				return { ok: false, reason: "error", message: safeErrorMessage(error) }
			}
		}

		const request: Promise<GitHubCopilotQuotaResult> = fetchQuota()
			.then((result) => {
				// One place for every outcome: a success is cached, and anything else (signed out, no Copilot, an
				// HTTP error, a thrown or cancelled request) drops an older success so it is not served as current.
				// A cancelled request says nothing about the account, so it leaves the cache alone.
				if (!controller.signal.aborted) {
					cache = result.ok ? { at: Date.now(), result, token: sessionToken } : undefined
				}
				return result
			})
			.finally(() => {
				if (inFlight?.request === request) inFlight = undefined
			})
		inFlight = { request, waiters: 0, controller }
	}

	const shared = inFlight
	shared.waiters++
	let left = false
	const leave = () => {
		if (left) return
		left = true
		// Last one out cancels the network work; earlier leavers just stop waiting.
		if (--shared.waiters === 0) {
			shared.controller.abort()
			// Do not let a later caller join a request that is already cancelled (it would only get "cancelled").
			if (inFlight === shared) inFlight = undefined
		}
	}
	return untilAborted(shared.request, signal, leave).finally(leave)
}

/** @internal test hook */
export function resetGitHubCopilotQuotaCache() {
	cache = undefined
	inFlight = undefined
}
