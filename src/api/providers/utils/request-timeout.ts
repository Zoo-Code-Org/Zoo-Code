/**
 * Returns the value to pass as a client/SDK request timeout option, or undefined.
 *
 * Per the abort-signal series contract, timeoutMs <= 0 (or undefined) means
 * 'no per-request timeout': the option is omitted entirely, because some SDKs
 * (e.g. the OpenAI Node SDK) treat timeout: 0 as an IMMEDIATE timeout.
 */
export function getRequestTimeoutMs(timeoutMs?: number): number | undefined {
	return typeof timeoutMs === "number" && timeoutMs > 0 ? timeoutMs : undefined
}
