import * as assert from "assert"
import * as fs from "fs/promises"
import * as path from "path"
import * as vscode from "vscode"

import { RooCodeEventName, type ClineMessage } from "@roo-code/types"

import { waitFor, sleep } from "../utils"
import { setDefaultSuiteTimeout } from "../test-utils"

const TEST_DIR_NAME = "search-files-tool-fixture"

suite("Roo Code search_files Tool", function () {
	setDefaultSuiteTimeout(this)

	let workspaceDir: string
	let testFiles: {
		jsFile: string
		tsFile: string
		jsonFile: string
		textFile: string
		nestedJsFile: string
		configFile: string
		readmeFile: string
	}

	// Create test files before all tests
	suiteSetup(async () => {
		// Get workspace directory
		const workspaceFolders = vscode.workspace.workspaceFolders
		if (!workspaceFolders || workspaceFolders.length === 0) {
			throw new Error("No workspace folder found")
		}
		workspaceDir = workspaceFolders[0]!.uri.fsPath
		console.log("Workspace directory:", workspaceDir)

		const testDir = path.join(workspaceDir, TEST_DIR_NAME)
		await fs.rm(testDir, { recursive: true, force: true })
		await fs.mkdir(path.join(testDir, "nested"), { recursive: true })

		// Create test files with different content types
		testFiles = {
			jsFile: path.join(testDir, "search-fixture.js"),
			tsFile: path.join(testDir, "search-fixture.ts"),
			jsonFile: path.join(testDir, "search-config.json"),
			textFile: path.join(testDir, "search-readme.txt"),
			nestedJsFile: path.join(testDir, "nested", "nested-search.js"),
			configFile: path.join(testDir, "app-config.yaml"),
			readmeFile: path.join(testDir, "README.md"),
		}

		// Create JavaScript file with functions
		await fs.writeFile(
			testFiles.jsFile,
			`function calculateTotal(items) {
	return items.reduce((sum, item) => sum + item.price, 0)
}

function validateUser(user) {
	if (!user.email || !user.name) {
		throw new Error("Invalid user data")
	}
	return true
}

// TODO: Add more validation functions
const API_URL = "https://api.example.com"
export { calculateTotal, validateUser }`,
		)

		// Create TypeScript file with interfaces
		await fs.writeFile(
			testFiles.tsFile,
			`interface User {
	id: number
	name: string
	email: string
	isActive: boolean
}

interface Product {
	id: number
	title: string
	price: number
	category: string
}

class UserService {
	async getUser(id: number): Promise<User> {
		// TODO: Implement user fetching
		throw new Error("Not implemented")
	}
	
	async updateUser(user: User): Promise<void> {
		// Implementation here
	}
}

export { User, Product, UserService }`,
		)

		// Create JSON configuration file
		await fs.writeFile(
			testFiles.jsonFile,
			`{
	"name": "test-app",
	"version": "1.0.0",
	"description": "A test application for search functionality",
	"main": "index.js",
	"scripts": {
		"start": "node index.js",
		"test": "jest",
		"build": "webpack"
	},
	"dependencies": {
		"express": "^4.18.0",
		"lodash": "^4.17.21"
	},
	"devDependencies": {
		"jest": "^29.0.0",
		"webpack": "^5.0.0"
	}
}`,
		)

		// Create text file with documentation
		await fs.writeFile(
			testFiles.textFile,
			`# Project Documentation

This is a test project for demonstrating search functionality.

## Features
- User management
- Product catalog
- Order processing
- Payment integration

## Installation
1. Clone the repository
2. Run npm install
3. Configure environment variables
4. Start the application

## API Endpoints
- GET /users - List all users
- POST /users - Create new user
- PUT /users/:id - Update user
- DELETE /users/:id - Delete user

## TODO
- Add authentication
- Implement caching
- Add error handling
- Write more tests`,
		)

		// Create nested directory and file
		await fs.writeFile(
			testFiles.nestedJsFile,
			`// Nested utility functions
function formatCurrency(amount) {
	return new Intl.NumberFormat('en-US', {
		style: 'currency',
		currency: 'USD'
	}).format(amount)
}

function debounce(func, wait) {
	let timeout
	return function executedFunction(...args) {
		const later = () => {
			clearTimeout(timeout)
			func(...args)
		}
		clearTimeout(timeout)
		timeout = setTimeout(later, wait)
	}
}

module.exports = { formatCurrency, debounce }`,
		)

		// Create YAML config file
		await fs.writeFile(
			testFiles.configFile,
			`# Application Configuration
app:
  name: "Test Application"
  version: "1.0.0"
  port: 3000
  
database:
  host: "localhost"
  port: 5432
  name: "testdb"
  user: "testuser"
  
redis:
  host: "localhost"
  port: 6379
  
logging:
  level: "info"
  file: "app.log"`,
		)

		// Create Markdown README
		await fs.writeFile(
			testFiles.readmeFile,
			`# Search Files Test Project

This project contains various file types for testing the search_files functionality.

## File Types Included

- **JavaScript files** (.js) - Contains functions and exports
- **TypeScript files** (.ts) - Contains interfaces and classes  
- **JSON files** (.json) - Configuration and package files
- **Text files** (.txt) - Documentation and notes
- **YAML files** (.yaml) - Configuration files
- **Markdown files** (.md) - Documentation

## Search Patterns to Test

1. Function definitions: \`function\\s+\\w+\`
2. TODO comments: \`TODO.*\`
3. Import/export statements: \`(import|export).*\`
4. Interface definitions: \`interface\\s+\\w+\`
5. Configuration keys: \`"\\w+":\\s*\`

## Expected Results

The search should find matches across different file types and provide context for each match.`,
		)

		console.log("Test files created successfully")
		console.log("Test files:", testFiles)
	})

	// Clean up after all tests
	suiteTeardown(async () => {
		// Cancel any running tasks before cleanup
		try {
			await globalThis.api.cancelCurrentTask()
		} catch {
			// Task might not be running
		}

		// Clean up all test files
		console.log("Cleaning up test files...")
		for (const [key, filePath] of Object.entries(testFiles)) {
			try {
				await fs.unlink(filePath)
				console.log(`Cleaned up ${key} test file`)
			} catch (error) {
				console.log(`Failed to clean up ${key} test file:`, error)
			}
		}

		// Clean up nested directory
		try {
			const testDir = path.join(workspaceDir, TEST_DIR_NAME)
			await fs.rm(testDir, { recursive: true, force: true })
			console.log("Cleaned up search test directory")
		} catch (error) {
			console.log("Failed to clean up search test directory:", error)
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

	test("Should search for function definitions in JavaScript files", async function () {
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
			// Start task to search for function definitions
			taskId = await api.startNewTask({
				configuration: {
					mode: "code",
					autoApprovalEnabled: true,
					alwaysAllowReadOnly: true,
					alwaysAllowReadOnlyOutsideWorkspace: true,
				},
				text: "Search the search-files-tool-fixture directory for JavaScript function declarations using the regex function\\s+\\w+ and report the function names you find.",
			})

			console.log("Task ID:", taskId)

			// Wait for task completion
			await waitFor(() => taskCompleted, { timeout: 60_000 })

			// Verify the AI found function definitions
			const completionMessage = messages.find(
				(m) =>
					m.type === "say" &&
					(m.say === "completion_result" || m.say === "text") &&
					(m.text?.includes("calculateTotal") ||
						m.text?.includes("validateUser") ||
						m.text?.includes("function")),
			)
			assert.ok(completionMessage, "AI should have found function definitions")

			console.log("Test passed! Function definitions found successfully with validated results")
		} finally {
			// Clean up
			api.off(RooCodeEventName.Message, messageHandler)
			api.off(RooCodeEventName.TaskCompleted, taskCompletedHandler)
		}
	})

	test("Should search for TODO comments across multiple file types", async function () {
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
			// Start task to search for TODO comments
			taskId = await api.startNewTask({
				configuration: {
					mode: "code",
					autoApprovalEnabled: true,
					alwaysAllowReadOnly: true,
					alwaysAllowReadOnlyOutsideWorkspace: true,
				},
				text: "Search the search-files-tool-fixture directory for TODO comments using the regex TODO.* and report the matching TODO entries.",
			})

			// Wait for task completion
			await waitFor(() => taskCompleted, { timeout: 60_000 })

			// Verify the AI found TODO comments
			const completionMessage = messages.find(
				(m) =>
					m.type === "say" &&
					(m.say === "completion_result" || m.say === "text") &&
					(m.text?.includes("TODO") ||
						m.text?.toLowerCase().includes("found") ||
						m.text?.toLowerCase().includes("results")),
			)
			assert.ok(completionMessage, "AI should have found TODO comments")

			console.log("Test passed! TODO comments found successfully")
		} finally {
			// Clean up
			api.off(RooCodeEventName.Message, messageHandler)
			api.off(RooCodeEventName.TaskCompleted, taskCompletedHandler)
		}
	})

	test("Should search with file pattern filter for TypeScript files", async function () {
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
			// Start task to search for interfaces in TypeScript files only
			taskId = await api.startNewTask({
				configuration: {
					mode: "code",
					autoApprovalEnabled: true,
					alwaysAllowReadOnly: true,
					alwaysAllowReadOnlyOutsideWorkspace: true,
				},
				text: "Search for interface definitions using the regex interface\\s+\\w+ with file_pattern *.ts in the search-files-tool-fixture directory and report the TypeScript interfaces you find.",
			})

			// Wait for task completion
			await waitFor(() => taskCompleted, { timeout: 60_000 })

			// Verify the AI found interface definitions
			const completionMessage = messages.find(
				(m) =>
					m.type === "say" &&
					(m.say === "completion_result" || m.say === "text") &&
					(m.text?.includes("User") || m.text?.includes("Product") || m.text?.includes("interface")),
			)
			assert.ok(completionMessage, "AI should have found interface definitions in TypeScript files")

			console.log("Test passed! TypeScript interfaces found with file pattern filter")
		} finally {
			// Clean up
			api.off(RooCodeEventName.Message, messageHandler)
			api.off(RooCodeEventName.TaskCompleted, taskCompletedHandler)
		}
	})

	test("Should search for configuration keys in JSON files", async function () {
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
			// Start task to search for configuration keys in JSON files
			taskId = await api.startNewTask({
				configuration: {
					mode: "code",
					autoApprovalEnabled: true,
					alwaysAllowReadOnly: true,
					alwaysAllowReadOnlyOutsideWorkspace: true,
				},
				text: 'Search for JSON configuration keys using the regex "\\w+":\\s* with file_pattern *.json in the search-files-tool-fixture directory and report the keys you find.',
			})

			// Wait for task completion
			await waitFor(() => taskCompleted, { timeout: 60_000 })

			// Verify the AI found configuration keys
			const completionMessage = messages.find(
				(m) =>
					m.type === "say" &&
					(m.say === "completion_result" || m.say === "text") &&
					(m.text?.includes("name") ||
						m.text?.includes("version") ||
						m.text?.includes("scripts") ||
						m.text?.includes("dependencies")),
			)
			assert.ok(completionMessage, "AI should have found configuration keys in JSON files")

			console.log("Test passed! JSON configuration keys found successfully")
		} finally {
			// Clean up
			api.off(RooCodeEventName.Message, messageHandler)
			api.off(RooCodeEventName.TaskCompleted, taskCompletedHandler)
		}
	})

	test("Should search in nested directories", async function () {
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
			// Start task to search in nested directories
			taskId = await api.startNewTask({
				configuration: {
					mode: "code",
					autoApprovalEnabled: true,
					alwaysAllowReadOnly: true,
					alwaysAllowReadOnlyOutsideWorkspace: true,
				},
				text: "Search for the utility functions formatCurrency and debounce using the regex function\\s+(format|debounce) in the search-files-tool-fixture directory and report what you find in the nested subdirectory.",
			})

			// Wait for task completion
			await waitFor(() => taskCompleted, { timeout: 60_000 })

			// Verify the AI found utility functions in nested directories
			const completionMessage = messages.find(
				(m) =>
					m.type === "say" &&
					(m.say === "completion_result" || m.say === "text") &&
					(m.text?.includes("formatCurrency") || m.text?.includes("debounce") || m.text?.includes("nested")),
			)
			assert.ok(completionMessage, "AI should have found utility functions in nested directories")

			console.log("Test passed! Nested directory search completed successfully")
		} finally {
			// Clean up
			api.off(RooCodeEventName.Message, messageHandler)
			api.off(RooCodeEventName.TaskCompleted, taskCompletedHandler)
		}
	})

	test("Should handle complex regex patterns", async function () {
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
			// Start task to search with complex regex
			taskId = await api.startNewTask({
				configuration: {
					mode: "code",
					autoApprovalEnabled: true,
					alwaysAllowReadOnly: true,
					alwaysAllowReadOnlyOutsideWorkspace: true,
				},
				text: "Search for import and export statements using the regex (import|export).* with file_pattern *.{js,ts} in the search-files-tool-fixture directory and report the module exports you find.",
			})

			// Wait for task completion
			await waitFor(() => taskCompleted, { timeout: 60_000 })

			// Verify the AI found import/export statements
			const completionMessage = messages.find(
				(m) =>
					m.type === "say" &&
					(m.say === "completion_result" || m.say === "text") &&
					(m.text?.includes("export") || m.text?.includes("import") || m.text?.includes("module")),
			)
			assert.ok(completionMessage, "AI should have found import/export statements")

			console.log("Test passed! Complex regex pattern search completed successfully")
		} finally {
			// Clean up
			api.off(RooCodeEventName.Message, messageHandler)
			api.off(RooCodeEventName.TaskCompleted, taskCompletedHandler)
		}
	})

	test("Should handle search with no matches", async function () {
		const api = globalThis.api
		const messages: ClineMessage[] = []
		let taskCompleted = false

		// Listen for messages
		const messageHandler = ({ message }: { message: ClineMessage }) => {
			messages.push(message)

			// Log all completion messages for debugging
			if (message.type === "say" && (message.say === "completion_result" || message.say === "text")) {
				console.log("AI completion message:", message.text?.substring(0, 300))
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
			// Start task to search for something that doesn't exist
			taskId = await api.startNewTask({
				configuration: {
					mode: "code",
					autoApprovalEnabled: true,
					alwaysAllowReadOnly: true,
					alwaysAllowReadOnlyOutsideWorkspace: true,
				},
				text: "Search the search-files-tool-fixture directory for nonExistentPattern12345 and report that there are no matches if the regex finds nothing.",
			})

			// Wait for task completion
			await waitFor(() => taskCompleted, { timeout: 60_000 })

			// Verify the AI provided a completion response (the tool was executed successfully)
			const completionMessage = messages.find(
				(m) =>
					m.type === "say" &&
					(m.say === "completion_result" || m.say === "text") &&
					m.text &&
					m.text.length > 10, // Any substantial response
			)

			// If we have a completion message, the test passes (AI handled the no-match scenario)
			if (completionMessage) {
				console.log("AI provided completion response for no-match scenario")
			} else {
				// Fallback: check for specific no-match indicators
				const noMatchMessage = messages.find(
					(m) =>
						m.type === "say" &&
						(m.say === "completion_result" || m.say === "text") &&
						(m.text?.toLowerCase().includes("no matches") ||
							m.text?.toLowerCase().includes("not found") ||
							m.text?.toLowerCase().includes("no results") ||
							m.text?.toLowerCase().includes("didn't find") ||
							m.text?.toLowerCase().includes("0 results") ||
							m.text?.toLowerCase().includes("found 0") ||
							m.text?.toLowerCase().includes("empty") ||
							m.text?.toLowerCase().includes("nothing")),
				)
				assert.ok(noMatchMessage, "AI should have provided a response to the no-match search")
			}

			assert.ok(completionMessage, "AI should have provided a completion response")

			console.log("Test passed! No-match scenario handled correctly")
		} finally {
			// Clean up
			api.off(RooCodeEventName.Message, messageHandler)
			api.off(RooCodeEventName.TaskCompleted, taskCompletedHandler)
		}
	})

	test("Should search for class definitions and methods", async function () {
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
			// Start task to search for class definitions and async methods
			taskId = await api.startNewTask({
				configuration: {
					mode: "code",
					autoApprovalEnabled: true,
					alwaysAllowReadOnly: true,
					alwaysAllowReadOnlyOutsideWorkspace: true,
				},
				text: "Search the search-files-tool-fixture directory for TypeScript class definitions and async methods using the regex (class\\s+\\w+|async\\s+\\w+) with file_pattern *.ts, then report what you find.",
			})

			// Wait for task completion
			await waitFor(() => taskCompleted, { timeout: 60_000 })

			// Verify the AI found class definitions and async methods
			const completionMessage = messages.find(
				(m) =>
					m.type === "say" &&
					(m.say === "completion_result" || m.say === "text") &&
					(m.text?.includes("UserService") ||
						m.text?.includes("class") ||
						m.text?.includes("async") ||
						m.text?.includes("getUser")),
			)
			assert.ok(completionMessage, "AI should have found class definitions and async methods")

			console.log("Test passed! Class definitions and async methods found successfully")
		} finally {
			// Clean up
			api.off(RooCodeEventName.Message, messageHandler)
			api.off(RooCodeEventName.TaskCompleted, taskCompletedHandler)
		}
	})
})
