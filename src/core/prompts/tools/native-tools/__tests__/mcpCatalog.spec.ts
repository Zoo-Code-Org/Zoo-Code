import type { McpServer } from "@roo-code/types"
import { getMcpServerTools, getMcpToolCatalog, resolveMcpToolFromCatalog } from "../mcp_server"
import { McpHub } from "../../../../../services/mcp/McpHub"
import { buildMcpToolName } from "../../../../../utils/mcp-name"

function server(name: string, toolNames: string[], options: Partial<McpServer> = {}): McpServer {
	return { name, config: "{}", status: "connected", tools: toolNames.map((name) => ({ name })), ...options }
}

function enabledHub(servers: McpServer[]): Pick<McpHub, "getServers"> {
	// The production getServers method reads only each connection's server.
	const receiver = { connections: servers.map((server) => ({ server })) }
	return { getServers: () => McpHub.prototype.getServers.call(receiver) }
}

describe("MCP catalog source invariant", () => {
	it("resolves each advertised name to its enabled, project-priority, scoped first source", () => {
		// Exhaust enabled, prompt, mode, and ordering inputs on the real catalog.
		for (const disabled of [false, true]) {
			for (const promptEnabled of [false, true]) {
				for (const allowed of [false, true]) {
					for (const reverse of [false, true]) {
						const name = "s".repeat(70)
						const project = server(name, ["first", "collision"], {
							source: "project",
							disabled,
							tools: [{ name: "first", enabledForPrompt: promptEnabled }, { name: "collision" }],
						})
						const global = server(name, ["global"], { source: "global" })
						const hub = enabledHub(reverse ? [project, global] : [global, project])
						const scope = allowed ? [name] : []
						const catalog = getMcpToolCatalog(hub, scope)
						const definitions = getMcpServerTools(hub, scope)
						expect(catalog).toHaveLength(allowed ? 1 : 0)
						for (const definition of definitions) {
							if (!("function" in definition)) throw new Error("Expected function definition")
							const resolved = resolveMcpToolFromCatalog(catalog, definition.function.name)
							expect(resolved?.tool.name).toBe(
								disabled ? "global" : promptEnabled ? "first" : "collision",
							)
							expect(resolved?.name).toBe(definition.function.name)
						}
						expect(resolveMcpToolFromCatalog(catalog, "mcp--unknown--tool")).toBeUndefined()
					}
				}
			}
		}
	})

	it("prefers an exact name and rejects an ambiguous altered separator", () => {
		const catalog = getMcpToolCatalog(enabledHub([server("a-b", ["tool"]), server("a_b", ["tool"])]))
		expect(resolveMcpToolFromCatalog(catalog, buildMcpToolName("a-b", "tool"))?.serverName).toBe("a-b")
		expect(resolveMcpToolFromCatalog(catalog, "mcp__a_b__tool")).toBeUndefined()
		expect(resolveMcpToolFromCatalog(catalog.slice(0, 1), "mcp__a_b__tool")?.serverName).toBe("a-b")
	})
})
