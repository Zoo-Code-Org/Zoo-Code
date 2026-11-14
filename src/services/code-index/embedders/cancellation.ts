export function waitForRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
	signal?.throwIfAborted()
	return new Promise((resolve, reject) => {
		const onAbort = () => {
			clearTimeout(timeout)
			signal?.removeEventListener("abort", onAbort)
			reject(signal?.reason)
		}
		const timeout = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort)
			resolve()
		}, delayMs)
		signal?.addEventListener("abort", onAbort, { once: true })
	})
}
