/** A persisted Zoo Code agent session. */
export type Session = {
	/** Stable session identifier. */
	id: string
	/** Optional parent session when this session was forked. */
	parentID?: string
	/** Human-readable session title. */
	title?: string
	/** Session creation time as an ISO string or epoch milliseconds. */
	createdAt?: string | number
	/** Additional server-provided session fields. */
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

/** A portable-core permission rule or decision. */
export type Permission = {
	/** Permission capability, such as `bash` or `edit`. */
	permission: string
	/** Rule action. */
	action: "allow" | "deny" | "ask" | string
	/** Glob or provider-specific pattern. */
	pattern?: string
}

/** Git worktree metadata shared across CLI and editor surfaces. */
export type WorktreeInfo = {
	/** Worktree identifier or path. */
	id: string
	/** Absolute worktree path. */
	path: string
	/** Current branch if known. */
	branch?: string
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

/** Options for sending a message. */
export type SendMessageOptions = {
	/** Provider/model string such as `anthropic/claude-sonnet-4`. */
	model?: string
	/** Mode or agent identifier. */
	mode?: string
	/** Extra file/context parts. */
	parts?: unknown[]
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
