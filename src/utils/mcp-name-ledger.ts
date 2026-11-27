/**
 * A process-wide ledger of MCP tool function names.
 *
 * buildMcpToolName sanitizes server and tool names before they reach the
 * model API, and the sanitizer deletes characters such as dots. A bare
 * split of the function name can therefore never return the original
 * names: a tool "System.readFile" reaches the server as "SystemreadFile"
 * (issue #2338). The ledger records the original pair under the exact
 * function name at advertisement time and hands it back at parse time.
 * It also indexes every record under the name's echo form, the string a
 * model produces when it rewrites each "--" separator as "__", so a
 * parser can check all bindings of an echoed name before it resolves
 * anything (CR thread 4713678648).
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
 * Echo form -> the function names recorded under it. Two distinct function
 * names can share one echo form when a separator overlaps an underscore the
 * server or tool name already carries: "mcp--svc_--ping" and
 * "mcp--svc--_ping" both echo as "mcp__svc___ping". A shared echo binds two
 * pairs to one name and must refuse (CR thread 4713678648).
 */
const echoIndex = new Map<string, string[]>()

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
	} else if (entry.serverName !== serverName || entry.toolName !== toolName) {
		entry.conflicted = true
	}
	// Index the record under its echo form. sanitizeMcpName collapses "--"
	// inside names, so the only "--" in a built name are its two separators.
	const echo = functionName.replace(/--/g, "__")
	const names = echoIndex.get(echo)
	if (names) {
		if (!names.includes(functionName)) {
			names.push(functionName)
		}
	} else {
		echoIndex.set(echo, [functionName])
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
 * Return the pair bound to an echoed function name, when exactly one
 * unconflicted name was recorded under that echo form. A shared echo — two
 * recorded names behind one echo form — resolves to nothing, like a
 * conflicted name: the echo cannot tell the scopes apart.
 */
export function resolveMcpToolEcho(name: string): McpToolAlias | undefined {
	const names = echoIndex.get(name.replace(/--/g, "__"))
	if (!names || names.length !== 1) {
		return undefined
	}
	return resolveMcpToolAlias(names[0])
}

/**
 * Whether an echoed name binds to more than one recorded pair, or to one
 * pair that was itself recorded for two scopes. Such an echo must refuse
 * instead of falling through to a split of the wire form.
 */
export function isMcpToolEchoAmbiguous(name: string): boolean {
	const names = echoIndex.get(name.replace(/--/g, "__"))
	if (!names) {
		return false
	}
	if (names.length > 1) {
		return true
	}
	return isMcpToolNameAmbiguous(names[0])
}

/**
 * Drop every record.
 */
export function clearMcpToolAliases(): void {
	ledger.clear()
	echoIndex.clear()
}
