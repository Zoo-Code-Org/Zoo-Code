import * as assert from "assert"
import * as fs from "fs/promises"
import * as path from "path"
import * as vscode from "vscode"

import { RooCodeEventName, type ClineMessage } from "@roo-code/types"

import { waitUntilCompleted, sleep } from "../utils"
import { setDefaultSuiteTimeout } from "../test-utils"

const TEST_DIR_NAME = "apply-diff-tool-fixture"

const testFiles = {
	simpleModify: {
		relativePath: `${TEST_DIR_NAME}/simple-modify.txt`,
		originalContent: "Hello World\nThis is a test file\nWith multiple lines",
		expectedContent: "Hello Universe\nThis is a test file\nWith multiple lines",
	},
	multipleReplace: {
		relativePath: `${TEST_DIR_NAME}/multiple-replace.js`,
		originalContent: `function calculate(x, y) {
	const sum = x + y
	const product = x * y
	return { sum: sum, product: product }
}`,
		expectedContent: `function compute(a, b) {
	const total = a + b
	const result = a * b
	return { total: total, result: result }
}`,
	},
	lineHints: {
		relativePath: `${TEST_DIR_NAME}/line-hints.js`,
		originalContent: `// Header comment
function oldFunction() {
	console.log("Old implementation")
}

// Another function
function keepThis() {
	console.log("Keep this")
}

// Footer comment`,
		expectedContent: `// Header comment
function newFunction() {
	console.log("New implementation")
}

// Another function
function keepThis() {
	console.log("Keep this")
}

// Footer comment`,
	},
	errorHandling: {
		relativePath: `${TEST_DIR_NAME}/error-handling.txt`,
		originalContent: "Original content",
	},
	multiSearchReplace: {
		relativePath: `${TEST_DIR_NAME}/multi-search-replace.js`,
		originalContent: `function processData(data) {
	console.log("Processing data")
	return data.map(item => item * 2)
}

// Some other code in between
const config = {
	timeout: 5000,
	retries: 3
}

function validateInput(input) {
	console.log("Validating input")
	if (!input) {
		throw new Error("Invalid input")
	}
	return true
}`,
		expectedContent: `function transformData(data) {
	console.log("Transforming data")
	return data.map(item => item * 2)
}

// Some other code in between
const config = {
	timeout: 5000,
	retries: 3
}

function checkInput(input) {
	console.log("Checking input")
	if (!input) {
		throw new Error("Invalid input")
	}
	return true
}`,
	},
}

