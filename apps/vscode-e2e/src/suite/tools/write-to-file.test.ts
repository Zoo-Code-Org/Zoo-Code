import * as assert from "assert"
import * as fs from "fs/promises"
import * as path from "path"
import * as vscode from "vscode"

import { RooCodeEventName, type ClineMessage } from "@roo-code/types"

import { waitUntilCompleted, sleep } from "../utils"
import { setDefaultSuiteTimeout } from "../test-utils"

const TEST_DIR_NAME = "write-to-file-tool-fixture"
const SIMPLE_FILE_RELATIVE_PATH = `${TEST_DIR_NAME}/write-to-file-smoke.txt`
const NESTED_FILE_RELATIVE_PATH = `${TEST_DIR_NAME}/nested/deep/directory/write-to-file-nested-smoke.txt`
const SIMPLE_FILE_CONTENT = "Hello, this is a test file!"
const NESTED_FILE_CONTENT = "File in nested directory"

suite("Roo Code write_to_file Tool", function () {
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
		await fs.mkdir(testDir, { recursive: true })
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

	test("Should create a new file with content", async function () {
		const api = globalThis.api
		const messages: ClineMessage[] = []
		let errorOccurred: string | null = null
		const targetPath = path.join(workspaceDir, SIMPLE_FILE_RELATIVE_PATH)

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
							alwaysAllowWrite: true,
							alwaysAllowReadOnly: true,
							alwaysAllowReadOnlyOutsideWorkspace: true,
						},
						text: "WRITE_TO_FILE_CREATE_SMOKE",
					}),
				timeout: 45_000,
			})

			assert.strictEqual(errorOccurred, null, `Error occurred: ${errorOccurred}`)

			const actualContent = await fs.readFile(targetPath, "utf-8")
			assert.strictEqual(actualContent.trim(), SIMPLE_FILE_CONTENT, "File content should match expected content")

			const toolApprovalMessage = messages.find(
				(message) =>
					message.type === "ask" &&
					message.ask === "tool" &&
					message.text?.includes("write-to-file-smoke.txt"),
			)
			assert.ok(toolApprovalMessage, "Task should have requested approval for the file write")
		} finally {
			api.off(RooCodeEventName.Message, messageHandler)
		}
	})

	test("Should create nested directories when writing file", async function () {
		const api = globalThis.api
		const messages: ClineMessage[] = []
		let errorOccurred: string | null = null
		const targetPath = path.join(workspaceDir, NESTED_FILE_RELATIVE_PATH)

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
							alwaysAllowWrite: true,
							alwaysAllowReadOnly: true,
							alwaysAllowReadOnlyOutsideWorkspace: true,
						},
						text: "WRITE_TO_FILE_NESTED_SMOKE",
					}),
				timeout: 45_000,
			})

			assert.strictEqual(errorOccurred, null, `Error occurred: ${errorOccurred}`)

			const actualContent = await fs.readFile(targetPath, "utf-8")
			assert.strictEqual(actualContent.trim(), NESTED_FILE_CONTENT, "Nested file content should match")

			const toolApprovalMessage = messages.find(
				(message) =>
					message.type === "ask" &&
					message.ask === "tool" &&
					message.text?.includes("write-to-file-nested-smoke.txt"),
			)
			assert.ok(toolApprovalMessage, "Task should have requested approval for the nested file write")
		} finally {
			api.off(RooCodeEventName.Message, messageHandler)
		}
	})
})
