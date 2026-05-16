import { createHttpTransport, createIpcTransport, type ZooTransport } from "./transport/index.js"
import type {
	CommandInfo,
	ExperimentalResourceMap,
	ExperimentalSession,
	ExperimentalSessionListOptions,
	FileContent,
	FileListOptions,
	FileNode,
	FileReadOptions,
	FileStatus,
	FindFilesOptions,
	FindSymbolsOptions,
	FindTextOptions,
	FormatterStatus,
	LspStatus,
	McpStatusMap,
	MessageChunk,
	MessageListOptions,
	MessagePart,
	MessageWithParts,
	Mode,
	ConfigWarning,
	ConfigProvidersResult,
	PathInfo,
	PermissionAlwaysRules,
	PermissionReply,
	PermissionRequest,
	QuestionAnswer,
	QuestionListOptions,
	QuestionRequest,
	ProviderAuthMethods,
	ProviderListResult,
	ProviderOAuthAuthorizeOptions,
	ProviderOAuthAuthorizeResult,
	ProviderOAuthCallbackOptions,
	PromptAsyncOptions,
	Project,
	ProjectUpdateOptions,
	PtySession,
	PtyShell,
	SearchMatch,
	SendMessageOptions,
	Session,
	SessionCreateOptions,
	SessionDiffOptions,
	SessionFileDiff,
	SessionForkOptions,
	SessionListOptions,
	SessionRevertOptions,
	SessionStatusMap,
	SessionUpdateOptions,
	SessionViewedOptions,
	SkillInfo,
	SymbolInfo,
	Todo,
	TuiAppendPromptOptions,
	TuiExecuteCommandOptions,
	TuiScope,
	TuiSelectSessionOptions,
	TuiShowToastOptions,
	VcsDiffOptions,
	VcsFileDiff,
	VcsInfo,
	WorkspaceAdapter,
	WorkspaceInfo,
	WorkspaceRouteOptions,
	WorkspaceStatus,
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

function promptAsyncQuery(options: Pick<PromptAsyncOptions, "directory" | "workspace"> = {}) {
	const params = new URLSearchParams()
	if (options.directory) params.set("directory", options.directory)
	if (options.workspace) params.set("workspace", options.workspace)
	const query = params.toString()
	return query ? `?${query}` : ""
}

function questionQuery(options: QuestionListOptions = {}) {
	const params = new URLSearchParams()
	if (options.directory) params.set("directory", options.directory)
	if (options.workspace) params.set("workspace", options.workspace)
	const query = params.toString()
	return query ? `?${query}` : ""
}

function workspaceRouteQuery(options: WorkspaceRouteOptions & { mode?: string } = {}) {
	const params = new URLSearchParams()
	if (options.directory) params.set("directory", options.directory)
	if (options.workspace) params.set("workspace", options.workspace)
	if (options.mode) params.set("mode", options.mode)
	const query = params.toString()
	return query ? `?${query}` : ""
}

function scopedQuery(options: WorkspaceRouteOptions & Record<string, string | number | boolean | undefined> = {}) {
	const params = new URLSearchParams()
	if (options.directory) params.set("directory", options.directory)
	if (options.workspace) params.set("workspace", options.workspace)
	for (const [key, value] of Object.entries(options)) {
		if (key === "directory" || key === "workspace" || value === undefined) continue
		params.set(key, String(value))
	}
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

	/** Share a session and return its updated metadata. */
	async shareSession(sessionID: string): Promise<Session> {
		return unwrap(
			await this.#transport.request<Session | { data?: Session }>({
				method: "POST",
				path: `/session/${encodeURIComponent(sessionID)}/share`,
			}),
		)
	}

	/** Remove sharing from a session and return its updated metadata. */
	async unshareSession(sessionID: string): Promise<Session> {
		return unwrap(
			await this.#transport.request<Session | { data?: Session }>({
				method: "DELETE",
				path: `/session/${encodeURIComponent(sessionID)}/share`,
			}),
		)
	}

	/** Revert a session to a prior message or part. */
	async revertSession(sessionID: string, options: SessionRevertOptions): Promise<Session> {
		return unwrap(
			await this.#transport.request<Session | { data?: Session }>({
				method: "POST",
				path: `/session/${encodeURIComponent(sessionID)}/revert`,
				body: options,
			}),
		)
	}

	/** Clear a session revert state. */
	async unrevertSession(sessionID: string): Promise<Session> {
		return unwrap(
			await this.#transport.request<Session | { data?: Session }>({
				method: "POST",
				path: `/session/${encodeURIComponent(sessionID)}/unrevert`,
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

	/** Queue a user prompt asynchronously and return after server acceptance. */
	async promptAsync(sessionID: string, message: string, options: PromptAsyncOptions = {}): Promise<void> {
		const { mode, directory, workspace, parts, ...rest } = options
		await this.#transport.request<void>({
			method: "POST",
			path: `/session/${encodeURIComponent(sessionID)}/prompt_async${promptAsyncQuery({ directory, workspace })}`,
			body: {
				...rest,
				agent: mode,
				noReply: rest.noReply ?? true,
				parts: [{ type: "text", text: message }, ...(parts ?? [])],
			},
		})
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

	/** List pending portable-core question requests. */
	async listQuestions(options: QuestionListOptions = {}): Promise<QuestionRequest[]> {
		return (
			unwrap(
				await this.#transport.request<QuestionRequest[] | { data?: QuestionRequest[] }>({
					path: `/question${questionQuery(options)}`,
				}),
			) ?? []
		)
	}

	/** Reply to a pending portable-core question request. */
	async replyQuestion(
		requestID: string,
		answers: QuestionAnswer[],
		options: QuestionListOptions = {},
	): Promise<boolean> {
		return (
			unwrap(
				await this.#transport.request<boolean | { data?: boolean }>({
					method: "POST",
					path: `/question/${encodeURIComponent(requestID)}/reply${questionQuery(options)}`,
					body: { answers },
				}),
			) ?? false
		)
	}

	/** Reject a pending portable-core question request. */
	async rejectQuestion(requestID: string, options: QuestionListOptions = {}): Promise<boolean> {
		return (
			unwrap(
				await this.#transport.request<boolean | { data?: boolean }>({
					method: "POST",
					path: `/question/${encodeURIComponent(requestID)}/reject${questionQuery(options)}`,
				}),
			) ?? false
		)
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

	/** Read portable-core path metadata. */
	async getPaths(options: WorkspaceRouteOptions = {}): Promise<PathInfo> {
		return unwrap(
			await this.#transport.request<PathInfo | { data?: PathInfo }>({
				path: `/path${workspaceRouteQuery(options)}`,
			}),
		)
	}

	/** Read current VCS metadata. */
	async getVcsInfo(options: WorkspaceRouteOptions = {}): Promise<VcsInfo> {
		return (
			unwrap(
				await this.#transport.request<VcsInfo | { data?: VcsInfo }>({
					path: `/vcs${workspaceRouteQuery(options)}`,
				}),
			) ?? {}
		)
	}

	/** Read VCS diffs for the selected mode. */
	async getVcsDiff(options: VcsDiffOptions): Promise<VcsFileDiff[]> {
		return (
			unwrap(
				await this.#transport.request<VcsFileDiff[] | { data?: VcsFileDiff[] }>({
					path: `/vcs/diff${workspaceRouteQuery(options)}`,
				}),
			) ?? []
		)
	}

	/** List portable-core slash commands. */
	async listCommands(options: WorkspaceRouteOptions = {}): Promise<CommandInfo[]> {
		return (
			unwrap(
				await this.#transport.request<CommandInfo[] | { data?: CommandInfo[] }>({
					path: `/command${workspaceRouteQuery(options)}`,
				}),
			) ?? []
		)
	}

	/** List portable-core skills. */
	async listSkills(options: WorkspaceRouteOptions = {}): Promise<SkillInfo[]> {
		return (
			unwrap(
				await this.#transport.request<SkillInfo[] | { data?: SkillInfo[] }>({
					path: `/skill${workspaceRouteQuery(options)}`,
				}),
			) ?? []
		)
	}

	/** Read LSP connection status entries. */
	async getLspStatus(options: WorkspaceRouteOptions = {}): Promise<LspStatus[]> {
		return (
			unwrap(
				await this.#transport.request<LspStatus[] | { data?: LspStatus[] }>({
					path: `/lsp${workspaceRouteQuery(options)}`,
				}),
			) ?? []
		)
	}

	/** Read formatter availability status entries. */
	async getFormatterStatus(options: WorkspaceRouteOptions = {}): Promise<FormatterStatus[]> {
		return (
			unwrap(
				await this.#transport.request<FormatterStatus[] | { data?: FormatterStatus[] }>({
					path: `/formatter${workspaceRouteQuery(options)}`,
				}),
			) ?? []
		)
	}

	/** List portable-core tool IDs. */
	async listToolIDs(options: WorkspaceRouteOptions = {}): Promise<string[]> {
		return (
			unwrap(
				await this.#transport.request<string[] | { data?: string[] }>({
					path: `/experimental/tool/ids${workspaceRouteQuery(options)}`,
				}),
			) ?? []
		)
	}

	/** List available PTY shells. */
	async listPtyShells(options: WorkspaceRouteOptions = {}): Promise<PtyShell[]> {
		return (
			unwrap(
				await this.#transport.request<PtyShell[] | { data?: PtyShell[] }>({
					path: `/pty/shells${workspaceRouteQuery(options)}`,
				}),
			) ?? []
		)
	}

	/** List active PTY sessions. */
	async listPtySessions(options: WorkspaceRouteOptions = {}): Promise<PtySession[]> {
		return (
			unwrap(
				await this.#transport.request<PtySession[] | { data?: PtySession[] }>({
					path: `/pty${workspaceRouteQuery(options)}`,
				}),
			) ?? []
		)
	}

	/** Append text to the portable-core TUI prompt. */
	async appendTuiPrompt(options: TuiAppendPromptOptions): Promise<boolean> {
		const { directory, workspace, ...body } = options
		return (
			unwrap(
				await this.#transport.request<boolean | { data?: boolean }>({
					method: "POST",
					path: `/tui/append-prompt${workspaceRouteQuery({ directory, workspace })}`,
					body,
				}),
			) ?? false
		)
	}

	/** Open the portable-core TUI help dialog. */
	async openTuiHelp(options: TuiScope = {}): Promise<boolean> {
		return (
			unwrap(
				await this.#transport.request<boolean | { data?: boolean }>({
					method: "POST",
					path: `/tui/open-help${workspaceRouteQuery(options)}`,
				}),
			) ?? false
		)
	}

	/** Execute a portable-core TUI command. */
	async executeTuiCommand(options: TuiExecuteCommandOptions): Promise<boolean> {
		const { directory, workspace, ...body } = options
		return (
			unwrap(
				await this.#transport.request<boolean | { data?: boolean }>({
					method: "POST",
					path: `/tui/execute-command${workspaceRouteQuery({ directory, workspace })}`,
					body,
				}),
			) ?? false
		)
	}

	/** Show a portable-core TUI toast. */
	async showTuiToast(options: TuiShowToastOptions): Promise<boolean> {
		const { directory, workspace, ...body } = options
		return (
			unwrap(
				await this.#transport.request<boolean | { data?: boolean }>({
					method: "POST",
					path: `/tui/show-toast${workspaceRouteQuery({ directory, workspace })}`,
					body,
				}),
			) ?? false
		)
	}

	/** Select a session in the portable-core TUI. */
	async selectTuiSession(options: TuiSelectSessionOptions): Promise<boolean> {
		const { directory, workspace, ...body } = options
		return (
			unwrap(
				await this.#transport.request<boolean | { data?: boolean }>({
					method: "POST",
					path: `/tui/select-session${workspaceRouteQuery({ directory, workspace })}`,
					body,
				}),
			) ?? false
		)
	}

	/** List experimental sessions. */
	async listExperimentalSessions(options: ExperimentalSessionListOptions = {}): Promise<ExperimentalSession[]> {
		return (
			unwrap(
				await this.#transport.request<ExperimentalSession[] | { data?: ExperimentalSession[] }>({
					path: `/experimental/session${scopedQuery(options)}`,
				}),
			) ?? []
		)
	}

	/** List experimental MCP resources. */
	async listResources(options: WorkspaceRouteOptions = {}): Promise<ExperimentalResourceMap> {
		return (
			unwrap(
				await this.#transport.request<ExperimentalResourceMap | { data?: ExperimentalResourceMap }>({
					path: `/experimental/resource${workspaceRouteQuery(options)}`,
				}),
			) ?? {}
		)
	}

	/** List workspace adapters. */
	async listWorkspaceAdapters(options: WorkspaceRouteOptions = {}): Promise<WorkspaceAdapter[]> {
		return (
			unwrap(
				await this.#transport.request<WorkspaceAdapter[] | { data?: WorkspaceAdapter[] }>({
					path: `/experimental/workspace/adapter${workspaceRouteQuery(options)}`,
				}),
			) ?? []
		)
	}

	/** List workspaces. */
	async listWorkspaces(options: WorkspaceRouteOptions = {}): Promise<WorkspaceInfo[]> {
		return (
			unwrap(
				await this.#transport.request<WorkspaceInfo[] | { data?: WorkspaceInfo[] }>({
					path: `/experimental/workspace${workspaceRouteQuery(options)}`,
				}),
			) ?? []
		)
	}

	/** Read workspace connection status. */
	async getWorkspaceStatus(options: WorkspaceRouteOptions = {}): Promise<WorkspaceStatus[]> {
		return (
			unwrap(
				await this.#transport.request<WorkspaceStatus[] | { data?: WorkspaceStatus[] }>({
					path: `/experimental/workspace/status${workspaceRouteQuery(options)}`,
				}),
			) ?? []
		)
	}

	/** Read one file's content. */
	async readFile(options: FileReadOptions): Promise<FileContent> {
		return unwrap(
			await this.#transport.request<FileContent | { data?: FileContent }>({
				path: `/file/content${scopedQuery(options)}`,
			}),
		)
	}

	/** List files under a workspace path. */
	async listFiles(options: FileListOptions): Promise<FileNode[]> {
		return (
			unwrap(
				await this.#transport.request<FileNode[] | { data?: FileNode[] }>({
					path: `/file${scopedQuery(options)}`,
				}),
			) ?? []
		)
	}

	/** Read current file status entries. */
	async getFileStatus(options: WorkspaceRouteOptions = {}): Promise<FileStatus[]> {
		return (
			unwrap(
				await this.#transport.request<FileStatus[] | { data?: FileStatus[] }>({
					path: `/file/status${workspaceRouteQuery(options)}`,
				}),
			) ?? []
		)
	}

	/** Find files by query. */
	async findFiles(options: FindFilesOptions): Promise<string[]> {
		return (
			unwrap(
				await this.#transport.request<string[] | { data?: string[] }>({
					path: `/find/file${scopedQuery(options)}`,
				}),
			) ?? []
		)
	}

	/** Find text matches by pattern. */
	async findText(options: FindTextOptions): Promise<SearchMatch[]> {
		return (
			unwrap(
				await this.#transport.request<SearchMatch[] | { data?: SearchMatch[] }>({
					path: `/find${scopedQuery(options)}`,
				}),
			) ?? []
		)
	}

	/** Find workspace symbols by query. */
	async findSymbols(options: FindSymbolsOptions): Promise<SymbolInfo[]> {
		return (
			unwrap(
				await this.#transport.request<SymbolInfo[] | { data?: SymbolInfo[] }>({
					path: `/find/symbol${scopedQuery(options)}`,
				}),
			) ?? []
		)
	}

	/** List known portable-core projects. */
	async listProjects(options: WorkspaceRouteOptions = {}): Promise<Project[]> {
		return (
			unwrap(
				await this.#transport.request<Project[] | { data?: Project[] }>({
					path: `/project${workspaceRouteQuery(options)}`,
				}),
			) ?? []
		)
	}

	/** Read the current portable-core project. */
	async getCurrentProject(options: WorkspaceRouteOptions = {}): Promise<Project> {
		return unwrap(
			await this.#transport.request<Project | { data?: Project }>({
				path: `/project/current${workspaceRouteQuery(options)}`,
			}),
		)
	}

	/** Initialize Git for the current portable-core project directory. */
	async initProjectGit(options: WorkspaceRouteOptions = {}): Promise<Project> {
		return unwrap(
			await this.#transport.request<Project | { data?: Project }>({
				method: "POST",
				path: `/project/git/init${workspaceRouteQuery(options)}`,
			}),
		)
	}

	/** Update portable-core project metadata. */
	async updateProject(projectID: string, options: ProjectUpdateOptions): Promise<Project> {
		const { directory, workspace, ...body } = options
		return unwrap(
			await this.#transport.request<Project | { data?: Project }>({
				method: "PATCH",
				path: `/project/${encodeURIComponent(projectID)}${workspaceRouteQuery({ directory, workspace })}`,
				body,
			}),
		)
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

	/** Read MCP server status from the portable core. */
	async getMcpStatus(): Promise<McpStatusMap> {
		return (
			unwrap(
				await this.#transport.request<McpStatusMap | { data?: McpStatusMap }>({
					path: "/mcp",
				}),
			) ?? {}
		)
	}

	/** Invalidate portable-core config caches and dispose active instances. */
	async invalidateConfig(): Promise<boolean> {
		return (
			unwrap(
				await this.#transport.request<boolean | { data?: boolean }>({
					method: "POST",
					path: "/global/dispose",
				}),
			) ?? false
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
