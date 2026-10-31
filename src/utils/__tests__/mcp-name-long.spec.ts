import { buildMcpToolName, parseMcpToolName, resolveMcpToolByName } from "../mcp-name"

const SERVER = "company-gateway-tools"
const TOOL = "confluence-confluence_get_space_page_tree"
const UNCUT = `mcp--${SERVER}--${TOOL}`

describe("long MCP tool names", () => {
	it("keeps names within the limit unchanged", () => {
		expect(buildMcpToolName("weather", "get_forecast")).toBe("mcp--weather--get_forecast")
	})

	it("shortens an over-long name to exactly 64 characters with a hash suffix", () => {
		const name = buildMcpToolName(SERVER, TOOL)

		expect(UNCUT.length).toBeGreaterThan(64)
		expect(name).toHaveLength(64)
		expect(name.slice(0, 55)).toBe(UNCUT.slice(0, 55))
		expect(name.slice(55)).toMatch(/^_[0-9a-f]{8}$/)
	})

	it.each([
		{ toolLength: 50, shortened: false },
		{ toolLength: 51, shortened: true },
	])(
		"treats a $toolLength-character tool as shortened: $shortened at the 64-character limit",
		({ toolLength, shortened }) => {
			const tool = "t".repeat(toolLength)
			const uncut = `mcp--weather--${tool}`
			const name = buildMcpToolName("weather", tool)

			expect(uncut).toHaveLength(14 + toolLength)
			expect(name).toHaveLength(64)
			if (shortened) {
				expect(name).toMatch(/_[0-9a-f]{8}$/)
			} else {
				expect(name).toBe(uncut)
			}
		},
	)

	describe("with a long server name", () => {
		it.each([46, 47, 48, 49, 50, 70])("keeps both separators for a %i-character server name", (serverLength) => {
			const server = `s${"x".repeat(serverLength - 1)}`
			const name = buildMcpToolName(server, TOOL)
			const parsed = parseMcpToolName(name)

			expect(name).toHaveLength(64)
			expect(name).toMatch(/_[0-9a-f]{8}$/)
			expect(parsed).not.toBeNull()
			expect(server.startsWith(parsed!.serverName)).toBe(true)
			expect(parsed!.toolName.length).toBeGreaterThan(0)
			expect(resolveMcpToolByName([{ name: server, tools: [{ name: TOOL }] }], name)).toEqual({
				serverName: server,
				toolName: TOOL,
			})
		})

		it("drops a hyphen at the cut so it does not merge with the separator", () => {
			const server = `${"a".repeat(46)}-${"b".repeat(10)}`
			const name = buildMcpToolName(server, TOOL)

			expect(name).not.toContain("---")
			expect(parseMcpToolName(name)?.serverName).toBe("a".repeat(46))
		})
	})

	it("is deterministic and keeps tools that share a 55-character prefix distinct", () => {
		const first = buildMcpToolName(SERVER, `${TOOL}_a`)
		const second = buildMcpToolName(SERVER, `${TOOL}_b`)

		expect(buildMcpToolName(SERVER, `${TOOL}_a`)).toBe(first)
		expect(first.slice(0, 55)).toBe(second.slice(0, 55))
		expect(first).not.toBe(second)
	})

	describe("resolveMcpToolByName", () => {
		const servers = [
			{ name: "other", tools: [{ name: "ping" }] },
			{ name: SERVER, tools: [{ name: TOOL }, { name: `${TOOL}_b` }] },
		]

		it.each([
			{ label: "the declared (hashed) name", called: buildMcpToolName(SERVER, TOOL) },
			{ label: "the full uncut name", called: UNCUT },
			{ label: "a name with underscores for hyphens", called: buildMcpToolName(SERVER, TOOL).replace(/-/g, "_") },
		])("resolves $label to the original server and tool", ({ called }) => {
			expect(resolveMcpToolByName(servers, called)).toEqual({ serverName: SERVER, toolName: TOOL })
		})

		it("resolves a short name", () => {
			expect(resolveMcpToolByName(servers, "mcp--other--ping")).toEqual({ serverName: "other", toolName: "ping" })
		})

		it("returns null for an unknown name", () => {
			expect(resolveMcpToolByName(servers, "mcp--company-gateway-tools--missing")).toBeNull()
		})

		it("cannot recover the tool from the hashed name alone, which is why the lookup exists", () => {
			const parsed = parseMcpToolName(buildMcpToolName(SERVER, TOOL))

			expect(parsed?.toolName).not.toBe(TOOL)
		})
	})
})
