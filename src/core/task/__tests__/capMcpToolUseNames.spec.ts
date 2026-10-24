import type { Anthropic } from "@anthropic-ai/sdk"

import type { ApiMessage } from "../../task-persistence"
import { buildMcpToolName } from "../../../utils/mcp-name"
import { capMcpToolUseNames } from "../capMcpToolUseNames"

type Block = Anthropic.Messages.ContentBlockParam

const SERVER = "company-gateway-tools"
const TOOL = "confluence-confluence_get_space_page_tree"
const UNCUT = `mcp--${SERVER}--${TOOL}`

const use = (name: string): Block => ({ type: "tool_use", id: "toolu_1", name, input: {} })
const assistant = (...content: Block[]): ApiMessage => ({ role: "assistant", content })

describe("capMcpToolUseNames", () => {
	it("renames an over-long MCP tool_use to the declared name", () => {
		const [message] = capMcpToolUseNames([assistant({ type: "text", text: "calling" }, use(UNCUT))])

		expect(message.content).toEqual([{ type: "text", text: "calling" }, use(buildMcpToolName(SERVER, TOOL))])
	})

	it("leaves short names, non-MCP names and other roles untouched", () => {
		const messages: ApiMessage[] = [
			{ role: "user", content: "hi" },
			assistant(use("read_file"), use("mcp--weather--get_forecast")),
		]

		expect(capMcpToolUseNames(messages)).toEqual(messages)
	})

	it("leaves an over-long name it cannot parse as an MCP tool", () => {
		const name = "x".repeat(70)

		expect(capMcpToolUseNames([assistant(use(name))])[0].content).toEqual([use(name)])
	})

	it("does not mutate its input", () => {
		const input = [assistant(use(UNCUT))]
		const snapshot = structuredClone(input)

		capMcpToolUseNames(input)

		expect(input).toEqual(snapshot)
	})
})
