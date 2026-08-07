/**
 * Linux/macOS-only e2e suite for the unified shell-resolution integration layer.
 *
 * PR #1136 wires the ShellResolver / CommandEnvironmentService snapshot into the
 * system prompt, the execute_command tool, the extension API, and the webview
 * message path. These tests prove the end-to-end contract:
 *
 *  1. A `terminalShellSelection` path override set through `api.setConfiguration()`
 *     flows into the resolved command environment, and the SAME resolved shell is
 *     rendered into the system prompt's SYSTEM INFORMATION block that the model
 *     receives (observed via the aimock request journal).
 *  2. The resolved shell actually executes the command — the marker file is
 *     written by the real resolved shell, proving settings reach runtime execution.
 *  3. With `terminalShellIntegrationDisabled: true`, the Inline Terminal (execa)
 *     provider label is shown; the resolution source reflects the explicit user
 *     path override.
 *
 * The path override uses /bin/bash, which only exists on Linux/macOS, so this
 * suite is skipped on Windows. Windows shell-resolution coverage (cmd.exe,
 * PowerShell, WSL) is proven by unit tests in
 * src/integrations/terminal/shell/__tests__/.
 */
import * as assert from "assert"
import * as fs from "fs/promises"
import * as path from "path"
import * as vscode from "vscode"

import { RooCodeEventName, type ClineMessage } from "@roo-code/types"

import { sleep, waitFor, waitUntilCompleted } from "./utils"
import { setDefaultSuiteTimeout } from "./test-utils"

const TEST_DIR_NAME = "shell-integration-e2e"
const PATH_FILE = "shell-integration-path.txt"
const AUTO_FILE = "shell-integration-auto.txt"
const BASH_PATH = "/bin/bash"

type AimockMessageContent = string | Array<{ type?: string; text?: string }>

type AimockJournalEntry = {
	timestamp?: number
	body?: {
		messages?: Array<{
			role?: string
			content?: AimockMessageContent
		}>
	}
}

const messageContentText = (content?: AimockMessageContent) => {
	if (typeof content === "string") {
		return content
	}

	return content?.map((part) => part.text ?? "").join("") ?? ""
}

const fetchAimockJournal = async (): Promise<AimockJournalEntry[]> => {
	const aimockUrl = process.env.AIMOCK_URL
	assert.ok(aimockUrl, "AIMOCK_URL must be set for shell-integration system-prompt assertions")

	const response = await fetch(`${aimockUrl}/__aimock/journal`)
	return (await response.json()) as AimockJournalEntry[]
}

/**
 * Returns the system-prompt text of the request whose user message contains the
 * given sentinel. The unified shell snapshot is rendered into the SYSTEM
 * INFORMATION section of the system prompt (the first `system` role message).
 */
const findSystemPromptFor = (entries: AimockJournalEntry[], userSentinel: string): string | undefined => {
	const entry = entries.find((e) => {
		const messages = e.body?.messages
		if (!messages) return false
		return messages.some(
			(message) => message.role === "user" && messageContentText(message.content).includes(userSentinel),
		)
	})

	if (!entry) return undefined

	const systemMessage = entry.body?.messages?.find((message) => message.role === "system")
	return systemMessage ? messageContentText(systemMessage.content) : undefined
}

