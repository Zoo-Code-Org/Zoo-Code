import type { ModeConfig, ToolGroup, ModelInfo, GroupEntry } from "@roo-code/types"
import { getModeBySlug, defaultModeSlug, getGroupName, getToolsForMode } from "../../../shared/modes"
import { TOOL_ALIASES, TOOL_GROUPS } from "../../../shared/tools"
import type { CodeIndexManager } from "../../../services/code-index/manager"
import { isToolAllowedForMode } from "../../../core/tools/validateToolUse"

type EffectiveMcpHub = {
	getServers(): Array<{
		name: string
		resources?: Array<{ uri: string; name?: string }>
		tools?: Array<{ enabledForPrompt?: boolean }>
	}>
}

/**
 * Canonical tool names that participate in the task-completion protocol.
 *
 * The effective tool policy re-adds these after the mode/permission filters, so a
 * mode that grants no groups still advertises them. A user `disabledTools` entry
 * cannot suppress them: such entries are ignored at policy entry (see
 * `partitionDisabledToolsForProtocol`), because the task loop can only exit
 * through the completion tool and configuration must not be able to close that
 * route. A model-profile `excludedTools` entry still suppresses the re-add and
 * reaches the runtime requirements, so prompt and validator agree on it too.
 *
 * `attempt_completion` is the only tool with no coherent prompt state when absent
 * (the task loop can only exit through it), so it is the sole protocol entry.
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
 * True when `toolName` is suppressed by the user's `disabledTools` list or the
 * model's `excludedTools` customization, comparing alias-resolved names exactly
 * as the resolver's exclusion steps do.
 *
 * This is the membership test behind those resolver steps, exposed for callers
 * (the MCP tool filter, the protocol-tool re-add step) that gate a whole tool
 * class on one canonical name without computing the full policy set. It answers
 * "is it listed", which is deliberately stricter than "is it finally available"
 * for tools that the resolver's later steps could re-grant through
 * `includedTools` or group membership.
 *
 * @param toolName The canonical tool name to test (may itself be an alias).
 * @param disabledTools The user's disabled-tools list (may contain aliases).
 * @param modelInfo The model customization whose `excludedTools` may list it.
 * @returns True when either list suppresses the tool.
 */
export function isToolDisabledOrExcluded(
	toolName: string,
	disabledTools: string[] | undefined,
	modelInfo: ModelInfo | undefined,
): boolean {
	const canonical = resolveToolAlias(toolName)
	const isSuppressed = (entry: string): boolean => resolveToolAlias(entry) === canonical
	return Boolean(disabledTools?.some(isSuppressed)) || Boolean(modelInfo?.excludedTools?.some(isSuppressed))
}

/**
 * Partitions a raw user `disabledTools` list into entries that carry disabling
 * weight and entries that name a protocol tool.
 *
 * Protocol tools are exempt from user disabling: the task loop exits only
 * through `attempt_completion`, so a configuration entry must not be able to
 * close that route. `effective` is what every suppression consumer must act
 * on, while `ignored` surfaces the stripped entries so callers can report
 * what was ignored instead of re-deriving the predicate elsewhere. Entries
 * are matched after alias resolution.
 *
 * @param disabledTools The user's disabled-tools list (may contain aliases).
 * @returns Order-preserving `effective` entries, plus the de-duplicated
 *   `ignored` entries that name a protocol tool.
 */
export function partitionDisabledToolsForProtocol(disabledTools: string[] | undefined): {
	effective: string[]
	ignored: string[]
} {
	const effective: string[] = []
	const ignored: string[] = []
	for (const entry of disabledTools ?? []) {
		if (PROTOCOL_TOOLS.includes(resolveToolAlias(entry))) {
			ignored.push(entry)
		} else {
			effective.push(entry)
		}
	}
	return { effective, ignored: [...new Set(ignored)] }
}

export interface EffectiveToolPolicyInput {
	mode: string
	customModes?: ModeConfig[]
	mcpHub?: EffectiveMcpHub
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
function resolveHasMcpTools(mcpHub?: EffectiveMcpHub, allowedServers?: string[]): boolean {
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
function hasAnyMcpResources(mcpHub: EffectiveMcpHub, allowedServers?: string[]): boolean {
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
 * compute the allowed tool set; step 11 re-adds `PROTOCOL_TOOLS` unless the
 * model's `excludedTools` suppresses them — `disabledTools` entries naming a
 * protocol tool are partitioned out at entry and carry no disabling weight.
 *
 * The returned policy is deterministic for a given input and free of side
 * effects.
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

	// A disabledTools entry naming a protocol tool carries no disabling weight;
	// partition it out once at entry so no later step can act on it.
	const { effective: effectiveDisabledTools } = partitionDisabledToolsForProtocol(disabledTools)

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

	// 9. Drop effective disabledTools entries (alias-resolved).
	if (effectiveDisabledTools.length) {
		for (const toolName of effectiveDisabledTools) {
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

	// 11. Protocol guarantee: re-add every protocol tool that the effective
	//     disabledTools list and the model's excludedTools do not suppress.
	//     After the entry partition only an excludedTools entry can suppress
	//     one, and `buildToolRequirements` partitions the same entries out of
	//     the runtime requirements, so the logical set and the validator
	//     cannot disagree about the completion tool in either direction.
	for (const tool of PROTOCOL_TOOLS) {
		if (!isToolDisabledOrExcluded(tool, effectiveDisabledTools, modelInfo)) {
			allowedToolNames.add(resolveToolAlias(tool))
		}
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
 * Builds the runtime `toolRequirements` map (tool name → false) from every entry
 * that carries disabling weight: the user's `disabledTools` minus protocol-tool
 * entries, plus every model `excludedTools` entry.
 *
 * A requirements entry outranks the always-available class in `validateToolUse`,
 * so every tool mapped here is rejected at execution with the standard
 * validation error tool_result, matching its removal from the policy. A
 * `disabledTools` entry naming a protocol tool is deliberately absent — the tool
 * stays callable, matching its retention in the policy.
 *
 * @param disabledTools The raw disabled-tools list (may contain aliases).
 * @param modelInfo The model customization whose `excludedTools` may suppress a
 *   protocol tool.
 * @returns A map of suppressed canonical/alias names to `false`.
 */
export function buildToolRequirements(disabledTools?: string[], modelInfo?: ModelInfo): Record<string, boolean> {
	const requirements: Record<string, boolean> = {}
	const { effective } = partitionDisabledToolsForProtocol(disabledTools)
	for (const toolName of [...effective, ...(modelInfo?.excludedTools ?? [])]) {
		const canonical = resolveToolAlias(toolName)
		requirements[toolName] = false
		requirements[canonical] = false
	}
	return requirements
}
