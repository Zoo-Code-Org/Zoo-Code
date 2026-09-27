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
