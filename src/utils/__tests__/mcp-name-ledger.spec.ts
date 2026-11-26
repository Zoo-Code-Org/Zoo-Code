import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { clearMcpToolAliases } from "../mcp-name-ledger"
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
		it("the first recorded pair wins and stays stable", () => {
			// Two servers that sanitize to the same wire form share one function
			// name. The first advertisement decides what the name resolves to,
			// and a later build must not flip it.
			const first = buildMcpToolName("one.server", "tool")
			const second = buildMcpToolName("oneserver", "tool")
			expect(second).toBe(first)
			expect(parseMcpToolName(first)).toStrictEqual({
				serverName: "one.server",
				toolName: "tool",
			})
			buildMcpToolName("one,server", "tool")
			expect(parseMcpToolName(first)).toStrictEqual({
				serverName: "one.server",
				toolName: "tool",
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
