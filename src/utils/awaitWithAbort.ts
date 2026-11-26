/** Race a pending operation with cancellation without retaining one listener per completed operation. */
export async function awaitWithAbort<T>(
	operation: Promise<T>,
	signal?: AbortSignal,
	message = "Request cancelled by user",
): Promise<T> {
	if (!signal) return operation
	let onAbort: (() => void) | undefined
	try {
		return await Promise.race([
			operation,
			new Promise<never>((_, reject) => {
				onAbort = () => reject(new Error(message))
				if (signal.aborted) onAbort()
				else signal.addEventListener("abort", onAbort, { once: true })
			}),
		])
	} finally {
		if (onAbort) signal.removeEventListener("abort", onAbort)
	}
}
