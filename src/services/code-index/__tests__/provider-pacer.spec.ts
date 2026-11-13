import { createHash } from "node:crypto"
import { ProviderPacer, ProviderPacerRegistry, makeRateLimitScope } from "../provider-pacer"
import { codeIndexLog } from "../code-index-log"

vi.mock("../code-index-log", () => ({ codeIndexLog: { info: vi.fn() } }))

function deferred<T>() {
	let resolve!: (value: T) => void
	let reject!: (error: unknown) => void
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise
		reject = rejectPromise
	})
	return { promise, resolve, reject }
}

const limited = (retryAfterMs?: number) => ({ status: 429, retryAfterMs })
const flush = () => vi.advanceTimersByTimeAsync(0)

beforeEach(() => {
	vi.mocked(codeIndexLog.info).mockClear()
	vi.useFakeTimers()
	vi.setSystemTime(0)
	vi.spyOn(Math, "random").mockReturnValue(0)
})

afterEach(() => {
	vi.clearAllTimers()
	vi.useRealTimers()
	vi.restoreAllMocks()
})

describe("ProviderPacer", () => {
	it("T35 shares a 30s pause, keeps in-flight results, and isolates allowance keys and stores", async () => {
		const registry = new ProviderPacerRegistry()
		const scope = makeRateLimitScope("openai", "https://example.test", "first")
		const pacer = registry.get(scope)
		expect(registry.get(scope)).toBe(pacer)
		const inFlight = deferred<string>()
		const kept = pacer.run("kept.ts", undefined, () => inFlight.promise)
		const first = vi.fn().mockRejectedValueOnce(limited(30_000)).mockResolvedValue("first")
		const firstResult = pacer.run("a.ts", undefined, first)
		await flush()
		const second = vi.fn().mockResolvedValue("second")
		const secondResult = pacer.run("b.ts", undefined, second)
		await flush()
		inFlight.resolve("kept")
		expect(await kept).toBe("kept")
		expect(
			await registry
				.get(makeRateLimitScope("qdrant", "https://store.test"))
				.run(undefined, undefined, async () => "store"),
		).toBe("store")
		expect(
			await registry
				.get(makeRateLimitScope("openai", "https://example.test", "second"))
				.run(undefined, undefined, async () => "other key"),
		).toBe("other key")
		await vi.advanceTimersByTimeAsync(29_999)
		expect(first).toHaveBeenCalledTimes(1)
		expect(second).not.toHaveBeenCalled()
		expect(pacer.state()).toMatchObject({ limit: 5, pausedUntil: 30_000, waitingPaths: ["a.ts", "b.ts"] })
		await vi.advanceTimersByTimeAsync(1)
		expect(await firstResult).toBe("first")
		expect(second).not.toHaveBeenCalled()
		await vi.advanceTimersByTimeAsync(125)
		expect(await secondResult).toBe("second")
	})

	it("T36 counts ten same-clock 429s once and ignores stale missing-delay reports after expiry", async () => {
		const pacer = new ProviderPacer("openai:test")
		const controllers = Array.from({ length: 10 }, () => new AbortController())
		const requests = controllers.map(() => deferred<void>())
		const outcomes = requests.map((request, index) =>
			pacer.run(`${index}.ts`, controllers[index].signal, () => request.promise).catch((error) => error),
		)
		await flush()
		for (const request of requests) request.reject(limited())
		await flush()
		expect(pacer.state()).toMatchObject({
			limit: 5,
			consecutiveRateLimits: 1,
			episodeSeq: 10,
			issueSeq: 10,
			pausedUntil: 500,
		})
		expect(codeIndexLog.info).toHaveBeenCalledTimes(1)
		for (const controller of controllers) controller.abort()
		await Promise.all(outcomes)
		await vi.advanceTimersByTimeAsync(500)
		pacer.reportRateLimit(limited(), 9)
		expect(pacer.state()).toMatchObject({ limit: 5, consecutiveRateLimits: 1, pausedUntil: undefined })
		pacer.reportRateLimit(limited(2000), 9)
		expect(pacer.state()).toMatchObject({ limit: 5, consecutiveRateLimits: 1, pausedUntil: 2500 })
	})

	it("T36 stale same-clock success neither resets backoff nor contributes to adaptive growth", async () => {
		const pacer = new ProviderPacer("openai:test")
		const stale = deferred<void>()
		const staleResult = pacer.run("stale", undefined, () => stale.promise)
		await flush()
		pacer.reportRateLimit(limited(), pacer.markIssued())
		stale.resolve()
		await staleResult
		expect(pacer.state().consecutiveRateLimits).toBe(1)
		await vi.advanceTimersByTimeAsync(500)
		const newIssue = pacer.markIssued()
		pacer.reportRateLimit(limited(), newIssue)
		expect(pacer.state()).toMatchObject({ limit: 2, consecutiveRateLimits: 2, pausedUntil: 1500 })
		await vi.advanceTimersByTimeAsync(1000)
		for (let successCount = 0; successCount < 19; successCount++) {
			const result = pacer.run("growth", undefined, async () => "ok")
			await vi.advanceTimersByTimeAsync(125)
			await result
		}
		expect(pacer.state().limit).toBe(2)
		await pacer.run("growth", undefined, async () => "ok")
		expect(pacer.state()).toMatchObject({ limit: 3, consecutiveRateLimits: 0 })
		for (let successCount = 0; successCount < 200; successCount++)
			await pacer.run(undefined, undefined, async () => undefined)
		expect(pacer.state().limit).toBe(10)
	})

	it.each([0, 1])(
		"T36 exponential equal jitter respects both bounds and the 300s base ceiling (random=%s)",
		async (random) => {
			vi.mocked(Math.random).mockReturnValue(random)
			const pacer = new ProviderPacer("openai:test")
			for (let episode = 1; episode <= 12; episode++) {
				const startedAt = Date.now()
				pacer.reportRateLimit(limited(), pacer.markIssued())
				const expected = Math.min(300_000, 1000 * 2 ** (episode - 1)) * (0.5 + random * 0.5)
				expect(pacer.state().pausedUntil).toBe(startedAt + expected)
				await vi.advanceTimersByTimeAsync(expected)
			}
		},
	)

	it("requires consecutive successes for growth, resetting progress on non-429 failures", async () => {
		const pacer = new ProviderPacer("openai:test")
		pacer.reportRateLimit(limited(1), pacer.markIssued())
		await vi.advanceTimersByTimeAsync(1)
		for (let successCount = 0; successCount < 19; successCount++) {
			const result = pacer.run(undefined, undefined, async () => undefined)
			await vi.advanceTimersByTimeAsync(125)
			await result
		}
		const error = { status: 500 }
		await expect(
			pacer.run(undefined, undefined, async () => {
				throw error
			}),
		).rejects.toBe(error)
		await pacer.run(undefined, undefined, async () => undefined)
		expect(pacer.state().limit).toBe(5)
		for (let successCount = 0; successCount < 19; successCount++)
			await pacer.run(undefined, undefined, async () => undefined)
		expect(pacer.state().limit).toBe(6)
	})

	it("a probe 429 creates the next episode and leaves followers blocked", async () => {
		const pacer = new ProviderPacer("openai:test")
		pacer.reportRateLimit(limited(100), pacer.markIssued())
		const controller = new AbortController()
		const request = vi.fn().mockRejectedValue(limited())
		const pending = pacer.run("probe", controller.signal, request).catch((error) => error)
		const follower = vi.fn().mockResolvedValue(undefined)
		const waiting = pacer.run("follower", controller.signal, follower).catch((error) => error)
		await vi.advanceTimersByTimeAsync(100)
		expect(pacer.state()).toMatchObject({ limit: 2, consecutiveRateLimits: 2, pausedUntil: 1100 })
		expect(request).toHaveBeenCalledOnce()
		expect(follower).not.toHaveBeenCalled()
		controller.abort()
		await Promise.all([pending, waiting])
	})

	it("releases and requeues a granted permit when another 429 pauses before consumption", async () => {
		const pacer = new ProviderPacer("openai:test")
		const request = vi.fn().mockResolvedValue("done")
		const result = pacer.run("granted.ts", undefined, request)
		pacer.reportRateLimit(limited(1000), pacer.markIssued())
		await flush()
		expect(request).not.toHaveBeenCalled()
		expect(pacer.state()).toMatchObject({ waitingPaths: ["granted.ts"], issueSeq: 1 })
		expect(pacer["active"]).toBe(0)
		await vi.advanceTimersByTimeAsync(999)
		expect(request).not.toHaveBeenCalled()
		await vi.advanceTimersByTimeAsync(1)
		expect(await result).toBe("done")
		expect(request).toHaveBeenCalledOnce()
		expect(pacer.state()).toMatchObject({ waitingPaths: [], issueSeq: 2 })
		expect(pacer["active"]).toBe(0)
		expect(vi.getTimerCount()).toBe(0)
	})

	it("rechecks cancellation after granting a permit but before invoking the caller", async () => {
		const pacer = new ProviderPacer("openai:test")
		const controller = new AbortController()
		const request = vi.fn().mockResolvedValue(undefined)
		const result = pacer.run(undefined, controller.signal, request)
		controller.abort()
		await expect(result).rejects.toBe(controller.signal.reason)
		expect(request).not.toHaveBeenCalled()
	})

	it.each([0, -1, NaN, Infinity, "invalid", 1e300, 8.64e15 + 1])(
		"uses fallback for invalid, elapsed, or out-of-range provider delay %s",
		(retryAfterMs) => {
			const pacer = new ProviderPacer("openai:test")
			pacer.reportRateLimit({ status: 429, retryAfterMs }, pacer.markIssued())
			expect(pacer.state().pausedUntil).toBe(500)
		},
	)

	// The deadline limit is 8.64e15 ms (max Date), so the same delay flips from valid to invalid as time advances.
	it.each([
		{ advanceMs: 0, retryAfterMs: 8.64e15, pausedUntil: 8.64e15, source: "provider" },
		{ advanceMs: 0, retryAfterMs: 8.64e15 - 500, pausedUntil: 8.64e15 - 500, source: "provider" },
		{ advanceMs: 1000, retryAfterMs: 8.64e15 - 500, pausedUntil: 1500, source: "backoff" },
	])(
		"validates the provider deadline at report time (advance $advanceMs ms, delay $retryAfterMs)",
		async ({ advanceMs, retryAfterMs, pausedUntil, source }) => {
			const pacer = new ProviderPacer("openai:test")
			await vi.advanceTimersByTimeAsync(advanceMs)
			pacer.reportRateLimit(limited(retryAfterMs), pacer.markIssued())
			expect(pacer.state().pausedUntil).toBe(pausedUntil)
			expect(codeIndexLog.info).toHaveBeenCalledWith("Provider pacing wait", expect.objectContaining({ source }))
			expect(new Date(pausedUntil).toISOString()).toEqual(expect.any(String))
		},
	)

	it("paused search reports extend without counting episodes or shortening waits", async () => {
		const pacer = new ProviderPacer("openai:test")
		pacer.reportRateLimit(limited(1000), pacer.markIssued())
		await vi.advanceTimersByTimeAsync(100)
		pacer.reportRateLimit(limited(100), pacer.markIssued())
		pacer.reportRateLimit(limited(2000), pacer.markIssued())
		expect(pacer.state()).toMatchObject({ limit: 5, episodeSeq: 1, consecutiveRateLimits: 1, pausedUntil: 2100 })
	})

	it.each(["server", "connection", "permanent", "abort"])(
		"T36 reopens one at a time after a probe %s outcome",
		async (outcome) => {
			const pacer = new ProviderPacer("openai:test")
			pacer.reportRateLimit(limited(1000), pacer.markIssued())
			const probe = deferred<string>()
			const controller = new AbortController()
			const probeRequest = vi.fn(() => probe.promise)
			const probeResult = pacer.run("probe", controller.signal, probeRequest).catch((error) => error)
			const startedAt: number[] = []
			const followers = Array.from({ length: 6 }, (_, index) =>
				pacer.run(`follower-${index}`, undefined, async () => {
					startedAt.push(Date.now())
				}),
			)
			await vi.advanceTimersByTimeAsync(1000)
			expect(probeRequest).toHaveBeenCalledOnce()
			expect(startedAt).toEqual([])
			await vi.advanceTimersByTimeAsync(1000)
			expect(startedAt).toEqual([])
			const error =
				outcome === "abort"
					? new DOMException("aborted", "AbortError")
					: outcome === "connection"
						? { code: "ECONNRESET" }
						: { status: outcome === "server" ? 500 : 400 }
			if (outcome === "abort") controller.abort(error)
			probe.reject(error)
			expect(await probeResult).toBe(error)
			await vi.advanceTimersByTimeAsync(124)
			expect(startedAt).toEqual([])
			await vi.advanceTimersByTimeAsync(1)
			expect(startedAt).toEqual([2125])
			await vi.advanceTimersByTimeAsync(125)
			expect(startedAt).toEqual([2125, 2250])
			await vi.runAllTimersAsync()
			await Promise.all(followers)
			expect(startedAt.slice(0, 4)).toEqual([2125, 2250, 2375, 2500])
		},
	)

	it("uses the upper 375ms staged gap and lets probe cancellation reopen before transport settles", async () => {
		vi.mocked(Math.random).mockReturnValue(1)
		const pacer = new ProviderPacer("openai:test")
		pacer.reportRateLimit(limited(100), pacer.markIssued())
		const probe = deferred<void>()
		const controller = new AbortController()
		const probeResult = pacer.run(undefined, controller.signal, () => probe.promise)
		const follower = vi.fn().mockResolvedValue(undefined)
		const followerResult = pacer.run(undefined, undefined, follower)
		await vi.advanceTimersByTimeAsync(100)
		controller.abort()
		await vi.advanceTimersByTimeAsync(374)
		expect(follower).not.toHaveBeenCalled()
		await vi.advanceTimersByTimeAsync(1)
		await followerResult
		probe.resolve()
		await probeResult
	})

	it("absorbs unlimited 429s but preserves a subsequent non-429 error unchanged", async () => {
		const pacer = new ProviderPacer("openai:test")
		const error = { status: 503 }
		const request = vi.fn().mockRejectedValue(limited(1))
		const result = pacer.run("retry", undefined, request).catch((caught) => caught)
		await vi.advanceTimersByTimeAsync(40)
		expect(request.mock.calls.length).toBeGreaterThan(30)
		request.mockRejectedValueOnce(error)
		await vi.advanceTimersByTimeAsync(1)
		expect(await result).toBe(error)
		expect(vi.getTimerCount()).toBe(0)
	})

	it("cancels permit waits and pause waits before invoking the caller's gate", async () => {
		const pacer = new ProviderPacer("openai:test")
		const active = deferred<void>()
		const activeResults = Array.from({ length: 10 }, () => pacer.run(undefined, undefined, () => active.promise))
		await flush()
		const controller = new AbortController()
		const gate = vi.fn().mockResolvedValue(undefined)
		const blocked = pacer.run("blocked", controller.signal, gate).catch((error) => error)
		controller.abort()
		expect(await blocked).toBe(controller.signal.reason)
		expect(gate).not.toHaveBeenCalled()
		active.resolve()
		await Promise.all(activeResults)
		pacer.reportRateLimit(limited(30_000), pacer.markIssued())
		const pausedController = new AbortController()
		const paused = pacer.run("paused", pausedController.signal, gate).catch((error) => error)
		pausedController.abort()
		expect(await paused).toBe(pausedController.signal.reason)
		expect(pacer.state().waitingPaths).toEqual([])
		expect(pacer.state().pausedUntil).toBe(30_000)
		expect(gate).not.toHaveBeenCalled()
		await expect(pacer.run("already aborted", pausedController.signal, gate)).rejects.toBe(
			pausedController.signal.reason,
		)
	})

	it("retains uncapped delays beyond 32-bit timers without sending early", async () => {
		const pacer = new ProviderPacer("openai:test")
		const delay = 2 ** 31 + 60_000
		pacer.reportRateLimit({ status: 429, headers: { "retry-after-ms": String(delay) } }, pacer.markIssued())
		const request = vi.fn().mockResolvedValue("ok")
		const result = pacer.run("long", undefined, request)
		expect(pacer.state().pausedUntil).toBe(delay)
		await vi.advanceTimersByTimeAsync(2 ** 31 - 1)
		expect(request).not.toHaveBeenCalled()
		expect(vi.getTimerCount()).toBe(1)
		await vi.advanceTimersByTimeAsync(60_000)
		expect(request).not.toHaveBeenCalled()
		await vi.advanceTimersByTimeAsync(1)
		expect(await result).toBe("ok")
	})
})

