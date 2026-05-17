import * as assert from "assert"
import * as fs from "fs/promises"
import * as path from "path"
import * as vscode from "vscode"

import { RooCodeEventName, type ClineMessage } from "@roo-code/types"

import { waitFor, sleep } from "../utils"
import { setDefaultSuiteTimeout } from "../test-utils"

const FILESYSTEM_SERVER_NAME = "filesystem"
const FILESYSTEM_SERVER_PACKAGE = "@modelcontextprotocol/server-filesystem@2026.1.14"
const TEST_DIR_NAME = "use-mcp-tool-fixture"
const TEST_CONFIG_RELATIVE_PATH = ".roo/mcp.json"
const READ_FILE_RELATIVE_PATH = `${TEST_DIR_NAME}/mcp-read-target.txt`
const WRITE_FILE_RELATIVE_PATH = `${TEST_DIR_NAME}/mcp-write-target.txt`
const TEST_DATA_RELATIVE_PATH = `${TEST_DIR_NAME}/mcp-data.json`
const TREE_FILE_RELATIVE_PATH = `${TEST_DIR_NAME}/nested/tree-child.txt`
const READ_FILE_CONTENT = "Initial content for MCP test"
const WRITE_FILE_CONTENT = "Hello from MCP!"
const TREE_FILE_CONTENT = "Nested MCP content"
const TEST_DATA_CONTENT = JSON.stringify({ test: "data", value: 42 }, null, 2)

type ParsedMcpRequest = {
	type?: string
	serverName?: string
	toolName?: string
	arguments?: string
}

type TaskRunResult = {
	messages: ClineMessage[]
	mcpRequest: ParsedMcpRequest | null
	mcpServerResponse: string | null
	errorOccurred: string | null
}

