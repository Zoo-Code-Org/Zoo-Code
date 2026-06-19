import { getModeBySlug, defaultModeSlug } from "../../shared/modes"
import { Task } from "../task/Task"

/**
 * Pure predicate: is `serverName` permitted by the (optional) per-mode allowlist?
 *
 * Semantics (mirrors the listing/filtering layer):
 *   - `undefined` allowlist → ALL servers allowed (backward compatible, feature opt-in)
 *   - empty `[]` allowlist   → NO servers allowed (every invocation rejected)
 *   - populated allowlist    → only listed server names allowed
 *
 * @param serverName The server the model is attempting to invoke.
 * @param allowedMcpServers The mode's allowlist, or `undefined` when the mode does not restrict MCP.
 * @returns true if the invocation should be permitted.
 */
export function isMcpServerAllowed(serverName: string, allowedMcpServers?: string[]): boolean {
	// No allowlist defined → unrestricted (backward compatible).
	if (allowedMcpServers === undefined) {
		return true
	}
	// Defined allowlist (including empty) → membership test. Empty array rejects everything.
	return new Set(allowedMcpServers).has(serverName)
}

/**
 * Resolves the current mode's MCP server allowlist from provider state.
 *
 * Returns `undefined` when the mode does not restrict MCP servers (or when the mode/state
 * cannot be resolved), which the predicate treats as "unrestricted".
 *
 * @param task The current task, used to reach provider state.
 * @returns The mode's `allowedMcpServers` allowlist, or `undefined` when unrestricted.
 */
export async function getAllowedMcpServersForTask(task: Task): Promise<string[] | undefined> {
	const provider = task.providerRef.deref()

	// Be defensive: provider may be gone, or `getState` may be unavailable (e.g. in tests).
	// In those cases we cannot determine an allowlist, so treat the mode as unrestricted to
	// avoid breaking tool execution — the listing/filtering layer remains the primary control.
	if (!provider || typeof provider.getState !== "function") {
		return undefined
	}

	try {
		const state = await provider.getState()
		const modeSlug = state?.mode ?? defaultModeSlug
		const modeConfig = getModeBySlug(modeSlug, state?.customModes)
		return modeConfig?.allowedMcpServers
	} catch {
		return undefined
	}
}

/**
 * Execution-time defense layer for per-mode MCP server restrictions.
 *
 * The listing/filtering layer (build-tools / filter-tools-for-mode / system prompt) only
 * controls which tools are *advertised* to the model. A model may still emit a tool call that
 * references a disallowed server (e.g. from earlier conversation history or hallucination). This
 * guard rejects such invocations at execution time so a disallowed server can never be reached.
 *
 * On rejection it records the tool error and pushes a clear, model-facing error message via
 * `pushToolResult` (consistent with other tool-validation failures) rather than throwing.
 *
 * @param task The current task.
 * @param toolName The MCP tool being invoked (for error reporting).
 * @param serverName The server name the model is attempting to use.
 * @param pushToolResult Callback used to surface the rejection to the model.
 * @param toolError Formatter to wrap the message as a tool error result.
 * @returns true if the invocation is allowed; false if it was rejected (caller must return).
 */
export async function ensureMcpServerAllowed(
	task: Task,
	toolName: "use_mcp_tool" | "access_mcp_resource",
	serverName: string,
	pushToolResult: (content: string) => void,
	toolError: (error: string) => string,
): Promise<boolean> {
	const allowedMcpServers = await getAllowedMcpServersForTask(task)

	if (isMcpServerAllowed(serverName, allowedMcpServers)) {
		return true
	}

	task.consecutiveMistakeCount++
	task.recordToolError(toolName)
	task.didToolFailInCurrentTurn = true

	const allowList = allowedMcpServers ?? []
	const allowedDescription =
		allowList.length > 0
			? `Allowed servers for this mode: ${allowList.join(", ")}.`
			: "No MCP servers are allowed in this mode."

	pushToolResult(
		toolError(
			`The MCP server "${serverName}" is not allowed in the current mode. ${allowedDescription} ` +
				`Do not attempt to use this server; choose an allowed server or a different approach.`,
		),
	)

	return false
}
