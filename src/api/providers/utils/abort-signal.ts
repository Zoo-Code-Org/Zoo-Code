/**
 * Whether a timeout value is usable as an SDK `timeout` option: a finite
 * number greater than zero.
 *
 * The value `0` means "no explicit timeout" across this series (the SDKs turn
 * `timeout: 0` into an immediate abort), and negative, `NaN`, `Infinity` and
 * fractional values make the SDK's own validation throw — so none of them may
 * be forwarded.
 */
export function hasUsableTimeout(timeoutMs?: number): timeoutMs is number {
	return typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
}

/** Maximum delay a Node timer (and therefore an SDK timeout option) accepts. */
export const MAX_TIMEOUT_MS = 2_147_483_647

/**
 * Convert a validated timeout to the value forwarded to an SDK or Node timer:
 * round fractions up (uint32 validation rejects them) and cap at the maximum
 * delay (Node clamps larger values to 1 ms otherwise).
 */
export function toSdkTimeoutMs(timeoutMs: number): number {
	return Math.min(Math.max(1, Math.ceil(timeoutMs)), MAX_TIMEOUT_MS)
}

/**
 * Merge an optional external abort signal with an optional timeout.
 *
 * Timeout values <= 0 and non-finite values are treated as disabled; finite
 * delays above 2^31-1 ms are capped (Node clamps them to 1 ms otherwise). The timeout is created via the
 * native AbortSignal.timeout() API, which self-manages its timer — callers do
 * not need to (and cannot) clear it manually.
 */
export function mergeAbortSignalAndTimeout(externalSignal?: AbortSignal, timeoutMs?: number): AbortSignal | undefined {
	// Node's AbortSignal.timeout() throws ERR_OUT_OF_RANGE for non-integer
	// delays (Infinity) and clamps delays above 2^31-1 ms to 1 ms, which would
	// abort almost immediately; treat non-finite values as "no timeout",
	// round fractional delays up to whole milliseconds (uint32 validation
	// throws for 1500.5), and cap the rest.
	const hasTimeout = hasUsableTimeout(timeoutMs)

	if (!hasTimeout) {
		return externalSignal
	}

	const timeoutSignal = AbortSignal.timeout(toSdkTimeoutMs(timeoutMs))

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
 * Bridge an optional caller-owned (external) abort signal to a per-request
 * signal, with an explicit detach handle.
 *
 * The returned `signal` aborts together with the external signal (immediately
 * if it is already aborted). Callers must invoke `dispose()` once the request
 * ends - on completion, failure, and early generator exit alike: the listener
 * is registered on the caller's long-lived signal, and an anonymous listener
 * left attached would outlive the request and retain the per-request
 * controller for every completed request.
 *
 * With no external signal, returns `{ signal: undefined, dispose: noop }` so
 * the client-level timeout remains the only cancellation mechanism.
 */
export function bridgeExternalAbortSignal(externalSignal?: AbortSignal): {
	signal?: AbortSignal
	dispose: () => void
} {
	if (!externalSignal) {
		return { signal: undefined, dispose: () => {} }
	}

	const controller = new AbortController()
	if (externalSignal.aborted) {
		controller.abort()
		return { signal: controller.signal, dispose: () => {} }
	}

	// Retain the callback so the listener can be detached once this request
	// ends: an anonymous listener on a long-lived external signal would
	// outlive the request and retain the per-request controller.
	const onExternalAbort = () => controller.abort()
	externalSignal.addEventListener("abort", onExternalAbort, { once: true })
	return {
		signal: controller.signal,
		dispose: () => externalSignal.removeEventListener("abort", onExternalAbort),
	}
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
 * Whether a failure indicates an aborted request: the caller's signal fired,
 * an `Error` carries a native abort error name (`AbortError`,
 * `APIUserAbortError`), or an `Error` carries the OpenAI SDK abort error
 * message (exactly "Request was aborted.").
 *
 * The name and message checks require an `Error` instance on purpose: a
 * plain object that merely looks like an abort must propagate unchanged so
 * callers can inspect the real failure shape. The message check is an exact
 * match on purpose: a substring match would misclassify unrelated errors
 * that merely mention aborting.
 */
export function isRequestAborted(error: unknown, signal?: AbortSignal): boolean {
	const hasAbortName = error instanceof Error && (error.name === "AbortError" || error.name === "APIUserAbortError")
	const hasSdkAbortMessage = error instanceof Error && error.message === "Request was aborted."
	return Boolean(signal?.aborted) || hasAbortName || hasSdkAbortMessage
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

/**
 * Await `pending` but reject with the provider's abort error when `signal`
 * aborts first. For async phases that have no native signal support (model
 * discovery) yet must still settle promptly on cancellation. The underlying
 * promise keeps running (its settlement is ignored) — cancellation is
 * cooperative at this boundary.
 *
 * The abort listener is detached once `pending` settles (success or
 * failure), so repeated calls on one signal do not accumulate listeners.
 */
export function rejectOnAbort<T>(pending: Promise<T>, signal: AbortSignal, providerName: string): Promise<T> {
	if (signal.aborted) {
		// The caller has already cancelled, so this branch never consumes `pending`;
		// attach a handler anyway so a rejecting `pending` cannot surface as an
		// unhandled rejection.
		void pending.catch(() => {})
		return Promise.reject(createAbortError(providerName))
	}
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(createAbortError(providerName))
		signal.addEventListener("abort", onAbort, { once: true })
		void pending.then(
			(value) => {
				signal.removeEventListener("abort", onAbort)
				resolve(value)
			},
			(error) => {
				signal.removeEventListener("abort", onAbort)
				reject(error)
			},
		)
	})
}

/**
 * Resolve a provider's model metadata inside a cancellation scope.
 *
 * A pre-aborted signal rejects immediately with the standardized AbortError
 * before any lookup starts; a signal that fires while the lookup is pending
 * settles via {@link rejectOnAbort} instead of waiting for the catalog to
 * resolve. Abort failures from the lookup itself are normalized to the
 * provider AbortError; any other resolution failure propagates unchanged.
 *
 * Accepts a provider-specific resolution step so the entry guard, race, and
 * normalization can share one implementation. Direct contract tests cover
 * this helper; providers do not currently call it.
 *
 * @internal Shared cancellation helper retained with direct contract tests for provider adoption.
 */
export async function resolveModelWithAbort<T>(
	fetchModel: () => Promise<T>,
	abortSignal: AbortSignal | undefined,
	providerName: string,
): Promise<T> {
	if (abortSignal?.aborted) {
		throw createAbortError(providerName)
	}

	try {
		if (abortSignal) {
			return await rejectOnAbort(fetchModel(), abortSignal, providerName)
		}
		return await fetchModel()
	} catch (error) {
		if (isRequestAborted(error, abortSignal)) {
			throw createAbortError(providerName)
		}
		throw error
	}
}
