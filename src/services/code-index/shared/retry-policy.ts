import { APIUserAbortError } from "openai"
import { FILE_RETRY_ATTEMPTS, FILE_RETRY_BASE_DELAY_MS } from "../constants"
import { waitForRetry } from "../embedders/cancellation"
import { classifyIndexingError, IndexingRetryError, type IndexingErrorClassification } from "./indexing-errors"
import type { FileFailureActivity } from "../file-failure-registry"

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
