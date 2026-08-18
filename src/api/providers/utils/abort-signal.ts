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
