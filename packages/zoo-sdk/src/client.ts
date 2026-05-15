import { createHttpTransport, createIpcTransport, type ZooTransport } from "./transport/index.js"
import type {
	MessageChunk,
	MessageListOptions,
	MessagePart,
	MessageWithParts,
	Mode,
	ConfigWarning,
	ConfigProvidersResult,
	PermissionAlwaysRules,
	PermissionReply,
	PermissionRequest,
	ProviderAuthMethods,
	ProviderListResult,
	ProviderOAuthAuthorizeOptions,
	ProviderOAuthAuthorizeResult,
	ProviderOAuthCallbackOptions,
	SendMessageOptions,
	Session,
	SessionCreateOptions,
	SessionDiffOptions,
	SessionFileDiff,
	SessionForkOptions,
	SessionListOptions,
	SessionStatusMap,
	SessionUpdateOptions,
	SessionViewedOptions,
	Todo,
	WorktreeCreateOptions,
	WorktreeDirectoryOptions,
	WorktreeDiff,
	WorktreeDiffFileOptions,
	WorktreeDiffItem,
	WorktreeDiffOptions,
	WorktreeInfo,
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

function messageListQuery(options: MessageListOptions = {}) {
	const params = new URLSearchParams()
	if (options.limit !== undefined) params.set("limit", String(options.limit))
	if (options.before) params.set("before", options.before)
	const query = params.toString()
	return query ? `?${query}` : ""
}

function sessionDiffQuery(options: SessionDiffOptions = {}) {
	const params = new URLSearchParams()
	if (options.messageID) params.set("messageID", options.messageID)
	const query = params.toString()
	return query ? `?${query}` : ""
}

function worktreeDirectoryBody(input: string | WorktreeDirectoryOptions): WorktreeDirectoryOptions {
	return typeof input === "string" ? { directory: input } : input
}

function worktreeDiffQuery(options: WorktreeDiffOptions & { file?: string } = {}) {
	const params = new URLSearchParams()
	if (options.base) params.set("base", options.base)
	if (options.file) params.set("file", options.file)
	const query = params.toString()
	return query ? `?${query}` : ""
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

	/** Persist the editor client's viewed-session state. */
	async setViewedSessions(options: SessionViewedOptions = {}): Promise<boolean> {
		return (
			unwrap(
				await this.#transport.request<boolean | { data?: boolean }>({
					method: "POST",
					path: "/session/viewed",
					body: options,
				}),
			) ?? false
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

	/** Read current status for known sessions. */
	async getSessionStatus(): Promise<SessionStatusMap> {
		return (
			unwrap(
				await this.#transport.request<SessionStatusMap | { data?: SessionStatusMap }>({
					path: "/session/status",
				}),
			) ?? {}
		)
	}

	/** List child sessions for a parent session. */
	async listSessionChildren(sessionID: string): Promise<Session[]> {
		return (
			unwrap(
				await this.#transport.request<Session[] | { data?: Session[] }>({
					path: `/session/${encodeURIComponent(sessionID)}/children`,
				}),
			) ?? []
		)
	}

	/** List todo items associated with a session. */
	async listSessionTodos(sessionID: string): Promise<Todo[]> {
		return (
			unwrap(
				await this.#transport.request<Todo[] | { data?: Todo[] }>({
					path: `/session/${encodeURIComponent(sessionID)}/todo`,
				}),
			) ?? []
		)
	}

	/** Update session metadata. */
	async updateSession(sessionID: string, options: SessionUpdateOptions): Promise<Session> {
		return unwrap(
			await this.#transport.request<Session | { data?: Session }>({
				method: "PATCH",
				path: `/session/${encodeURIComponent(sessionID)}`,
				body: options,
			}),
		)
	}

	/** Delete a persisted session. */
	async deleteSession(sessionID: string): Promise<boolean> {
		return (
			unwrap(
				await this.#transport.request<boolean | { data?: boolean }>({
					method: "DELETE",
					path: `/session/${encodeURIComponent(sessionID)}`,
				}),
			) ?? false
		)
	}

	/** Fork a session, optionally from a specific message. */
	async forkSession(sessionID: string, options: SessionForkOptions = {}): Promise<Session> {
		return unwrap(
			await this.#transport.request<Session | { data?: Session }>({
				method: "POST",
				path: `/session/${encodeURIComponent(sessionID)}/fork`,
				body: options,
			}),
		)
	}

	/** Read file diffs for a session checkpoint. */
	async getSessionDiff(sessionID: string, options: SessionDiffOptions = {}): Promise<SessionFileDiff[]> {
		return (
			unwrap(
				await this.#transport.request<SessionFileDiff[] | { data?: SessionFileDiff[] }>({
					path: `/session/${encodeURIComponent(sessionID)}/diff${sessionDiffQuery(options)}`,
				}),
			) ?? []
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

	/** List persisted messages for a session. */
	async listMessages(sessionID: string, options: MessageListOptions = {}): Promise<MessageWithParts[]> {
		return (
			unwrap(
				await this.#transport.request<MessageWithParts[] | { data?: MessageWithParts[] }>({
					path: `/session/${encodeURIComponent(sessionID)}/message${messageListQuery(options)}`,
				}),
			) ?? []
		)
	}

	/** Fetch one persisted session message and its parts. */
	async getMessage(sessionID: string, messageID: string): Promise<MessageWithParts> {
		return unwrap(
			await this.#transport.request<MessageWithParts | { data?: MessageWithParts }>({
				path: `/session/${encodeURIComponent(sessionID)}/message/${encodeURIComponent(messageID)}`,
			}),
		)
	}

	/** Delete one persisted session message. */
	async deleteMessage(sessionID: string, messageID: string): Promise<boolean> {
		return (
			unwrap(
				await this.#transport.request<boolean | { data?: boolean }>({
					method: "DELETE",
					path: `/session/${encodeURIComponent(sessionID)}/message/${encodeURIComponent(messageID)}`,
				}),
			) ?? false
		)
	}

	/** Update one persisted message part. */
	async updateMessagePart(
		sessionID: string,
		messageID: string,
		partID: string,
		part: MessagePart,
	): Promise<MessagePart> {
		return unwrap(
			await this.#transport.request<MessagePart | { data?: MessagePart }>({
				method: "PATCH",
				path: `/session/${encodeURIComponent(sessionID)}/message/${encodeURIComponent(messageID)}/part/${encodeURIComponent(partID)}`,
				body: part,
			}),
		)
	}

	/** Delete one persisted message part. */
	async deleteMessagePart(sessionID: string, messageID: string, partID: string): Promise<boolean> {
		return (
			unwrap(
				await this.#transport.request<boolean | { data?: boolean }>({
					method: "DELETE",
					path: `/session/${encodeURIComponent(sessionID)}/message/${encodeURIComponent(messageID)}/part/${encodeURIComponent(partID)}`,
				}),
			) ?? false
		)
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

	/** List portable-core worktree directories. */
	async listWorktrees(): Promise<string[]> {
		return (
			unwrap(await this.#transport.request<string[] | { data?: string[] }>({ path: "/experimental/worktree" })) ??
			[]
		)
	}

	/** Create a portable-core worktree. */
	async createWorktree(options: WorktreeCreateOptions = {}): Promise<WorktreeInfo> {
		return unwrap(
			await this.#transport.request<WorktreeInfo | { data?: WorktreeInfo }>({
				method: "POST",
				path: "/experimental/worktree",
				body: options,
			}),
		)
	}

	/** Remove a portable-core worktree. */
	async removeWorktree(input: string | WorktreeDirectoryOptions): Promise<boolean> {
		return (
			unwrap(
				await this.#transport.request<boolean | { data?: boolean }>({
					method: "DELETE",
					path: "/experimental/worktree",
					body: worktreeDirectoryBody(input),
				}),
			) ?? false
		)
	}

	/** Reset a portable-core worktree. */
	async resetWorktree(input: string | WorktreeDirectoryOptions): Promise<boolean> {
		return (
			unwrap(
				await this.#transport.request<boolean | { data?: boolean }>({
					method: "POST",
					path: "/experimental/worktree/reset",
					body: worktreeDirectoryBody(input),
				}),
			) ?? false
		)
	}

	/** Read the full worktree diff. Experimental: currently backed by legacy Hono routes. */
	async getWorktreeDiff(options: WorktreeDiffOptions = {}): Promise<WorktreeDiff[]> {
		return (
			unwrap(
				await this.#transport.request<WorktreeDiff[] | { data?: WorktreeDiff[] }>({
					path: `/experimental/worktree/diff${worktreeDiffQuery(options)}`,
				}),
			) ?? []
		)
	}

	/** Read summarized worktree diff items. Experimental: currently backed by legacy Hono routes. */
	async getWorktreeDiffSummary(options: WorktreeDiffOptions = {}): Promise<WorktreeDiffItem[]> {
		return (
			unwrap(
				await this.#transport.request<WorktreeDiffItem[] | { data?: WorktreeDiffItem[] }>({
					path: `/experimental/worktree/diff/summary${worktreeDiffQuery(options)}`,
				}),
			) ?? []
		)
	}

	/** Read one worktree diff file. Experimental: currently backed by legacy Hono routes. */
	async getWorktreeDiffFile(options: WorktreeDiffFileOptions): Promise<WorktreeDiffItem | null> {
		return (
			unwrap(
				await this.#transport.request<WorktreeDiffItem | null | { data?: WorktreeDiffItem | null }>({
					path: `/experimental/worktree/diff/file${worktreeDiffQuery(options)}`,
				}),
			) ?? null
		)
	}

	/** List providers visible to the portable core. */
	async listProviders(): Promise<ProviderListResult> {
		return (
			unwrap(
				await this.#transport.request<ProviderListResult | { data?: ProviderListResult }>({
					path: "/provider",
				}),
			) ?? {}
		)
	}

	/** Read available authentication methods for providers. */
	async getProviderAuthMethods(): Promise<ProviderAuthMethods> {
		return (
			unwrap(
				await this.#transport.request<ProviderAuthMethods | { data?: ProviderAuthMethods }>({
					path: "/provider/auth",
				}),
			) ?? {}
		)
	}

	/** Start an OAuth flow for a provider. */
	async authorizeProviderOAuth(
		providerID: string,
		options: ProviderOAuthAuthorizeOptions,
	): Promise<ProviderOAuthAuthorizeResult> {
		return (
			unwrap(
				await this.#transport.request<ProviderOAuthAuthorizeResult | { data?: ProviderOAuthAuthorizeResult }>({
					method: "POST",
					path: `/provider/${encodeURIComponent(providerID)}/oauth/authorize`,
					body: options,
				}),
			) ?? {}
		)
	}

	/** Complete an OAuth flow for a provider. */
	async callbackProviderOAuth(providerID: string, options: ProviderOAuthCallbackOptions): Promise<boolean> {
		return (
			unwrap(
				await this.#transport.request<boolean | { data?: boolean }>({
					method: "POST",
					path: `/provider/${encodeURIComponent(providerID)}/oauth/callback`,
					body: options,
				}),
			) ?? false
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
