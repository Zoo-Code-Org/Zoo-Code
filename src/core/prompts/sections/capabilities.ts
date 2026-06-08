import { McpHub } from "../../../services/mcp/McpHub"

/**
 * Builds the CAPABILITIES section of the system prompt.
 *
 * The MCP availability line is only emitted when at least one MCP server is actually
 * exposed to the current mode. When `allowedMcpServers` is provided, the hub's server
 * list is filtered by that allowlist BEFORE deciding whether to advertise MCP, so the
 * capability text matches the per-mode tool exposure:
 *   - `undefined` allowlist  → all connected servers count (backward compatible)
 *   - empty `[]` allowlist   → no servers count ⇒ MCP line omitted
 *   - populated allowlist    → only listed servers count
 *
 * @param cwd Current working directory used in the prompt text.
 * @param mcpHub Optional MCP hub. When omitted, the MCP line is never emitted.
 * @param allowedMcpServers Optional per-mode allowlist of MCP server names. When provided,
 *   the hub's servers are filtered to this set before determining MCP availability.
 */
export function getCapabilitiesSection(cwd: string, mcpHub?: McpHub, allowedMcpServers?: string[]): string {
	// Determine whether any MCP server is actually available to the current mode.
	// Filtering the hub's servers by the allowlist (when provided) keeps the capability
	// text consistent with the tools that are exposed for the mode.
	let hasMcpServers = false
	if (mcpHub) {
		let servers = mcpHub.getServers()
		if (allowedMcpServers) {
			const allowSet = new Set(allowedMcpServers)
			servers = servers.filter((server) => allowSet.has(server.name))
		}
		hasMcpServers = servers.length > 0
	}

	return `====

CAPABILITIES

- You have access to tools that let you execute CLI commands on the user's computer, list files, view source code definitions, regex search, read and write files, and ask follow-up questions. These tools help you effectively accomplish a wide range of tasks, such as writing code, making edits or improvements to existing files, understanding the current state of a project, performing system operations, and much more.
- When the user initially gives you a task, a recursive list of all filepaths in the current workspace directory ('${cwd}') will be included in environment_details. This provides an overview of the project's file structure, offering key insights into the project from directory/file names (how developers conceptualize and organize their code) and file extensions (the language used). This can also guide decision-making on which files to explore further. If you need to further explore directories such as outside the current workspace directory, you can use the list_files tool. If you pass 'true' for the recursive parameter, it will list files recursively. Otherwise, it will list files at the top level, which is better suited for generic directories where you don't necessarily need the nested structure, like the Desktop.
- You can use the execute_command tool to run commands on the user's computer whenever you feel it can help accomplish the user's task. When you need to execute a CLI command, you must provide a clear explanation of what the command does. Prefer to execute complex CLI commands over creating executable scripts, since they are more flexible and easier to run. Interactive and long-running commands are allowed, since the commands are run in the user's VSCode terminal. The user may keep commands running in the background and you will be kept updated on their status along the way. Each command you execute is run in a new terminal instance.${
		hasMcpServers
			? `
- You have access to MCP servers that may provide additional tools and resources. Each server may provide different capabilities that you can use to accomplish tasks more effectively.
`
			: ""
	}`
}
