import * as assert from "assert"
import * as fs from "fs/promises"
import * as path from "path"
import * as os from "os"
import * as vscode from "vscode"

import { RooCodeEventName, type ClineMessage } from "@roo-code/types"

import { waitFor, sleep } from "../utils"
import { setDefaultSuiteTimeout } from "../test-utils"

suite("Roo Code read_file Tool", function () {
	setDefaultSuiteTimeout(this)

	let tempDir: string
	let testFiles: {
		simple: string
		multiline: string
		empty: string
		large: string
		xmlContent: string
		nested: string
	}

	// Create a temporary directory and test files
	suiteSetup(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "roo-test-read-"))

		// Create test files in VSCode workspace directory
		const workspaceDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || tempDir

		// Create test files with different content types
		testFiles = {
			simple: path.join(workspaceDir, "simple-read-file-smoke.txt"),
			multiline: path.join(workspaceDir, "multiline-read-file.txt"),
			empty: path.join(workspaceDir, "empty-read-file.txt"),
			large: path.join(workspaceDir, "large-read-file.txt"),
			xmlContent: path.join(workspaceDir, "xml-content-read-file.xml"),
			nested: path.join(workspaceDir, "nested", "deep", "nested-read-file.txt"),
		}

		// Create files with content
		await fs.writeFile(testFiles.simple, "Hello, World!")
		await fs.writeFile(testFiles.multiline, "Line 1\nLine 2\nLine 3\nLine 4\nLine 5")
		await fs.writeFile(testFiles.empty, "")

		// Create a large file (100 lines)
		const largeContent = Array.from(
			{ length: 100 },
			(_, i) => `Line ${i + 1}: This is a test line with some content`,
		).join("\n")
		await fs.writeFile(testFiles.large, largeContent)

		// Create XML content file
		await fs.writeFile(
			testFiles.xmlContent,
			"<root>\n  <child>Test content</child>\n  <data>Some data</data>\n</root>",
		)

		// Create nested directory and file
		await fs.mkdir(path.dirname(testFiles.nested), { recursive: true })
		await fs.writeFile(testFiles.nested, "Content in nested directory")

		console.log("Test files created in:", workspaceDir)
		console.log("Test files:", testFiles)
	})

	// Clean up temporary directory and files after tests
	suiteTeardown(async () => {
		// Clear any running tasks before cleanup
		try {
			await globalThis.api.clearCurrentTask()
		} catch {
			// Task might not be running
		}

		// Clean up test files
		for (const filePath of Object.values(testFiles)) {
			try {
				await fs.unlink(filePath)
			} catch {
				// File might not exist
			}
		}

		// Clean up nested directory
		try {
			await fs.rmdir(path.dirname(testFiles.nested))
			await fs.rmdir(path.dirname(path.dirname(testFiles.nested)))
		} catch {
			// Directory might not exist or not be empty
		}

		await fs.rm(tempDir, { recursive: true, force: true })
	})

	// Clean up before each test
	setup(async () => {
		// Clear any previous task
		try {
			await globalThis.api.clearCurrentTask()
		} catch {
			// Task might not be running
		}

		// Small delay to ensure clean state
		await sleep(100)
	})

	// Clean up after each test
	teardown(async () => {
		// Clear the current task
		try {
			await globalThis.api.clearCurrentTask()
		} catch {
			// Task might not be running
		}

		// Small delay to ensure clean state
		await sleep(100)
	})

	test("Should read a simple text file", async function () {
		const api = globalThis.api
		const messages: ClineMessage[] = []
		let taskStarted = false
		let taskCompleted = false
		let errorOccurred: string | null = null

		// Listen for messages
		const messageHandler = ({ message }: { message: ClineMessage }) => {
			messages.push(message)

			// Log important messages for debugging
			if (message.type === "say" && message.say === "error") {
				errorOccurred = message.text || "Unknown error"
				console.error("Error:", message.text)
			}

			// Log all AI responses for debugging
			if (message.type === "say" && (message.say === "text" || message.say === "completion_result")) {
				console.log("AI response:", message.text?.substring(0, 200))
			}
		}
		api.on(RooCodeEventName.Message, messageHandler)

		// Listen for task events
		const taskStartedHandler = (id: string) => {
			if (id === taskId) {
				taskStarted = true
				console.log("Task started:", id)
			}
		}
		api.on(RooCodeEventName.TaskStarted, taskStartedHandler)

		const taskCompletedHandler = (id: string) => {
			if (id === taskId) {
				taskCompleted = true
				console.log("Task completed:", id)
			}
		}
		api.on(RooCodeEventName.TaskCompleted, taskCompletedHandler)

		let taskId: string
		try {
			// Start task with a simple read file request
			const fileName = path.basename(testFiles.simple)
			// Use a very explicit prompt
			taskId = await api.startNewTask({
				configuration: {
					mode: "code",
					autoApprovalEnabled: true,
					alwaysAllowReadOnly: true,
					alwaysAllowReadOnlyOutsideWorkspace: true,
				},
				text: `READ_FILE_SIMPLE_SMOKE: Please use the read_file tool to read the file named "${fileName}". This file contains the text "Hello, World!" and is located in the current workspace directory. Assume the file exists and you can read it directly. After reading it, tell me what the file contains.`,
			})

			console.log("Task ID:", taskId)
			console.log("Reading file:", fileName)
			console.log("Expected file path:", testFiles.simple)

			// Wait for task to start
			await waitFor(() => taskStarted, { timeout: 60_000 })

			// Check for early errors
			if (errorOccurred) {
				console.error("Early error detected:", errorOccurred)
			}

			// Wait for task completion
			await waitFor(() => taskCompleted, { timeout: 60_000 })

			// Check that no errors occurred
			assert.strictEqual(errorOccurred, null, "No errors should have occurred")

			// The committed aimock fixture drives this through a read_file tool call.
			// The public e2e event stream only exposes the final assistant response.
			const hasContent = messages.some(
				(m) =>
					m.type === "say" &&
					(m.say === "completion_result" || m.say === "text") &&
					m.text?.toLowerCase().includes("hello") &&
					m.text?.toLowerCase().includes("world"),
			)
			assert.ok(hasContent, "AI should have mentioned the file content 'Hello, World!'")

			console.log("Test passed! File read successfully with correct content")
		} finally {
			// Clean up
			api.off(RooCodeEventName.Message, messageHandler)
			api.off(RooCodeEventName.TaskStarted, taskStartedHandler)
			api.off(RooCodeEventName.TaskCompleted, taskCompletedHandler)
		}
	})

	test("Should read a multiline file", async function () {
		const api = globalThis.api
		const messages: ClineMessage[] = []
		let taskCompleted = false

		// Listen for messages
		const messageHandler = ({ message }: { message: ClineMessage }) => {
			messages.push(message)

			// Log AI responses
			if (message.type === "say" && (message.say === "text" || message.say === "completion_result")) {
				console.log("AI response:", message.text?.substring(0, 200))
			}
		}
		api.on(RooCodeEventName.Message, messageHandler)

		// Listen for task completion
		const taskCompletedHandler = (id: string) => {
			if (id === taskId) {
				taskCompleted = true
			}
		}
		api.on(RooCodeEventName.TaskCompleted, taskCompletedHandler)

		let taskId: string
		try {
			// Start task
			const fileName = path.basename(testFiles.multiline)
			taskId = await api.startNewTask({
				configuration: {
					mode: "code",
					autoApprovalEnabled: true,
					alwaysAllowReadOnly: true,
					alwaysAllowReadOnlyOutsideWorkspace: true,
				},
				text: `READ_FILE_MULTILINE_SMOKE: Use the read_file tool to read the file "${fileName}" which contains 5 lines of text (Line 1, Line 2, Line 3, Line 4, Line 5). Assume the file exists and you can read it directly. Count how many lines it has and tell me the result.`,
			})

			// Wait for task completion
			await waitFor(() => taskCompleted, { timeout: 60_000 })

			// The replay fixture only completes after aimock sees a tool response
			// containing the first and final expected lines.
			const hasLineCount = messages.some(
				(m) =>
					m.type === "say" &&
					(m.say === "completion_result" || m.say === "text") &&
					(m.text?.includes("5") || m.text?.toLowerCase().includes("five")),
			)
			assert.ok(hasLineCount, "AI should have mentioned the file has 5 lines")

			console.log("Test passed! Multiline file read successfully with correct content")
		} finally {
			// Clean up
			api.off(RooCodeEventName.Message, messageHandler)
			api.off(RooCodeEventName.TaskCompleted, taskCompletedHandler)
		}
	})

	test("Should read file with slice offset/limit", async function () {
		const api = globalThis.api
		const messages: ClineMessage[] = []
		let taskCompleted = false

		// Listen for messages
		const messageHandler = ({ message }: { message: ClineMessage }) => {
			messages.push(message)

			// Log AI responses
			if (message.type === "say" && (message.say === "text" || message.say === "completion_result")) {
				console.log("AI response:", message.text?.substring(0, 200))
			}
		}
		api.on(RooCodeEventName.Message, messageHandler)

		// Listen for task completion
		const taskCompletedHandler = (id: string) => {
			if (id === taskId) {
				taskCompleted = true
			}
		}
		api.on(RooCodeEventName.TaskCompleted, taskCompletedHandler)

		let taskId: string
		try {
			// Start task
			const fileName = path.basename(testFiles.multiline)
			taskId = await api.startNewTask({
				configuration: {
					mode: "code",
					autoApprovalEnabled: true,
					alwaysAllowReadOnly: true,
					alwaysAllowReadOnlyOutsideWorkspace: true,
				},
				text: `READ_FILE_SLICE_SMOKE: Use the read_file tool to read the file "${fileName}" using slice mode with offset=2 and limit=3 (1-based offset). The file contains lines like "Line 1", "Line 2", etc. After reading, show me the three lines you read.`,
			})

			// Wait for task completion
			await waitFor(() => taskCompleted, { timeout: 60_000 })

			const hasLines = messages.some(
				(m) =>
					m.type === "say" &&
					(m.say === "completion_result" || m.say === "text") &&
					m.text?.includes("Line 2") &&
					m.text?.includes("Line 3") &&
					m.text?.includes("Line 4"),
			)
			assert.ok(hasLines, "AI should have mentioned the requested lines")

			console.log("Test passed! File read with line range successfully")
		} finally {
			// Clean up
			api.off(RooCodeEventName.Message, messageHandler)
			api.off(RooCodeEventName.TaskCompleted, taskCompletedHandler)
		}
	})

	test("Should handle reading non-existent file", async function () {
		const api = globalThis.api
		const messages: ClineMessage[] = []
		let taskCompleted = false

		// Listen for messages
		const messageHandler = ({ message }: { message: ClineMessage }) => {
			messages.push(message)
		}
		api.on(RooCodeEventName.Message, messageHandler)

		// Listen for task completion
		const taskCompletedHandler = (id: string) => {
			if (id === taskId) {
				taskCompleted = true
			}
		}
		api.on(RooCodeEventName.TaskCompleted, taskCompletedHandler)

		let taskId: string
		try {
			// Start task with non-existent file
			const nonExistentFile = "non-existent-read-file.txt"
			taskId = await api.startNewTask({
				configuration: {
					mode: "code",
					autoApprovalEnabled: true,
					alwaysAllowReadOnly: true,
					alwaysAllowReadOnlyOutsideWorkspace: true,
				},
				text: `READ_FILE_MISSING_SMOKE: Try to read the file "${nonExistentFile}" and tell me what happens. This file does not exist, so I expect you to handle the error appropriately.`,
			})

			// Wait for task completion
			await waitFor(() => taskCompleted, { timeout: 60_000 })

			// Verify the AI handled the error appropriately
			const completionMessage = messages.find(
				(m) =>
					m.type === "say" &&
					(m.say === "completion_result" || m.say === "text") &&
					(m.text?.toLowerCase().includes("not found") ||
						m.text?.toLowerCase().includes("doesn't exist") ||
						m.text?.toLowerCase().includes("does not exist")),
			)
			assert.ok(completionMessage, "AI should have mentioned the file was not found")

			console.log("Test passed! Non-existent file handled correctly")
		} finally {
			// Clean up
			api.off(RooCodeEventName.Message, messageHandler)
			api.off(RooCodeEventName.TaskCompleted, taskCompletedHandler)
		}
	})

	test("Should read XML content file", async function () {
		const api = globalThis.api
		const messages: ClineMessage[] = []
		let taskCompleted = false

		// Listen for messages
		const messageHandler = ({ message }: { message: ClineMessage }) => {
			messages.push(message)

			// Log AI responses
			if (message.type === "say" && (message.say === "text" || message.say === "completion_result")) {
				console.log("AI response:", message.text?.substring(0, 200))
			}
		}
		api.on(RooCodeEventName.Message, messageHandler)

		// Listen for task completion
		const taskCompletedHandler = (id: string) => {
			if (id === taskId) {
				taskCompleted = true
			}
		}
		api.on(RooCodeEventName.TaskCompleted, taskCompletedHandler)

		let taskId: string
		try {
			// Start task
			const fileName = path.basename(testFiles.xmlContent)
			taskId = await api.startNewTask({
				configuration: {
					mode: "code",
					autoApprovalEnabled: true,
					alwaysAllowReadOnly: true,
					alwaysAllowReadOnlyOutsideWorkspace: true,
				},
				text: `READ_FILE_XML_SMOKE: Use the read_file tool to read the XML file "${fileName}". It contains XML elements including root, child, and data. Assume the file exists and you can read it directly. Tell me what elements you find.`,
			})

			// Wait for task completion
			await waitFor(() => taskCompleted, { timeout: 60_000 })

			// Verify the AI mentioned the XML content - be more flexible
			const hasXMLContent = messages.some(
				(m) =>
					m.type === "say" &&
					(m.say === "completion_result" || m.say === "text") &&
					m.text?.toLowerCase().includes("root") &&
					m.text?.toLowerCase().includes("child") &&
					m.text?.toLowerCase().includes("data"),
			)
			assert.ok(hasXMLContent, "AI should have mentioned the XML elements")

			console.log("Test passed! XML file read successfully")
		} finally {
			// Clean up
			api.off(RooCodeEventName.Message, messageHandler)
			api.off(RooCodeEventName.TaskCompleted, taskCompletedHandler)
		}
	})

	test("Should read multiple files in sequence", async function () {
		const api = globalThis.api
		const messages: ClineMessage[] = []
		let taskCompleted = false

		// Listen for messages
		const messageHandler = ({ message }: { message: ClineMessage }) => {
			messages.push(message)
		}
		api.on(RooCodeEventName.Message, messageHandler)

		// Listen for task completion
		const taskCompletedHandler = (id: string) => {
			if (id === taskId) {
				taskCompleted = true
			}
		}
		api.on(RooCodeEventName.TaskCompleted, taskCompletedHandler)

		let taskId: string
		try {
			// Start task to read multiple files
			const simpleFileName = path.basename(testFiles.simple)
			const multilineFileName = path.basename(testFiles.multiline)
			taskId = await api.startNewTask({
				configuration: {
					mode: "code",
					autoApprovalEnabled: true,
					alwaysAllowReadOnly: true,
					alwaysAllowReadOnlyOutsideWorkspace: true,
				},
				text: `READ_FILE_MULTIPLE_SMOKE: Use the read_file tool to read these two files:
1. "${simpleFileName}" - contains "Hello, World!"
2. "${multilineFileName}" - contains 5 lines of text
Assume both files exist and you can read them directly. Read each file and tell me what you found in each one.`,
			})

			// Wait for task completion
			await waitFor(() => taskCompleted, { timeout: 60_000 })

			// Verify the AI mentioned both file contents.
			const hasContent = messages.some(
				(m) =>
					m.type === "say" &&
					(m.say === "completion_result" || m.say === "text") &&
					m.text?.includes("Hello, World!") &&
					m.text?.includes("Line 1") &&
					m.text?.includes("Line 5"),
			)
			assert.ok(hasContent, "AI should have mentioned contents of the files")

			console.log("Test passed! Multiple files read successfully")
		} finally {
			// Clean up
			api.off(RooCodeEventName.Message, messageHandler)
			api.off(RooCodeEventName.TaskCompleted, taskCompletedHandler)
		}
	})

	test("Should read large file efficiently", async function () {
		const api = globalThis.api
		const messages: ClineMessage[] = []
		let taskCompleted = false

		// Listen for messages
		const messageHandler = ({ message }: { message: ClineMessage }) => {
			messages.push(message)

			// Log AI responses
			if (message.type === "say" && (message.say === "text" || message.say === "completion_result")) {
				console.log("AI response:", message.text?.substring(0, 200))
			}
		}
		api.on(RooCodeEventName.Message, messageHandler)

		// Listen for task completion
		const taskCompletedHandler = (id: string) => {
			if (id === taskId) {
				taskCompleted = true
			}
		}
		api.on(RooCodeEventName.TaskCompleted, taskCompletedHandler)

		let taskId: string
		try {
			// Start task
			const fileName = path.basename(testFiles.large)
			taskId = await api.startNewTask({
				configuration: {
					mode: "code",
					autoApprovalEnabled: true,
					alwaysAllowReadOnly: true,
					alwaysAllowReadOnlyOutsideWorkspace: true,
				},
				text: `READ_FILE_LARGE_SMOKE: Use the read_file tool to read the file "${fileName}" which has 100 lines. Each line follows the pattern "Line N: This is a test line with some content". Assume the file exists and you can read it directly. Tell me about the pattern you see.`,
			})

			// Wait for task completion
			await waitFor(() => taskCompleted, { timeout: 60_000 })

			// Verify the AI mentioned the line pattern - be more flexible
			const hasPattern = messages.some(
				(m) =>
					m.type === "say" &&
					(m.say === "completion_result" || m.say === "text") &&
					m.text?.toLowerCase().includes("100 lines") &&
					m.text?.toLowerCase().includes("line n"),
			)
			assert.ok(hasPattern, "AI should have identified the line pattern")

			console.log("Test passed! Large file read efficiently")
		} finally {
			// Clean up
			api.off(RooCodeEventName.Message, messageHandler)
			api.off(RooCodeEventName.TaskCompleted, taskCompletedHandler)
		}
	})
})
