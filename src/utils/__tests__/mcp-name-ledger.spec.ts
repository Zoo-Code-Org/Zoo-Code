import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { clearMcpToolAliases, createMcpToolAliasScope, endMcpToolAliasScope } from "../mcp-name-ledger"
import { buildMcpToolName, normalizeMcpToolName, parseMcpToolName } from "../mcp-name"

/**
 * The ledger makes the advertised function name resolvable to the original
 * server and tool names. sanitizeMcpName deletes characters (dots, spaces,
 * "@", ...), so a bare split can never return them. buildMcpToolName records
 * the original pair; parseMcpToolName reads it back. Names that were never
 * built keep the legacy split behavior.
 *
 * Invariant under test (docs/architecture/tla/McpToolNameLedger.tla,
 * ExactRoundTrip): a resolved pair was advertised under that exact name.
 */

// A server and a tool whose names carry characters that sanitizeMcpName
// deletes. The issue reports dots: "System.readFile" reaches the server as
// "SystemreadFile".
const DOTTED_CASES: Array<[string, string]> = [
	["System.reader", "readFile"],
	["my.server", "read.file"],
	["System.reader", "read.file"],
	["a.b.c", "d.e.f"],
	["svc-1.0", "get.user.info"],
	["my server", "my.tool"],
	["server@name", "tool!name"],
	["3com.server", "404.report"],
]

