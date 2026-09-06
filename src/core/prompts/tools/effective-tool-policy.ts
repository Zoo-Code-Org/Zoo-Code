import type { ModeConfig, ToolGroup, ModelInfo, GroupEntry } from "@roo-code/types"
import { getModeBySlug, defaultModeSlug, getGroupName, getToolsForMode } from "../../../shared/modes"
import { TOOL_ALIASES, TOOL_GROUPS } from "../../../shared/tools"
import type { CodeIndexManager } from "../../../services/code-index/manager"
import type { McpHub } from "../../../services/mcp/McpHub"
import { isToolAllowedForMode } from "../../../core/tools/validateToolUse"

/**
 * Canonical tool names that participate in the task-completion protocol and must
 * remain logically available even when a profile disables them.
 *
 * The effective tool policy re-adds every one of these after `disabledTools` and
 * model-specific exclusions have been applied, so the system prompt and the API's
 * logical allowed set always agree that these tools can be called.
 *
 * `attempt_completion` is the only tool with no coherent prompt state when absent
 * (the task loop can only exit through it), so it is the sole protocol guarantee.
 */
export const PROTOCOL_TOOLS: readonly string[] = ["attempt_completion"]

/**
 * Extract the first edit restriction declared by a mode's groups, if any.
 *
 * A group entry may be either a bare group name (string) or a tuple of
 * `[groupName, options]`. Only a tuple entry with a `fileRegex` establishes a
 * prompt-visible edit restriction.
 *
 * Returning only the first restriction is intentional: the mode schema rejects
 * duplicate groups (the `rawGroupEntryArraySchema` refine in
 * `packages/types/src/mode.ts`), so a mode can declare at most one `edit` group
 * with a `fileRegex`; and the runtime validator (`validateToolUse.ts`) likewise
 * returns at the first matching group, so the prompt and the validator agree.
 *
 * @param groups The mode's group entries.
 * @returns The first `{ fileRegex, description }` found, or undefined when the
 *   mode declares no restricted edit group.
 */
function getEditRestriction(groups: readonly GroupEntry[]):
	| {
			fileRegex: string
			description?: string
	  }
	| undefined {
	for (const group of groups) {
		const groupName = getGroupName(group)
		if (groupName !== "edit") {
			continue
		}
		if (Array.isArray(group) && group[1]?.fileRegex) {
			return { fileRegex: group[1].fileRegex, description: group[1].description }
		}
	}
	return undefined
}

/**
 * Reverse lookup map - maps alias name to canonical tool name.
 * Built once at module load from the central TOOL_ALIASES constant.
 */
const ALIAS_TO_CANONICAL: Map<string, string> = new Map(
	Object.entries(TOOL_ALIASES).map(([alias, canonical]) => [alias, canonical]),
)

/**
 * Resolves a tool name to its canonical name.
 * If the tool name is an alias, returns the canonical tool name.
 * If it's already a canonical name or unknown, returns as-is.
 *
 * @param toolName - The tool name to resolve (may be an alias)
 * @returns The canonical tool name
 */
export function resolveToolAlias(toolName: string): string {
	const canonical = ALIAS_TO_CANONICAL.get(toolName)
	return canonical ?? toolName
}

/**
 * Canonical protocol-tool names already warned about. Module-level so the
 * protocol-override warning fires at most once per tool per process.
 */
const warnedProtocolOverrides = new Set<string>()

/**
 * Warns once per process, per protocol tool, when `disabledTools` tries to
 * disable a protocol tool — which the protocol guarantee step makes a no-op.
 *
 * Uses `console.warn` (not the shared `logger`, which is a no-op in production)
 * so the no-op disable is visible to extension developers.
 *
 * @param disabledTools The raw disabled-tools list (may contain aliases).
 */
function warnProtocolToolOverrides(disabledTools?: string[]): void {
	if (!disabledTools?.length) {
		return
	}
	for (const toolName of disabledTools) {
		const canonical = resolveToolAlias(toolName)
		if (PROTOCOL_TOOLS.includes(canonical) && !warnedProtocolOverrides.has(canonical)) {
			warnedProtocolOverrides.add(canonical)
			console.warn(
				`[effective-tool-policy] '${canonical}' is a protocol tool: disabling it via disabledTools is a no-op; it remains available.`,
			)
		}
	}
}

export interface EffectiveToolPolicyInput {
	mode: string
	customModes?: ModeConfig[]
	mcpHub?: McpHub
	disabledTools?: string[]
	modelInfo?: ModelInfo
	experiments?: Record<string, boolean>
	todoListEnabled?: boolean
	codeIndexManager?: CodeIndexManager
	/**
	 * Optional explicit per-mode MCP server allowlist. When provided it takes
	 * precedence; when omitted the resolver falls back to the mode config's own
	 * allowlist (defense in depth), so a restricted mode can never retain
	 * `access_mcp_resource` based on resources from disallowed servers.
	 */
	allowedMcpServers?: string[]
}

