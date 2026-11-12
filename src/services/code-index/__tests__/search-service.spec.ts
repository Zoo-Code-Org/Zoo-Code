import * as path from "path"
import { CodeIndexSearchService } from "../search-service"
import { FileFailureRegistry } from "../file-failure-registry"
import { ProviderPacerRegistry } from "../provider-pacer"
import { SearchProviderRateLimitError } from "../shared/indexing-errors"
import { CodeIndexStateManager, type IndexingState } from "../state-manager"
import type { IEmbedder } from "../interfaces/embedder"
import type { IVectorStore } from "../interfaces/vector-store"
import { EmbeddingError } from "../shared/indexing-errors"

vi.mock("vscode", () => ({
	EventEmitter: class {
		event = vi.fn()
		fire(): void {}
		dispose(): void {}
	},
}))
vi.mock("../../../i18n", () => ({ t: (key: string) => key }))

vi.mock("../code-index-log", () => ({ codeIndexLog: { error: vi.fn(), info: vi.fn() } }))

function prepare(state: IndexingState = "Indexed", failed = true, exists = true) {
	const failures = new FileFailureRegistry()
	if (failed) {
		for (const file of ["src/a.ts", "other/b.ts"]) {
			failures.renew(file, "revision")
			failures.record(file, "revision", "embed", "unavailable", 3, "exhausted", "server")
		}
	}
	const config = {
		isFeatureEnabled: true,
		isFeatureConfigured: true,
		currentSearchMinScore: 0.4,
		currentSearchMaxResults: 12,
	}
	const stateManager = new CodeIndexStateManager()
	stateManager.setSystemState(state, "Original status")
	const setSystemState = vi.spyOn(stateManager, "setSystemState")
	const embedder = { rateLimitScope: "embedding:test", createEmbeddings: vi.fn<IEmbedder["createEmbeddings"]>() }
	embedder.createEmbeddings.mockResolvedValue({ embeddings: [[1, 0]] })
	const store = {
		search: vi.fn<IVectorStore["search"]>().mockResolvedValue([]),
		collectionExists: vi.fn<IVectorStore["collectionExists"]>().mockResolvedValue(exists),
	}
	const getCurrentStatus = vi.fn(() => stateManager.getCurrentStatus())
	const pacers = new ProviderPacerRegistry()
	const service = new CodeIndexSearchService(
		config,
		stateManager,
		embedder,
		store,
		failures,
		pacers,
		getCurrentStatus,
	)
	const statusBefore = stateManager.getCurrentStatus()
	const failuresBefore = failures.list()
	const registryMethods = ["record", "clear", "renew", "resetAllBudgets", "getRetryBudget"] as const
	const registryWrites = registryMethods.map((method) => vi.spyOn(failures, method))
	function expectUnchanged() {
		expect(setSystemState).not.toHaveBeenCalled()
		expect(stateManager.getCurrentStatus()).toEqual(statusBefore)
		expect(failures.list()).toEqual(failuresBefore)
		for (const write of registryWrites) expect(write).not.toHaveBeenCalled()
	}
	return { service, failures, pacers, store, embedder, config, stateManager, getCurrentStatus, expectUnchanged }
}

afterEach(() => {
	vi.useRealTimers()
	vi.restoreAllMocks()
})

