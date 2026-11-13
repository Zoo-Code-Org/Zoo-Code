import * as path from "path"
import { CodeIndexSearchService } from "../search-service"
import { FileFailureRegistry } from "../file-failure-registry"
import { ProviderPacerRegistry } from "../provider-pacer"
import { SearchProviderRateLimitError } from "../shared/indexing-errors"
import { CodeIndexStateManager, type IndexingState } from "../state-manager"
import type { IEmbedder } from "../interfaces/embedder"
import type { IVectorStore } from "../interfaces/vector-store"

vi.mock("vscode", () => ({
	EventEmitter: class {
		event = vi.fn()
		fire(): void {}
		dispose(): void {}
	},
}))
vi.mock("../../../i18n", () => ({ t: (key: string) => key }))
vi.mock("@roo-code/telemetry", () => ({ TelemetryService: { instance: { captureEvent: vi.fn() } } }))

function prepare(state: IndexingState, { failed = false, exists = true, enabled = true } = {}) {
	const failures = new FileFailureRegistry()
	if (failed) {
		for (const file of ["src/a.ts", "other/b.ts"]) {
			failures.renew(file, "revision")
			failures.record(file, "revision", "embed", "unavailable", 3, "exhausted", "server")
		}
	}
	const config = {
		isFeatureEnabled: enabled,
		isFeatureConfigured: true,
		currentSearchMinScore: 0.4,
		currentSearchMaxResults: 12,
	}
	const stateManager = new CodeIndexStateManager()
	stateManager.setSystemState(state, "status")
	const setSystemState = vi.spyOn(stateManager, "setSystemState")
	const embedder = { createEmbeddings: vi.fn<IEmbedder["createEmbeddings"]>() }
	embedder.createEmbeddings.mockResolvedValue({ embeddings: [[1, 0]] })
	const store = {
		search: vi.fn<IVectorStore["search"]>().mockResolvedValue([]),
		collectionExists: vi.fn<IVectorStore["collectionExists"]>().mockResolvedValue(exists),
	}
	const pacers = new ProviderPacerRegistry()
	const service = new CodeIndexSearchService(config, stateManager, embedder, store, failures, pacers)
	return { service, failures, pacers, store, embedder, setSystemState }
}

async function withWaitingPath(pacers: ProviderPacerRegistry, file: string) {
	const controller = new AbortController()
	const limited = Object.assign(new Error("limited"), { status: 429, retryAfterMs: 60_000 })
	const pending = pacers
		.get("openai:1")
		.run(file, controller.signal, () => Promise.reject(limited))
		.catch(() => {})
	await new Promise((resolve) => setTimeout(resolve, 0))
	return async () => {
		controller.abort()
		await pending
	}
}

afterEach(() => vi.restoreAllMocks())

describe("CodeIndexSearchService (CI-SS-01)", () => {
	it.each([
		{ state: "Indexed", failed: false, incomplete: false },
		{ state: "Indexed", failed: true, incomplete: true },
		{ state: "Indexing", failed: false, incomplete: true },
		{ state: "Standby", failed: true, incomplete: true },
	] as const)(
		"$state with failures=$failed reports incomplete=$incomplete",
		async ({ state, failed, incomplete }) => {
			const { service } = prepare(state, { failed })
			const response = await service.searchIndex("query")
			expect(response.incomplete).toBe(incomplete)
			expect(response.failedPaths).toEqual(failed ? ["src/a.ts", "other/b.ts"] : [])
			expect(response.waitingPaths).toEqual([])
		},
	)

	it("reports waiting paths separately and deduplicated, for matches and empty results", async () => {
		const { service, pacers, store } = prepare("Indexing", { failed: true })
		const releaseFirst = await withWaitingPath(pacers, "w.ts")
		const releaseSecond = await withWaitingPath(pacers, "w.ts")
		try {
			for (const results of [[], [{ id: "point", score: 0.9 }]]) {
				store.search.mockResolvedValueOnce(results)
				const response = await service.searchIndex("query")
				expect(response.results).toEqual(results)
				expect(response).toMatchObject({ incomplete: true, waitingPaths: ["w.ts"] })
				expect(response.failedPaths).toEqual(["src/a.ts", "other/b.ts"])
			}
		} finally {
			await releaseFirst()
			await releaseSecond()
		}
	})

	it("reports whole-workspace failures for a directory-scoped search", async () => {
		const { service, store } = prepare("Indexed", { failed: true })
		const response = await service.searchIndex("query", "src")
		expect(store.search).toHaveBeenCalledWith([1, 0], path.normalize("src"), 0.4, 12)
		expect(response.failedPaths).toEqual(["src/a.ts", "other/b.ts"])
	})

	it.each([
		{ state: "Error", failed: true, exists: true },
		{ state: "Stopping", failed: true, exists: true },
		{ state: "Standby", failed: false, exists: true },
		{ state: "Standby", failed: true, exists: false },
	] as const)(
		"rejects search in $state (failures=$failed, collection=$exists)",
		async ({ state, failed, exists }) => {
			const { service, embedder } = prepare(state, { failed, exists })
			await expect(service.searchIndex("query")).rejects.toThrow(`Current state: ${state}`)
			expect(embedder.createEmbeddings).not.toHaveBeenCalled()
		},
	)

	it("does not set Error when a query fails", async () => {
		const { service, embedder, setSystemState } = prepare("Indexed")
		embedder.createEmbeddings.mockRejectedValue(Object.assign(new Error("bad"), { status: 400 }))
		await expect(service.searchIndex("query")).rejects.toThrow()
		expect(setSystemState).not.toHaveBeenCalled()
	})

	it("turns a query rate limit into SearchProviderRateLimitError without waiting", async () => {
		const { service, embedder } = prepare("Indexed")
		embedder.createEmbeddings.mockRejectedValue(Object.assign(new Error("limited"), { status: 429 }))
		await expect(service.searchIndex("query")).rejects.toBeInstanceOf(SearchProviderRateLimitError)
		expect(embedder.createEmbeddings).toHaveBeenCalledOnce()
	})

	it("rejects when the feature is disabled", async () => {
		const { service } = prepare("Indexed", { enabled: false })
		await expect(service.searchIndex("query")).rejects.toThrow("disabled or not configured")
	})
})
