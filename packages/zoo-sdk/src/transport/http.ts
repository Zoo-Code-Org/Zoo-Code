import type { TransportRequest, ZooTransport } from "./types.js"

export type HttpTransportOptions = {
	/** Base URL for the Zoo CLI server. */
	baseUrl: string
	/** Optional fetch implementation for tests or host environments. */
	fetch?: typeof fetch
	/** Headers sent with every request. */
	headers?: Record<string, string>
}

function normalize(baseUrl: string, path: string) {
	return new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString()
}

async function parse(response: Response) {
	if (!response.ok) throw new Error(`Zoo server request failed: ${response.status} ${response.statusText}`)
	if (response.status === 204) return undefined
	const text = await response.text()
	if (!text) return undefined
	return JSON.parse(text)
}

async function* lines(response: Response) {
	if (!response.ok) throw new Error(`Zoo server stream failed: ${response.status} ${response.statusText}`)
	if (!response.body) return
	const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
	let buffer = ""
	while (true) {
		const { value, done } = await reader.read()
		if (done) break
		buffer += value
		let index: number
		while ((index = buffer.indexOf("\n")) >= 0) {
			const line = buffer.slice(0, index).trim()
			buffer = buffer.slice(index + 1)
			if (!line) continue
			yield line.startsWith("data:") ? line.slice(5).trim() : line
		}
	}
	const tail = buffer.trim()
	if (tail) yield tail.startsWith("data:") ? tail.slice(5).trim() : tail
}

/** Create an HTTP transport for a running Zoo CLI server. */
export function createHttpTransport(options: HttpTransportOptions): ZooTransport {
	const fetcher = options.fetch ?? fetch
	return {
		async request<T>(request: TransportRequest): Promise<T> {
			const response = await fetcher(normalize(options.baseUrl, request.path), {
				method: request.method ?? "GET",
				headers: {
					...options.headers,
					...request.headers,
					...(request.body === undefined ? {} : { "content-type": "application/json" }),
				},
				body: request.body === undefined ? undefined : JSON.stringify(request.body),
				duplex: "half",
			} as RequestInit)
			return (await parse(response)) as T
		},
		async *stream(request: TransportRequest): AsyncIterableIterator<unknown> {
			const response = await fetcher(normalize(options.baseUrl, request.path), {
				method: request.method ?? "GET",
				headers: {
					accept: "text/event-stream, application/x-ndjson, application/json",
					...options.headers,
					...request.headers,
					...(request.body === undefined ? {} : { "content-type": "application/json" }),
				},
				body: request.body === undefined ? undefined : JSON.stringify(request.body),
				duplex: "half",
			} as RequestInit)
			for await (const line of lines(response)) {
				if (line === "[DONE]") return
				yield JSON.parse(line)
			}
		},
	}
}
