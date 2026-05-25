import * as assert from "assert"
import * as fs from "fs/promises"
import * as path from "path"
import * as vscode from "vscode"

import { RooCodeEventName, type ClineMessage } from "@roo-code/types"

import { sleep, waitUntilCompleted } from "../utils"
import { setDefaultSuiteTimeout } from "../test-utils"

const TEST_DIR_NAME = "execute-command-tool-fixture"
const CUSTOM_CWD_RELATIVE_PATH = `${TEST_DIR_NAME}/custom-cwd`
const SIMPLE_FILE_RELATIVE_PATH = `${TEST_DIR_NAME}/simple-echo.txt`
const MULTI_COMMAND_FILE_RELATIVE_PATH = `${TEST_DIR_NAME}/multi-command.txt`
const CUSTOM_CWD_OUTPUT_RELATIVE_PATH = `${CUSTOM_CWD_RELATIVE_PATH}/output.txt`

suite("Roo Code execute_command Tool", function () {
	setDefaultSuiteTimeout(this)

	let workspaceDir: string
	let testDir: string

	suiteSetup(async () => {
		const aimockUrl = process.env.AIMOCK_URL
		const isRecord = process.env.AIMOCK_RECORD === "true"

		await globalThis.api.setConfiguration({
			apiProvider: "openrouter" as const,
			openRouterApiKey: aimockUrl && !isRecord ? "mock-key" : process.env.OPENROUTER_API_KEY!,
			openRouterModelId: "anthropic/claude-sonnet-4.5",
			...(aimockUrl && { openRouterBaseUrl: `${aimockUrl}/v1` }),
		})

		const workspaceFolders = vscode.workspace.workspaceFolders
		if (!workspaceFolders || workspaceFolders.length === 0) {
			throw new Error("No workspace folder found")
		}

		workspaceDir = workspaceFolders[0]!.uri.fsPath
		testDir = path.join(workspaceDir, TEST_DIR_NAME)
		await fs.rm(testDir, { recursive: true, force: true })
	})

	suiteTeardown(async () => {
		try {
			await globalThis.api.cancelCurrentTask()
		} catch {
			// Task might not be running
		}

		const aimockUrl = process.env.AIMOCK_URL
		const isRecord = process.env.AIMOCK_RECORD === "true"
		await globalThis.api.setConfiguration({
			apiProvider: "openrouter" as const,
			openRouterApiKey: aimockUrl && !isRecord ? "mock-key" : process.env.OPENROUTER_API_KEY!,
			openRouterModelId: "openai/gpt-4.1",
			...(aimockUrl && { openRouterBaseUrl: `${aimockUrl}/v1` }),
		})

		await fs.rm(testDir, { recursive: true, force: true })
	})

	setup(async () => {
		try {
			await globalThis.api.cancelCurrentTask()
		} catch {
			// Task might not be running
		}

		await fs.rm(testDir, { recursive: true, force: true })
		await fs.mkdir(path.join(workspaceDir, CUSTOM_CWD_RELATIVE_PATH), { recursive: true })
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

	test("Should execute simple echo command", async function () {
		const api = globalThis.api
		const messages: ClineMessage[] = []
		let errorOccurred: string | null = null

		const messageHandler = ({ message }: { message: ClineMessage }) => {
			messages.push(message)
			if (message.type === "say" && message.say === "error") {
				errorOccurred = message.text || "Unknown error"
			}
		}
		api.on(RooCodeEventName.Message, messageHandler)

		try {
			await waitUntilCompleted({
				api,
				start: () =>
					api.startNewTask({
						configuration: {
							mode: "code",
							autoApprovalEnabled: true,
							alwaysAllowExecute: true,
							allowedCommands: ["*"],
							terminalShellIntegrationDisabled: true,
						},
						text: "EXECUTE_COMMAND_SIMPLE_SMOKE",
					}),
				timeout: 60_000,
			})
			assert.strictEqual(errorOccurred, null, `Error occurred: ${errorOccurred}`)

			const content = await fs.readFile(path.join(workspaceDir, SIMPLE_FILE_RELATIVE_PATH), "utf-8")
			assert.ok(content.includes("Hello from test"), "File should contain the echoed text")

			const completionMessage = messages.find(
				(message) =>
					message.type === "say" &&
					(message.say === "completion_result" || message.say === "text") &&
					message.text?.includes("simple-echo.txt"),
			)
			assert.ok(completionMessage, "AI should have acknowledged the created file")
		} finally {
			api.off(RooCodeEventName.Message, messageHandler)
		}
	})

	test("Should execute command with custom working directory", async function () {
		const api = globalThis.api
		const messages: ClineMessage[] = []
		let errorOccurred: string | null = null

		const messageHandler = ({ message }: { message: ClineMessage }) => {
			messages.push(message)
			if (message.type === "say" && message.say === "error") {
				errorOccurred = message.text || "Unknown error"
			}
		}
		api.on(RooCodeEventName.Message, messageHandler)

		try {
			await waitUntilCompleted({
				api,
				start: () =>
					api.startNewTask({
						configuration: {
							mode: "code",
							autoApprovalEnabled: true,
							alwaysAllowExecute: true,
							allowedCommands: ["*"],
							terminalShellIntegrationDisabled: true,
						},
						text: "EXECUTE_COMMAND_CWD_SMOKE",
					}),
				timeout: 60_000,
			})
			assert.strictEqual(errorOccurred, null, `Error occurred: ${errorOccurred}`)

			const content = await fs.readFile(path.join(workspaceDir, CUSTOM_CWD_OUTPUT_RELATIVE_PATH), "utf-8")
			assert.ok(content.includes("Test in subdirectory"), "File should contain the echoed text")

			const completionMessage = messages.find(
				(message) =>
					message.type === "say" &&
					(message.say === "completion_result" || message.say === "text") &&
					message.text?.includes("custom-cwd"),
			)
			assert.ok(completionMessage, "AI should have acknowledged the custom cwd execution")
		} finally {
			api.off(RooCodeEventName.Message, messageHandler)
		}
	})

	test("Should execute multiple commands sequentially", async function () {
		const api = globalThis.api
		const messages: ClineMessage[] = []
		let errorOccurred: string | null = null

		const messageHandler = ({ message }: { message: ClineMessage }) => {
			messages.push(message)
			if (message.type === "say" && message.say === "error") {
				errorOccurred = message.text || "Unknown error"
			}
		}
		api.on(RooCodeEventName.Message, messageHandler)

		try {
			await waitUntilCompleted({
				api,
				start: () =>
					api.startNewTask({
						configuration: {
							mode: "code",
							autoApprovalEnabled: true,
							alwaysAllowExecute: true,
							allowedCommands: ["*"],
							terminalShellIntegrationDisabled: true,
						},
						text: "EXECUTE_COMMAND_MULTI_SMOKE",
					}),
				timeout: 90_000,
			})
			assert.strictEqual(errorOccurred, null, `Error occurred: ${errorOccurred}`)

			const content = await fs.readFile(path.join(workspaceDir, MULTI_COMMAND_FILE_RELATIVE_PATH), "utf-8")
			assert.ok(content.includes("Line 1"), "Should contain the first line")
			assert.ok(content.includes("Line 2"), "Should contain the second line")

			const completionMessage = messages.find(
				(message) =>
					message.type === "say" &&
					(message.say === "completion_result" || message.say === "text") &&
					message.text?.includes("multi-command.txt"),
			)
			assert.ok(completionMessage, "AI should have acknowledged the multi-command run")
		} finally {
			api.off(RooCodeEventName.Message, messageHandler)
		}
	})

	test("Should handle long-running commands", async function () {
		const api = globalThis.api
		const messages: ClineMessage[] = []
		let errorOccurred: string | null = null
		let commandCompleted = false

		const messageHandler = ({ message }: { message: ClineMessage }) => {
			messages.push(message)
			if (message.type === "say" && message.say === "error") {
				errorOccurred = message.text || "Unknown error"
			}
			if (message.type === "say" && message.say === "command_output") {
				if (message.text?.includes("Command completed after delay")) {
					commandCompleted = true
				}
			}
		}
		api.on(RooCodeEventName.Message, messageHandler)

		try {
			await waitUntilCompleted({
				api,
				start: () =>
					api.startNewTask({
						configuration: {
							mode: "code",
							autoApprovalEnabled: true,
							alwaysAllowExecute: true,
							allowedCommands: ["*"],
							terminalShellIntegrationDisabled: true,
						},
						text: "EXECUTE_COMMAND_LONG_RUNNING_SMOKE",
					}),
				timeout: 60_000,
			})
			await sleep(500)

			assert.strictEqual(errorOccurred, null, `Error occurred: ${errorOccurred}`)
			assert.ok(commandCompleted, "Command output should include the delayed completion text")

			const completionMessage = messages.find(
				(message) =>
					message.type === "say" &&
					(message.say === "completion_result" || message.say === "text") &&
					message.text?.includes("Command completed after delay"),
			)
			assert.ok(completionMessage, "AI should have acknowledged the long-running command result")
		} finally {
			api.off(RooCodeEventName.Message, messageHandler)
		}
	})
})
