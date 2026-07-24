export type MergedAbortSignal = {
	signal?: AbortSignal
	cleanup: () => void
}

const noop = () => {}

/**
 * Merge an optional external abort signal with an optional timeout.
 *
 * Timeout values <= 0 are treated as disabled. Call cleanup() from a finally
 * block to clear any pending timeout created by this helper.
 */
export function mergeAbortSignalAndTimeout(externalSignal?: AbortSignal, timeoutMs?: number): MergedAbortSignal {
	const hasTimeout = typeof timeoutMs === "number" && timeoutMs > 0

	if (!externalSignal && !hasTimeout) {
		return { cleanup: noop }
	}

	if (externalSignal && !hasTimeout) {
		return { signal: externalSignal, cleanup: noop }
	}

	const timeoutController = new AbortController()
	const timeoutId = setTimeout(() => timeoutController.abort(), timeoutMs)
	const cleanup = () => clearTimeout(timeoutId)

	if (!externalSignal) {
		return { signal: timeoutController.signal, cleanup }
	}

	return { signal: mergeAbortSignals(externalSignal, timeoutController.signal), cleanup }
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
