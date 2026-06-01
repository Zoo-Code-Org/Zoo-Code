/**
 * Linux-only e2e smoke test for the VS Code terminal profile override.
 *
 * Proves that:
 *  1. Setting a profile override causes commands to run through the selected
 *     VS Code integrated-terminal shell without a shell_integration_warning.
 *  2. Clearing the override starts a fresh terminal on the next command.
 *
 * Windows profile coverage (cmd.exe fast-path, PowerShell) is proven by unit
 * tests in src/integrations/terminal/__tests__/. This test requires /bin/bash
 * which only exists on Linux/macOS.
 */
import * as assert from "assert"
import * as fs from "fs/promises"
import * as path from "path"
import * as vscode from "vscode"

import { RooCodeEventName, type ClineMessage } from "@roo-code/types"

import { sleep, waitUntilCompleted } from "../utils"
import { setDefaultSuiteTimeout } from "../test-utils"

const TEST_DIR_NAME = "terminal-profile-e2e"
const OVERRIDE_FILE = "terminal-profile-override.txt"
const DEFAULT_FILE = "terminal-profile-default.txt"
const PROFILE_NAME = "Zoo E2E Bash"

suite("Terminal Profile", function () {
	if (process.platform !== "linux") {
		return
	}

	setDefaultSuiteTimeout(this)

	let workspaceDir: string
	let testDir: string
	let originalProfiles: Record<string, unknown> | undefined

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

		// Save the current global linux profiles so we can restore them in teardown.
		originalProfiles = vscode.workspace
			.getConfiguration("terminal.integrated.profiles")
			.inspect<Record<string, unknown>>("linux")?.globalValue

		// Write the test profile to VS Code user (global) settings.
		// Terminal.getConfiguredProfiles() intentionally excludes workspace settings
		// for security, so global scope is required here.
		await vscode.workspace.getConfiguration("terminal.integrated.profiles").update(
			"linux",
			{
				...originalProfiles,
				[PROFILE_NAME]: { path: "/bin/bash", args: ["--noprofile", "--norc"] },
			},
			vscode.ConfigurationTarget.Global,
		)

		// Activate the profile override in-process. api.setConfiguration() alone
		// does not call Terminal.setTerminalProfile(), so this dedicated method is
		// required to wire up the static in the running extension host.
		globalThis.api.setTerminalProfile(PROFILE_NAME)
	})

	suiteTeardown(async () => {
		try {
			await globalThis.api.cancelCurrentTask()
		} catch {
			// task may not be running
		}

		// Always restore — order matters: clear profile first so any subsequent
		// terminal creation uses the default, then restore VS Code settings.
		globalThis.api.setTerminalProfile(undefined)

		await vscode.workspace
			.getConfiguration("terminal.integrated.profiles")
			.update("linux", originalProfiles, vscode.ConfigurationTarget.Global)

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

		await fs.rm(path.join(testDir, OVERRIDE_FILE), { force: true })
		await fs.rm(path.join(testDir, DEFAULT_FILE), { force: true })
		await sleep(100)
	})

	teardown(async () => {
		try {
			await globalThis.api.cancelCurrentTask()
		} catch {
			// task may not be running
		}

		await sleep(100)
	})

	test("executes command through profile override without shell integration warning", async function () {
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
							alwaysAllowExecute: true,
							allowedCommands: ["*"],
							terminalShellIntegrationDisabled: false,
						},
						text: "TERMINAL_PROFILE_E2E_OVERRIDE",
					}),
				timeout: 90_000,
			})

			const gotWarning = messages.some((m) => m.type === "say" && m.say === "shell_integration_warning")
			const gotError = messages.some((m) => m.type === "say" && m.say === "error")

			assert.strictEqual(gotWarning, false, "Shell integration warning should not fire with a valid profile")
			assert.strictEqual(
				gotError,
				false,
				`Unexpected error: ${messages.find((m) => m.type === "say" && m.say === "error")?.text}`,
			)

			const content = await fs.readFile(path.join(testDir, OVERRIDE_FILE), "utf-8")
			assert.ok(content.includes("zoo-profile-override-ok"), `Output file should contain marker, got: ${content}`)

			assert.ok(vscode.window.terminals.length >= 1, "At least one VS Code terminal should exist")
			const profileTerminal = vscode.window.terminals.find((terminal) => {
				const options = terminal.creationOptions as vscode.TerminalOptions
				return (
					options.name === "Zoo Code" &&
					options.shellPath === "/bin/bash" &&
					Array.isArray(options.shellArgs) &&
					options.shellArgs.includes("--noprofile") &&
					options.shellArgs.includes("--norc")
				)
			})
			assert.ok(profileTerminal, "Expected a Zoo Code terminal created with the configured Bash profile")
		} finally {
			api.off(RooCodeEventName.Message, messageHandler)
		}
	})

	test("starts a fresh terminal after clearing the profile override", async function () {
		const api = globalThis.api
		const messages: ClineMessage[] = []

		const messageHandler = ({ message }: { message: ClineMessage }) => {
			messages.push(message)
		}
		api.on(RooCodeEventName.Message, messageHandler)

		try {
			// Clear the override — this also calls TerminalRegistry.closeIdleTerminals()
			// so the terminal from test 1 is disposed before this task runs.
			api.setTerminalProfile(undefined)
			await sleep(200) // let VS Code process the disposal before the next task

			await waitUntilCompleted({
				api,
				start: () =>
					api.startNewTask({
						configuration: {
							mode: "code",
							autoApprovalEnabled: true,
							alwaysAllowExecute: true,
							allowedCommands: ["*"],
							terminalShellIntegrationDisabled: false,
						},
						text: "TERMINAL_PROFILE_E2E_DEFAULT",
					}),
				timeout: 90_000,
			})

			const gotWarning = messages.some((m) => m.type === "say" && m.say === "shell_integration_warning")
			const gotError = messages.some((m) => m.type === "say" && m.say === "error")

			assert.strictEqual(gotWarning, false, "Shell integration warning should not fire with the default profile")
			assert.strictEqual(
				gotError,
				false,
				`Unexpected error: ${messages.find((m) => m.type === "say" && m.say === "error")?.text}`,
			)

			const content = await fs.readFile(path.join(testDir, DEFAULT_FILE), "utf-8")
			assert.ok(content.includes("zoo-profile-default-ok"), `Output file should contain marker, got: ${content}`)
		} finally {
			api.off(RooCodeEventName.Message, messageHandler)
		}
	})
})
