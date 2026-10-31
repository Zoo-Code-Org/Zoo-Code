import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("vscode", () => ({ version: "1.0.0", authentication: { getSession: vi.fn() } }))

import { parseCopilotQuota } from "../copilotQuota"

const NOW = 1_800_000_000_000

// Shape recorded from GET api.github.com/copilot_internal/user (business plan).
const businessPayload = {
	copilot_plan: "business",
	quota_reset_date: "2026-11-01",
	quota_reset_date_utc: "2026-11-01T00:00:00.000Z",
	quota_snapshots: {
		chat: { unlimited: true, entitlement: 0, remaining: 0 },
		completions: { unlimited: true, entitlement: 0, remaining: 0 },
		premium_interactions: {
			entitlement: 140000,
			remaining: 100610,
			quota_remaining: 100610.7,
			unlimited: false,
			percent_remaining: 71.8,
		},
	},
}

describe("parseCopilotQuota", () => {
	it("derives used credits from the precise quota_remaining, like GitHub's panel", () => {
		const q = parseCopilotQuota(businessPayload, NOW)!
		expect(q.plan).toBe("business")
		expect(q.unlimited).toBe(false)
		expect(q.entitlement).toBe(140000)
		expect(q.used).toBe(39389.3)
		expect(q.usedPercent).toBeCloseTo(28.135, 2)
		expect(q.resetAt).toBe(Date.parse("2026-11-01T00:00:00.000Z"))
		expect(q.fetchedAt).toBe(NOW)
	})

	it("falls back to the integer remaining twin", () => {
		const payload = structuredClone(businessPayload)
		delete (payload.quota_snapshots.premium_interactions as Record<string, unknown>).quota_remaining
		expect(parseCopilotQuota(payload, NOW)!.used).toBe(39390)
	})

	it("falls back to percent_remaining when counts are missing", () => {
		const q = parseCopilotQuota(
			{ quota_snapshots: { premium_interactions: { unlimited: false, percent_remaining: 40 } } },
			NOW,
		)!
		expect(q.used).toBeUndefined()
		expect(q.entitlement).toBeUndefined()
		expect(q.usedPercent).toBe(60)
	})

	it("leaves usage unset when neither counts nor percent_remaining are reported", () => {
		const q = parseCopilotQuota({ quota_snapshots: { premium_interactions: { unlimited: false } } }, NOW)!
		expect(q.used).toBeUndefined()
		expect(q.usedPercent).toBeUndefined()
	})

	it("reports unlimited plans without numbers", () => {
		const q = parseCopilotQuota(
			{ copilot_plan: "enterprise", quota_snapshots: { premium_interactions: { unlimited: true } } },
			NOW,
		)!
		expect(q).toMatchObject({ plan: "enterprise", unlimited: true })
		expect(q.usedPercent).toBeUndefined()
	})

	it("clamps over-consumption to 100%", () => {
		const q = parseCopilotQuota(
			{ quota_snapshots: { premium_interactions: { entitlement: 300, quota_remaining: -12 } } },
			NOW,
		)!
		expect(q.used).toBe(300)
		expect(q.usedPercent).toBe(100)
	})

	it("uses the date-only reset field when the UTC variant is absent", () => {
		const payload = { ...businessPayload, quota_reset_date_utc: undefined }
		expect(parseCopilotQuota(payload, NOW)!.resetAt).toBe(Date.parse("2026-11-01"))
	})

	it.each([null, undefined, "nope", [], {}, { quota_snapshots: {} }])("returns undefined for %j", (payload) => {
		expect(parseCopilotQuota(payload, NOW)).toBeUndefined()
	})
})

// --- getGitHubCopilotQuota (network + auth paths) ----------------------------------------------

import * as vscodeApi from "vscode"
import { getGitHubCopilotQuota, resetGitHubCopilotQuotaCache } from "../copilotQuota"

const getSession = vscodeApi.authentication.getSession as unknown as ReturnType<typeof vi.fn>

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

