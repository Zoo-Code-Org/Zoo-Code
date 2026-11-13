import * as path from "path"
import { TelemetryService } from "@roo-code/telemetry"
import { TelemetryEventName } from "@roo-code/types"
import type { VectorStoreSearchResult } from "./interfaces/vector-store"
import type { IEmbedder } from "./interfaces/embedder"
import type { IVectorStore } from "./interfaces/vector-store"
import type { CodeIndexConfigManager } from "./config-manager"
import type { CodeIndexStateManager } from "./state-manager"
import type { FileFailureRegistry } from "./file-failure-registry"
import type { ProviderPacerRegistry } from "./provider-pacer"
import { retryWithPolicy } from "./shared/retry-policy"
import { classifyIndexingError, SearchProviderRateLimitError } from "./shared/indexing-errors"
import { t } from "../../i18n"

export interface CodeIndexSearchResponse {
	results: VectorStoreSearchResult[]
	incomplete: boolean
	failedPaths: string[]
	waitingPaths: string[]
}

/**
 * Service responsible for searching the code index.
 */
export class CodeIndexSearchService {
	constructor(
		private readonly configManager: Pick<
			CodeIndexConfigManager,
			"isFeatureEnabled" | "isFeatureConfigured" | "currentSearchMinScore" | "currentSearchMaxResults"
		>,
		private readonly stateManager: Pick<CodeIndexStateManager, "getCurrentStatus">,
		private readonly embedder: Pick<IEmbedder, "createEmbeddings">,
		private readonly vectorStore: Pick<IVectorStore, "search" | "collectionExists">,
		private readonly failures: Pick<FileFailureRegistry, "list">,
		private readonly providerPacers: Pick<ProviderPacerRegistry, "waitingPaths">,
	) {}

	public async searchIndex(query: string, directoryPrefix?: string): Promise<CodeIndexSearchResponse> {
		if (!this.configManager.isFeatureEnabled || !this.configManager.isFeatureConfigured) {
			throw new Error("Code index feature is disabled or not configured.")
		}

		const minScore = this.configManager.currentSearchMinScore
		const maxResults = this.configManager.currentSearchMaxResults

		const currentState = this.stateManager.getCurrentStatus().systemStatus
		const partialStandby =
			currentState === "Standby" && this.hasOutstandingWork() && (await this.vectorStore.collectionExists())
		if (currentState !== "Indexed" && currentState !== "Indexing" && !partialStandby) {
			throw new Error(`Code index is not ready for search. Current state: ${currentState}`)
		}

		try {
			const embeddingResponse = await retryWithPolicy(
				async () => {
					try {
						return await this.embedder.createEmbeddings([query])
					} catch (error) {
						if (classifyIndexingError(error) !== "rate-limit") throw error
						throw new SearchProviderRateLimitError(t("embeddings:searchProviderRateLimited"), error)
					}
				},
				{ budget: { retriesUsed: 0 } },
			)
			const vector = embeddingResponse?.embeddings[0]
			if (!vector) {
				throw new Error("Failed to generate embedding for query.")
			}

			let normalizedPrefix: string | undefined = undefined
			if (directoryPrefix) {
				normalizedPrefix = path.normalize(directoryPrefix)
			}

			const results = await this.vectorStore.search(vector, normalizedPrefix, minScore, maxResults)
			const failedPaths = [...new Set(this.failures.list().map((failure) => failure.path))]
			const waitingPaths = this.providerPacers.waitingPaths()
			const scanning = this.stateManager.getCurrentStatus().systemStatus === "Indexing"
			return {
				results,
				incomplete: scanning || failedPaths.length > 0 || waitingPaths.length > 0,
				failedPaths,
				waitingPaths,
			}
		} catch (error) {
			console.error("[CodeIndexSearchService] Error during search:", error)
			TelemetryService.instance.captureEvent(TelemetryEventName.CODE_INDEX_ERROR, {
				error: (error as Error).message,
				stack: (error as Error).stack,
				location: "searchIndex",
			})
			throw error
		}
	}

	private hasOutstandingWork(): boolean {
		return this.failures.list().length > 0 || this.providerPacers.waitingPaths().length > 0
	}
}
