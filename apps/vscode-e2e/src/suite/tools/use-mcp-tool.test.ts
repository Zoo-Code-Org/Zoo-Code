import * as assert from "assert"
import * as fs from "fs/promises"
import * as path from "path"
import * as vscode from "vscode"

import { RooCodeEventName, type ClineMessage } from "@roo-code/types"

import { waitFor, sleep } from "../utils"
import { setDefaultSuiteTimeout } from "../test-utils"

const FILESYSTEM_SERVER_NAME = "filesystem"
const TEST_DIR_NAME = "use-mcp-tool-fixture"
const TEST_CONFIG_RELATIVE_PATH = ".roo/mcp.json"
const MCP_SERVER_READY_RELATIVE_PATH = `${TEST_DIR_NAME}/mcp-server-ready`
const READ_FILE_RELATIVE_PATH = `${TEST_DIR_NAME}/mcp-read-target.txt`
const WRITE_FILE_RELATIVE_PATH = `${TEST_DIR_NAME}/mcp-write-target.txt`
const TEST_DATA_RELATIVE_PATH = `${TEST_DIR_NAME}/mcp-data.json`
const TREE_FILE_RELATIVE_PATH = `${TEST_DIR_NAME}/nested/tree-child.txt`
const READ_FILE_CONTENT = "Initial content for MCP test"
const WRITE_FILE_CONTENT = "Hello from MCP!"
const TREE_FILE_CONTENT = "Nested MCP content"
const TEST_DATA_CONTENT = JSON.stringify({ test: "data", value: 42 }, null, 2)
const READ_FILE_PROMPT =
	"USE_MCP_TOOL_READ_FILE_SMOKE: Call the filesystem MCP read_file tool exactly once for use-mcp-tool-fixture/mcp-read-target.txt, then confirm what it says."
const WRITE_FILE_PROMPT =
	"USE_MCP_TOOL_WRITE_FILE_SMOKE: Call the filesystem MCP write_file tool exactly once to write 'Hello from MCP!' to use-mcp-tool-fixture/mcp-write-target.txt. Do not read the file afterward; complete after the MCP server confirms the write succeeded."
const LIST_DIRECTORY_PROMPT =
	"USE_MCP_TOOL_LIST_DIRECTORY_SMOKE: Call the filesystem MCP list_directory tool exactly once for use-mcp-tool-fixture, then summarize the entry names you find."
const DIRECTORY_TREE_PROMPT =
	"USE_MCP_TOOL_DIRECTORY_TREE_SMOKE: Call the filesystem MCP directory_tree tool exactly once for use-mcp-tool-fixture and mention the nested child file."
const UNKNOWN_SERVER_PROMPT =
	"USE_MCP_TOOL_UNKNOWN_SERVER_SMOKE: Call the standard use_mcp_tool tool with server_name exactly nonexistent-server, tool_name read_file, and path use-mcp-tool-fixture/mcp-read-target.txt. Then explain the missing-server error."