describe("mcp tool name ledger", () => {
	beforeEach(() => {
		clearMcpToolAliases()
	})

	afterEach(() => {
		clearMcpToolAliases()
	})

	describe("round trip through the ledger", () => {
		it.each(DOTTED_CASES)("returns the original pair for %s / %s", (serverName, toolName) => {
			const functionName = buildMcpToolName(serverName, toolName)
			expect(parseMcpToolName(functionName)).toStrictEqual({
				serverName,
				toolName,
			})
		})

		it("resolves the issue example: a dotted tool name survives the wire", () => {
			// Issue 2338: a tool name like "System.readFile" is called as
			// "SystemreadFile". The model echoes the advertised name; the parse
			// must hand back the name the server registered.
			const functionName = buildMcpToolName("system", "System.readFile")
			const parsed = parseMcpToolName(normalizeMcpToolName(functionName))
			expect(parsed).toStrictEqual({
				serverName: "system",
				toolName: "System.readFile",
			})
		})

		it("resolves a name the model echoes with underscore separators", () => {
			// Models (especially Claude) rewrite "mcp--x--y" as "mcp__x__y".
			// The parser normalizes separators before it consults the ledger.
			const functionName = buildMcpToolName("System.reader", "read.file")
			const underscored = functionName.replace(/--/g, "__")
			expect(parseMcpToolName(underscored)).toStrictEqual({
				serverName: "System.reader",
				toolName: "read.file",
			})
		})

		it("returns the original names when the function name is truncated at 64 chars", () => {
			const serverName = "very.long.server.name.that.keeps.going.and.going"
			const toolName = "an.extremely.long.tool.name.with.dots.inside.it"
			const functionName = buildMcpToolName(serverName, toolName)
			expect(functionName.length).toBeLessThanOrEqual(64)
			expect(parseMcpToolName(functionName)).toStrictEqual({
				serverName,
				toolName,
			})
		})

		it("repeated builds of one pair stay resolvable", () => {
			const functionName = buildMcpToolName("a.b", "c.d")
			buildMcpToolName("a.b", "c.d")
			buildMcpToolName("a.b", "c.d")
			expect(parseMcpToolName(functionName)).toStrictEqual({
				serverName: "a.b",
				toolName: "c.d",
			})
		})
	})

	describe("collision policy", () => {
		it("a cross-scope conflict marks the name ambiguous and refuses to route it", () => {
			// "one.server"/"tool" and "oneserver"/"tool" both build
			// mcp--oneserver--tool. One function name advertised for two pairs
			// has no safe resolution: parsing must not hand either scope's
			// pair to the call, because one of the two scopes would receive
			// the other's traffic.
			const first = buildMcpToolName("one.server", "tool")
			const second = buildMcpToolName("oneserver", "tool")
			expect(second).toBe(first)
			expect(parseMcpToolName(first)).toBeNull()
			expect(parseMcpToolName(normalizeMcpToolName(first))).toBeNull()
		})

		it("a conflict stays refused when either pair is rebuilt", () => {
			buildMcpToolName("one.server", "tool")
			buildMcpToolName("oneserver", "tool")
			buildMcpToolName("one.server", "tool")
			expect(parseMcpToolName("mcp--oneserver--tool")).toBeNull()
		})

		it("repeated builds of one pair keep the name resolvable", () => {
			const functionName = buildMcpToolName("one.server", "tool")
			buildMcpToolName("one.server", "tool")
			buildMcpToolName("one.server", "tool")
			expect(parseMcpToolName(functionName)).toStrictEqual({
				serverName: "one.server",
				toolName: "tool",
			})
		})
	})

	describe("scoped records", () => {
		it("restores resolution once the conflicting scope ends", () => {
			// CR thread 4727751392 (PR 2669): "one.server"/"tool" and
			// "oneserver"/"tool" both build mcp--oneserver--tool. While both
			// scopes are live the name is ambiguous and stays unresolved.
			// Once the first scope ends (McpHub replaces the server), the
			// surviving pair must resolve again, through the raw name, the
			// normalized form, and the model's underscore echo.
			const first = createMcpToolAliasScope()
			buildMcpToolName("one.server", "tool", first)
			expect(parseMcpToolName("mcp--oneserver--tool")).toStrictEqual({
				serverName: "one.server",
				toolName: "tool",
			})

			const second = createMcpToolAliasScope()
			expect(buildMcpToolName("oneserver", "tool", second)).toBe("mcp--oneserver--tool")
			expect(parseMcpToolName("mcp--oneserver--tool")).toBeNull()
			expect(parseMcpToolName("mcp__oneserver__tool")).toBeNull()

			endMcpToolAliasScope(first)

			expect(parseMcpToolName("mcp--oneserver--tool")).toStrictEqual({
				serverName: "oneserver",
				toolName: "tool",
			})
			expect(parseMcpToolName(normalizeMcpToolName("mcp__oneserver__tool"))).toStrictEqual({
				serverName: "oneserver",
				toolName: "tool",
			})
			expect(parseMcpToolName("mcp__oneserver__tool")).toStrictEqual({
				serverName: "oneserver",
				toolName: "tool",
			})
		})

		it("keeps a single record resolvable after its scope ends", () => {
			// A name whose pair was advertised by one scope only keeps
			// resolving across scope ends: the exact pair is still the only
			// pair ever recorded for the name, so handing it back stays safe.
			const scope = createMcpToolAliasScope()
			const functionName = buildMcpToolName("a.b", "c.d", scope)
			endMcpToolAliasScope(scope)
			expect(parseMcpToolName(functionName)).toStrictEqual({
				serverName: "a.b",
				toolName: "c.d",
			})
		})

		it("resolves a fresh scope's pair after the older scopes end", () => {
			// Two live scopes held two pairs. Both end; a new scope
			// advertises a third pair. The live pair is the only active one,
			// so it resolves even though two older pairs were recorded.
			const first = createMcpToolAliasScope()
			buildMcpToolName("one.server", "tool", first)
			const second = createMcpToolAliasScope()
			buildMcpToolName("oneserver", "tool", second)
			endMcpToolAliasScope(first)
			endMcpToolAliasScope(second)

			const third = createMcpToolAliasScope()
			buildMcpToolName("one.server.", "tool", third)
			expect(parseMcpToolName("mcp--oneserver--tool")).toStrictEqual({
				serverName: "one.server.",
				toolName: "tool",
			})
		})

		it("builds without a scope keep the process-wide behavior", () => {
			// Records made without a scope (the ToolRouter ranking path and
			// hub-less builds) live for the whole process, like every record
			// did before scopes: a conflict between two unscoped builds never
			// restores, because neither scope ever ends.
			buildMcpToolName("one.server", "tool")
			buildMcpToolName("oneserver", "tool")
			expect(parseMcpToolName("mcp--oneserver--tool")).toBeNull()
		})
	})

	describe("echoed names with internal double underscores", () => {
		it("resolves an echo whose server name carries double underscores", () => {
			// sanitizeMcpName keeps underscores, so a server "svc__prod"
			// records mcp--svc__prod--readfile. The model echoes every
			// separator as "__": mcp__svc__prod__readfile. The first and last
			// "__" are separators, the middle one belongs to the server.
			const functionName = buildMcpToolName("svc__prod", "readfile")
			expect(functionName).toBe("mcp--svc__prod--readfile")
			const echoed = functionName.replace(/--/g, "__")
			expect(parseMcpToolName(echoed)).toStrictEqual({
				serverName: "svc__prod",
				toolName: "readfile",
			})
		})

		it("resolves an echo whose tool name carries double underscores", () => {
			const functionName = buildMcpToolName("svc", "read__file")
			const echoed = functionName.replace(/--/g, "__")
			expect(parseMcpToolName(echoed)).toStrictEqual({
				serverName: "svc",
				toolName: "read__file",
			})
		})

		it("an echo matching two different recorded names resolves to nothing", () => {
			// mcp__svc__prod__readfile rebuilds both recorded keys:
			// mcp--svc__prod--readfile and mcp--svc--prod__readfile. Two
			// pairs, no safe pick.
			buildMcpToolName("svc__prod", "readfile")
			buildMcpToolName("svc", "prod__readfile")
			expect(parseMcpToolName("mcp__svc__prod__readfile")).toBeNull()
		})

		it("a key recorded for two pairs refuses its echoed name instead of the legacy split", () => {
			// Regression evidence (CR pre-merge check, PR 2669): two builds
			// whose tool names sanitize to one wire form conflict on one key.
			// The candidate-key loop finds the conflicted key under this echo;
			// removing that check (or the echo-binding refusal) lets the
			// legacy split return a pair no safe resolution backs.
			buildMcpToolName("svc__prod", "readfile")
			buildMcpToolName("svc__prod", "read.file")
			expect(parseMcpToolName("mcp__svc__prod__readfile")).toBeNull()
		})

		it("an echo shared at an underscore boundary resolves to nothing", () => {
			// CR thread 4713678648: "svc_" + separator and separator + "_ping"
			// both echo as mcp__svc___ping. The separator overlaps the names'
			// own underscore, so no split of the echo recovers the recorded
			// keys: mcp--svc_--ping and mcp--svc--_ping. Two pairs bind one
			// echoed name, and the parse must refuse it instead of handing
			// back the one pair the normalized form happens to hit.
			buildMcpToolName("svc_", "ping")
			buildMcpToolName("svc", "_ping")
			expect(parseMcpToolName("mcp__svc___ping")).toBeNull()
		})

		it("one recording at an underscore boundary still resolves through its echo", () => {
			// With a single record the echo is unambiguous, so it resolves to
			// the recorded pair even though the echo overlaps the server's own
			// underscore. Both canonical names also keep resolving through
			// their exact wire forms once the second scope records.
			buildMcpToolName("svc_", "ping")
			expect(parseMcpToolName("mcp__svc___ping")).toStrictEqual({
				serverName: "svc_",
				toolName: "ping",
			})
			buildMcpToolName("svc", "_ping")
			expect(parseMcpToolName("mcp--svc_--ping")).toStrictEqual({ serverName: "svc_", toolName: "ping" })
			expect(parseMcpToolName("mcp--svc--_ping")).toStrictEqual({ serverName: "svc", toolName: "_ping" })
		})

		it("a name with more underscore runs than the enumeration bound keeps the legacy split", () => {
			// Seven "__" runs exceed MAX_CANDIDATE_SEPARATORS; no ledger key
			// is recorded for this shape, so the split decides.
			const echoed = "mcp__a__b__c__d__e__f__g__h"
			expect(parseMcpToolName(echoed)).toStrictEqual({
				serverName: "a",
				toolName: "b--c--d--e--f--g--h",
			})
		})
	})

	describe("unrecorded names keep the legacy behavior", () => {
		it("splits a name no build ever produced", () => {
			expect(parseMcpToolName("mcp--weather--get_forecast")).toStrictEqual({
				serverName: "weather",
				toolName: "get_forecast",
			})
		})

		it("still rejects malformed names", () => {
			expect(parseMcpToolName("mcp--")).toBeNull()
			expect(parseMcpToolName("mcp--server")).toBeNull()
			expect(parseMcpToolName("server--tool")).toBeNull()
		})

		it("clearMcpToolAliases drops every record and the split takes over", () => {
			const functionName = buildMcpToolName("a.b", "c.d")
			clearMcpToolAliases()
			expect(parseMcpToolName(functionName)).toStrictEqual({
				serverName: "ab",
				toolName: "cd",
			})
		})
	})
})
