import { createHttpTransport, createIpcTransport, type ZooTransport } from "./transport/index.js"
import type {
	MessageChunk,
	Mode,
	ConfigWarning,
	ConfigProvidersResult,
	PermissionAlwaysRules,
	PermissionReply,
	PermissionRequest,
	SendMessageOptions,
	Session,
	SessionCreateOptions,
	SessionListOptions,
	ZooEvent,
	ZooConfig,
	ZooServerEvent,
} from "./types.js"

export type ZooClientConnectOptions =
	| { transport: ZooTransport }
	| { baseUrl: string; fetch?: typeof fetch; headers?: Record<string, string> }
	| { hostname?: string; port: number; fetch?: typeof fetch; headers?: Record<string, string> }
	| { ipcPath: string; headers?: Record<string, string> }

type Handler = (event: ZooEvent) => void

function transportFrom(options: ZooClientConnectOptions) {
	if ("transport" in options) return options.transport
	if ("ipcPath" in options) return createIpcTransport(options)
	if ("baseUrl" in options) return createHttpTransport(options)
	return createHttpTransport({
		baseUrl: `http://${options.hostname ?? "127.0.0.1"}:${options.port}`,
		fetch: options.fetch,
		headers: options.headers,
	})
}

function unwrap<T>(value: T | { data?: T }) {
	if (value && typeof value === "object" && "data" in value) return (value as { data?: T }).data as T
	return value as T
}

/** Client for the Zoo Code portable-core server. */
export class ZooClient {
	readonly #transport: ZooTransport
	readonly #handlers = new Map<string, Set<Handler>>()

	private constructor(transport: ZooTransport) {
		this.#transport = transport
	}

	/** Connect to a running Zoo CLI server over HTTP, IPC, or a custom transport. */
	static async connect(options: ZooClientConnectOptions): Promise<ZooClient> {
		return new ZooClient(transportFrom(options))
	}

	/** Create a new agent session. */
	async createSession(options: SessionCreateOptions = {}): Promise<Session> {
		return unwrap(
			await this.#transport.request<Session | { data?: Session }>({
				method: "POST",
				path: "/session",
				body: options,
			}),
		)
	}

	/** List known sessions. */
	async listSessions(options: SessionListOptions = {}): Promise<Session[]> {
		const query = options.directory ? `?directory=${encodeURIComponent(options.directory)}` : ""
		return (
			unwrap(await this.#transport.request<Session[] | { data?: Session[] }>({ path: `/session${query}` })) ?? []
		)
	}

	/** Fetch a session by id. */
	async getSession(sessionID: string): Promise<Session> {
		return unwrap(
			await this.#transport.request<Session | { data?: Session }>({
				path: `/session/${encodeURIComponent(sessionID)}`,
			}),
		)
	}

	/** Abort a running session. */
	async abortSession(sessionID: string): Promise<void> {
		await this.#transport.request({ method: "POST", path: `/session/${encodeURIComponent(sessionID)}/abort` })
	}

	/** Send a user message and stream response chunks. */
	async *sendMessage(
		sessionID: string,
		message: string,
		options: SendMessageOptions = {},
	): AsyncIterableIterator<MessageChunk> {
		const { mode, ...rest } = options
		const body = { ...rest, agent: mode, message, parts: options.parts ?? [{ type: "text", text: message }] }
		for await (const chunk of this.#transport.stream({
			method: "POST",
			path: `/session/${encodeURIComponent(sessionID)}/message`,
			body,
		})) {
			const event = chunk as MessageChunk
			this.#emit(event)
			yield event
		}
	}

	/** Subscribe to client-side events emitted while streaming messages. */
	on<T extends ZooEvent["type"]>(type: T, handler: (event: Extract<ZooEvent, { type: T }>) => void): () => void {
		const set = this.#handlers.get(type) ?? new Set<Handler>()
		set.add(handler as Handler)
		this.#handlers.set(type, set)
		return () => set.delete(handler as Handler)
	}

	/** Subscribe to portable-core server events such as permission requests. */
	async *subscribeEvents(): AsyncIterableIterator<ZooServerEvent> {
		for await (const event of this.#transport.stream({ path: "/event" })) {
			yield event as ZooServerEvent
		}
	}

	/** Reply to a pending portable-core permission request. */
	async replyPermission(requestID: string, reply: PermissionReply): Promise<void> {
		await this.#transport.request({
			method: "POST",
			path: `/permission/${encodeURIComponent(requestID)}/reply`,
			body: reply,
		})
	}

	/** List pending portable-core permission requests. */
	async listPermissions(): Promise<PermissionRequest[]> {
		return (
			unwrap(
				await this.#transport.request<PermissionRequest[] | { data?: PermissionRequest[] }>({
					path: "/permission",
				}),
			) ?? []
		)
	}

	/** Save always-allow/deny rules for a pending portable-core permission request. */
	async savePermissionAlwaysRules(requestID: string, rules: PermissionAlwaysRules): Promise<boolean> {
		return (
			unwrap(
				await this.#transport.request<boolean | { data?: boolean }>({
					method: "POST",
					path: `/permission/${encodeURIComponent(requestID)}/always-rules`,
					body: rules,
				}),
			) ?? false
		)
	}

	/** List portable-core agents/modes available for message routing. */
	async listModes(): Promise<Mode[]> {
		const result = unwrap(await this.#transport.request<unknown[] | { data?: unknown[] }>({ path: "/agent" })) ?? []
		return result.map((agent) => {
			const record = agent && typeof agent === "object" ? (agent as Record<string, unknown>) : {}
			const id = typeof record.id === "string" ? record.id : String(record.name ?? "")
			return {
				id,
				name:
					typeof record.displayName === "string"
						? record.displayName
						: typeof record.name === "string"
							? record.name
							: id,
				description: typeof record.description === "string" ? record.description : undefined,
				primary:
					typeof record.primary === "boolean" ? record.primary : record.mode === "primary" ? true : undefined,
			}
		})
	}

	/** Read the portable-core configuration snapshot. */
	async getConfig(): Promise<ZooConfig> {
		return unwrap(await this.#transport.request<ZooConfig | { data?: ZooConfig }>({ path: "/config" })) ?? {}
	}

	/** Update portable-core configuration. */
	async updateConfig(config: ZooConfig): Promise<ZooConfig> {
		return (
			unwrap(
				await this.#transport.request<ZooConfig | { data?: ZooConfig }>({
					method: "PATCH",
					path: "/config",
					body: config,
				}),
			) ?? {}
		)
	}

	/** Read warnings produced while loading portable-core configuration. */
	async getConfigWarnings(): Promise<ConfigWarning[]> {
		return (
			unwrap(
				await this.#transport.request<ConfigWarning[] | { data?: ConfigWarning[] }>({
					path: "/config/warnings",
				}),
			) ?? []
		)
	}

	/** Read configured providers/defaults from the portable core. */
	async getConfigProviders(): Promise<ConfigProvidersResult> {
		return (
			unwrap(
				await this.#transport.request<ConfigProvidersResult | { data?: ConfigProvidersResult }>({
					path: "/config/providers",
				}),
			) ?? {}
		)
	}

	/** Close any transport resources owned by this client. */
	async close(): Promise<void> {
		await this.#transport.close?.()
	}

	#emit(event: ZooEvent) {
		for (const handler of this.#handlers.get(event.type) ?? []) handler(event)
	}
}
