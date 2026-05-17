import * as path from "path"

import { LLMock } from "@copilotkit/aimock"

const TEST_DIR_NAME = "use-mcp-tool-fixture"
const FILESYSTEM_SERVER_NAME = "filesystem"

type UseMcpToolFixture = {
	userMessagePattern: string
	toolCallId: string
	toolName: string
	toolArguments?: Record<string, unknown>
	serverName?: string
	result: string
	id: string
}

export function addUseMcpToolResultFixtures(mock: InstanceType<typeof LLMock>, workspaceDir: string) {
	const readFilePath = path.join(workspaceDir, TEST_DIR_NAME, "mcp-read-target.txt")
	const writeFilePath = path.join(workspaceDir, TEST_DIR_NAME, "mcp-write-target.txt")

	const fixtures: UseMcpToolFixture[] = [
		{
			userMessagePattern: "USE_MCP_TOOL_READ_FILE_SMOKE",
			toolCallId: "call_use_mcp_tool_read_file_001",
			toolName: "read_file",
			toolArguments: { path: readFilePath },
			result: "Read the requested file through the MCP filesystem server.",
			id: "call_use_mcp_tool_read_file_002",
		},
		{
			userMessagePattern: "USE_MCP_TOOL_WRITE_FILE_SMOKE",
			toolCallId: "call_use_mcp_tool_write_file_001",
			toolName: "write_file",
			toolArguments: { path: writeFilePath, content: "Hello from MCP!" },
			result: "Created the requested file through the MCP filesystem server.",
			id: "call_use_mcp_tool_write_file_002",
		},
		{
			userMessagePattern: "USE_MCP_TOOL_LIST_DIRECTORY_SMOKE",
			toolCallId: "call_use_mcp_tool_list_directory_001",
			toolName: "list_directory",
			toolArguments: { path: path.join(workspaceDir, TEST_DIR_NAME) },
			result: "Listed the requested directory through the MCP filesystem server.",
			id: "call_use_mcp_tool_list_directory_002",
		},
		{
			userMessagePattern: "USE_MCP_TOOL_DIRECTORY_TREE_SMOKE",
			toolCallId: "call_use_mcp_tool_directory_tree_001",
			toolName: "directory_tree",
			toolArguments: { path: path.join(workspaceDir, TEST_DIR_NAME) },
			result: "Returned the directory tree through the MCP filesystem server.",
			id: "call_use_mcp_tool_directory_tree_002",
		},
		{
			userMessagePattern: "USE_MCP_TOOL_GET_FILE_INFO_SMOKE",
			toolCallId: "call_use_mcp_tool_get_file_info_001",
			toolName: "get_file_info",
			toolArguments: { path: readFilePath },
			result: "Returned the requested file metadata through the MCP filesystem server.",
			id: "call_use_mcp_tool_get_file_info_002",
		},
		{
			userMessagePattern: "USE_MCP_TOOL_UNKNOWN_SERVER_SMOKE",
			toolCallId: "call_use_mcp_tool_unknown_server_001",
			serverName: "nonexistent-server",
			toolName: "read_file",
			toolArguments: { path: readFilePath },
			result: "Handled the missing MCP server gracefully.",
			id: "call_use_mcp_tool_unknown_server_002",
		},
	]

	for (const fixture of fixtures) {
		mock.addFixture({
			match: {
				userMessage: new RegExp(fixture.userMessagePattern),
			},
			response: {
				toolCalls: [
					{
						name: "use_mcp_tool",
						arguments: JSON.stringify({
							server_name: fixture.serverName ?? FILESYSTEM_SERVER_NAME,
							tool_name: fixture.toolName,
							arguments: fixture.toolArguments,
						}),
						id: fixture.toolCallId,
					},
				],
			},
		})

		mock.addFixture({
			match: {
				toolCallId: fixture.toolCallId,
			},
			response: {
				toolCalls: [
					{
						name: "attempt_completion",
						arguments: JSON.stringify({ result: fixture.result }),
						id: fixture.id,
					},
				],
			},
		})
	}
}
