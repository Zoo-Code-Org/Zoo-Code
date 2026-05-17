import * as assert from "assert"
import * as fs from "fs/promises"
import * as path from "path"
import * as vscode from "vscode"

import { RooCodeEventName, type ClineMessage } from "@roo-code/types"

import { waitFor, sleep } from "../utils"
import { setDefaultSuiteTimeout } from "../test-utils"

const TEST_DIR_NAME = "list-files-tool-fixture"
const SYMLINK_TEST_DIR_NAME = "list-files-symlink-fixture"

suite("Roo Code list_files Tool", function () {
	setDefaultSuiteTimeout(this)

	let workspaceDir: string
	let testFiles: {
		rootFile1: string
		rootFile2: string
		nestedDir: string
		nestedFile1: string
		nestedFile2: string
		deepNestedDir: string
		deepNestedFile: string
		hiddenFile: string
		configFile: string
		readmeFile: string
	}

	// Create test files and directories before all tests
	suiteSetup(async () => {
		// Get workspace directory
		const workspaceFolders = vscode.workspace.workspaceFolders
		if (!workspaceFolders || workspaceFolders.length === 0) {
			throw new Error("No workspace folder found")
		}
		workspaceDir = workspaceFolders[0]!.uri.fsPath

		// Create test directory structure
		const testDir = path.join(workspaceDir, TEST_DIR_NAME)
		const nestedDir = path.join(testDir, "nested")
		const deepNestedDir = path.join(nestedDir, "deep")

		await fs.rm(testDir, { recursive: true, force: true })
		await fs.rm(path.join(workspaceDir, SYMLINK_TEST_DIR_NAME), { recursive: true, force: true })

		testFiles = {
			rootFile1: path.join(testDir, "root-file-1.txt"),
			rootFile2: path.join(testDir, "root-file-2.js"),
			nestedDir: nestedDir,
			nestedFile1: path.join(nestedDir, "nested-file-1.md"),
			nestedFile2: path.join(nestedDir, "nested-file-2.json"),
			deepNestedDir: deepNestedDir,
			deepNestedFile: path.join(deepNestedDir, "deep-nested-file.ts"),
			hiddenFile: path.join(testDir, ".hidden-file"),
			configFile: path.join(testDir, "config.yaml"),
			readmeFile: path.join(testDir, "README.md"),
		}

		// Create directories
		await fs.mkdir(testDir, { recursive: true })
		await fs.mkdir(nestedDir, { recursive: true })
		await fs.mkdir(deepNestedDir, { recursive: true })

		// Create root level files
		await fs.writeFile(testFiles.rootFile1, "This is root file 1 content")
		await fs.writeFile(
			testFiles.rootFile2,
			`function testFunction() {
	console.log("Hello from root file 2");
}`,
		)

		// Create nested files
		await fs.writeFile(
			testFiles.nestedFile1,
			`# Nested File 1

This is a markdown file in the nested directory.`,
		)
		await fs.writeFile(
			testFiles.nestedFile2,
			`{
	"name": "nested-config",
	"version": "1.0.0",
	"description": "Test configuration file"
}`,
		)

		// Create deep nested file
		await fs.writeFile(
			testFiles.deepNestedFile,
			`interface TestInterface {
	id: number;
	name: string;
}`,
		)

		// Create hidden file
		await fs.writeFile(testFiles.hiddenFile, "Hidden file content")

		// Create config file
		await fs.writeFile(
			testFiles.configFile,
			`app:
  name: test-app
  version: 1.0.0
database:
  host: localhost
  port: 5432`,
		)

		// Create README file
		await fs.writeFile(
			testFiles.readmeFile,
			`# List Files Test Directory

This directory contains various files and subdirectories for testing the list_files tool functionality.

## Structure
- Root files (txt, js)
- Nested directory with files (md, json)
- Deep nested directory with TypeScript file
- Hidden file
- Configuration files (yaml)`,
		)
	})

	// Clean up test files and directories after all tests
	suiteTeardown(async () => {
		// Cancel any running tasks before cleanup
		try {
			await globalThis.api.cancelCurrentTask()
		} catch {
			// Task might not be running
		}

		// Clean up test directory structure
		const testDirName = path.basename(path.dirname(testFiles.rootFile1))
		const testDir = path.join(workspaceDir, testDirName)

		try {
			await fs.rm(testDir, { recursive: true, force: true })
		} catch {
			// cleanup failure is non-fatal
		}
	})

	// Clean up before each test
	setup(async () => {
		// Cancel any previous task
		try {
			await globalThis.api.cancelCurrentTask()
		} catch {
			// Task might not be running
		}

		// Small delay to ensure clean state
		await sleep(100)
	})

	// Clean up after each test
	teardown(async () => {
		// Cancel the current task
		try {
			await globalThis.api.cancelCurrentTask()
		} catch {
			// Task might not be running
		}

		// Small delay to ensure clean state
		await sleep(100)
	})

	test("Should list files in a directory (non-recursive)", async function () {
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
			// Start task to list files in test directory
			taskId = await api.startNewTask({
				configuration: {
					mode: "code",
					autoApprovalEnabled: true,
					alwaysAllowReadOnly: true,
					alwaysAllowReadOnlyOutsideWorkspace: true,
				},
				text: "List the files in the list-files-tool-fixture directory without recursing into subdirectories, and report what you find.",
			})

			// Wait for task completion
			await waitFor(() => taskCompleted, { timeout: 60_000 })

			const completionMessage = messages.find(
				(m) =>
					m.type === "say" &&
					(m.say === "completion_result" || m.say === "text") &&
					m.text?.includes("root-file-1.txt") &&
					m.text?.includes(".hidden-file") &&
					m.text?.includes("nested/"),
			)
			assert.ok(completionMessage, "AI should have summarized the non-recursive directory contents")
		} finally {
			// Clean up
			api.off(RooCodeEventName.Message, messageHandler)
			api.off(RooCodeEventName.TaskCompleted, taskCompletedHandler)
		}
	})

	test("Should list files in a directory (recursive)", async function () {
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
			// Start task to list files recursively in test directory
			taskId = await api.startNewTask({
				configuration: {
					mode: "code",
					autoApprovalEnabled: true,
					alwaysAllowReadOnly: true,
					alwaysAllowReadOnlyOutsideWorkspace: true,
				},
				text: "List every file in the list-files-tool-fixture directory recursively and confirm that the nested path for deep-nested-file.ts is included.",
			})

			// Wait for task completion
			await waitFor(() => taskCompleted, { timeout: 60_000 })

			const completionMessage = messages.find(
				(m) =>
					m.type === "say" &&
					(m.say === "completion_result" || m.say === "text") &&
					m.text?.includes("nested/deep/") &&
					m.text?.includes("deep-nested-file.ts"),
			)
			assert.ok(completionMessage, "AI should have summarized the recursive directory contents")
		} finally {
			// Clean up
			api.off(RooCodeEventName.Message, messageHandler)
			api.off(RooCodeEventName.TaskCompleted, taskCompletedHandler)
		}
	})

	test("Should list symlinked files and directories", async function () {
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
			// Create a symlink test directory
			const testDir = path.join(workspaceDir, SYMLINK_TEST_DIR_NAME)
			await fs.rm(testDir, { recursive: true, force: true })
			await fs.mkdir(testDir, { recursive: true })

			// Create a source directory with content
			const sourceDir = path.join(testDir, "source")
			await fs.mkdir(sourceDir, { recursive: true })
			const sourceFile = path.join(sourceDir, "source-file.txt")
			await fs.writeFile(sourceFile, "Content from symlinked file")

			// Create symlinks to file and directory
			const symlinkFile = path.join(testDir, "link-to-file.txt")
			const symlinkDir = path.join(testDir, "link-to-dir")

			try {
				await fs.symlink(sourceFile, symlinkFile)
				await fs.symlink(sourceDir, symlinkDir)
			} catch {
				return
			}

			// Start task to list files in symlink test directory
			taskId = await api.startNewTask({
				configuration: {
					mode: "code",
					autoApprovalEnabled: true,
					alwaysAllowReadOnly: true,
					alwaysAllowReadOnlyOutsideWorkspace: true,
				},
				text: "Call list_files with path='list-files-symlink-fixture' and recursive=false. Report everything the tool returns.",
			})

			// 120s: real models may loop before finding the symlink fixture path.
			await waitFor(() => taskCompleted, { timeout: 120_000 })

			const completionMessage = messages.find((m) => {
				if (m.type !== "say" || (m.say !== "completion_result" && m.say !== "text")) {
					return false
				}

				const text = m.text ?? ""
				const mentionsOriginalEntry = text.includes("source-file.txt") || text.includes("source/")
				const mentionsSymlinkEntry = text.includes("link-to-file.txt") || text.includes("link-to-dir")

				return mentionsOriginalEntry && mentionsSymlinkEntry
			})
			assert.ok(completionMessage, "AI should have summarized both the original and symlinked directory contents")

			// Cleanup
			await fs.rm(testDir, { recursive: true, force: true })
		} finally {
			// Clean up
			api.off(RooCodeEventName.Message, messageHandler)
			api.off(RooCodeEventName.TaskCompleted, taskCompletedHandler)
		}
	})

	test("Should list files in workspace root directory", async function () {
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
			// Start task to list files in workspace root
			taskId = await api.startNewTask({
				configuration: {
					mode: "code",
					autoApprovalEnabled: true,
					alwaysAllowReadOnly: true,
					alwaysAllowReadOnlyOutsideWorkspace: true,
				},
				text: "List the files in the workspace root directory without recursing and confirm whether list-files-tool-fixture or list-files-symlink-fixture is present.",
			})

			// Wait for task completion
			await waitFor(() => taskCompleted, { timeout: 60_000 })

			// Verify the AI mentioned some expected workspace files/directories
			const completionMessage = messages.find(
				(m) =>
					m.type === "say" &&
					(m.say === "completion_result" || m.say === "text") &&
					(m.text?.includes("list-files-tool-fixture") || m.text?.includes("list-files-symlink-fixture")),
			)
			assert.ok(completionMessage, "AI should have mentioned workspace contents")
		} finally {
			// Clean up
			api.off(RooCodeEventName.Message, messageHandler)
			api.off(RooCodeEventName.TaskCompleted, taskCompletedHandler)
		}
	})
})
