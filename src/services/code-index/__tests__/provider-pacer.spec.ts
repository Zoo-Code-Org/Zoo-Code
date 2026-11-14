import { ProviderPacer, ProviderPacerRegistry, makeRateLimitScope } from "../provider-pacer"

const rateLimit = (retryAfterMs?: number) => Object.assign(new Error("limited"), { status: 429, retryAfterMs })

async function settle(promise: Promise<unknown>) {
	return promise.then(
		(value) => ({ value }),
		(error: unknown) => ({ error }),
	)
}

describe("makeRateLimitScope (CI-PP-01)", () => {
	it.each([
		["same configuration", ["openai", "https://api.test/v1", "key"], ["openai", "https://api.test/v1", "key"]],
		["trailing slash", ["openai", "https://api.test/v1/", "key"], ["openai", "https://api.test/v1", "key"]],
		["credentials in URL", ["openai", "https://u:p@api.test/v1", "key"], ["openai", "https://api.test/v1", "key"]],
		["URL hash", ["openai", "https://api.test/v1#x", "key"], ["openai", "https://api.test/v1", "key"]],
	])("gives equal scopes for %s", (_label, first, second) => {
		const [provider, url, key] = first
		const [provider2, url2, key2] = second
		expect(makeRateLimitScope(provider, url, key)).toBe(makeRateLimitScope(provider2, url2, key2))
	})

	it.each([
		["API key", ["openai", "https://api.test", "a"], ["openai", "https://api.test", "b"]],
		["endpoint", ["openai", "https://a.test", "k"], ["openai", "https://b.test", "k"]],
		["provider", ["openai", "https://a.test", "k"], ["mistral", "https://a.test", "k"]],
	])("gives unequal scopes for a different %s", (_label, first, second) => {
		expect(makeRateLimitScope(first[0], first[1], first[2])).not.toBe(
			makeRateLimitScope(second[0], second[1], second[2]),
		)
	})

	it("distinguishes extra inputs and never embeds the key", () => {
		const scope = makeRateLimitScope("bedrock", undefined, undefined, "us-east-1|default")
		expect(scope).not.toBe(makeRateLimitScope("bedrock", undefined, undefined, "us-west-2|default"))
		expect(makeRateLimitScope("openai", "https://api.test", "secret-key")).not.toContain("secret-key")
		expect(scope.startsWith("bedrock:")).toBe(true)
	})
})

