/**
 * A process-wide ledger of MCP tool function names.
 *
 * buildMcpToolName sanitizes server and tool names before they reach the
 * model API, and the sanitizer deletes characters such as dots. A bare
 * split of the function name can therefore never return the original
 * names: a tool "System.readFile" reaches the server as "SystemreadFile"
 * (issue #2338). The ledger records the original pair under the exact
 * function name at advertisement time and hands it back at parse time.
 */

export interface McpToolAlias {
	serverName: string
	toolName: string
}

const ledger = new Map<string, McpToolAlias>()

/**
 * Record the original server and tool names under an advertised function name.
 *
 * The first record for a name wins. Two different pairs can sanitize to the
 * same function name, and the tool definition builder already resolves that
 * collision with a first-occurrence-wins rule; a stable resolution keeps the
 * model's view of one name consistent.
 */
export function recordMcpToolAlias(functionName: string, serverName: string, toolName: string): void {
	if (!ledger.has(functionName)) {
		ledger.set(functionName, { serverName, toolName })
	}
}

/**
 * Return the original pair recorded for a function name, if any.
 *
 * Names that no build ever produced resolve to undefined. Callers keep
 * their legacy split for those.
 */
export function resolveMcpToolAlias(functionName: string): McpToolAlias | undefined {
	return ledger.get(functionName)
}

/**
 * Drop every record.
 */
export function clearMcpToolAliases(): void {
	ledger.clear()
}
