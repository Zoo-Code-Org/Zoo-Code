import { APIUserAbortError } from "openai"
import { FILE_RETRY_ATTEMPTS, FILE_RETRY_BASE_DELAY_MS, PACED_EMBEDDING_TIMEOUT_MS } from "../constants"
import { waitForRetry } from "../embedders/cancellation"
import { classifyIndexingError, IndexingRetryError, type IndexingErrorClassification } from "./indexing-errors"
import type { FileFailureActivity } from "../file-failure-registry"
import type { EmbeddingResponse, IEmbedder } from "../interfaces/embedder"
import type { ProviderPacerRegistry } from "../provider-pacer"

export interface RetryBudget {
	retriesUsed: number
}

export interface RetryFailure {
	error: unknown
	attempt: number
	classification: IndexingErrorClassification
	willRetry: boolean
	delayMs: number
	delaySource: "default"
}

export interface RetryPolicyOptions {
	signal?: AbortSignal
	activity?: FileFailureActivity
	budget?: RetryBudget
	onFailure?: (failure: RetryFailure) => void
}

export async function retryWithPolicy<T>(
	operation: () => Promise<T>,
	{ signal, activity, budget = { retriesUsed: 0 }, onFailure }: RetryPolicyOptions = {},
): Promise<T> {
	while (true) {
		signal?.throwIfAborted()
		try {
			return await operation()
		} catch (error) {
			signal?.throwIfAborted()
			const classification = classifyIndexingError(error, signal)
			if (classification === "rate-limit") throw error
			const attempt = budget.retriesUsed + 1
			const willRetry = classification !== "permanent" && attempt < FILE_RETRY_ATTEMPTS
			const delayMs = willRetry ? FILE_RETRY_BASE_DELAY_MS * 2 ** budget.retriesUsed : 0
			if (willRetry) budget.retriesUsed++
			onFailure?.({
				error,
				attempt,
				classification,
				willRetry,
				delayMs,
				delaySource: "default",
			})
			if (!willRetry) {
				if (
					error instanceof APIUserAbortError ||
					(error &&
						typeof error === "object" &&
						"name" in error &&
						(error.name === "AbortError" || error.name === "APIUserAbortError"))
				)
					throw error
				throw new IndexingRetryError(error, attempt, classification, activity)
			}
			await waitForRetry(delayMs, signal)
		}
	}
}

/**
 * Embeds texts through the scope's pacer (429 waits) and the retry policy (other transient errors).
 * Callers without a stop signal get a time limit, because the pacer waits on 429 with no attempt limit.
 */
export function createPacedEmbeddings(
	embedder: Pick<IEmbedder, "createEmbeddings" | "rateLimitScope">,
	pacers: Pick<ProviderPacerRegistry, "get">,
	texts: string[],
	signal: AbortSignal = AbortSignal.timeout(PACED_EMBEDDING_TIMEOUT_MS),
	path?: string,
): Promise<EmbeddingResponse> {
	return retryWithPolicy(
		() => pacers.get(embedder.rateLimitScope).run(path, signal, () => embedder.createEmbeddings(texts)),
		{ signal },
	)
}
