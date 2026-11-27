/**
 * Utilities for sanitizing MCP server and tool names to conform to
 * API function name requirements across all providers.
 */

import {
	isMcpToolNameAmbiguous,
	resolveMcpToolAlias,
	recordMcpToolAlias,
	resolveMcpToolEcho,
	isMcpToolEchoAmbiguous,
} from "./mcp-name-ledger"

/**
 * Separator used between MCP prefix, server name, and tool name.
 * We use "--" (double hyphen) because:
 * 1. It's allowed by all providers (dashes are permitted in function names)
 * 2. It won't conflict with underscores in sanitized server/tool names
 * 3. It's unique enough to be a reliable delimiter for parsing
 */
export const MCP_TOOL_SEPARATOR = "--"

/**
 * Prefix for all MCP tool function names.
 */
export const MCP_TOOL_PREFIX = "mcp"

/**
 * Normalize a string for comparison by treating hyphens and underscores as equivalent.
 * This is used to match tool names when models convert hyphens to underscores.
 *
 * @param name - The name to normalize
 * @returns The normalized name with all hyphens converted to underscores
 */
export function normalizeForComparison(name: string): string {
	return name.replace(/-/g, "_")
}

/**
 * Normalize an MCP tool name by converting underscore separators back to hyphens.
 * This handles the case where models (especially Claude) convert hyphens to underscores
 * in tool names when using native tool calling.
 *
 * For example: "mcp__server__tool" -> "mcp--server--tool"
 *
 * This function uses fuzzy matching - it treats hyphens and underscores as equivalent
 * when normalizing the separator pattern.
 *
 * @param toolName - The tool name that may have underscore separators
 * @returns The normalized tool name with hyphen separators
 */
export function normalizeMcpToolName(toolName: string): string {
	// Normalize for comparison to detect MCP tools regardless of separator style
	const normalized = normalizeForComparison(toolName)

	// Only normalize if it looks like an MCP tool (starts with mcp__)
	if (normalized.startsWith("mcp__")) {
		// Find the pattern: mcp{sep}server{sep}tool where sep is -- or __
		// We need to convert the separators while preserving the rest

		// Prefer the canonical separator when present: a raw "--" can only be a
		// separator, while "__" may be part of a legal server or tool name
		const parts = toolName.includes(MCP_TOOL_SEPARATOR) ? toolName.split(MCP_TOOL_SEPARATOR) : toolName.split("__")

		if (parts.length >= 3 && parts[0].toLowerCase() === "mcp") {
			// Reconstruct with proper -- separators
			const serverName = parts[1]
			const toolNamePart = parts.slice(2).join("--") // Rejoin in case tool name had separator
			return `${MCP_TOOL_PREFIX}${MCP_TOOL_SEPARATOR}${serverName}${MCP_TOOL_SEPARATOR}${toolNamePart}`
		}
	}
	return toolName
}

/**
 * Check if a tool name is an MCP tool (starts with the MCP prefix and separator).
 * Uses fuzzy matching to handle both hyphen and underscore separators.
 *
 * @param toolName - The tool name to check
 * @returns true if the tool name starts with "mcp--" or "mcp__", false otherwise
 */
export function isMcpTool(toolName: string): boolean {
	const normalized = normalizeForComparison(toolName)
	return normalized.startsWith(`${MCP_TOOL_PREFIX}__`)
}

/**
 * Sanitize a name to be safe for use in API function names.
 * This removes special characters and ensures the name starts correctly.
 *
 * Note: Hyphens are preserved since they are valid in function names.
 * Models may convert hyphens to underscores, but we handle this with
 * fuzzy matching when parsing tool names.
 *
 * @param name - The original name (e.g., MCP server name or tool name)
 * @returns A sanitized name that conforms to API requirements
 */
export function sanitizeMcpName(name: string): string {
	if (!name) {
		return "_"
	}

	// Replace spaces with underscores first
	let sanitized = name.replace(/\s+/g, "_")

	// Only allow alphanumeric, underscores, and hyphens
	sanitized = sanitized.replace(/[^a-zA-Z0-9_-]/g, "")

	// Replace any double-hyphen sequences with single hyphen to avoid separator conflicts
	sanitized = sanitized.replace(/--+/g, "-")

	// Ensure the name starts with a letter or underscore
	if (sanitized.length > 0 && !/^[a-zA-Z_]/.test(sanitized)) {
		sanitized = "_" + sanitized
	}

	// If empty after sanitization, use a placeholder
	if (!sanitized) {
		sanitized = "_unnamed"
	}

	return sanitized
}

/**
 * Build a full MCP tool function name from server and tool names.
 * The format is: mcp--{sanitized_server_name}--{sanitized_tool_name}
 *
 * The total length is capped at 64 characters to conform to API limits.
 *
 * @param serverName - The MCP server name
 * @param toolName - The tool name
 * @returns A sanitized function name in the format mcp--serverName--toolName
 */
export function buildMcpToolName(serverName: string, toolName: string): string {
	const sanitizedServer = sanitizeMcpName(serverName)
	const sanitizedTool = sanitizeMcpName(toolName)

	// Build the full name: mcp--{server}--{tool}
	const fullName = `${MCP_TOOL_PREFIX}${MCP_TOOL_SEPARATOR}${sanitizedServer}${MCP_TOOL_SEPARATOR}${sanitizedTool}`

	// Truncate if necessary (max 64 chars for Gemini)
	const functionName = fullName.length > 64 ? fullName.slice(0, 64) : fullName

	// The sanitized name may have lost characters (dots, spaces) or length.
	// Record the original pair under the exact name the model will call, so
	// parseMcpToolName can hand them back (issue #2338).
	recordMcpToolAlias(functionName, serverName, toolName)

	return functionName
}