suite("Shell Integration", function () {
	if (process.platform !== "linux" && process.platform !== "darwin") {
		return
	}

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
		if (!workspaceFolders?.length) throw new Error("No workspace folder found")
		workspaceDir = workspaceFolders[0]!.uri.fsPath
		testDir = path.join(workspaceDir, TEST_DIR_NAME)
		await fs.rm(testDir, { recursive: true, force: true })
		await fs.mkdir(testDir, { recursive: true })
	})

	suiteTeardown(async () => {
		try {
			await globalThis.api.cancelCurrentTask()
		} catch {
			// task may not be running
		}

		// Restore a clean shell selection so subsequent suites resolve the default.
		await globalThis.api.setConfiguration({
			terminalShellSelection: { kind: "auto" },
		})

		await fs.rm(testDir, { recursive: true, force: true })

		const aimockUrl = process.env.AIMOCK_URL
		const isRecord = process.env.AIMOCK_RECORD === "true"
		await globalThis.api.setConfiguration({
			apiProvider: "openrouter" as const,
			openRouterApiKey: aimockUrl && !isRecord ? "mock-key" : process.env.OPENROUTER_API_KEY!,
			openRouterModelId: "openai/gpt-4.1",
			...(aimockUrl && { openRouterBaseUrl: `${aimockUrl}/v1` }),
		})
	})

	setup(async () => {
		try {
			await globalThis.api.cancelCurrentTask()
		} catch {
			// task may not be running
		}

		await fs.rm(path.join(testDir, PATH_FILE), { force: true })
		await fs.rm(path.join(testDir, AUTO_FILE), { force: true })
		await sleep(100)
	})

	teardown(async () => {
		try {
			await globalThis.api.cancelCurrentTask()
		} catch {
			// task may not be running
		}

		// Always reset to auto so a failing test cannot leak an override into the
		// next test or the next suite.
		await globalThis.api.setConfiguration({
			terminalShellSelection: { kind: "auto" },
		})

		await sleep(100)
	})

	test("path override flows to system prompt and command execution", async function () {
		const api = globalThis.api
		const messages: ClineMessage[] = []

		const messageHandler = ({ message }: { message: ClineMessage }) => {
			messages.push(message)
		}
		api.on(RooCodeEventName.Message, messageHandler)

		try {
			// Configure a unified path override. This is the settings entry point the
			// PR threads through to ShellResolver as a userOverride (priority 2).
			await api.setConfiguration({
				terminalShellSelection: { kind: "path", path: BASH_PATH },
			})

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
						text: "SHELL_INTEGRATION_E2E_PATH_OVERRIDE",
					}),
				timeout: 90_000,
			})

			const gotError = messages.find((m) => m.type === "say" && m.say === "error")
			assert.strictEqual(gotError, undefined, `Unexpected error: ${gotError?.text}`)

			// 1. The resolved shell environment is rendered into the system prompt.
			//    Wait for aimock to journal the request, then read its system message.
			let systemPrompt: string | undefined
			await waitFor(async () => {
				systemPrompt = findSystemPromptFor(await fetchAimockJournal(), "SHELL_INTEGRATION_E2E_PATH_OVERRIDE")
				return systemPrompt !== undefined
			})

			assert.ok(systemPrompt, "System prompt should be present in the aimock journal")
			assert.ok(
				systemPrompt!.includes("Default Shell:"),
				"System prompt should contain the Default Shell line",
			)
			assert.ok(
				systemPrompt!.includes("Command Execution Provider: Inline Terminal"),
				`System prompt should show the Inline Terminal provider, got:\n${systemPrompt}`,
			)
			assert.ok(
				systemPrompt!.includes("Shell Resolution Source: User Override"),
				`System prompt should show the User Override source, got:\n${systemPrompt}`,
			)
			assert.ok(
				systemPrompt!.includes("Shell Constraints:"),
				"System prompt should contain the Shell Constraints line",
			)
			// The resolved executable basename for /bin/bash is "bash".
			assert.ok(
				systemPrompt!.includes("bash"),
				`System prompt should reference the resolved bash executable, got:\n${systemPrompt}`,
			)

			// 2. The same resolved shell executed the command for real.
			const content = await fs.readFile(path.join(testDir, PATH_FILE), "utf-8")
			assert.ok(
				content.includes("zoo-shell-integration-path-ok"),
				`Output file should contain marker, got: ${content}`,
			)
		} finally {
			api.off(RooCodeEventName.Message, messageHandler)
		}
	})

	test("auto selection resolves a shell and renders environment info", async function () {
		const api = globalThis.api
		const messages: ClineMessage[] = []

		const messageHandler = ({ message }: { message: ClineMessage }) => {
			messages.push(message)
		}
		api.on(RooCodeEventName.Message, messageHandler)

		try {
			// Auto selection — no explicit override. The resolver walks the priority
			// chain to an OS/env-derived default and still produces a resolved
			// environment that the system prompt renders.
			await api.setConfiguration({
				terminalShellSelection: { kind: "auto" },
			})

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
						text: "SHELL_INTEGRATION_E2E_AUTO",
					}),
				timeout: 90_000,
			})

			const gotError = messages.find((m) => m.type === "say" && m.say === "error")
			assert.strictEqual(gotError, undefined, `Unexpected error: ${gotError?.text}`)

			// The system prompt still carries the structured shell environment block
			// (not the legacy bare getShell() fallback), proving the unified snapshot
			// drives the prompt even without an explicit override.
			let systemPrompt: string | undefined
			await waitFor(async () => {
				systemPrompt = findSystemPromptFor(await fetchAimockJournal(), "SHELL_INTEGRATION_E2E_AUTO")
				return systemPrompt !== undefined
			})

			assert.ok(systemPrompt, "System prompt should be present in the aimock journal")
			assert.ok(
				systemPrompt!.includes("Command Execution Provider:"),
				`System prompt should contain a Command Execution Provider line, got:\n${systemPrompt}`,
			)
			assert.ok(
				systemPrompt!.includes("Shell Resolution Source:"),
				`System prompt should contain a Shell Resolution Source line, got:\n${systemPrompt}`,
			)

			const content = await fs.readFile(path.join(testDir, AUTO_FILE), "utf-8")
			assert.ok(
				content.includes("zoo-shell-integration-auto-ok"),
				`Output file should contain marker, got: ${content}`,
			)
		} finally {
			api.off(RooCodeEventName.Message, messageHandler)
		}
	})
})
