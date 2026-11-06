import { hasUsableTimeout, toSdkTimeoutMs } from "./abort-signal"

/**
 * Returns the value to pass as a client/SDK request timeout option, or undefined.
 *
 * Per the abort-signal series contract, timeoutMs <= 0, non-finite values
 * (or undefined) mean 'no per-request timeout': the option is omitted
 * entirely, because some SDKs (e.g. the OpenAI Node SDK) treat timeout: 0 as
 * an IMMEDIATE timeout. Values that do survive validation are handed to
 * toSdkTimeoutMs, which rounds fractions up (AbortSignal.timeout validates its
 * delay as uint32 and throws for fractions) and caps them at the maximum timer
 * delay: a Node timer clamps anything past 2^31-1 ms to ~1 ms, which would
 * abort the request almost immediately instead of honouring the timeout.
 */
export function getRequestTimeoutMs(timeoutMs?: number): number | undefined {
	return hasUsableTimeout(timeoutMs) ? toSdkTimeoutMs(timeoutMs) : undefined
}

/**
 * Fresh error for a per-request deadline elapsing in a given phase.
 *
 * Distinct from the abort contract error on purpose: a timeout is not a user
 * cancellation, and callers treat the two differently.
 */
export function createTimeoutError(providerName: string, phase: "model discovery" | "completion request"): Error {
	const timeoutError = new Error(`The ${providerName} ${phase} timed out`)
	timeoutError.name = "TimeoutError"
	return timeoutError
}