describe("getGitHubCopilotQuota", () => {
	beforeEach(() => {
		resetGitHubCopilotQuotaCache()
		getSession.mockReset()
		getSession.mockResolvedValue({ accessToken: "gho_token" })
	})

	it("returns the parsed quota using the existing VS Code GitHub session, silently", async () => {
		const fetchSpy = vi.fn(async () => json(businessPayload))
		const result = await getGitHubCopilotQuota({}, fetchSpy as never)

		expect(result).toMatchObject({ ok: true, quota: { plan: "business", entitlement: 140000 } })
		// Silent: must never raise a sign-in prompt from a background usage refresh.
		expect(getSession).toHaveBeenCalledWith("github", expect.any(Array), { silent: true })
		expect(fetchSpy).toHaveBeenCalledWith(
			"https://api.github.com/copilot_internal/user",
			expect.objectContaining({
				headers: expect.objectContaining({ Authorization: "token gho_token" }),
			}),
		)
	})

	it("falls back to the second scope set when the first has no session", async () => {
		getSession.mockResolvedValueOnce(undefined).mockResolvedValueOnce({ accessToken: "second" })
		const fetchSpy = vi.fn(async () => json(businessPayload))
		await getGitHubCopilotQuota({}, fetchSpy as never)
		expect(getSession).toHaveBeenCalledTimes(2)
		expect(fetchSpy).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({ headers: expect.objectContaining({ Authorization: "token second" }) }),
		)
	})

	it("reports signedOut without calling GitHub when there is no session", async () => {
		getSession.mockResolvedValue(undefined)
		const fetchSpy = vi.fn()
		expect(await getGitHubCopilotQuota({}, fetchSpy as never)).toEqual({ ok: false, reason: "signedOut" })
		expect(fetchSpy).not.toHaveBeenCalled()
	})

	it.each([
		[401, "signedOut"],
		[403, "noCopilot"],
		[404, "noCopilot"],
	] as const)("maps HTTP %s to %s", async (status, reason) => {
		const result = await getGitHubCopilotQuota({}, (async () => json({}, status)) as never)
		expect(result).toMatchObject({ ok: false, reason })
	})

	it("reports other HTTP failures as an error with the status", async () => {
		const result = await getGitHubCopilotQuota({}, (async () => json({}, 500)) as never)
		expect(result).toEqual({ ok: false, reason: "error", message: "GitHub API error 500" })
	})

	it.each([
		["an empty quota_snapshots", { quota_snapshots: {} }],
		["a renamed premium field", { copilot_plan: "pro", quota_snapshots: { premium_requests: {} } }],
		["no quota_snapshots", { copilot_plan: "pro" }],
	])(
		"reports an error, not noCopilot, when a successful payload has no premium snapshot (%s)",
		async (_name, body) => {
			const result = await getGitHubCopilotQuota({}, (async () => json(body)) as never)
			expect(result).toEqual({ ok: false, reason: "error", message: "GitHub returned no premium request quota" })
		},
	)

	it("turns network errors into a generic error result instead of throwing", async () => {
		const result = await getGitHubCopilotQuota({}, (async () => {
			throw new Error("offline")
		}) as never)
		// Arbitrary error text is never forwarded: it can embed URLs, headers or tokens.
		expect(result).toEqual({ ok: false, reason: "error", message: "Request failed" })
	})

	it("never leaks the access token through an error message", async () => {
		const result = await getGitHubCopilotQuota({}, (async () => {
			throw new Error("request to https://api.github.com failed: Authorization: token gho_token")
		}) as never)
		expect(JSON.stringify(result)).not.toContain("gho_token")
	})

	it("reports a timeout plainly", async () => {
		const result = await getGitHubCopilotQuota({}, (async () => {
			throw Object.assign(new Error("The operation timed out"), { name: "TimeoutError" })
		}) as never)
		expect(result).toEqual({ ok: false, reason: "error", message: "Request timed out" })
	})

	it("caches successful results and bypasses the cache when forced", async () => {
		const fetchSpy = vi.fn(async () => json(businessPayload))
		await getGitHubCopilotQuota({}, fetchSpy as never)
		await getGitHubCopilotQuota({}, fetchSpy as never)
		expect(fetchSpy).toHaveBeenCalledTimes(1)
		await getGitHubCopilotQuota({ force: true }, fetchSpy as never)
		expect(fetchSpy).toHaveBeenCalledTimes(2)
	})

	describe("the cache lifetime", () => {
		afterEach(() => vi.useRealTimers())

		it.each([
			[59_999, 1],
			[60_000, 2],
		])("serves a cached result %i ms after it was fetched with %i request(s) in total", async (age, requests) => {
			vi.useFakeTimers()
			vi.setSystemTime(1_000_000)
			const fetchSpy = vi.fn(async () => json(businessPayload))
			await getGitHubCopilotQuota({}, fetchSpy as never)

			vi.setSystemTime(1_000_000 + age)
			await getGitHubCopilotQuota({}, fetchSpy as never)

			expect(fetchSpy).toHaveBeenCalledTimes(requests)
		})
	})

	it("does not cache failures", async () => {
		const fail = vi.fn(async () => json({}, 500))
		await getGitHubCopilotQuota({}, fail as never)
		await getGitHubCopilotQuota({}, fail as never)
		expect(fail).toHaveBeenCalledTimes(2)
	})

	it.each([
		["an HTTP error", async () => json({}, 500), { ok: false, reason: "error" }],
		["a signed-out answer", async () => json({}, 401), { ok: false, reason: "signedOut" }],
		["a missing Copilot plan", async () => json({}, 403), { ok: false, reason: "noCopilot" }],
		[
			"a thrown error",
			async () => {
				throw new Error("network down")
			},
			{ ok: false, reason: "error" },
		],
	])("drops an older success when a forced refresh fails with %s", async (_label, failure, expected) => {
		const good = vi.fn(async () => json(businessPayload))
		await getGitHubCopilotQuota({}, good as never)

		const failed = await getGitHubCopilotQuota({ force: true }, failure as never)
		expect(failed).toMatchObject(expected)

		// The old success must not be served as if it were current: the next normal call fetches again.
		const retry = vi.fn(async () => json(businessPayload))
		await getGitHubCopilotQuota({}, retry as never)
		expect(retry).toHaveBeenCalledTimes(1)
	})

	describe("cancellation", () => {
		/** A fetch that never answers on its own and records the signal it was given. */
		const hangingFetch = () => {
			let seen: AbortSignal | undefined
			const fetchSpy = vi.fn(
				(_url: string, init?: RequestInit) =>
					new Promise<Response>((_resolve, reject) => {
						seen = init?.signal ?? undefined
						seen?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")))
					}),
			)
			return { fetchSpy, signal: () => seen }
		}

		it("stops the GitHub request when the only caller goes away", async () => {
			const { fetchSpy, signal } = hangingFetch()
			const controller = new AbortController()
			const result = getGitHubCopilotQuota({ signal: controller.signal }, fetchSpy as never)
			await vi.waitFor(() => expect(signal()).toBeDefined())
			expect(signal()!.aborted).toBe(false)

			controller.abort()
			await expect(result).rejects.toMatchObject({ name: "AbortError" })
			expect(signal()!.aborted).toBe(true)
		})

		it("keeps the shared request running until its last caller leaves", async () => {
			const { fetchSpy, signal } = hangingFetch()
			const leaving = new AbortController()
			const staying = new AbortController()

			const a = getGitHubCopilotQuota({ signal: staying.signal }, fetchSpy as never)
			const b = getGitHubCopilotQuota({ signal: leaving.signal }, fetchSpy as never)
			await vi.waitFor(() => expect(signal()).toBeDefined())
			expect(fetchSpy).toHaveBeenCalledTimes(1)

			leaving.abort()
			await expect(b).rejects.toMatchObject({ name: "AbortError" })
			expect(signal()!.aborted).toBe(false)

			staying.abort()
			await expect(a).rejects.toMatchObject({ name: "AbortError" })
			expect(signal()!.aborted).toBe(true)
		})

		it("rejects at once with a signal that is already aborted, and makes no request", async () => {
			const fetchSpy = vi.fn()
			const controller = new AbortController()
			controller.abort()
			await expect(getGitHubCopilotQuota({ signal: controller.signal }, fetchSpy as never)).rejects.toMatchObject(
				{
					name: "AbortError",
				},
			)
			expect(fetchSpy).not.toHaveBeenCalled()
		})

		it("does not cache a cancelled request, so the next call fetches again", async () => {
			const { fetchSpy } = hangingFetch()
			const controller = new AbortController()
			const cancelled = getGitHubCopilotQuota({ signal: controller.signal }, fetchSpy as never)
			await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalled())
			controller.abort()
			await expect(cancelled).rejects.toMatchObject({ name: "AbortError" })

			const good = vi.fn(async () => json(businessPayload))
			await expect(getGitHubCopilotQuota({}, good as never)).resolves.toMatchObject({ ok: true })
			expect(good).toHaveBeenCalledTimes(1)
		})

		it("starts a new request instead of joining one whose last caller already left", async () => {
			let release: (session: { accessToken: string }) => void = () => {}
			getSession.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)))
			const controller = new AbortController()
			const first = getGitHubCopilotQuota({ signal: controller.signal }, vi.fn() as never)
			await vi.waitFor(() => expect(getSession).toHaveBeenCalled())
			controller.abort()
			await expect(first).rejects.toMatchObject({ name: "AbortError" })

			// The cancelled request is still waiting on the token; a new caller must not be handed its result.
			const good = vi.fn(async () => json(businessPayload))
			const second = getGitHubCopilotQuota({}, good as never)
			release({ accessToken: "gho_token" })

			await expect(second).resolves.toMatchObject({ ok: true })
			expect(good).toHaveBeenCalledTimes(1)
		})

		it("stops waiting for a session request that never settles when the caller goes away", async () => {
			getSession.mockImplementationOnce(() => new Promise(() => {}))
			const fetchSpy = vi.fn()
			const controller = new AbortController()

			const result = getGitHubCopilotQuota({ signal: controller.signal }, fetchSpy as never)
			await vi.waitFor(() => expect(getSession).toHaveBeenCalled())
			controller.abort()

			await expect(result).rejects.toMatchObject({ name: "AbortError" })
			expect(fetchSpy).not.toHaveBeenCalled()
			// The stuck lookup is not left holding the slot: the next call starts over.
			const good = vi.fn(async () => json(businessPayload))
			await expect(getGitHubCopilotQuota({}, good as never)).resolves.toMatchObject({ ok: true })
		})

		it("does not start the GitHub request when it was cancelled while the token was being fetched", async () => {
			let release: (session: { accessToken: string }) => void = () => {}
			getSession.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)))
			const fetchSpy = vi.fn()
			const controller = new AbortController()

			const result = getGitHubCopilotQuota({ signal: controller.signal }, fetchSpy as never)
			await vi.waitFor(() => expect(getSession).toHaveBeenCalled())
			controller.abort()
			release({ accessToken: "gho_token" })

			await expect(result).rejects.toMatchObject({ name: "AbortError" })
			expect(fetchSpy).not.toHaveBeenCalled()
		})
	})

	it("shares one in-flight request between concurrent callers", async () => {
		const fetchSpy = vi.fn(async () => json(businessPayload))
		const [a, b] = await Promise.all([
			getGitHubCopilotQuota({}, fetchSpy as never),
			getGitHubCopilotQuota({}, fetchSpy as never),
		])
		expect(fetchSpy).toHaveBeenCalledTimes(1)
		expect(a).toEqual(b)
	})
})
