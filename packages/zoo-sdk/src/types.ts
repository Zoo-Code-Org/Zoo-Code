/** A persisted Zoo Code agent session. */
export type Session = {
	/** Stable session identifier. */
	id: string
	/** Optional parent session when this session was forked. */
	parentID?: string
	/** Human-readable session title. */
	title?: string
	/** Workspace directory associated with the session. */
	directory?: string
	/** CLI session time metadata. */
	time?: SessionTime
	/** Session creation time as an ISO string or epoch milliseconds. */
	createdAt?: string | number
	/** Additional server-provided session fields. */
	[key: string]: unknown
}

/** Session timestamp metadata returned by the portable core. */
export type SessionTime = {
	created?: number
	updated?: number
	archived?: number
	compacting?: number
	[key: string]: unknown
}

/** A chat or tool message associated with a session. */
export type Message = {
	/** Stable message identifier. */
	id: string
	/** Session this message belongs to. */
	sessionID: string
	/** Message role in the conversation. */
	role: "user" | "assistant" | "system" | "tool" | string
	/** Optional message text. */
	text?: string
	/** Additional server-provided message fields. */
	[key: string]: unknown
}

/** Options for listing persisted session messages. */
export type MessageListOptions = {
	/** Maximum number of messages to return. */
	limit?: number
	/** Cursor returned by a previous message listing. */
	before?: string
}

/** A persisted message part associated with a session message. */
export type MessagePart = {
	/** Stable part identifier. */
	id: string
	/** Parent message identifier. */
	messageID: string
	/** Parent session identifier. */
	sessionID: string
	/** Part discriminator. */
	type: string
	/** Additional server-provided fields. */
	[key: string]: unknown
}

/** Persisted message plus its associated parts. */
export type MessageWithParts = {
	/** Message metadata. */
	info: Message
	/** Message parts. */
	parts: MessagePart[]
	/** Additional server-provided fields. */
	[key: string]: unknown
}

/** A streamed response event or content chunk from the Zoo portable core. */
export type MessageChunk = {
	/** Event type, such as `text`, `tool_use`, or `error`. */
	type: string
	/** Session this chunk belongs to when known. */
	sessionID?: string
	/** Event payload from the server. */
	[key: string]: unknown
}

/** A model/tool call requested by the portable core. */
export type ToolCall = {
	/** Stable tool-call identifier. */
	id: string
	/** Tool name. */
	name: string
	/** Tool input payload. */
	input: unknown
}

/** A tool execution result returned to the portable core. */
export type ToolResult = {
	/** Tool-call identifier this result answers. */
	callID: string
	/** Whether the tool execution succeeded. */
	ok: boolean
	/** Result output or error details. */
	output?: unknown
}

/** A configured model provider visible to Zoo Code. */
export type Provider = {
	/** Provider identifier, for example `anthropic` or `openai`. */
	id: string
	/** Display name. */
	name?: string
	/** Supported model map or list. */
	models?: unknown
	/** Additional provider metadata. */
	[key: string]: unknown
}

/** Provider list returned by the portable core. */
export type ProviderListResult = {
	/** Available providers. */
	all?: Provider[]
	/** Default model/provider selections. */
	default?: unknown
	/** Provider IDs with usable credentials. */
	connected?: string[]
	/** Providers that failed to load or authenticate. */
	failed?: unknown[]
	/** Additional server-provided fields. */
	[key: string]: unknown
}

/** Authentication method exposed for a provider. */
export type ProviderAuthMethod = {
	/** Auth method type, such as `oauth` or `api`. */
	type: string
	/** Display label for the auth method. */
	label?: string
	/** Additional prompts or method metadata. */
	[key: string]: unknown
}

/** Provider auth methods keyed by provider ID. */
export type ProviderAuthMethods = Record<string, ProviderAuthMethod[]>

/** Input for starting a provider OAuth flow. */
export type ProviderOAuthAuthorizeOptions = {
	/** Auth method index selected by the caller. */
	method: number
	/** Provider-specific input values. */
	inputs?: Record<string, unknown>
}

/** Provider OAuth authorization response. */
export type ProviderOAuthAuthorizeResult = {
	/** Authorization URL, when the provider needs browser auth. */
	url?: string
	/** Provider-specific method or flow metadata. */
	method?: string
	/** User-facing instructions returned by the provider. */
	instructions?: string
	/** Additional server-provided fields. */
	[key: string]: unknown
}

