import { checkAutoApproval } from "../index"

describe("autonomous CLI approval", () => {
	const originalValue = process.env.ROO_CLI_AUTONOMOUS

	afterEach(() => {
		if (originalValue === undefined) delete process.env.ROO_CLI_AUTONOMOUS
		else process.env.ROO_CLI_AUTONOMOUS = originalValue
	})

	it("approves every MCP tool only for the explicitly autonomous CLI process", async () => {
		const state = { autoApprovalEnabled: true, alwaysAllowMcp: true, mcpServers: [] }
		const text = JSON.stringify({ type: "use_mcp_tool", server_name: "local", tool_name: "mutate" })

		delete process.env.ROO_CLI_AUTONOMOUS
		await expect(checkAutoApproval({ state, ask: "use_mcp_server", text })).resolves.toEqual({ decision: "ask" })

		process.env.ROO_CLI_AUTONOMOUS = "1"
		await expect(checkAutoApproval({ state, ask: "use_mcp_server", text })).resolves.toEqual({
			decision: "approve",
		})
	})
})
