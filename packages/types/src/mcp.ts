import { z } from "zod"

/** Canonical generated names, including prefixes cut off at the provider's 64-character limit. */
export function isCanonicalMcpToolName(name: string): boolean {
	if (name.length > 64 || !/^mcp--[A-Za-z_][\w-]*$/.test(name)) return false
	// Check the separator separately so two overlapping repetitions cannot backtrack.
	return name.length === 64 || /--[A-Za-z_]/.test(name.slice(6))
}

export const DEFAULT_MCP_DYNAMIC_LOAD_THRESHOLD = 50
export const DEFAULT_MCP_DYNAMIC_LOAD_INITIAL_K = 30
export const DEFAULT_MCP_DYNAMIC_LOAD_SEARCH_TURNS = 7
export const MAX_ATTACHED_DURING_ROLLING = 60

/** The MCP declarations of the newest gated tool build of a task. */
export interface McpToolStatus {
	attachedToolNames: string[]
	/** MCP tools that the mode and the tool policy allow. */
	totalScoped: number
}

export const mcpDynamicLoadThresholdSchema = z.number().int().min(0)
export const mcpDynamicLoadInitialKSchema = z.number().int().min(1)
export const mcpDynamicLoadSearchTurnsSchema = z.number().int().min(0)

/** Apply the same validation to persisted values and direct runtime callers. */
export function resolveMcpDynamicLoadSettings(threshold: unknown, initialK: unknown, searchTurns?: unknown) {
	return {
		threshold: mcpDynamicLoadThresholdSchema.safeParse(threshold).data ?? DEFAULT_MCP_DYNAMIC_LOAD_THRESHOLD,
		initialK: mcpDynamicLoadInitialKSchema.safeParse(initialK).data ?? DEFAULT_MCP_DYNAMIC_LOAD_INITIAL_K,
		searchTurns:
			mcpDynamicLoadSearchTurnsSchema.safeParse(searchTurns).data ?? DEFAULT_MCP_DYNAMIC_LOAD_SEARCH_TURNS,
	}
}

/**
 * McpServerUse
 */

export interface McpServerUse {
	type: string
	serverName: string
	toolName?: string
	uri?: string
}

/**
 * McpExecutionStatus
 */

export const mcpExecutionStatusSchema = z.discriminatedUnion("status", [
	z.object({
		executionId: z.string(),
		status: z.literal("started"),
		serverName: z.string(),
		toolName: z.string(),
	}),
	z.object({
		executionId: z.string(),
		status: z.literal("output"),
		response: z.string(),
	}),
	z.object({
		executionId: z.string(),
		status: z.literal("completed"),
		response: z.string().optional(),
	}),
	z.object({
		executionId: z.string(),
		status: z.literal("error"),
		error: z.string().optional(),
	}),
])

export type McpExecutionStatus = z.infer<typeof mcpExecutionStatusSchema>

/**
 * McpServer
 */

export type McpServer = {
	name: string
	config: string
	status: "connected" | "connecting" | "disconnected"
	error?: string
	errorHistory?: McpErrorEntry[]
	tools?: McpTool[]
	resources?: McpResource[]
	resourceTemplates?: McpResourceTemplate[]
	disabled?: boolean
	timeout?: number
	source?: "global" | "project"
	projectPath?: string
	instructions?: string
}

export type McpTool = {
	name: string
	description?: string
	inputSchema?: object
	alwaysAllow?: boolean
	enabledForPrompt?: boolean
}

export type McpResource = {
	uri: string
	name: string
	mimeType?: string
	description?: string
}

export type McpResourceTemplate = {
	uriTemplate: string
	name: string
	description?: string
	mimeType?: string
}

export type McpResourceResponse = {
	_meta?: Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
	contents: Array<{
		uri: string
		mimeType?: string
		text?: string
		blob?: string
	}>
}

export type McpResourceLinkAnnotations = {
	audience?: ("user" | "assistant")[]
	priority?: number
	lastModified?: string
}

// Defined in MCP spec 2025-06-18: https://modelcontextprotocol.io/specification/2025-06-18/server/tools
export type McpResourceLink = {
	type: "resource_link"
	uri: string
	name: string
	description?: string
	mimeType?: string
	title?: string
	size?: number
	annotations?: McpResourceLinkAnnotations
}

export type McpToolCallResponse = {
	_meta?: Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
	content: Array<
		| { type: "text"; text: string }
		| { type: "image"; data: string; mimeType: string }
		| { type: "audio"; data: string; mimeType: string }
		| { type: "resource"; resource: { uri: string; mimeType?: string; text?: string; blob?: string } }
		| McpResourceLink
	>
	isError?: boolean
}

export type McpErrorEntry = {
	message: string
	timestamp: number
	level: "error" | "warn" | "info"
}