export interface EffectiveToolPolicy {
	/** Canonical tool names logically available for this request (after all filters, incl. protocol guarantee) */
	tools: ReadonlySet<string>
	hasMcpGroup: boolean // mode's groups include "mcp"
	hasMcpTools: boolean // ≥1 dynamic MCP tool enabled for allowed servers
	hasMcpResources: boolean // ≥1 accessible resource on allowed servers
	/**
	 * The mode's first edit-group file restriction. First-only is intentional:
	 * the mode schema rejects duplicate groups, so at most one `edit` group can
	 * carry a `fileRegex`, and the runtime validator likewise stops at the first
	 * matching group — prompt and validator agree.
	 */
	editRestriction?: { fileRegex: string; description?: string }
}

/**
 * True when at least one dynamic MCP tool (e.g. `mcp_serverName_toolName`) is
 * enabled for the allowed servers. Used both to gate the MCP capability bullet in
 * the prompt and to prune `use_mcp_tool` from the policy's tool set, so servers
 * whose every tool is `enabledForPrompt: false` do not count.
 *
 * Cheap existence check: it inspects the MCP server snapshot directly (allowlist
 * + `enabledForPrompt !== false`, mirroring the `getMcpServerTools` filter) and
 * never materializes or normalizes tool schemas.
 *
 * @param mcpHub The MCP hub, or undefined when MCP is unavailable (always false).
 * @param allowedServers Optional per-mode server allowlist; when provided only
 *   these servers are considered.
 * @returns True when at least one allowed server exposes a prompt-enabled tool.
 */
function resolveHasMcpTools(mcpHub?: McpHub, allowedServers?: string[]): boolean {
	if (!mcpHub) {
		return false
	}
	let servers = mcpHub.getServers()
	if (allowedServers) {
		const allowSet = new Set(allowedServers)
		servers = servers.filter((server) => allowSet.has(server.name))
	}
	return servers.some((server) => server.tools?.some((tool) => tool.enabledForPrompt !== false))
}

/**
 * True when `mcpHub` exposes at least one accessible resource on the allowed servers.
 *
 * When `allowedServers` is provided, only servers whose name is in the allowlist
 * are considered, keeping the `access_mcp_resource` availability check consistent
 * with the mode's MCP server allowlist.
 *
 * @param mcpHub The MCP hub whose server snapshot is inspected.
 * @param allowedServers Optional per-mode server allowlist; when provided only
 *   these servers are considered.
 * @returns True when at least one allowed server exposes one or more resources.
 */
export function hasAnyMcpResources(mcpHub: McpHub, allowedServers?: string[]): boolean {
	let servers = mcpHub.getServers()
	if (allowedServers) {
		const allowSet = new Set(allowedServers)
		servers = servers.filter((server) => allowSet.has(server.name))
	}
	return servers.some((server) => server.resources && server.resources.length > 0)
}

/**
 * Computes the request-scoped effective tool policy: the set of tool names
 * logically available for a single request, together with the MCP and edit
 * metadata the system prompt needs.
 *
 * This is the single source of truth shared by prompt generation, API tool
 * construction, runtime validation, and preview. The numbered steps below (1-10)
 * compute the allowed tool set; step 11 adds the protocol guarantee that re-adds
 * `PROTOCOL_TOOLS`.
 *
 * The returned policy is deterministic for a given input. The only side effect
 * is an intentional, process-deduplicated `console.warn` when a protocol tool is
 * disabled via `disabledTools` (such a disable is a no-op); it fires at most once
 * per tool per process, so repeated calls never re-warn and do not affect output.
 *
 * @param input Mode, custom modes, MCP hub, disabled tools, model customization,
 *   experiment flags, todo-list enablement, and the code index manager.
 * @returns An {@link EffectiveToolPolicy} describing the effective tool set.
 */