suite("Roo Code apply_diff Tool", function () {
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
			await globalThis.api.clearCurrentTask()
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
			await globalThis.api.clearCurrentTask()
		} catch {
			// Task might not be running
		}

		await fs.rm(testDir, { recursive: true, force: true })
		await fs.mkdir(testDir, { recursive: true })

		for (const fixture of Object.values(testFiles)) {
			await fs.writeFile(path.join(workspaceDir, fixture.relativePath), fixture.originalContent)
		}

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

	test("Should apply diff to modify existing file content", async function () {
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
							alwaysAllowWrite: true,
							alwaysAllowReadOnly: true,
							alwaysAllowReadOnlyOutsideWorkspace: true,
						},
						text: "APPLY_DIFF_SIMPLE_SMOKE",
					}),
				timeout: 60_000,
			})
			await sleep(1_000)

			assert.strictEqual(errorOccurred, null, `Error occurred: ${errorOccurred}`)

			const actualContent = await fs.readFile(
				path.join(workspaceDir, testFiles.simpleModify.relativePath),
				"utf-8",
			)
			assert.strictEqual(
				actualContent.trim(),
				testFiles.simpleModify.expectedContent.trim(),
				"File content should be modified correctly",
			)

			const completionMessage = messages.find(
				(message) =>
					message.type === "say" &&
					(message.say === "completion_result" || message.say === "text") &&
					message.text?.includes("Hello Universe"),
			)
			assert.ok(completionMessage, "AI should have acknowledged the updated file content")
		} finally {
			api.off(RooCodeEventName.Message, messageHandler)
		}
	})

	test("Should apply multiple search/replace blocks in single diff", async function () {
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
							alwaysAllowWrite: true,
							alwaysAllowReadOnly: true,
							alwaysAllowReadOnlyOutsideWorkspace: true,
						},
						text: "APPLY_DIFF_MULTI_REPLACE_SMOKE",
					}),
				timeout: 60_000,
			})
			await sleep(1_000)

			assert.strictEqual(errorOccurred, null, `Error occurred: ${errorOccurred}`)

			const actualContent = await fs.readFile(
				path.join(workspaceDir, testFiles.multipleReplace.relativePath),
				"utf-8",
			)
			assert.strictEqual(
				actualContent.trim(),
				testFiles.multipleReplace.expectedContent.trim(),
				"All replacements should be applied correctly",
			)

			const completionMessage = messages.find(
				(message) =>
					message.type === "say" &&
					(message.say === "completion_result" || message.say === "text") &&
					message.text?.includes("multiple-replace.js"),
			)
			assert.ok(completionMessage, "AI should have acknowledged the multiple replacements")
		} finally {
			api.off(RooCodeEventName.Message, messageHandler)
		}
	})

	test("Should handle apply_diff with line number hints", async function () {
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
							alwaysAllowWrite: true,
							alwaysAllowReadOnly: true,
							alwaysAllowReadOnlyOutsideWorkspace: true,
						},
						text: "APPLY_DIFF_LINE_HINTS_SMOKE",
					}),
				timeout: 60_000,
			})
			await sleep(1_000)

			assert.strictEqual(errorOccurred, null, `Error occurred: ${errorOccurred}`)

			const actualContent = await fs.readFile(path.join(workspaceDir, testFiles.lineHints.relativePath), "utf-8")
			assert.strictEqual(
				actualContent.trim(),
				testFiles.lineHints.expectedContent.trim(),
				"Only the targeted function should be modified",
			)

			const completionMessage = messages.find(
				(message) =>
					message.type === "say" &&
					(message.say === "completion_result" || message.say === "text") &&
					message.text?.includes("newFunction"),
			)
			assert.ok(completionMessage, "AI should have acknowledged the targeted change")
		} finally {
			api.off(RooCodeEventName.Message, messageHandler)
		}
	})

	test("Should handle apply_diff errors gracefully", async function () {
		const api = globalThis.api
		const messages: ClineMessage[] = []

		const messageHandler = ({ message }: { message: ClineMessage }) => {
			messages.push(message)
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
						text: "APPLY_DIFF_ERROR_SMOKE",
					}),
				timeout: 60_000,
			})
			await sleep(1_000)

			const actualContent = await fs.readFile(
				path.join(workspaceDir, testFiles.errorHandling.relativePath),
				"utf-8",
			)
			assert.strictEqual(
				actualContent.trim(),
				testFiles.errorHandling.originalContent.trim(),
				"File content should remain unchanged when the search pattern is not found",
			)

			const completionMessage = messages.find(
				(message) =>
					message.type === "say" &&
					(message.say === "completion_result" || message.say === "text") &&
					message.text?.includes("did not match"),
			)
			assert.ok(completionMessage, "AI should have acknowledged the graceful apply_diff failure")
		} finally {
			api.off(RooCodeEventName.Message, messageHandler)
		}
	})

	test("Should apply multiple search/replace blocks to edit two separate functions", async function () {
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
							alwaysAllowWrite: true,
							alwaysAllowReadOnly: true,
							alwaysAllowReadOnlyOutsideWorkspace: true,
						},
						text: "APPLY_DIFF_MULTI_BLOCK_SMOKE",
					}),
				timeout: 60_000,
			})
			await sleep(1_000)

			assert.strictEqual(errorOccurred, null, `Error occurred: ${errorOccurred}`)

			const actualContent = await fs.readFile(
				path.join(workspaceDir, testFiles.multiSearchReplace.relativePath),
				"utf-8",
			)
			assert.strictEqual(
				actualContent.trim(),
				testFiles.multiSearchReplace.expectedContent.trim(),
				"Both functions should be modified with separate search/replace blocks",
			)

			const completionMessage = messages.find(
				(message) =>
					message.type === "say" &&
					(message.say === "completion_result" || message.say === "text") &&
					message.text?.includes("multi-search-replace.js"),
			)
			assert.ok(completionMessage, "AI should have acknowledged the multi-block apply_diff update")
		} finally {
			api.off(RooCodeEventName.Message, messageHandler)
		}
	})
})
