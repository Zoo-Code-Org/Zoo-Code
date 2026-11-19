import type OpenAI from "openai"
import type { McpTool } from "@roo-code/types"
import type { McpHub } from "../../../../services/mcp/McpHub"
import { buildMcpToolName, toolNamesMatch } from "../../../../utils/mcp-name"
import { normalizeToolSchema, type JsonSchema } from "../../../../utils/json-schema"

/** The enabled catalog uses hub project priority and first-wins canonical names. */
export function getMcpToolCatalog(mcpHub?: Pick<McpHub, "getServers">, allowedServers?: string[]) {
	const entries = new Map<string, { name: string; serverName: string; tool: McpTool }>()
	for (const server of mcpHub?.getServers() ?? []) {
		if (allowedServers && !allowedServers.includes(server.name)) continue
		for (const tool of server.tools ?? []) {
			if (tool.enabledForPrompt === false) continue
			const name = buildMcpToolName(server.name, tool.name)
			if (!entries.has(name)) entries.set(name, { name, serverName: server.name, tool })
		}
	}
	return [...entries.values()]
}

/** Build definitions from the same catalog used to resolve truncated names. */
export function getMcpServerTools(
	mcpHub?: Pick<McpHub, "getServers">,
	allowedServers?: string[],
): OpenAI.Chat.ChatCompletionTool[] {
	return getMcpToolCatalog(mcpHub, allowedServers).map(({ name, tool }) => {
		const originalSchema = tool.inputSchema as Record<string, unknown> | undefined
		const parameters = originalSchema
			? (normalizeToolSchema(originalSchema) as JsonSchema)
			: ({ type: "object", additionalProperties: false } as JsonSchema)
		return {
			type: "function",
			function: { name, description: tool.description, parameters: parameters as OpenAI.FunctionParameters },
		}
	})
}

/** Exact names win. An altered separator is accepted only when its match is unique. */
export function resolveMcpToolFromCatalog(catalog: ReturnType<typeof getMcpToolCatalog>, name: string) {
	const exact = catalog.find((entry) => entry.name === name)
	if (exact) return exact
	const aliases = catalog.filter((entry) => toolNamesMatch(entry.name, name))
	return aliases.length === 1 ? aliases[0] : undefined
}
