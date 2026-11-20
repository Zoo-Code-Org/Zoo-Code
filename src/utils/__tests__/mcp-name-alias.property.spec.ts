import type { ToolName } from "@roo-code/types"
import { NativeToolCallParser } from "../../core/assistant-message/NativeToolCallParser"
import { normalizeMcpToolName, parseMcpToolName } from "../mcp-name"

describe("truncated MCP alias acceptance invariant", () => {
	it.each(["s", "_s", "my-server", "my_server"])(
		"accepts a two-part alias from server %s only at the provider limit",
		(seed) => {
			for (const length of [63, 64, 65]) {
				const server = seed.repeat(60).slice(0, length - 5)
				const name = `mcp__${server}`
				expect(normalizeMcpToolName(name)).toBe(length === 64 ? `mcp--${server}` : name)
				expect(parseMcpToolName(name)).toEqual(length === 64 ? { serverName: server, toolName: "" } : null)
				// Dynamic MCP names are valid at runtime but are outside the static ToolName union.
				const call = { id: "alias", name: name as ToolName, arguments: "{}" }
				for (const parsed of [
					NativeToolCallParser.parseToolCall(call),
					NativeToolCallParser.parseDynamicMcpTool(call),
				]) {
					if (length === 64) {
						expect(parsed).toMatchObject({
							type: "mcp_tool_use",
							id: "alias",
							serverName: server,
							toolName: "",
						})
					} else {
						expect(parsed).toBeNull()
					}
				}
			}
		},
	)
})
