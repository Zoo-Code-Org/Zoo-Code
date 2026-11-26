export async function* asyncStreamFrom<T>(chunks: T[]): AsyncGenerator<T> {
	for (const chunk of chunks) {
		yield chunk
	}
}

export async function collectStream<T>(stream: AsyncIterable<T>): Promise<T[]> {
	const chunks: T[] = []
	for await (const chunk of stream) {
		chunks.push(chunk)
	}
	return chunks
}

export function sseResponse(body: string): Response {
	return new Response(body, { headers: { "content-type": "text/event-stream" } })
}
