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
