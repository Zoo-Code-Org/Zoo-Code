import { buildMcpToolName, resolveMcpToolByName, toolNamesMatch } from "../../../utils/mcp-name"
import { NativeToolCallParser } from "../NativeToolCallParser"

const SERVER = "company-gateway-tools"
const TOOL = "confluence-confluence_get_space_page_tree"

describe("NativeToolCallParser.parseDynamicMcpTool name for API history", () => {
	it("records an over-long uncut name under the declared name", () => {
		const result = NativeToolCallParser.parseDynamicMcpTool({
			id: "toolu_1",
			name: `mcp--${SERVER}--${TOOL}`,
			arguments: "{}",
		})

		expect(result?.name).toBe(buildMcpToolName(SERVER, TOOL))
		expect(result?.name.length).toBeLessThanOrEqual(64)
	})

	it("resolves an over-long uncut name whose hyphens the model turned into underscores", () => {
		const mangled = `mcp--${SERVER}--${TOOL}`.replace(/-/g, "_")

		const result = NativeToolCallParser.parseDynamicMcpTool({ id: "toolu_5", name: mangled, arguments: "{}" })

		expect(result).not.toBeNull()
		expect(result!.name.length).toBeLessThanOrEqual(64)
		// The recorded name is the declared one, up to the hyphen/underscore spelling.
		expect(toolNamesMatch(result!.name, buildMcpToolName(SERVER, TOOL))).toBe(true)
		expect(resolveMcpToolByName([{ name: SERVER, tools: [{ name: TOOL }] }], result!.name)).toEqual({
			serverName: SERVER,
			toolName: TOOL,
		})
	})

	it("keeps the declared name the model returned", () => {
		const declared = buildMcpToolName(SERVER, TOOL)

		const result = NativeToolCallParser.parseDynamicMcpTool({ id: "toolu_2", name: declared, arguments: "{}" })

		expect(result?.name).toBe(declared)
	})

	it("parses the declared name of a tool on a server with a very long name", () => {
		const declared = buildMcpToolName("s".repeat(60), TOOL)

		const result = NativeToolCallParser.parseDynamicMcpTool({ id: "toolu_4", name: declared, arguments: "{}" })

		expect(result).toMatchObject({ type: "mcp_tool_use", name: declared })
	})

	it("keeps a short name verbatim", () => {
		const result = NativeToolCallParser.parseDynamicMcpTool({
			id: "toolu_3",
			name: "mcp--weather--get_forecast",
			arguments: "{}",
		})

		expect(result).toMatchObject({ name: "mcp--weather--get_forecast", serverName: "weather" })
	})
})