describe("ProviderPacerRegistry and scope", () => {
	it("normalizes URL identity, strips credentials and hashes keys without disclosing configuration", () => {
		const scope = makeRateLimitScope("openai", "https://user:password@EXAMPLE.test:443/v1/", "secret")
		expect(scope).toBe(makeRateLimitScope("openai", "https://example.test/v1", "secret"))
		expect(scope).not.toContain("secret")
		expect(scope).not.toContain("password")
		expect(scope).not.toContain("example")
		expect(scope).not.toBe(makeRateLimitScope("openai", "https://example.test/v1", "other"))
		expect(makeRateLimitScope("bedrock", undefined, undefined, "region/profile")).not.toBe(
			makeRateLimitScope("bedrock", undefined, undefined, "other/profile"),
		)
		expect(makeRateLimitScope("ollama", "http://localhost:11434")).toMatch(/^ollama:[a-f0-9]{64}$/)
		const keyHash = createHash("sha256").update("secret").digest("hex")
		expect(scope).toBe(
			`openai:${createHash("sha256")
				.update(JSON.stringify(["openai", "https://example.test/v1", keyHash, ""]))
				.digest("hex")}`,
		)
	})

	it("notifies status, returns detached paused snapshots and deduplicates all waiting paths", async () => {
		const registry = new ProviderPacerRegistry()
		const changed = vi.fn()
		const disposables: { dispose(): void }[] = []
		registry.onDidChange(changed, undefined, disposables)
		const embedder = registry.get("openai:https://private.test?key=secret")
		const store = registry.get("qdrant:https://private-store.test")
		embedder.reportRateLimit(limited(1000), embedder.markIssued())
		store.reportRateLimit(limited(2000), store.markIssued())
		const controller = new AbortController()
		const queued: [typeof embedder, string][] = [
			[embedder, "same.ts"],
			[embedder, "embed-only.ts"],
			[embedder, "same.ts"],
			[store, "same.ts"],
			[store, "store-only.ts"],
		]
		const outcomes = queued.map(([pacer, file]) =>
			pacer.run(file, controller.signal, async () => undefined).catch((error) => error),
		)
		await flush()
		const allPaths = ["same.ts", "embed-only.ts", "store-only.ts"]
		expect(registry.waitingPaths()).toEqual(allPaths)
		expect(registry.providerWaits()).toEqual([
			{ service: "openai", resumeAt: 1000, waitingFiles: ["same.ts", "embed-only.ts"] },
			{ service: "qdrant", resumeAt: 2000, waitingFiles: ["same.ts", "store-only.ts"] },
		])
		registry.providerWaits()[0].waitingFiles.push("mutated")
		expect(registry.waitingPaths()).toEqual(allPaths)
		controller.abort()
		await Promise.all(outcomes)
		expect(registry.waitingPaths()).toEqual([])
		expect(changed).toHaveBeenCalled()
		disposables[0].dispose()
		changed.mockClear()
		await vi.advanceTimersByTimeAsync(2000)
		expect(changed).not.toHaveBeenCalled()
		expect(registry.providerWaits()).toEqual([])
		expect(registry.get("https://user:secret@host").service).toBe("https")
		expect(registry.get("unsafe/key:secret").service).toBe("provider")
	})
})
