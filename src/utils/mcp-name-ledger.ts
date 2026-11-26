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

interface LedgerEntry extends McpToolAlias {
	/**
	 * A later build recorded a different pair under this function name.
	 * Two scopes advertise one name for two pairs, so no parse can know
	 * which pair the model means. The name stops resolving at all.
	 */
	conflicted: boolean
}

const ledger = new Map<string, LedgerEntry>()

/**
 * Record the original server and tool names under an advertised function name.
 *
 * The first record for a name wins while every build repeats the same pair.
 * When a later scope records a DIFFERENT pair under the same name, the name
 * becomes ambiguous: the entry keeps the first pair but is marked conflicted,
 * and resolveMcpToolAlias refuses it. A conflicted name never resolves to one
 * scope's pair, because that would route the other scope's tool calls to the
 * wrong server.
 */
export function recordMcpToolAlias(functionName: string, serverName: string, toolName: string): void {
	const entry = ledger.get(functionName)
	if (!entry) {
		ledger.set(functionName, { serverName, toolName, conflicted: false })
		return
	}
	if (entry.serverName !== serverName || entry.toolName !== toolName) {
		entry.conflicted = true
	}
}

/**
 * Return the original pair recorded for a function name, if any.
 *
 * Ambiguous names resolve to undefined, like names no build ever produced.
 * Callers keep their legacy split for unknown names, but parseMcpToolName
 * consults isMcpToolNameAmbiguous first so an ambiguous name never falls
 * through to a split of the wire form.
 */
export function resolveMcpToolAlias(functionName: string): McpToolAlias | undefined {
	const entry = ledger.get(functionName)
	if (!entry || entry.conflicted) {
		return undefined
	}
	return { serverName: entry.serverName, toolName: entry.toolName }
}

/**
 * Whether a function name was advertised for two different server/tool pairs.
 * Such a name must not resolve to any pair.
 */
export function isMcpToolNameAmbiguous(functionName: string): boolean {
	return ledger.get(functionName)?.conflicted === true
}

/**
 * Drop every record.
 */
export function clearMcpToolAliases(): void {
	ledger.clear()
}
