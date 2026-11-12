import * as path from "path"
import type { VectorStoreSearchResult } from "./interfaces/vector-store"
import type { IEmbedder } from "./interfaces/embedder"
import type { IVectorStore } from "./interfaces/vector-store"
import type { CodeIndexConfigManager } from "./config-manager"
import type { CodeIndexStateManager } from "./state-manager"
import { codeIndexLog } from "./code-index-log"
import type { FileFailureRegistry } from "./file-failure-registry"
import { retryWithPolicy } from "./shared/retry-policy"
import { ProviderPacerRegistry } from "./provider-pacer"
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
		private readonly embedder: Pick<IEmbedder, "createEmbeddings" | "rateLimitScope">,
		private readonly vectorStore: Pick<IVectorStore, "search" | "collectionExists">,
		private readonly failures: FileFailureRegistry,
		private readonly providerPacers: ProviderPacerRegistry,
		private readonly getCurrentStatus: () => Pick<
			ReturnType<CodeIndexStateManager["getCurrentStatus"]>,
			"systemStatus"
		> = () => this.stateManager.getCurrentStatus(),
	) {}

	public async searchIndex(
		query: string,
		directoryPrefix?: string,
		signal?: AbortSignal,
	): Promise<CodeIndexSearchResponse> {
		signal?.throwIfAborted()
		if (!this.configManager.isFeatureEnabled || !this.configManager.isFeatureConfigured) {
			throw new Error("Code index feature is disabled or not configured.")
		}

		const minScore = this.configManager.currentSearchMinScore
		const maxResults = this.configManager.currentSearchMaxResults

		try {
			let currentState = this.getCurrentStatus().systemStatus
			let partialStandby = false
			if (
				currentState === "Standby" &&
				(this.failures.list().length > 0 || this.providerPacers.waitingPaths().length > 0)
			) {
				partialStandby = await this.vectorStore.collectionExists()
				signal?.throwIfAborted()
				currentState = this.getCurrentStatus().systemStatus
				partialStandby &&=
					currentState === "Standby" &&
					(this.failures.list().length > 0 || this.providerPacers.waitingPaths().length > 0)
			}
			if (currentState !== "Indexed" && currentState !== "Indexing" && !partialStandby) {
				throw new Error(`Code index is not ready for search. Current state: ${currentState}`)
			}

			const pacer = this.providerPacers.get(this.embedder.rateLimitScope)
			const embeddingResponse = await retryWithPolicy(
				async () => {
					const issueSeq = pacer.markIssued()
					try {
						return await this.embedder.createEmbeddings([query], undefined, signal)
					} catch (error) {
						signal?.throwIfAborted()
						if (classifyIndexingError(error) !== "rate-limit") throw error
						pacer.reportRateLimit(error, issueSeq)
						throw new SearchProviderRateLimitError(t("embeddings:searchProviderRateLimited"), error)
					}
				},
				{ signal, budget: { retriesUsed: 0 } },
			)
			signal?.throwIfAborted()
			const vector = embeddingResponse?.embeddings[0]
			if (!vector) {
				throw new Error("Failed to generate embedding for query.")
			}

			let normalizedPrefix: string | undefined = undefined
			if (directoryPrefix) {
				normalizedPrefix = path.normalize(directoryPrefix)
			}

			const results = await this.vectorStore.search(vector, normalizedPrefix, minScore, maxResults)
			signal?.throwIfAborted()
			const failedPaths = this.failures.list().map((failure) => failure.path)
			const waitingPaths = this.providerPacers.waitingPaths()
			return { results, incomplete: failedPaths.length > 0 || waitingPaths.length > 0, failedPaths, waitingPaths }
		} catch (error) {
			signal?.throwIfAborted()
			codeIndexLog.error("Search failed", { error })
			throw error
		}
	}
}