/** Input for completing a provider OAuth flow. */
export type ProviderOAuthCallbackOptions = {
	/** Auth method index selected by the caller. */
	method: number
	/** Authorization code or provider callback payload. */
	code?: string
	/** Additional callback fields. */
	[key: string]: unknown
}

/** A Zoo/Roo mode or primary agent selection. */
export type Mode = {
	/** Mode identifier. */
	id: string
	/** Display name. */
	name: string
	/** Optional mode description. */
	description?: string
	/** Whether this mode can be selected as a primary agent. */
	primary?: boolean
}

/** Optional workspace scoping for portable-core instance routes. */
export type WorkspaceRouteOptions = {
	directory?: string
	workspace?: string
}

/** Portable-core path metadata. */
export type PathInfo = {
	home: string
	state: string
	config: string
	worktree: string
	directory: string
}

/** Current VCS metadata for a workspace. */
export type VcsInfo = {
	branch?: string
	default_branch?: string
}

/** VCS diff mode supported by portable core. */
export type VcsMode = "git" | "branch"

/** Options for querying VCS diffs. */
export type VcsDiffOptions = WorkspaceRouteOptions & {
	mode: VcsMode
}

/** One VCS diff item. */
export type VcsFileDiff = {
	file: string
	patch: string
	additions: number
	deletions: number
	status?: "added" | "deleted" | "modified"
}

/** Portable-core command metadata. */
export type CommandInfo = {
	name: string
	description?: string
	agent?: string
	model?: string
	source?: "command" | "mcp" | "skill"
	template: unknown
	subtask?: boolean
	hints: string[]
}

/** Portable-core skill metadata. */
export type SkillInfo = {
	name: string
	description: string
	location: string
	content: string
	[key: string]: unknown
}

/** LSP connection status entry. */
export type LspStatus = {
	id: string
	name: string
	root: string
	status: "connected" | "error" | string
	[key: string]: unknown
}

/** Formatter availability status entry. */
export type FormatterStatus = {
	name: string
	extensions: string[]
	enabled: boolean
	[key: string]: unknown
}

/** Portable-core project metadata. */
export type Project = {
	id: string
	worktree: string
	vcs?: "git"
	name?: string
	icon?: {
		url?: string
		override?: string
		color?: string
	}
	commands?: {
		start?: string
	}
	time: {
		created: number
		updated: number
		initialized?: number
	}
	sandboxes: string[]
	[key: string]: unknown
}

/** Options for updating portable-core project metadata. */
export type ProjectUpdateOptions = WorkspaceRouteOptions & {
	name?: string
	icon?: {
		url?: string
		override?: string
		color?: string
	}
	commands?: {
		start?: string
	}
}

/** Options for reading one file. */
export type FileReadOptions = WorkspaceRouteOptions & {
	path: string
}

/** Options for listing files under a path. */
export type FileListOptions = WorkspaceRouteOptions & {
	path: string
}

/** File content returned by portable core. */
export type FileContent = {
	type: "text" | "binary" | string
	content: string
	diff?: string
	encoding?: "base64" | string
	mimeType?: string
	[key: string]: unknown
}

/** File tree node returned by portable core. */
export type FileNode = {
	name: string
	path: string
	absolute: string
	type: "file" | "directory" | string
	ignored: boolean
	[key: string]: unknown
}

/** File status entry returned by portable core. */
export type FileStatus = {
	path: string
	added: number
	removed: number
	status: "added" | "deleted" | "modified" | string
	[key: string]: unknown
}

/** Options for finding files. */
export type FindFilesOptions = WorkspaceRouteOptions & {
	query: string
	dirs?: "true" | "false"
	type?: "file" | "directory"
	limit?: number
}

/** Options for finding text. */
export type FindTextOptions = WorkspaceRouteOptions & {
	pattern: string
}

/** Options for finding workspace symbols. */
export type FindSymbolsOptions = WorkspaceRouteOptions & {
	query: string
}

/** Text search match returned by portable core. */
export type SearchMatch = {
	path?: { text: string }
	lines?: { text: string }
	line_number?: number
	absolute_offset?: number
	submatches?: Array<{ match: { text: string }; start: number; end: number }>
	[key: string]: unknown
}

/** Workspace symbol returned by portable core. */
export type SymbolInfo = {
	name?: string
	kind?: string | number
	location?: unknown
	containerName?: string
	[key: string]: unknown
}

/** MCP server status returned by portable core. */
export type McpStatus = {
	status: string
	error?: string
	[key: string]: unknown
}

