import { CodeIndexSearchService } from "../search-service"
import { ProviderPacerRegistry } from "../provider-pacer"
import type { CodeIndexConfigManager } from "../config-manager"
import type { CodeIndexStateManager } from "../state-manager"
import type { IEmbedder, IVectorStore } from "../interfaces"

vi.mock("@roo-code/telemetry", () => ({ TelemetryService: { instance: { captureEvent: vi.fn() } } }))

describe("CodeIndexSearchService", () => {
	it("waits on the scope's pacer and retries a 429", async () => {
		const pacers = new ProviderPacerRegistry()
		const run = vi.spyOn(pacers.get("openai:1"), "run")
		const createEmbeddings = vi.fn<IEmbedder["createEmbeddings"]>().mockResolvedValue({ embeddings: [[0.1]] })
		const search = vi.fn<IVectorStore["search"]>().mockResolvedValue([])
		// Doubles provide only the members searchIndex reads.
		const service = new CodeIndexSearchService(
			{
				isFeatureEnabled: true,
				isFeatureConfigured: true,
				currentSearchMinScore: 0.4,
				currentSearchMaxResults: 10,
			} as unknown as CodeIndexConfigManager,
			{
				getCurrentStatus: () => ({ systemStatus: "Indexed" }),
				setSystemState: vi.fn(),
			} as unknown as CodeIndexStateManager,
			{ createEmbeddings, rateLimitScope: "openai:1" } as unknown as IEmbedder,
			{ search } as unknown as IVectorStore,
			pacers,
		)

		vi.useFakeTimers()
		createEmbeddings.mockRejectedValueOnce(Object.assign(new Error("limited"), { status: 429, retryAfterMs: 5000 }))
		const pending = service.searchIndex("query")
		await vi.advanceTimersByTimeAsync(4999)
		expect(createEmbeddings).toHaveBeenCalledTimes(1)
		expect(search).not.toHaveBeenCalled()
		await vi.advanceTimersByTimeAsync(1)
		await expect(pending).resolves.toEqual([])
		vi.useRealTimers()
		expect(createEmbeddings).toHaveBeenCalledTimes(2)
		expect(run).toHaveBeenCalledTimes(1)
		expect(search).toHaveBeenCalledWith([0.1], undefined, 0.4, 10)
	})
})
