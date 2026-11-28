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
 *
 * Records are scoped. Every build of an MCP tool list runs inside a scope
 * owned by the caller (McpHub creates one per server-list generation and
 * ends it when the list changes, CR thread 4727751392). A pair whose scope
 * ended stops being advertised; once it is the only pair ever recorded for
 * a name it keeps resolving, so a renamed server's tool works again. A
 * name that two live scopes advertise for two different pairs resolves to
 * nothing: no parse can know which pair the model means. Records made
 * without a scope are never released and behave like the pre-scope
 * process-wide ledger.
 */

export interface McpToolAlias {
	serverName: string
	toolName: string
}

interface PairRecord extends McpToolAlias {
	/**
	 * The scopes currently advertising this pair. Ending a scope removes
	 * its token; a record whose scopes are all gone stays as history, so
	 * the collapse rule can still see the one pair the name ever had.
	 */
	scopes: Set<string>
}

const ledger = new Map<string, Map<string, PairRecord>>()

/**
 * Echo form -> the function names recorded under it. Two distinct function
 * names can share one echo form when a separator overlaps an underscore the
 * server or tool name already carries: "mcp--svc_--ping" and
 * "mcp--svc--_ping" both echo as "mcp__svc___ping". A shared echo binds two
 * pairs to one name and must refuse (CR thread 4713678648).
 */
const echoIndex = new Map<string, string[]>()

/**
 * The scope of records made without one (the ToolRouter ranking path and
 * hub-less builds). It is never handed to endMcpToolAliasScope, so those
 * records live for the whole process.
 */
const UNSCOPED = ""

let scopeCounter = 0

/**
 * Create a scope token. A build passes its scope to buildMcpToolName so
 * the records it makes can be released together when the caller's tool
 * list stops being current.
 */
export function createMcpToolAliasScope(): string {
	scopeCounter += 1
	return `mcp-alias-scope-${scopeCounter}`
}

/**
 * End a scope: every record it advertised stops being actively advertised.
 * The records themselves stay, so a name with exactly one lifetime pair
 * keeps resolving across scope ends. Ending an unknown scope does nothing.
 */
export function endMcpToolAliasScope(scopeId: string): void {
	for (const records of ledger.values()) {
		for (const record of records.values()) {
			record.scopes.delete(scopeId)
		}
	}
}

function pairKey(serverName: string, toolName: string): string {
	return JSON.stringify([serverName, toolName])
}

function recordsOf(functionName: string): PairRecord[] {
	const records = ledger.get(functionName)
	return records ? [...records.values()] : []
}

/**
 * Record the original server and tool names under an advertised function
 * name, as advertised by the given scope (or without a scope).
 *
 * The first record for a name wins while every live scope repeats the same
 * pair. When live scopes record DIFFERENT pairs under the same name, the
 * name is ambiguous: resolveMcpToolAlias refuses it. A conflicted name
 * never resolves to one scope's pair, because that would route the other
 * scope's tool calls to the wrong server. When the conflicting scopes end,
 * the surviving pair resolves again.
 */
export function recordMcpToolAlias(functionName: string, serverName: string, toolName: string, scopeId?: string): void {
	let records = ledger.get(functionName)
	if (!records) {
		records = new Map()
		ledger.set(functionName, records)
	}
	const key = pairKey(serverName, toolName)
	const record = records.get(key)
	if (record) {
		record.scopes.add(scopeId ?? UNSCOPED)
	} else {
		records.set(key, { serverName, toolName, scopes: new Set([scopeId ?? UNSCOPED]) })
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
 * Collapse records to one resolvable pair. Exactly one live pair wins.
 * With no live pair, exactly one lifetime pair still resolves, so a name
 * keeps working across scope ends. Two distinct live pairs, or two
 * lifetime pairs with every scope gone, are ambiguous: no pair is safe to
 * return. No records at all means the name is unknown.
 */
function collapse(records: PairRecord[]): McpToolAlias | "ambiguous" | "unknown" {
	const active = records.filter((record) => record.scopes.size > 0)
	const pool = active.length > 0 ? active : records
	const distinct = new Map<string, PairRecord>()
	for (const record of pool) {
		distinct.set(pairKey(record.serverName, record.toolName), record)
	}
	if (distinct.size === 1) {
		const [record] = distinct.values()
		return record ? { serverName: record.serverName, toolName: record.toolName } : "unknown"
	}
	return distinct.size === 0 ? "unknown" : "ambiguous"
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
	const collapsed = collapse(recordsOf(functionName))
	return typeof collapsed === "string" ? undefined : collapsed
}

/**
 * Whether a function name cannot safely resolve to any pair: two distinct
 * live scopes advertise different pairs for it, or two different pairs were
 * advertised and every scope has since ended.
 */
export function isMcpToolNameAmbiguous(functionName: string): boolean {
	return collapse(recordsOf(functionName)) === "ambiguous"
}

/**
 * Return the pair bound to an echoed function name, when its records
 * collapse to exactly one pair. A shared echo — two recorded names behind
 * one echo form — resolves to nothing while both are live, like a
 * conflicted name: the echo cannot tell the scopes apart.
 */
export function resolveMcpToolEcho(name: string): McpToolAlias | undefined {
	const names = echoIndex.get(name.replace(/--/g, "__"))
	if (!names) {
		return undefined
	}
	const collapsed = collapse(names.flatMap(recordsOf))
	return typeof collapsed === "string" ? undefined : collapsed
}

/**
 * Whether an echoed name cannot safely resolve to any pair: its records
 * bind more than one live pair, or more than one lifetime pair with every
 * scope gone. Such an echo must refuse instead of falling through to a
 * split of the wire form.
 */
export function isMcpToolEchoAmbiguous(name: string): boolean {
	const names = echoIndex.get(name.replace(/--/g, "__"))
	if (!names) {
		return false
	}
	return collapse(names.flatMap(recordsOf)) === "ambiguous"
}

/**
 * Drop every record.
 *
 * An explicit internal test seam: the ledger is process-wide, so specs
 * reset it between tests to isolate their own records. No production
 * path clears the ledger; scopes end their own records
 * (McpToolNameLedger.tla models EndScope, not a clear).
 *
 * @internal
 */
export function clearMcpToolAliases(): void {
	ledger.clear()
	echoIndex.clear()
}