/** MCP status keyed by configured server name. */
export type McpStatusMap = Record<string, McpStatus>

/** A portable-core permission rule or decision. */
export type Permission = {
	/** Permission capability, such as `bash` or `edit`. */
	permission: string
	/** Rule action. */
	action: "allow" | "deny" | "ask" | string
	/** Glob or provider-specific pattern. */
	pattern?: string
}

/** One selectable answer option for a portable-core question. */
export type QuestionOption = {
	label: string
	description: string
	labelKey?: string
	descriptionKey?: string
	mode?: string
	[key: string]: unknown
}

/** One question shown to the user. */
export type QuestionInfo = {
	question: string
	header: string
	options: QuestionOption[]
	multiple?: boolean
	questionKey?: string
	headerKey?: string
	custom?: boolean
	[key: string]: unknown
}

/** Optional tool metadata attached to a question request. */
export type QuestionTool = {
	messageID: string
	callID: string
	[key: string]: unknown
}

/** Pending portable-core question request. */
export type QuestionRequest = {
	id: string
	sessionID: string
	questions: QuestionInfo[]
	blocking?: boolean
	tool?: QuestionTool
	[key: string]: unknown
}

/** Selected labels for one question. */
export type QuestionAnswer = string[]

/** Optional workspace scoping for question routes. */
export type QuestionListOptions = {
	directory?: string
	workspace?: string
}

/** Git worktree metadata shared across CLI and editor surfaces. */
export type WorktreeInfo = {
	/** Worktree name returned by the portable core. */
	name?: string
	/** Current branch if known. */
	branch?: string
	/** Absolute worktree directory. */
	directory?: string
	/** Worktree identifier or path alias for SDK callers. */
	id?: string
	/** Absolute worktree path alias for SDK callers. */
	path?: string
	/** Additional server-provided fields. */
	[key: string]: unknown
}

/** Options for creating a worktree. */
export type WorktreeCreateOptions = {
	/** Optional worktree name. */
	name?: string
	/** Optional setup command to run after creating the worktree. */
	startCommand?: string
}

/** Options for operations that target a worktree directory. */
export type WorktreeDirectoryOptions = {
	/** Worktree directory to target. */
	directory: string
}

/** Worktree diff file status. */
export type WorktreeDiffStatus = "added" | "deleted" | "modified"

/** Options for querying worktree diffs. */
export type WorktreeDiffOptions = {
	/** Base branch or revision. */
	base?: string
}

/** Options for querying one worktree diff file. */
export type WorktreeDiffFileOptions = WorktreeDiffOptions & {
	/** Relative file path to inspect. */
	file: string
}

/** Full worktree file diff returned by the portable core. */
export type WorktreeDiff = {
	/** Relative file path. */
	file: string
	/** Before content. */
	before?: string
	/** After content. */
	after?: string
	/** Patch text when returned by the route. */
	patch?: string
	/** Added line count. */
	additions: number
	/** Deleted line count. */
	deletions: number
	/** File status. */
	status?: WorktreeDiffStatus
}

/** Summarized worktree diff item. */
export type WorktreeDiffItem = WorktreeDiff & {
	/** Patch text. */
	patch: string
	/** Before content, often empty for summaries. */
	before: string
	/** After content, often empty for summaries. */
	after: string
	/** Whether the file is tracked by git. */
	tracked: boolean
	/** Whether the file appears generated. */
	generatedLike: boolean
	/** Whether content was summarized. */
	summarized: boolean
	/** Diff version stamp. */
	stamp: string
}

/** Options used to create a new session. */
export type SessionCreateOptions = {
	/** Optional title for display in history. */
	title?: string
	/** Initial permission rules. */
	permission?: Permission[]
}

/** Options for listing sessions. */
export type SessionListOptions = {
	/** Optional project/workspace directory filter. */
	directory?: string
}

/** Viewed-session state tracked by editor clients. */
export type SessionViewedOptions = {
	/** Sessions currently focused by clients. */
	focused?: string[]
	/** Sessions currently open by clients. */
	open?: string[]
}

/** Options for forking a session. */
export type SessionForkOptions = {
	/** Optional message to fork from. */
	messageID?: string
}

/** Options for reading a session diff. */
export type SessionDiffOptions = {
	/** Optional message to diff at. */
	messageID?: string
}

/** Options for reverting a session to a prior message or part. */
export type SessionRevertOptions = {
	/** Message to revert to. */
	messageID: string
	/** Optional part within the message to revert to. */
	partID?: string
}

