export type JsonObject = Record<string, unknown>
export type CodexResponseEvent = JsonObject & { type: string }

export interface CodexWebSocketOptions {
	headers: Record<string, string>
	signal: AbortSignal
	timeoutMs: number
}
