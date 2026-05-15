import http from "node:http"
import type { TransportRequest, ZooTransport } from "./types.js"

export type IpcTransportOptions = {
	/** Unix socket path exposed by `zoo server --ipc`. */
	ipcPath: string
	/** Headers sent with every request. */
	headers?: Record<string, string>
}

function body(input: unknown) {
	if (input === undefined) return undefined
	return JSON.stringify(input)
}

function requestRaw(options: IpcTransportOptions, input: TransportRequest) {
	const payload = body(input.body)
	return new Promise<http.IncomingMessage>((resolve, reject) => {
		const req = http.request(
			{
				socketPath: options.ipcPath,
				path: input.path,
				method: input.method ?? "GET",
				headers: {
					...options.headers,
					...input.headers,
					...(payload === undefined
						? {}
						: { "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)) }),
				},
			},
			resolve,
		)
		req.on("error", reject)
		if (payload !== undefined) req.write(payload)
		req.end()
	})
}

async function readAll(response: http.IncomingMessage) {
	const chunks: Buffer[] = []
	for await (const chunk of response) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
	return Buffer.concat(chunks).toString("utf8")
}

/** Create an IPC transport for a Zoo CLI Unix-socket server. */
export function createIpcTransport(options: IpcTransportOptions): ZooTransport {
	return {
		async request<T>(request: TransportRequest): Promise<T> {
			const response = await requestRaw(options, request)
			if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
				throw new Error(`Zoo IPC request failed: ${response.statusCode ?? "unknown"}`)
			}
			const text = await readAll(response)
			return (text ? JSON.parse(text) : undefined) as T
		},
		async *stream(request: TransportRequest): AsyncIterableIterator<unknown> {
			const response = await requestRaw(options, request)
			if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
				throw new Error(`Zoo IPC stream failed: ${response.statusCode ?? "unknown"}`)
			}
			let buffer = ""
			for await (const chunk of response) {
				buffer += chunk.toString()
				let index: number
				while ((index = buffer.indexOf("\n")) >= 0) {
					const line = buffer.slice(0, index).trim()
					buffer = buffer.slice(index + 1)
					if (!line) continue
					const payload = line.startsWith("data:") ? line.slice(5).trim() : line
					if (payload === "[DONE]") return
					yield JSON.parse(payload)
				}
			}
			const tail = buffer.trim()
			if (tail) yield JSON.parse(tail.startsWith("data:") ? tail.slice(5).trim() : tail)
		},
	}
}
