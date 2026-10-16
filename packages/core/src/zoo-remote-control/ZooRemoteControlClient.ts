import {
	zooRemoteCommandsResponseSchema,
	type ZooRemoteCommandAck,
	type ZooRemoteCommandsResponse,
	type ZooRemoteEvent,
	type ZooRemotePresence,
	type ZooRemoteSnapshot,
} from "./types.js"

export type ZooRemoteControlClientOptions = {
	getBaseUrl: () => string
	getSessionToken: () => string
	fetchFn?: typeof fetch
	log?: (message: string) => void
}

/**
 * Thin HTTP client for /api/extension/remote/* using the Zoo session token.
 * Callers treat route-missing 404 as "server not ready" and back off.
 * Ack 404 (command_not_found) must not use the same backoff path.
 */
export class ZooRemoteControlClient {
	private readonly getBaseUrl: () => string
	private readonly getSessionToken: () => string
	private readonly fetchFn: typeof fetch
	private readonly log: (message: string) => void

	constructor(options: ZooRemoteControlClientOptions) {
		this.getBaseUrl = options.getBaseUrl
		this.getSessionToken = options.getSessionToken
		this.fetchFn = options.fetchFn ?? fetch
		this.log = options.log ?? (() => {})
	}

	async postPresence(presence: ZooRemotePresence): Promise<{ ok: boolean; status: number }> {
		return this.request("POST", "/api/extension/remote/presence", presence)
	}

	async postEvents(instanceId: string, events: ZooRemoteEvent[]): Promise<{ ok: boolean; status: number }> {
		return this.request("POST", "/api/extension/remote/events", { instanceId, events })
	}

	async postSnapshot(snapshot: ZooRemoteSnapshot): Promise<{ ok: boolean; status: number }> {
		return this.request("POST", "/api/extension/remote/snapshot", snapshot)
	}

	async getCommands(instanceId: string): Promise<{
		ok: boolean
		status: number
		body?: ZooRemoteCommandsResponse
	}> {
		const result = await this.requestJson(
			"GET",
			`/api/extension/remote/commands?instanceId=${encodeURIComponent(instanceId)}`,
			undefined,
			zooRemoteCommandsResponseSchema,
		)
		return result
	}

	async ackCommand(ack: ZooRemoteCommandAck): Promise<{ ok: boolean; status: number }> {
		return this.request("POST", `/api/extension/remote/commands/${encodeURIComponent(ack.commandId)}/ack`, ack)
	}

	private async request(method: string, path: string, body?: unknown): Promise<{ ok: boolean; status: number }> {
		const result = await this.requestJson(method, path, body)
		return { ok: result.ok, status: result.status }
	}

	private async requestJson<T>(
		method: string,
		path: string,
		body: unknown | undefined,
		schema?: { parse: (data: unknown) => T },
	): Promise<{ ok: boolean; status: number; body?: T }> {
		const token = this.getSessionToken()
		if (!token) {
			return { ok: false, status: 401 }
		}

		const url = `${this.getBaseUrl().replace(/\/$/, "")}${path}`

		try {
			const response = await this.fetchFn(url, {
				method,
				headers: {
					Authorization: `Bearer ${token}`,
					Accept: "application/json",
					...(body !== undefined ? { "Content-Type": "application/json" } : {}),
				},
				...(body !== undefined ? { body: JSON.stringify(body) } : {}),
			})

			if (!response.ok) {
				if (response.status !== 404) {
					this.log(`[ZooRemoteControl] ${method} ${path} -> ${response.status}`)
				}
				return { ok: false, status: response.status }
			}

			if (!schema) {
				return { ok: true, status: response.status }
			}

			const json: unknown = await response.json()
			return { ok: true, status: response.status, body: schema.parse(json) }
		} catch (error) {
			this.log(
				`[ZooRemoteControl] ${method} ${path} failed: ${error instanceof Error ? error.message : String(error)}`,
			)
			return { ok: false, status: 0 }
		}
	}
}