/** File diff returned for a session checkpoint. */
export type SessionFileDiff = {
	/** Relative file path. */
	file: string
	/** Previous file content. */
	before: string
	/** Current file content. */
	after: string
	/** Added line count. */
	additions: number
	/** Deleted line count. */
	deletions: number
	/** Additional server-provided fields. */
	[key: string]: unknown
}

/** Session update payload accepted by the portable core. */
export type SessionUpdateOptions = {
	/** Updated display title. */
	title?: string
	/** Updated permission ruleset. */
	permission?: unknown
	/** Updated session time metadata. */
	time?: Pick<SessionTime, "archived"> & Record<string, unknown>
}

/** Session todo item returned by the portable core. */
export type Todo = {
	/** Todo item content. */
	content: string
	/** Todo status, such as pending or completed. */
	status: string
	/** Todo priority, such as low, medium, or high. */
	priority: string
	/** Additional server-provided fields. */
	[key: string]: unknown
}

/** Portable-core session status entry. */
export type SessionStatus = {
	/** Status discriminator, such as idle, busy, retry, or offline. */
	type: string
	/** Additional status metadata. */
	[key: string]: unknown
}

/** Session statuses keyed by session ID. */
export type SessionStatusMap = Record<string, SessionStatus>

/** Options for sending a message. */
export type SendMessageOptions = {
	/** Provider/model string such as `anthropic/claude-sonnet-4`. */
	model?: string
	/** Mode or agent identifier. */
	mode?: string
	/** Extra file/context parts. */
	parts?: unknown[]
}

/** Options for queueing an asynchronous prompt. */
export type PromptAsyncOptions = SendMessageOptions & {
	/** Existing message identifier when appending to a queued message. */
	messageID?: string
	/** Whether the server should skip assistant response generation. Defaults to true for SDK safety. */
	noReply?: boolean
	/** Optional system prompt override. */
	system?: string
	/** Provider-specific model variant. */
	variant?: string
	/** Optional tool enablement map. */
	tools?: Record<string, boolean>
	/** Optional response format hint. */
	format?: unknown
	/** Editor context snapshot for the prompt. */
	editorContext?: {
		visibleFiles?: string[]
		openTabs?: string[]
		activeFile?: string
		shell?: string
	}
	/** Optional project directory query parameter. */
	directory?: string
	/** Optional workspace query parameter. */
	workspace?: string
}

/** Events emitted by `ZooClient.on`. */
export type ZooEvent = MessageChunk

/** Permission request emitted by the portable core when a tool needs approval. */
export type PermissionRequest = {
	/** Stable permission request identifier. */
	id: string
	/** Session that owns the request. */
	sessionID: string
	/** Permission capability, such as `bash` or `edit`. */
	permission: string
	/** Optional tool name or payload from the portable core. */
	tool?: unknown
	/** Suggested always-allow patterns. */
	patterns?: string[]
	/** Additional portable-core metadata. */
	metadata?: unknown
	/** Whether this request can be answered as an always rule. */
	always?: boolean
	/** Additional server-provided fields. */
	[key: string]: unknown
}

/** Config loading warning returned by the portable core. */
export type ConfigWarning = {
	/** Config source path or source label that produced the warning. */
	path: string
	/** Human-readable warning message. */
	message: string
	/** Optional detailed diagnostic text. */
	detail?: string
}

/** Always-allow/deny rule selections saved for a pending permission request. */
export type PermissionAlwaysRules = {
	/** Patterns approved for future matching requests. */
	approvedAlways?: string[]
	/** Patterns denied for future matching requests. */
	deniedAlways?: string[]
}

/** Server event emitted by the Zoo CLI event stream. */
export type ZooServerEvent =
	| { type: "permission.asked"; properties: PermissionRequest }
	| { type: string; properties?: unknown; [key: string]: unknown }

/** Permission decision sent back to the portable core. */
export type PermissionReply = {
	/** Approval decision. */
	reply: "once" | "always" | "reject"
	/** Optional user feedback for rejected requests. */
	message?: string
}

/** Portable-core configuration snapshot. Shape is intentionally loose while zoo.jsonc schema stabilizes. */
export type ZooConfig = Record<string, unknown>

/** Configured provider/default-model data returned by the portable core. */
export type ConfigProvidersResult = {
	providers?: Provider[] | Record<string, unknown>
	default?: unknown
	[key: string]: unknown
}