/**
 * Upper bound on the "__" runs a name may carry before candidate key
 * enumeration is skipped. Models rewrite the "--" separator as "__", and a
 * server or tool name may hold its own "__", so more than one position can
 * be a separator. Each subset of runs maps back to "--" to form one
 * candidate ledger key. Real names carry a handful of runs; a name beyond
 * this bound keeps the legacy split behavior instead of a combinatorial
 * search over the ledger.
 */
const MAX_CANDIDATE_SEPARATORS = 6

/**
 * Build every candidate ledger key for an echoed function name.
 *
 * The model echoes "mcp--svc__prod--readfile" as "mcp__svc__prod__readfile",
 * where the first and last "__" are rewritten separators and the middle one
 * belongs to the server name. A single normalized form cannot recover that
 * key, so each subset of "__" runs is mapped back to "--" and checked
 * against the ledger. The raw form itself is skipped: the caller already
 * tried it as an exact key.
 */
function ledgerCandidateKeys(mcpToolName: string): string[] {
	const segments = mcpToolName.split("__")
	const runs = segments.length - 1
	if (runs < 1 || runs > MAX_CANDIDATE_SEPARATORS) {
		return []
	}
	const keys: string[] = []
	for (let mask = 1; mask < 1 << runs; mask++) {
		let key = segments[0]
		for (let i = 0; i < runs; i++) {
			key += (mask & (1 << i) ? MCP_TOOL_SEPARATOR : "__") + segments[i + 1]
		}
		keys.push(key)
	}
	return keys
}

/**
 * Parse an MCP tool function name back into server and tool names.
 * This handles both hyphen and underscore separators using fuzzy matching.
 *
 * A name the ledger marks ambiguous resolves to null: it was advertised for
 * two different pairs, so no pair is safe to return.
 *
 * @param mcpToolName - The full MCP tool name (e.g., "mcp--weather--get_forecast" or "mcp__weather__get_forecast")
 * @returns An object with serverName and toolName, or null if parsing fails
 */
export function parseMcpToolName(mcpToolName: string): { serverName: string; toolName: string } | null {
	// Prefer the exact pair recorded when the name was built: sanitization may
	// have deleted characters that the split below can never restore (issue
	// #2338). The raw name is tried first, then the recorded echo bindings of
	// the raw and the normalized form. Models rewrite the "--" separators as
	// "__", and a separator can overlap an underscore the server or tool name
	// already carries, so no split of the echoed string recovers every
	// recorded key (CR thread 4713678648): the ledger indexes each record by
	// its echo form instead. An echo bound to two different pairs resolves to
	// nothing here; the ambiguity check below refuses the call.
	const normalizedName = normalizeMcpToolName(mcpToolName)
	const alias =
		resolveMcpToolAlias(mcpToolName) ?? resolveMcpToolEcho(mcpToolName) ?? resolveMcpToolEcho(normalizedName)
	if (alias) {
		return { serverName: alias.serverName, toolName: alias.toolName }
	}

	// An echoed name whose server or tool name carries its own "__" hides the
	// recorded key: the rewrite of the separators cannot be told apart from
	// the name's own underscores. Enumerate the candidate keys instead.
	// Every candidate must agree on one pair; two different pairs, or a
	// candidate the ledger marks ambiguous, leave the call unresolved.
	let candidate: { serverName: string; toolName: string } | undefined
	let ambiguous =
		isMcpToolNameAmbiguous(mcpToolName) ||
		isMcpToolNameAmbiguous(normalizedName) ||
		isMcpToolEchoAmbiguous(mcpToolName) ||
		isMcpToolEchoAmbiguous(normalizedName)
	for (const key of ledgerCandidateKeys(mcpToolName)) {
		if (isMcpToolNameAmbiguous(key)) {
			ambiguous = true
			break
		}
		const hit = resolveMcpToolAlias(key)
		if (!hit) {
			continue
		}
		if (candidate && (candidate.serverName !== hit.serverName || candidate.toolName !== hit.toolName)) {
			ambiguous = true
			break
		}
		candidate ??= hit
	}
	if (ambiguous) {
		return null
	}
	if (candidate) {
		return { serverName: candidate.serverName, toolName: candidate.toolName }
	}

	// Normalize the name to handle both separator styles
	const prefix = MCP_TOOL_PREFIX + MCP_TOOL_SEPARATOR
	if (!normalizedName.startsWith(prefix)) {
		return null
	}

	// Remove the "mcp--" prefix
	const remainder = normalizedName.slice(prefix.length)

	// Split on the separator to get server and tool names
	const separatorIndex = remainder.indexOf(MCP_TOOL_SEPARATOR)
	if (separatorIndex === -1) {
		return null
	}

	const serverName = remainder.slice(0, separatorIndex)
	const toolName = remainder.slice(separatorIndex + MCP_TOOL_SEPARATOR.length)

	if (!serverName || !toolName) {
		return null
	}

	return {
		serverName,
		toolName,
	}
}

/**
 * Check if two tool names match using fuzzy comparison.
 * Treats hyphens and underscores as equivalent.
 *
 * @param name1 - First tool name
 * @param name2 - Second tool name
 * @returns true if the names match (treating - and _ as equivalent)
 */
export function toolNamesMatch(name1: string, name2: string): boolean {
	return normalizeForComparison(name1) === normalizeForComparison(name2)
}
