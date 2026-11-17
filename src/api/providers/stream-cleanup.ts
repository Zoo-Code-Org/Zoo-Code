/**
 * Forward chunks from an async iterable and run the cleanup callback once when
 * iteration ends: normal completion, a failure from the underlying stream, or
 * an early stop by the consumer. Providers use this to detach a bridged
 * external abort listener as soon as the request's stream has finished,
 * keeping the cleanup out of the (existing) stream loop body.
 */
export async function* withFinallyCleanup<T>(
	stream: AsyncIterable<T>,
	cleanup: (() => void) | undefined,
): AsyncGenerator<T> {
	try {
		for await (const chunk of stream) {
			yield chunk
		}
	} finally {
		cleanup?.()
	}
}