describe("CodeIndexSearchService", () => {
	it.each(["Indexed", "Indexing", "Standby"] as const)(
		"returns every failed path with matches or no matches in %s",
		async (state) => {
			const { service, store } = prepare(state)
			for (const results of [[], [{ id: "point", score: 0.9 }]]) {
				store.search.mockResolvedValueOnce(results)
				await expect(service.searchIndex("query", "src/folder")).resolves.toEqual({
					results,
					incomplete: true,
					failedPaths: ["src/a.ts", "other/b.ts"],
					waitingPaths: [],
				})
			}
			expect(store.search).toHaveBeenCalledWith([1, 0], path.normalize("src/folder"), 0.4, 12)
			expect(store.collectionExists).toHaveBeenCalledTimes(state === "Standby" ? 2 : 0)
		},
	)

	it.each(["Indexed", "Indexing"] as const)("allows %s without known failures", async (state) => {
		const { service, expectUnchanged } = prepare(state, false)
		await expect(service.searchIndex("query")).resolves.toEqual({
			results: [],
			incomplete: false,
			failedPaths: [],
			waitingPaths: [],
		})
		expectUnchanged()
	})

	it.each([
		["Standby", false, true],
		["Standby", true, false],
		["Error", true, true],
		["Stopping", true, true],
	] as const)("rejects %s / failures %s / collection %s", async (state, failed, exists) => {
		const { service, embedder, store, expectUnchanged } = prepare(state, failed, exists)
		await expect(service.searchIndex("query")).rejects.toThrow(`Current state: ${state}`)
		expect(embedder.createEmbeddings).not.toHaveBeenCalled()
		expect(store.collectionExists).toHaveBeenCalledTimes(state === "Standby" && failed ? 1 : 0)
		expectUnchanged()
	})

	it.each(["isFeatureEnabled", "isFeatureConfigured"] as const)("rejects when %s is false", async (setting) => {
		const { service, config, embedder, expectUnchanged } = prepare()
		config[setting] = false
		await expect(service.searchIndex("query")).rejects.toThrow("disabled or not configured")
		expect(embedder.createEmbeddings).not.toHaveBeenCalled()
		expectUnchanged()
	})

	it("uses the manager's computed status instead of raw progress state", async () => {
		const { service, getCurrentStatus, embedder, stateManager } = prepare("Indexing")
		getCurrentStatus.mockReturnValue({ ...stateManager.getCurrentStatus(), systemStatus: "Error" })
		await expect(service.searchIndex("query")).rejects.toThrow("Current state: Error")
		expect(embedder.createEmbeddings).not.toHaveBeenCalled()
	})

	it.each(["Error", "Stopping"] as const)("does not bypass %s reached during collection lookup", async (state) => {
		const { service, store, getCurrentStatus, stateManager, embedder } = prepare("Standby")
		store.collectionExists.mockImplementation(async () => {
			getCurrentStatus.mockReturnValue({ ...stateManager.getCurrentStatus(), systemStatus: state })
			return true
		})
		await expect(service.searchIndex("query")).rejects.toThrow(`Current state: ${state}`)
		expect(embedder.createEmbeddings).not.toHaveBeenCalled()
	})

	it.each([true, false])("preserves cancellation during collection lookup, rejects=%s", async (rejects) => {
		const { service, store, embedder, expectUnchanged } = prepare("Standby")
		const controller = new AbortController()
		const reason = Object.freeze({ cancelled: true })
		store.collectionExists.mockImplementation(async () => {
			controller.abort(reason)
			if (rejects) throw new Error("collection lookup failed")
			return true
		})
		await expect(service.searchIndex("query", undefined, controller.signal)).rejects.toBe(reason)
		expect(embedder.createEmbeddings).not.toHaveBeenCalled()
		expectUnchanged()
	})

	it.each([true, false])("snapshots failures at response time, recovery=%s", async (recovered) => {
		const { service, failures, store } = prepare()
		store.search.mockImplementation(async () => {
			failures.clear("src/a.ts")
			failures.clear("other/b.ts")
			if (!recovered) {
				failures.renew("pending.ts", "new")
				failures.record("pending.ts", "new", "embed", "waiting", 1, "retrying", "server")
			}
			return []
		})
		await expect(service.searchIndex("query", "src")).resolves.toEqual({
			results: [],
			incomplete: !recovered,
			failedPaths: recovered ? [] : ["pending.ts"],
			waitingPaths: [],
		})
	})

	it("supports the state-manager fallback when no status supplier is provided", async () => {
		const { config, stateManager, embedder, store, failures, pacers } = prepare()
		const service = new CodeIndexSearchService(config, stateManager, embedder, store, failures, pacers)
		await expect(service.searchIndex("query")).resolves.toMatchObject({ incomplete: true })
	})

	it.each(["Indexed", "Indexing", "Standby"] as const)(
		"keeps %s health unchanged on store failure",
		async (state) => {
			const { service, store, expectUnchanged } = prepare(state)
			const error = new Error("store unavailable")
			store.search.mockRejectedValue(error)
			await expect(service.searchIndex("query")).rejects.toBe(error)
			expect(store.search).toHaveBeenCalledOnce()
			expectUnchanged()
		},
	)

	it("rejects an empty embedding without changing indexing health", async () => {
		const { service, embedder, store, expectUnchanged } = prepare()
		embedder.createEmbeddings.mockResolvedValue({ embeddings: [] })
		await expect(service.searchIndex("query")).rejects.toThrow("Failed to generate embedding")
		expect(store.search).not.toHaveBeenCalled()
		expectUnchanged()
	})

	it.each([401, 408, 409])("does not retry permanent query errors (%s)", async (status) => {
		const { service, embedder, expectUnchanged } = prepare()
		const error = Object.freeze(Object.assign(new Error("unavailable"), { status }))
		embedder.createEmbeddings.mockRejectedValue(error)
		await expect(service.searchIndex("query")).rejects.toMatchObject({
			cause: error,
			classification: "permanent",
			attempts: 1,
		})
		expect(embedder.createEmbeddings).toHaveBeenCalledOnce()
		expect(error).not.toHaveProperty("attempts")
		expectUnchanged()
	})

	it.each([503])("uses one two-retry budget per query (%s)", async (status) => {
		vi.useFakeTimers()
		const { service, embedder, expectUnchanged } = prepare()
		const error = Object.assign(new Error("unavailable"), { status })
		embedder.createEmbeddings.mockRejectedValue(error)
		for (const expectedCalls of [3, 6]) {
			const outcome = service.searchIndex("query").catch((failure: unknown) => failure)
			await vi.advanceTimersByTimeAsync(499)
			expect(embedder.createEmbeddings).toHaveBeenCalledTimes(expectedCalls - 2)
			await vi.advanceTimersByTimeAsync(1)
			expect(embedder.createEmbeddings).toHaveBeenCalledTimes(expectedCalls - 1)
			await vi.advanceTimersByTimeAsync(1000)
			await expect(outcome).resolves.toMatchObject({ cause: error, attempts: 3 })
			expect(embedder.createEmbeddings).toHaveBeenCalledTimes(expectedCalls)
		}
		expectUnchanged()
	})

	it.each([60_000, 61_000, 120_000])(
		"reports a query 429 immediately with full %s ms pause",
		async (retryAfterMs) => {
			vi.useFakeTimers()
			const { service, embedder, pacers, expectUnchanged } = prepare()
			const error = new EmbeddingError("limited", { status: 429 }, { retryAfterMs })
			embedder.createEmbeddings.mockRejectedValue(error)
			await expect(service.searchIndex("query")).rejects.toMatchObject({
				name: SearchProviderRateLimitError.name,
				message: "embeddings:searchProviderRateLimited",
				cause: error,
			})
			expect(pacers.get(embedder.rateLimitScope).state().pausedUntil).toBe(Date.now() + retryAfterMs)
			expect(pacers.waitingPaths()).toEqual([])
			expect(embedder.createEmbeddings).toHaveBeenCalledOnce()
			expectUnchanged()
		},
	)

	it("does not wait for provider pauses or indexing permits", async () => {
		vi.useFakeTimers()
		const { service, embedder, pacers } = prepare()
		const pacer = pacers.get(embedder.rateLimitScope)
		pacer.reportRateLimit(
			new EmbeddingError("limited", { status: 429 }, { retryAfterMs: 120_000 }),
			pacer.markIssued(),
		)
		await expect(service.searchIndex("query")).resolves.toMatchObject({ incomplete: true })
		expect(embedder.createEmbeddings).toHaveBeenCalledOnce()
	})

	it("bypasses saturated indexing permits and marks each query request issued", async () => {
		const { service, embedder, pacers, expectUnchanged } = prepare("Indexed", false)
		const pacer = pacers.get(embedder.rateLimitScope)
		let release!: () => void
		const held = new Promise<void>((resolve) => {
			release = resolve
		})
		const indexing = Array.from({ length: pacer.state().limit }, (_, position) =>
			pacer.run(`file-${position}.ts`, undefined, () => held),
		)
		await Promise.resolve()
		const markIssued = vi.spyOn(pacer, "markIssued")
		try {
			await expect(service.searchIndex("query")).resolves.toMatchObject({ incomplete: false })
			expect(embedder.createEmbeddings).toHaveBeenCalledOnce()
			expect(markIssued).toHaveBeenCalledOnce()
			expectUnchanged()
		} finally {
			release()
			await Promise.all(indexing)
		}
	})

	it.each(["Standby", "Error", "Stopping"] as const)("waiting-only search gate preserves %s", async (state) => {
		const { service, pacers, embedder } = prepare(state, false)
		vi.spyOn(pacers, "waitingPaths").mockReturnValue(["waiting.ts"])
		if (state === "Standby") {
			await expect(service.searchIndex("query")).resolves.toEqual({
				results: [],
				incomplete: true,
				failedPaths: [],
				waitingPaths: ["waiting.ts"],
			})
		} else {
			await expect(service.searchIndex("query")).rejects.toThrow(`Current state: ${state}`)
			expect(embedder.createEmbeddings).not.toHaveBeenCalled()
		}
	})

	it("rechecks waiting-only availability after collection lookup", async () => {
		const { service, pacers, store, embedder } = prepare("Standby", false)
		const waiting = vi.spyOn(pacers, "waitingPaths").mockReturnValue(["waiting.ts"])
		store.collectionExists.mockImplementation(async () => {
			waiting.mockReturnValue([])
			return true
		})
		await expect(service.searchIndex("query")).rejects.toThrow("Current state: Standby")
		expect(embedder.createEmbeddings).not.toHaveBeenCalled()
	})

	it("snapshots waiting paths only after the store responds", async () => {
		const { service, pacers, store } = prepare("Indexed", false)
		const waiting = vi.spyOn(pacers, "waitingPaths").mockReturnValue([])
		store.search.mockImplementation(async () => {
			waiting.mockReturnValue(["late.ts"])
			return []
		})
		await expect(service.searchIndex("query")).resolves.toEqual({
			results: [],
			incomplete: true,
			failedPaths: [],
			waitingPaths: ["late.ts"],
		})
	})

	it("cancels a retry wait with unchanged reason and no later request", async () => {
		vi.useFakeTimers()
		const { service, embedder, store, expectUnchanged } = prepare()
		embedder.createEmbeddings.mockRejectedValue(new EmbeddingError("unavailable", { status: 503 }))
		const controller = new AbortController()
		const reason = Object.freeze({ cancelled: true })
		const outcome = service.searchIndex("query", undefined, controller.signal).catch((error: unknown) => error)
		await vi.advanceTimersByTimeAsync(0)
		controller.abort(reason)
		await expect(outcome).resolves.toBe(reason)
		await vi.advanceTimersByTimeAsync(120_000)
		expect(embedder.createEmbeddings).toHaveBeenCalledExactlyOnceWith(["query"], undefined, controller.signal)
		expect(store.search).not.toHaveBeenCalled()
		expect(vi.getTimerCount()).toBe(0)
		expectUnchanged()
	})

	it("does not issue requests for an already cancelled caller", async () => {
		const { service, embedder, store, expectUnchanged } = prepare()
		const signal = AbortSignal.abort(new Error("caller ended"))
		await expect(service.searchIndex("query", undefined, signal)).rejects.toBe(signal.reason)
		expect(embedder.createEmbeddings).not.toHaveBeenCalled()
		expect(store.search).not.toHaveBeenCalled()
		expectUnchanged()
	})

	it.each(["embed", "search"] as const)("preserves cancellation after in-flight %s finishes", async (activity) => {
		const { service, embedder, store, expectUnchanged } = prepare()
		const controller = new AbortController()
		const reason = new Error("caller ended")
		if (activity === "embed") {
			embedder.createEmbeddings.mockImplementation(async () => {
				controller.abort(reason)
				return { embeddings: [[1, 0]] }
			})
		} else {
			store.search.mockImplementation(async () => {
				controller.abort(reason)
				return []
			})
		}
		await expect(service.searchIndex("query", undefined, controller.signal)).rejects.toBe(reason)
		expect(store.search).toHaveBeenCalledTimes(activity === "embed" ? 0 : 1)
		expectUnchanged()
	})
})
