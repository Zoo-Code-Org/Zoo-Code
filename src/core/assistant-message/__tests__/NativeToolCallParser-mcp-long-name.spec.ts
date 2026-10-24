import { buildMcpToolName } from "../../../utils/mcp-name"
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

	it("keeps the declared name the model returned", () => {
		const declared = buildMcpToolName(SERVER, TOOL)

		const result = NativeToolCallParser.parseDynamicMcpTool({ id: "toolu_2", name: declared, arguments: "{}" })

		expect(result?.name).toBe(declared)
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