describe("ProviderPacer (CI-PP-02)", () => {
	beforeEach(() => vi.useFakeTimers({ now: 0 }))
	afterEach(() => vi.useRealTimers())

	it.each([61_000, 120_000])("honors a %d ms Retry-After in full", async (delay) => {
		const pacer = new ProviderPacer("openai:1")
		const request = vi.fn().mockRejectedValueOnce(rateLimit(delay)).mockResolvedValue("ok")
		const run = pacer.run("a.ts", undefined, request)
		await vi.advanceTimersByTimeAsync(delay - 1)
		expect(request).toHaveBeenCalledTimes(1)
		await vi.advanceTimersByTimeAsync(1)
		await expect(run).resolves.toBe("ok")
		expect(request).toHaveBeenCalledTimes(2)
	})

	it("backs off exponentially without a delay, caps at 300 s and resets on success", async () => {
		const pacer = new ProviderPacer("openai:1")
		const request = vi.fn()
		for (let iter = 0; iter < 12; iter++) request.mockRejectedValueOnce(rateLimit())
		request.mockResolvedValue("ok")
		const run = pacer.run(undefined, undefined, request)
		await vi.advanceTimersByTimeAsync(0)
		const waits: number[] = []
		while (request.mock.calls.length < 13) {
			const before = Date.now()
			const resume = pacer.resumeAt!
			await vi.advanceTimersByTimeAsync(resume - before)
			waits.push(resume - before)
		}
		await expect(run).resolves.toBe("ok")
		expect(waits.slice(0, 4)).toEqual([1000, 2000, 4000, 8000])
		expect(Math.max(...waits)).toBe(300_000)

		request.mockRejectedValueOnce(rateLimit()).mockResolvedValue("ok")
		const next = pacer.run(undefined, undefined, request)
		await vi.advanceTimersByTimeAsync(0)
		expect(pacer.resumeAt! - Date.now()).toBe(1000)
		await vi.advanceTimersByTimeAsync(1000)
		await next
	})

	it("never shortens an existing pause when a later 429 asks for less", async () => {
		const pacer = new ProviderPacer("openai:1")
		let releaseShort: (() => void) | undefined
		const shortRequest = vi
			.fn()
			.mockImplementationOnce(
				() => new Promise((_resolve, reject) => (releaseShort = () => reject(rateLimit(1000)))),
			)
			.mockResolvedValue("ok")
		const short = settle(pacer.run(undefined, undefined, shortRequest))
		const slow = settle(pacer.run(undefined, undefined, vi.fn().mockRejectedValueOnce(rateLimit(60_000))))
		await vi.advanceTimersByTimeAsync(0)
		expect(pacer.resumeAt).toBe(60_000)
		releaseShort?.()
		await vi.advanceTimersByTimeAsync(0)
		expect(pacer.resumeAt).toBe(60_000)
		await vi.advanceTimersByTimeAsync(59_999)
		expect(shortRequest).toHaveBeenCalledTimes(1)
		await vi.advanceTimersByTimeAsync(1)
		await expect(Promise.all([slow, short])).resolves.toEqual([{ value: undefined }, { value: "ok" }])
		expect(shortRequest).toHaveBeenCalledTimes(2)
	})

	it("counts concurrent 429s during one pause as a single backoff step", async () => {
		const pacer = new ProviderPacer("openai:1")
		const releases: Array<() => void> = []
		const request = () =>
			vi
				.fn()
				.mockImplementationOnce(
					() => new Promise((_resolve, reject) => releases.push(() => reject(rateLimit()))),
				)
				.mockResolvedValue("ok")
		const runs = [1, 2, 3, 4].map(() => settle(pacer.run(undefined, undefined, request())))
		await vi.advanceTimersByTimeAsync(0)
		for (const release of releases) release()
		await vi.advanceTimersByTimeAsync(0)
		expect(pacer.resumeAt! - Date.now()).toBe(1000)
		await vi.advanceTimersByTimeAsync(1000)
		await expect(Promise.all(runs)).resolves.toEqual([1, 2, 3, 4].map(() => ({ value: "ok" })))
	})

	it("rejects a waiter at once with the abort reason and drops its path", async () => {
		const pacer = new ProviderPacer("openai:1")
		const first = settle(pacer.run("a.ts", undefined, vi.fn().mockRejectedValueOnce(rateLimit(60_000))))
		await vi.advanceTimersByTimeAsync(0)
		const controller = new AbortController()
		const request = vi.fn()
		const waiting = pacer.run("b.ts", controller.signal, request)
		expect(pacer.waitingPaths).toContain("b.ts")
		const reason = new Error("stopped")
		controller.abort(reason)
		await expect(waiting).rejects.toBe(reason)
		expect(pacer.waitingPaths).not.toContain("b.ts")
		expect(request).not.toHaveBeenCalled()
		await vi.advanceTimersByTimeAsync(60_000)
		await expect(first).resolves.toEqual({ value: undefined })
	})

	it("rethrows non-rate-limit errors unchanged", async () => {
		const failure = Object.assign(new Error("server"), { status: 500 })
		await expect(
			new ProviderPacer("openai:1").run(undefined, undefined, () => Promise.reject(failure)),
		).rejects.toBe(failure)
	})

	it("keeps waits longer than the 32-bit timer limit", async () => {
		const pacer = new ProviderPacer("openai:1")
		const delay = 2 ** 31 + 10_000
		const request = vi.fn().mockRejectedValueOnce(rateLimit(delay)).mockResolvedValue("ok")
		const run = pacer.run(undefined, undefined, request)
		await vi.advanceTimersByTimeAsync(2 ** 31)
		expect(request).toHaveBeenCalledTimes(1)
		await vi.advanceTimersByTimeAsync(10_000)
		await expect(run).resolves.toBe("ok")
	})
})

describe("ProviderPacerRegistry", () => {
	beforeEach(() => vi.useFakeTimers({ now: 0 }))
	afterEach(() => vi.useRealTimers())

	it("shares a scope's pause, isolates other scopes and reports deduplicated waits", async () => {
		const registry = new ProviderPacerRegistry()
		const changed = vi.fn()
		registry.onDidChange(changed)
		const paused = settle(
			registry.get("openai:1").run("a.ts", undefined, vi.fn().mockRejectedValueOnce(rateLimit(5000))),
		)
		await vi.advanceTimersByTimeAsync(0)
		const same = settle(registry.get("openai:1").run("a.ts", undefined, vi.fn().mockResolvedValue("ok")))
		const other = vi.fn().mockResolvedValue("other")
		await expect(registry.get("qdrant:2").run("b.ts", undefined, other)).resolves.toBe("other")

		expect(registry.providerWaits()).toEqual([{ service: "openai", resumeAt: 5000, waitingFiles: ["a.ts"] }])
		expect(registry.waitingPaths()).toEqual(["a.ts"])
		expect(registry.hasWaitingRequests()).toBe(true)
		expect(changed).toHaveBeenCalled()

		await vi.advanceTimersByTimeAsync(5000)
		await expect(Promise.all([paused, same])).resolves.toEqual([{ value: undefined }, { value: "ok" }])
		expect(registry.providerWaits()).toEqual([])
		expect(registry.hasWaitingRequests()).toBe(false)
	})
})