const GET_FILE_INFO_PROMPT =
	"USE_MCP_TOOL_GET_FILE_INFO_SMOKE: Call the filesystem MCP get_file_info tool exactly once for use-mcp-tool-fixture/mcp-read-target.txt and confirm the metadata lookup completed."

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
	let mcpServerReadyPath: string

	async function writeFilesystemMcpConfig() {
		await fs.mkdir(rooDir, { recursive: true })
		await fs.writeFile(
			mcpConfigPath,
			JSON.stringify(
				{
					mcpServers: {
						[FILESYSTEM_SERVER_NAME]: {
							command: process.env.npm_node_execpath ?? "node",
							args: [path.join(__dirname, "fixtures", "filesystem-mcp-server.js"), workspaceDir],
							env: {
								MCP_TEST_READY_FILE: mcpServerReadyPath,
							},
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

	async function waitForFilesystemMcpServer() {
		await waitFor(
			async () => {
				try {
					await fs.access(mcpServerReadyPath)
					return true
				} catch {
					return false
				}
			},
			{ timeout: 30_000 },
		)
	}

	function findCompletionMessage(messages: ClineMessage[]) {
		return [...messages]
			.reverse()
			.find(
				(message) => message.type === "say" && (message.say === "completion_result" || message.say === "text"),
			)
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
					const parsed = JSON.parse(message.text) as ParsedMcpRequest
					if (parsed.serverName && parsed.toolName) {
						mcpRequest = parsed
					}
				} catch {
					// Ignore partial JSON; a later complete ask will overwrite.
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
		mcpServerReadyPath = path.join(workspaceDir, MCP_SERVER_READY_RELATIVE_PATH)

		await resetFixtureWorkspace()
		await writeFilesystemMcpConfig()
		await waitForFilesystemMcpServer()
	})

	suiteTeardown(async () => {
		try {
			await globalThis.api.clearCurrentTask()
		} catch {
			// Task might not be running
		}

		await fs.rm(testDir, { recursive: true, force: true })
		await fs.rm(rooDir, { recursive: true, force: true })
	})

	setup(async () => {
		try {
			await globalThis.api.clearCurrentTask()
		} catch {
			// Task might not be running
		}

		await resetFixtureWorkspace()
		await sleep(100)
	})

	teardown(async () => {
		try {
			await globalThis.api.clearCurrentTask()
		} catch {
			// Task might not be running
		}

		await sleep(100)
	})

	test("Should request MCP filesystem read_file tool and complete successfully", async function () {
		const { mcpRequest, mcpServerResponse, errorOccurred, messages } = await runMcpTask(READ_FILE_PROMPT)

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

		const completionMessage = findCompletionMessage(messages)
		assert.ok(completionMessage, "AI should have acknowledged the MCP read_file result")
	})

	test("Should request MCP filesystem write_file tool and complete successfully", async function () {
		const targetPath = path.join(workspaceDir, WRITE_FILE_RELATIVE_PATH)
		const { mcpRequest, mcpServerResponse, errorOccurred, messages } = await runMcpTask(WRITE_FILE_PROMPT)

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

		const completionMessage = findCompletionMessage(messages)
		assert.ok(completionMessage, "AI should have acknowledged the MCP write_file result")
	})

	test("Should request MCP filesystem list_directory tool and complete successfully", async function () {
		const { mcpRequest, mcpServerResponse, errorOccurred, messages } = await runMcpTask(LIST_DIRECTORY_PROMPT)

		assert.strictEqual(errorOccurred, null, `Error occurred: ${errorOccurred}`)
		assert.ok(mcpRequest, "The use_mcp_tool request should have been emitted")
		assert.strictEqual(mcpRequest?.serverName, FILESYSTEM_SERVER_NAME)
		assert.strictEqual(mcpRequest?.toolName, "list_directory")
		assert.ok(mcpServerResponse, "Should have received a response from the MCP server")
		assert.ok(
			mcpServerResponse?.includes("mcp-read-target.txt"),
			"Directory listing should include the read fixture",
		)
		assert.ok(mcpServerResponse?.includes("nested"), "Directory listing should include the nested directory")

		const completionMessage = findCompletionMessage(messages)
		assert.ok(completionMessage, "AI should have acknowledged the MCP directory listing result")
	})

	test("Should request MCP filesystem directory_tree tool and complete successfully", async function () {
		const { mcpRequest, mcpServerResponse, errorOccurred, messages } = await runMcpTask(DIRECTORY_TREE_PROMPT)

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

		const completionMessage = findCompletionMessage(messages)
		assert.ok(completionMessage, "AI should have acknowledged the MCP directory tree result")
	})

	test("Should handle MCP server error gracefully and complete task", async function () {
		const { mcpRequest, mcpServerResponse, errorOccurred, messages } = await runMcpTask(UNKNOWN_SERVER_PROMPT)
		const completionMessage = findCompletionMessage(messages)

		if (mcpRequest) {
			assert.strictEqual(mcpRequest.type, "use_mcp_tool")
		}
		assert.strictEqual(mcpServerResponse, null, "Unknown MCP servers should not produce an MCP server response")
		assert.ok(completionMessage, "AI should have acknowledged the missing MCP server error")
		const errorText = `${completionMessage?.text ?? ""}\n${errorOccurred ?? ""}`
		assert.ok(errorText.includes("nonexistent-server"), "Task output should mention the missing MCP server")
	})

	test("Should validate MCP request message format and complete successfully", async function () {
		const targetPath = path.join(workspaceDir, READ_FILE_RELATIVE_PATH)
		const { mcpRequest, mcpServerResponse, errorOccurred, messages } = await runMcpTask(GET_FILE_INFO_PROMPT)

		assert.strictEqual(errorOccurred, null, `Error occurred: ${errorOccurred}`)
		assert.ok(mcpRequest, "The use_mcp_tool request should have been emitted")
		assert.strictEqual(mcpRequest?.type, "use_mcp_tool")
		assert.strictEqual(mcpRequest?.serverName, FILESYSTEM_SERVER_NAME)
		assert.strictEqual(mcpRequest?.toolName, "get_file_info")

		const parsedArguments = JSON.parse(mcpRequest?.arguments ?? "{}") as { path?: string }
		assert.ok(
			parsedArguments.path === READ_FILE_RELATIVE_PATH || parsedArguments.path === targetPath,
			"The MCP request should include the target file path",
		)

		assert.ok(mcpServerResponse, "Should have received a response from the MCP server")
		assert.ok(mcpServerResponse?.includes("size:"), "File info response should contain the size field")
		assert.ok(
			mcpServerResponse?.includes("isFile: true"),
			"File info response should identify the target as a file",
		)
		assert.ok(mcpServerResponse?.includes("permissions:"), "File info response should contain permissions")

		const completionMessage = findCompletionMessage(messages)
		assert.ok(completionMessage, "AI should have completed after validating the MCP file metadata result")
	})
})
