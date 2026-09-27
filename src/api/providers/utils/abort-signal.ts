/**
 * Merge an optional external abort signal with an optional timeout.
 *
 * Timeout values <= 0 are treated as disabled. The timeout is created via the
 * native AbortSignal.timeout() API, which self-manages its timer — callers do
 * not need to (and cannot) clear it manually.
 */
export function mergeAbortSignalAndTimeout(externalSignal?: AbortSignal, timeoutMs?: number): AbortSignal | undefined {
	const hasTimeout = typeof timeoutMs === "number" && timeoutMs > 0

	if (!hasTimeout) {
		return externalSignal
	}

	const timeoutSignal = AbortSignal.timeout(timeoutMs)

	if (!externalSignal) {
		return timeoutSignal
	}

	return mergeAbortSignals(externalSignal, timeoutSignal)
}

/**
 * Merge two abort signals using the standard AbortSignal.any() API.
 *
 * Returns the primary signal directly when no secondary signal is provided to
 * avoid creating unnecessary controllers/listeners for the common single-signal
 * path.
 */
export function mergeAbortSignals(primarySignal: AbortSignal, secondarySignal?: AbortSignal): AbortSignal {
	if (!secondarySignal) {
		return primarySignal
	}

	return AbortSignal.any([primarySignal, secondarySignal])
}

/**
 * Throw an AbortError if the given signal is already aborted.
 *
 * Use as a fast-fail guard at the top of request-building code paths so
 * callers receive a consistent `name === "AbortError"` when the operation
 * was cancelled before it started, without building or issuing the request.
 */
export function throwIfAborted(signal?: AbortSignal): void {
	if (!signal?.aborted) {
		return
	}

	const abortError = new Error("This operation was aborted")
	abortError.name = "AbortError"
	throw abortError
}

/**
 * Request options this series passes to the OpenAI SDK call. The SDK's
 * `RequestOptions` declares `signal` as `AbortSignal | null | undefined`,
 * which does not satisfy the builder's base constraint, so the builder is
 * typed with only the options this series sets. The built config is still
 * assignable to the SDK's `RequestOptions`.
 */
export type OpenAiRequestOptions = {
	signal?: AbortSignal
}

/**
 * Whether a failure indicates an aborted request: the caller's signal fired,
 * the SDK raised a native abort error, or the error carries the OpenAI SDK
 * abort error message (exactly "Request was aborted."). The message check
 * is an exact match on purpose: a substring match would misclassify
 * unrelated errors that merely mention aborting.
 */
export function isRequestAborted(error: unknown, signal?: AbortSignal): boolean {
	const candidate = error as { name?: string; message?: string }
	return (
		Boolean(signal?.aborted) ||
		candidate?.name === "AbortError" ||
		candidate?.name === "APIUserAbortError" ||
		candidate?.message === "Request was aborted."
	)
}

/**
 * Fresh error satisfying the Task.ts abort contract: `name ===
 * "AbortError"` and a message ending in "aborted" (no trailing period). The
 * OpenAI SDK's own abort error does not satisfy this contract (name "Error",
 * message "Request was aborted."), so raw SDK abort errors must be
 * normalized instead of rethrown.
 */
export function createAbortError(providerName: string): Error {
	const abortError = new Error(`The ${providerName} request was aborted`)
	abortError.name = "AbortError"
	return abortError
}
