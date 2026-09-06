import type OpenAI from "openai"
import type { ModeConfig, ModelInfo } from "@roo-code/types"
import { defaultModeSlug } from "../../../shared/modes"
import type { CodeIndexManager } from "../../../services/code-index/manager"
import type { McpHub } from "../../../services/mcp/McpHub"
import { resolveEffectiveToolPolicy, resolveToolAlias } from "./effective-tool-policy"
import { isToolAllowedForMode } from "../../../core/tools/validateToolUse"

// Re-export the resolver's alias helper so existing importers of this module
// (NativeToolCallParser, presentAssistantMessage, build-tools) keep binding to the
// single canonical implementation in effective-tool-policy.ts.
export { resolveToolAlias }

/**
 * Cache for renamed tool definitions.
 * Maps "canonicalName:aliasName" to the pre-built tool definition.
 * This avoids creating new objects via spread operators on every assistant message.
 */
const RENAMED_TOOL_CACHE: Map<string, OpenAI.Chat.ChatCompletionTool> = new Map()

/**
 * Gets or creates a renamed tool definition with the alias name.
 * Uses RENAMED_TOOL_CACHE to avoid repeated object allocation.
 *
 * @param tool - The original tool definition
 * @param aliasName - The alias name to use
 * @returns Cached or newly created renamed tool definition
 */
function getOrCreateRenamedTool(
	tool: OpenAI.Chat.ChatCompletionTool,
	aliasName: string,
): OpenAI.Chat.ChatCompletionTool {
	if (!("function" in tool) || !tool.function) {
		return tool
	}

	const cacheKey = `${tool.function.name}:${aliasName}`
	let renamedTool = RENAMED_TOOL_CACHE.get(cacheKey)

	if (!renamedTool) {
		renamedTool = {
			...tool,
			function: {
				...tool.function,
				name: aliasName,
			},
		}
		RENAMED_TOOL_CACHE.set(cacheKey, renamedTool)
	}

	return renamedTool
}

/**
 * Filters native tools based on mode restrictions and model customization.
 * This ensures native tools are filtered consistently with mode/tool permissions.
 *
 * @param nativeTools - Array of all available native tools
 * @param mode - Current mode slug
 * @param customModes - Custom mode configurations
 * @param experiments - Experiment flags
 * @param codeIndexManager - Code index manager for codebase_search feature check
 * @param settings - Additional settings for tool filtering (includes modelInfo for model-specific customization)
 * @param mcpHub - MCP hub for checking available resources
 * @param allowedMcpServers - Optional allowlist of MCP server names for the current mode. When
 *   provided, the resource-availability check only considers servers in this list, so a mode that
 *   restricts MCP servers cannot retain `access_mcp_resource` based on resources from disallowed servers.
 * @returns Filtered array of tools allowed for the mode
 */
export function filterNativeToolsForMode(
	nativeTools: OpenAI.Chat.ChatCompletionTool[],
	mode: string | undefined,
	customModes: ModeConfig[] | undefined,
	experiments: Record<string, boolean> | undefined,
	codeIndexManager?: CodeIndexManager,
	settings?: Record<string, any>,
	mcpHub?: McpHub,
	allowedMcpServers?: string[],
): OpenAI.Chat.ChatCompletionTool[] {
	// Resolve the single, request-scoped effective tool policy. The filter below
	// consumes only its `tools` set (plus alias renames from model customization),
	// so prompt generation and API tool construction agree on the logical allowed
	// set. attempt_completion is always advertised (the protocol guarantee), even
	// if it appears in disabledTools.
	const modelInfo = settings?.modelInfo as ModelInfo | undefined

	const policy = resolveEffectiveToolPolicy({
		mode: mode ?? defaultModeSlug,
		customModes,
		mcpHub,
		disabledTools: settings?.disabledTools,
		modelInfo,
		experiments,
		todoListEnabled: settings?.todoListEnabled,
		codeIndexManager,
		allowedMcpServers,
	})

	// Apply model-specific alias renames (canonical -> alias) to the allowed set.
	// Included-tools customization may rename a tool to the alias the caller asked
	// for; excluded/always-available semantics are already resolved by the resolver.
	const aliasRenames = resolveModelAliasRenames(modelInfo, policy.tools)

	// Filter native tools based on the allowed tool names and apply alias renames
	const filteredTools: OpenAI.Chat.ChatCompletionTool[] = []

	for (const tool of nativeTools) {
		// Handle both ChatCompletionTool and ChatCompletionCustomTool
		if ("function" in tool && tool.function) {
			const toolName = tool.function.name
			if (policy.tools.has(resolveToolAlias(toolName))) {
				// Check if this tool should be renamed to an alias
				const aliasName = aliasRenames.get(toolName)
				if (aliasName) {
					// Use cached renamed tool definition to avoid per-message object allocation
					filteredTools.push(getOrCreateRenamedTool(tool, aliasName))
				} else {
					filteredTools.push(tool)
				}
			}
		}
	}

	return filteredTools
}

/**
 * Computes canonical -> alias renames from model-specific included-tools
 * customization, but only for tools that remain in the effective policy's allowed
 * set (exclusions are already applied by the resolver). An alias listed in
 * includedTools renames the canonical tool to that alias.
 */
function resolveModelAliasRenames(
	modelInfo: ModelInfo | undefined,
	allowedTools: ReadonlySet<string>,
): Map<string, string> {
	const aliasRenames = new Map<string, string>()
	if (!modelInfo?.includedTools?.length) {
		return aliasRenames
	}
	for (const included of modelInfo.includedTools) {
		const canonical = resolveToolAlias(included)
		if (canonical !== included && allowedTools.has(canonical)) {
			aliasRenames.set(canonical, included)
		}
	}
	return aliasRenames
}

/**
 * Filters MCP tools based on whether use_mcp_tool is allowed in the current mode.
 *
 * @param mcpTools - Array of MCP tools
 * @param mode - Current mode slug
 * @param customModes - Custom mode configurations
 * @param experiments - Experiment flags
 * @returns Filtered array of MCP tools if use_mcp_tool is allowed, empty array otherwise
 */
export function filterMcpToolsForMode(
	mcpTools: OpenAI.Chat.ChatCompletionTool[],
	mode: string | undefined,
	customModes: ModeConfig[] | undefined,
	experiments: Record<string, boolean> | undefined,
): OpenAI.Chat.ChatCompletionTool[] {
	const modeSlug = mode ?? defaultModeSlug

	// MCP tools are always in the mcp group, check if use_mcp_tool is allowed
	const isMcpAllowed = isToolAllowedForMode(
		"use_mcp_tool",
		modeSlug,
		customModes ?? [],
		undefined,
		undefined,
		experiments ?? {},
	)

	return isMcpAllowed ? mcpTools : []
}