suite("Roo Code use_mcp_tool Tool", function () {
	setDefaultSuiteTimeout(this)

	let workspaceDir: string
	let testDir: string
	let rooDir: string
	let mcpConfigPath: string

	async function writeFilesystemMcpConfig() {
		await fs.mkdir(rooDir, { recursive: true })
		await fs.writeFile(
			mcpConfigPath,
			JSON.stringify(
				{
					mcpServers: {
						[FILESYSTEM_SERVER_NAME]: {
							command: "npx",
							args: ["-y", FILESYSTEM_SERVER_PACKAGE, workspaceDir],
							alwaysAllow: [
								"read_file",
								"write_file",
								"list_directory",
								"directory_tree",
								"get_file_info",
							],
						},
					},
				},
				null,
				2,
			),
		)
	}

	async function resetFixtureWorkspace() {
		await fs.rm(testDir, { recursive: true, force: true })
		await fs.mkdir(path.join(testDir, "nested"), { recursive: true })
		await fs.writeFile(path.join(workspaceDir, READ_FILE_RELATIVE_PATH), READ_FILE_CONTENT)
		await fs.writeFile(path.join(workspaceDir, TEST_DATA_RELATIVE_PATH), TEST_DATA_CONTENT)
		await fs.writeFile(path.join(workspaceDir, TREE_FILE_RELATIVE_PATH), TREE_FILE_CONTENT)
		await fs.rm(path.join(workspaceDir, WRITE_FILE_RELATIVE_PATH), { force: true })
	}

	async function runMcpTask(text: string): Promise<TaskRunResult> {
		const api = globalThis.api
		const messages: ClineMessage[] = []
		let attemptCompletionCalled = false
		let mcpRequest: ParsedMcpRequest | null = null
		let mcpServerResponse: string | null = null
		let errorOccurred: string | null = null

		const messageHandler = ({ message }: { message: ClineMessage }) => {
			messages.push(message)

			if (message.type === "ask" && message.ask === "use_mcp_server" && message.text) {
				try {
					mcpRequest = JSON.parse(message.text) as ParsedMcpRequest
				} catch {
					mcpRequest = null
				}
			}

			if (message.type === "say" && message.say === "mcp_server_response") {
				mcpServerResponse = message.text || null
			}

			if (message.type === "say" && message.say === "completion_result") {
				attemptCompletionCalled = true
			}

			if (message.type === "say" && message.say === "error") {
				errorOccurred = message.text || "Unknown error"
			}
		}

		api.on(RooCodeEventName.Message, messageHandler)

		try {
			await api.startNewTask({
				configuration: {
					mode: "code",
					autoApprovalEnabled: true,
					alwaysAllowMcp: true,
					mcpEnabled: true,
				},
				text,
			})

			await waitFor(() => attemptCompletionCalled, { timeout: 45_000 })
			return { messages, mcpRequest, mcpServerResponse, errorOccurred }
		} finally {
			api.off(RooCodeEventName.Message, messageHandler)
		}
	}

	suiteSetup(async () => {
		const workspaceFolders = vscode.workspace.workspaceFolders
		if (!workspaceFolders || workspaceFolders.length === 0) {
			throw new Error("No workspace folder found")
		}

		workspaceDir = workspaceFolders[0]!.uri.fsPath
		testDir = path.join(workspaceDir, TEST_DIR_NAME)
		rooDir = path.join(workspaceDir, ".roo")
		mcpConfigPath = path.join(workspaceDir, TEST_CONFIG_RELATIVE_PATH)

		await writeFilesystemMcpConfig()
		await resetFixtureWorkspace()
		await sleep(5_000)
	})

	suiteTeardown(async () => {
		try {
			await globalThis.api.cancelCurrentTask()
		} catch {
			// Task might not be running
		}

		await fs.rm(testDir, { recursive: true, force: true })
		await fs.rm(rooDir, { recursive: true, force: true })
	})

	setup(async () => {
		try {
			await globalThis.api.cancelCurrentTask()
		} catch {
			// Task might not be running
		}

		await resetFixtureWorkspace()
		await sleep(100)
	})

	teardown(async () => {
		try {
			await globalThis.api.cancelCurrentTask()
		} catch {
			// Task might not be running
		}

		await sleep(100)
	})

	test("Should request MCP filesystem read_file tool and complete successfully", async function () {
		const { mcpRequest, mcpServerResponse, errorOccurred, messages } =
			await runMcpTask("USE_MCP_TOOL_READ_FILE_SMOKE")

		assert.strictEqual(errorOccurred, null, `Error occurred: ${errorOccurred}`)
		assert.ok(mcpRequest, "The use_mcp_tool request should have been emitted")
		assert.strictEqual(mcpRequest?.type, "use_mcp_tool")
		assert.strictEqual(mcpRequest?.serverName, FILESYSTEM_SERVER_NAME)
		assert.strictEqual(mcpRequest?.toolName, "read_file")
		assert.ok(mcpServerResponse, "Should have received a response from the MCP server")
		assert.ok(
			mcpServerResponse?.includes(READ_FILE_CONTENT),
			"MCP read_file response should contain the file contents",
		)

		const completionMessage = messages.find(
			(message) =>
				message.type === "say" &&
				(message.say === "completion_result" || message.say === "text") &&
				message.text?.includes("requested file"),
		)
		assert.ok(completionMessage, "AI should have acknowledged the MCP read_file result")
	})

	test("Should request MCP filesystem write_file tool and complete successfully", async function () {
		const targetPath = path.join(workspaceDir, WRITE_FILE_RELATIVE_PATH)
		const { mcpRequest, mcpServerResponse, errorOccurred, messages } = await runMcpTask(
			"USE_MCP_TOOL_WRITE_FILE_SMOKE",
		)

		assert.strictEqual(errorOccurred, null, `Error occurred: ${errorOccurred}`)
		assert.ok(mcpRequest, "The use_mcp_tool request should have been emitted")
		assert.strictEqual(mcpRequest?.serverName, FILESYSTEM_SERVER_NAME)
		assert.strictEqual(mcpRequest?.toolName, "write_file")
		assert.ok(mcpServerResponse, "Should have received a response from the MCP server")
		assert.ok(
			mcpServerResponse?.includes("Successfully wrote"),
			"MCP write_file response should report a successful write",
		)

		const actualContent = await fs.readFile(targetPath, "utf-8")
		assert.strictEqual(actualContent, WRITE_FILE_CONTENT, "write_file should create the expected file content")

		const completionMessage = messages.find(
			(message) => message.type === "say" && (message.say === "completion_result" || message.say === "text"),
		)
		assert.ok(completionMessage, "AI should have acknowledged the MCP write_file result")
	})

	test("Should request MCP filesystem list_directory tool and complete successfully", async function () {
		const { mcpRequest, mcpServerResponse, errorOccurred, messages } = await runMcpTask(
			"USE_MCP_TOOL_LIST_DIRECTORY_SMOKE",
		)

		assert.strictEqual(errorOccurred, null, `Error occurred: ${errorOccurred}`)
		assert.ok(mcpRequest, "The use_mcp_tool request should have been emitted")
		assert.strictEqual(mcpRequest?.serverName, FILESYSTEM_SERVER_NAME)
		assert.strictEqual(mcpRequest?.toolName, "list_directory")
		assert.ok(mcpServerResponse, "Should have received a response from the MCP server")
		assert.ok(
			mcpServerResponse?.includes("[FILE] mcp-read-target.txt"),
			"Directory listing should include the read fixture",
		)
		assert.ok(mcpServerResponse?.includes("[DIR] nested"), "Directory listing should include the nested directory")

		const completionMessage = messages.find(
			(message) => message.type === "say" && (message.say === "completion_result" || message.say === "text"),
		)
		assert.ok(completionMessage, "AI should have acknowledged the MCP directory listing result")
	})

	test("Should request MCP filesystem directory_tree tool and complete successfully", async function () {
		const { mcpRequest, mcpServerResponse, errorOccurred, messages } = await runMcpTask(
			"USE_MCP_TOOL_DIRECTORY_TREE_SMOKE",
		)

		assert.strictEqual(errorOccurred, null, `Error occurred: ${errorOccurred}`)
		assert.ok(mcpRequest, "The use_mcp_tool request should have been emitted")
		assert.strictEqual(mcpRequest?.serverName, FILESYSTEM_SERVER_NAME)
		assert.strictEqual(mcpRequest?.toolName, "directory_tree")
		assert.ok(mcpServerResponse, "Should have received a response from the MCP server")
		assert.ok(
			mcpServerResponse?.includes('"name": "nested"'),
			"Directory tree response should include the nested directory",
		)
		assert.ok(
			mcpServerResponse?.includes('"name": "tree-child.txt"'),
			"Directory tree response should include the nested file",
		)

		const completionMessage = messages.find(
			(message) => message.type === "say" && (message.say === "completion_result" || message.say === "text"),
		)
		assert.ok(completionMessage, "AI should have acknowledged the MCP directory tree result")
	})

	test("Should handle MCP server error gracefully and complete task", async function () {
		const { mcpRequest, mcpServerResponse, errorOccurred, messages } = await runMcpTask(
			"USE_MCP_TOOL_UNKNOWN_SERVER_SMOKE",
		)

		if (mcpRequest) {
			assert.strictEqual(mcpRequest.type, "use_mcp_tool")
		}
		assert.strictEqual(mcpServerResponse, null, "Unknown MCP servers should not produce an MCP server response")
		assert.ok(errorOccurred, "Unknown MCP servers should surface an error")
		assert.ok(errorOccurred?.includes("nonexistent-server"), "Error should mention the missing MCP server")
		assert.ok(
			errorOccurred?.includes(FILESYSTEM_SERVER_NAME),
			"Error should mention the configured filesystem server",
		)

		const completionMessage = messages.find(
			(message) => message.type === "say" && (message.say === "completion_result" || message.say === "text"),
		)
		assert.ok(completionMessage, "AI should have acknowledged the missing MCP server error")
	})

	test("Should validate MCP request message format and complete successfully", async function () {
		const targetPath = path.join(workspaceDir, READ_FILE_RELATIVE_PATH)
		const { mcpRequest, mcpServerResponse, errorOccurred, messages } = await runMcpTask(
			"USE_MCP_TOOL_GET_FILE_INFO_SMOKE",
		)

		assert.strictEqual(errorOccurred, null, `Error occurred: ${errorOccurred}`)
		assert.ok(mcpRequest, "The use_mcp_tool request should have been emitted")
		assert.strictEqual(mcpRequest?.type, "use_mcp_tool")
		assert.strictEqual(mcpRequest?.serverName, FILESYSTEM_SERVER_NAME)
		assert.strictEqual(mcpRequest?.toolName, "get_file_info")

		const parsedArguments = JSON.parse(mcpRequest?.arguments ?? "{}") as { path?: string }
		assert.strictEqual(parsedArguments.path, targetPath, "The MCP request should include the target file path")

		assert.ok(mcpServerResponse, "Should have received a response from the MCP server")
		assert.ok(mcpServerResponse?.includes("size:"), "File info response should contain the size field")
		assert.ok(
			mcpServerResponse?.includes("isFile: true"),
			"File info response should identify the target as a file",
		)
		assert.ok(mcpServerResponse?.includes("permissions:"), "File info response should contain permissions")

		const completionMessage = messages.find(
			(message) => message.type === "say" && (message.say === "completion_result" || message.say === "text"),
		)
		assert.ok(completionMessage, "AI should have completed after validating the MCP file metadata result")
	})
})