export function resolveEffectiveToolPolicy(input: EffectiveToolPolicyInput): EffectiveToolPolicy {
	const {
		mode,
		customModes,
		mcpHub,
		disabledTools,
		modelInfo,
		experiments,
		todoListEnabled,
		codeIndexManager,
		allowedMcpServers,
	} = input

	// 1. Resolve mode config with default-slug fallback (existing behavior).
	const modeSlug = mode ?? defaultModeSlug
	const modeConfig = getModeBySlug(modeSlug, customModes) || getModeBySlug(defaultModeSlug, customModes)!

	// 2. Start from all tools granted by the mode's groups (including always-available tools).
	const allowedToolNames = new Set<string>(getToolsForMode(modeConfig.groups))

	// 3. Filter through per-mode permission checks (feature/experiment flags, custom-mode overrides).
	for (const tool of Array.from(allowedToolNames)) {
		if (!isToolAllowedForMode(tool, modeSlug, customModes ?? [], undefined, undefined, experiments ?? {})) {
			allowedToolNames.delete(tool)
		}
	}

	// 4. Apply model-specific tool customization (excluded tools removed; included tools added only when their group is allowed).
	if (modelInfo) {
		// Exclusions.
		if (modelInfo.excludedTools?.length) {
			for (const excluded of modelInfo.excludedTools) {
				allowedToolNames.delete(resolveToolAlias(excluded))
			}
		}
		// Inclusions: only tools belonging to an allowed group are added.
		if (modelInfo.includedTools?.length) {
			const toolToGroup = new Map<string, ToolGroup>()
			for (const [groupName, groupConfig] of Object.entries(TOOL_GROUPS)) {
				groupConfig.tools.forEach((tool) => toolToGroup.set(tool, groupName as ToolGroup))
				groupConfig.customTools?.forEach((tool) => toolToGroup.set(tool, groupName as ToolGroup))
			}

			const allowedGroups = new Set<string>(
				modeConfig.groups.map((groupEntry: GroupEntry) =>
					Array.isArray(groupEntry) ? groupEntry[0] : groupEntry,
				),
			)

			for (const included of modelInfo.includedTools) {
				const resolvedTool = resolveToolAlias(included)
				const toolGroup = toolToGroup.get(resolvedTool)
				if (toolGroup && allowedGroups.has(toolGroup)) {
					allowedToolNames.add(resolvedTool)
				}
			}
		}
	}

	// 5. Drop codebase_search unless the code index is enabled, configured, and initialized.
	if (
		!codeIndexManager ||
		!(codeIndexManager.isFeatureEnabled && codeIndexManager.isFeatureConfigured && codeIndexManager.isInitialized)
	) {
		allowedToolNames.delete("codebase_search")
	}

	// 6. Drop update_todo_list when the todo list is disabled.
	if (todoListEnabled === false) {
		allowedToolNames.delete("update_todo_list")
	}

	// 7. Drop generate_image unless the image-generation experiment is enabled.
	if (experiments?.imageGeneration !== true) {
		allowedToolNames.delete("generate_image")
	}

	// 8. Drop run_slash_command unless the run-slash-command experiment is enabled.
	if (experiments?.runSlashCommand !== true) {
		allowedToolNames.delete("run_slash_command")
	}

	// 9. Drop disabledTools entries (alias-resolved).
	if (disabledTools?.length) {
		for (const toolName of disabledTools) {
			allowedToolNames.delete(resolveToolAlias(toolName))
		}
	}

	// 10. Drop the MCP group tools unless allowed servers actually expose them.
	// Fall back to the mode config's own allowlist when the caller omits the
	// parameter, so the restriction is enforced regardless of call site
	// (defense in depth). `getToolsForMode` grants both group tools together, so
	// each is pruned independently: `access_mcp_resource` when no allowed server
	// exposes resources, and `use_mcp_tool` when no allowed server exposes a
	// prompt-enabled tool (mirrors `getMcpServerTools`, which would emit none).
	const effectiveAllowedMcpServers = allowedMcpServers ?? modeConfig.allowedMcpServers
	const hasMcpResources = !!mcpHub && hasAnyMcpResources(mcpHub, effectiveAllowedMcpServers)
	if (!hasMcpResources) {
		allowedToolNames.delete("access_mcp_resource")
	}
	const hasMcpTools = resolveHasMcpTools(mcpHub, effectiveAllowedMcpServers)
	if (!hasMcpTools) {
		allowedToolNames.delete("use_mcp_tool")
	}

	// 11. Protocol guarantee: re-add every protocol tool so the logical set and
	//     the runtime validator both agree it is callable even when disabled.
	warnProtocolToolOverrides(disabledTools)
	for (const tool of PROTOCOL_TOOLS) {
		allowedToolNames.add(resolveToolAlias(tool))
	}

	const hasMcpGroup = modeConfig.groups.some((groupEntry: GroupEntry) => getGroupName(groupEntry) === "mcp")

	return {
		tools: allowedToolNames,
		hasMcpGroup,
		hasMcpTools,
		hasMcpResources,
		editRestriction: getEditRestriction(modeConfig.groups),
	}
}

/**
 * Builds the runtime `toolRequirements` map (tool name → false) from a list of
 * disabled tool names. Protocol tools and their aliases are intentionally
 * skipped so that `attempt_completion` (and every call site that disables it)
 * can never be marked un-callable at runtime.
 *
 * @param disabledTools The raw disabled-tools list (may contain aliases).
 * @returns A map of disabled canonical/alias names to `false`.
 */
export function buildToolRequirements(disabledTools?: string[]): Record<string, boolean> {
	const requirements: Record<string, boolean> = {}
	if (!disabledTools?.length) {
		return requirements
	}
	for (const toolName of disabledTools) {
		const canonical = resolveToolAlias(toolName)
		if (PROTOCOL_TOOLS.includes(canonical) || PROTOCOL_TOOLS.includes(toolName)) {
			continue
		}
		requirements[toolName] = false
		requirements[canonical] = false
	}
	return requirements
}
