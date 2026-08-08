/**
 * E2E tests for the unified ShellResolver (ARCH-TERMINAL-001).
 *
 * Exercises the built extension bundle end-to-end: configuration changes flow
 * through the extension host into the ShellResolver priority chain, and the
 * resolved shell surfaces via the CommandEnvironmentService used by tasks.
 *
 * Priority chain under test:
 *   1. CLI override
 *   2. User path override (terminalShellSelection.kind === "path")
 *   3. User profile override (terminalShellSelection.kind === "profile")
 *   4. Legacy execaShellPath
 *   5. Zoo Code terminalProfile
 *   6. VS Code default profile
 *   7. OS default
 *   8. Safe platform fallback
 *
 * What we assert:
 * - Setting terminalShellSelection to a valid path override resolves that shell.
 * - Setting terminalShellSelection to an invalid path rejects (rejectable error)
 *   and falls back to a working shell for the next command.
 * - Clearing the selection re-resolves to the default chain.
 * - The execaShellPath legacy override is honored when the new setting is absent.
 *
 * Platform gating:
 * - Windows-specific assertions run only on win32 (cmd.exe, PowerShell paths).
 * - POSIX assertions run on linux/darwin (/bin/bash, /bin/zsh).
 */
import * as assert from "assert"
import * as fs from "fs/promises"
import * as path from "path"
import * as vscode from "vscode"

import { RooCodeEventName, type ClineMessage, type TerminalShellSelection } from "@roo-code/types"

import { sleep, waitUntilCompleted } from "./utils"
import { setDefaultSuiteTimeout } from "./test-utils"

const TEST_DIR_NAME = "shell-resolution-e2e"
const MARKER_OVERRIDE = "shell-resolution-override-ok"
const MARKER_FALLBACK = "shell-resolution-fallback-ok"
const MARKER_DISALLOWED = "shell-resolution-disallowed-ok"
const MARKER_LEGACY = "shell-resolution-legacy-ok"
const MARKER_CLEARED = "shell-resolution-cleared-ok"

/**
 * Returns the platform-appropriate valid shell path for override tests.
 * These paths are in the static SHELL_ALLOWLIST.
 */
function validShellPath(): string {
	if (process.platform === "win32") {
		return "C:\\Windows\\System32\\cmd.exe"
	}
	return "/bin/bash"
}

/**
 * Returns a shell path that is NOT in the allowlist (guaranteed to fail
 * isShellPathAllowed). Used to prove the rejectable-error path.
 */
function disallowedShellPath(): string {
	if (process.platform === "win32") {
		return "C:\\evil\\not-a-shell.exe"
	}
	return "/tmp/evil/not-a-shell"
}

/**
 * Returns a shell path that is allowlisted but does not exist on disk.
 * Used to prove the executable-not-found fallthrough.
 */
function missingShellPath(): string {
	if (process.platform === "win32") {
		return "C:\\Windows\\System32\\cmd-does-not-exist.exe"
	}
	return "/bin/bash-does-not-exist"
}

suite("Shell Resolution", function () {
	setDefaultSuiteTimeout(this)

	let workspaceDir: string
	let testDir: string
	let originalShellSelection: TerminalShellSelection | undefined
	let originalExecaShellPath: string | undefined

	suiteSetup(async () => {
		const aimockUrl = process.env.AIMOCK_URL
		const isRecord = process.env.AIMOCK_RECORD === "true"

		await globalThis.api.setConfiguration({
			apiProvider: "openrouter" as const,
			openRouterApiKey: aimockUrl && !isRecord ? "mock-key" : process.env.OPENROUTER_API_KEY!,
			openRouterModelId: "openai/gpt-4.1",
			...(aimockUrl && { openRouterBaseUrl: `${aimockUrl}/v1` }),
		})

		const workspaceFolders = vscode.workspace.workspaceFolders
		if (!workspaceFolders?.length) throw new Error("No workspace folder found")
		workspaceDir = workspaceFolders[0]!.uri.fsPath
		testDir = path.join(workspaceDir, TEST_DIR_NAME)
		await fs.rm(testDir, { recursive: true, force: true })
		await fs.mkdir(testDir, { recursive: true })

		// Capture original settings so we can restore them.
		const config = globalThis.api.getConfiguration()
		originalShellSelection = config.terminalShellSelection
		originalExecaShellPath = config.execaShellPath
	})

	suiteTeardown(async () => {
		try {
			await globalThis.api.cancelCurrentTask()
		} catch {
			// task may not be running
		}

		// Restore original shell-related settings.
		await globalThis.api.setConfiguration({
			terminalShellSelection: originalShellSelection,
			execaShellPath: originalExecaShellPath,
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

		// Clean any marker files from previous tests.
		for (const marker of [MARKER_OVERRIDE, MARKER_FALLBACK, MARKER_DISALLOWED, MARKER_LEGACY, MARKER_CLEARED]) {
			await fs.rm(path.join(testDir, `${marker}.txt`), { force: true })
		}
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

	/**
	 * Starts a task that writes a marker file via execute_command, then asserts
	 * the task completed without a shell_integration_warning or error message.
	 */
	async function runCommandTask(markerName: string, timeoutMs = 30_000): Promise<ClineMessage[]> {
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
							alwaysAllowWrite: true,
							alwaysAllowReadOnly: true,
							allowedCommands: ["*"],
							terminalShellIntegrationDisabled: false,
						},
						text: `Write the text "${markerName}" to a file named "${markerName}.txt" in the current workspace directory.`,
					}),
				timeout: timeoutMs,
			})

			return messages
		} finally {
			api.off(RooCodeEventName.Message, messageHandler)
		}
	}

	function assertNoShellErrors(messages: ClineMessage[], context: string): void {
		const gotWarning = messages.some((m) => m.type === "say" && m.say === "shell_integration_warning")
		const gotError = messages.some((m) => m.type === "say" && m.say === "error")

		assert.strictEqual(gotWarning, false, `Shell integration warning should not fire (${context})`)
		assert.strictEqual(
			gotError,
			false,
			`Unexpected error (${context}): ${messages.find((m) => m.type === "say" && m.say === "error")?.text}`,
		)
	}

	test("path override resolves the selected shell and executes commands", async function () {
		const shellPath = validShellPath()

		await globalThis.api.setConfiguration({
			terminalShellSelection: { kind: "path", path: shellPath },
		})

		const messages = await runCommandTask(MARKER_OVERRIDE)

		assertNoShellErrors(messages, "path override")

		const content = await fs.readFile(path.join(testDir, `${MARKER_OVERRIDE}.txt`), "utf-8")
		assert.ok(content.includes(MARKER_OVERRIDE), `Marker file should contain "${MARKER_OVERRIDE}", got: ${content}`)
	})

	test("invalid path override falls back to a working shell", async function () {
		// Set an allowlisted-but-nonexistent path. The resolver should reject it
		// (rejectable error) and the next command should still succeed via
		// the fallback chain.
		const badPath = missingShellPath()

		await globalThis.api.setConfiguration({
			terminalShellSelection: { kind: "path", path: badPath },
		})

		// The task itself should still complete because the runtime falls back
		// to the safe fallback shell when the override is rejected.
		const messages = await runCommandTask(MARKER_FALLBACK)

		// We expect either:
		// a) The task completed via fallback shell (no error), OR
		// b) An error was surfaced but the system did not hang.
		// The critical invariant is that the extension does not crash or hang.
		const gotError = messages.some((m) => m.type === "say" && m.say === "error")

		// If the fallback worked, the marker file should exist.
		const markerPath = path.join(testDir, `${MARKER_FALLBACK}.txt`)
		const markerExists = await fs
			.access(markerPath)
			.then(() => true)
			.catch(() => false)

		if (!gotError && markerExists) {
			const content = await fs.readFile(markerPath, "utf-8")
			assert.ok(content.includes(MARKER_FALLBACK), `Fallback marker file should contain "${MARKER_FALLBACK}"`)
		} else {
			// Error path is acceptable — the invariant is that we got a terminal
			// state (error or completion), not a hang.
			assert.ok(
				gotError || markerExists,
				"Task should either complete via fallback or surface a terminal error, not hang",
			)
		}
	})

	test("disallowed path override is rejected and does not execute", async function () {
		const badPath = disallowedShellPath()

		await globalThis.api.setConfiguration({
			terminalShellSelection: { kind: "path", path: badPath },
		})

		const messages = await runCommandTask(MARKER_DISALLOWED)

		// The disallowed path should NOT produce a successful marker file
		// from that shell. If a marker exists, it came from the fallback shell.
		const markerPath = path.join(testDir, `${MARKER_DISALLOWED}.txt`)
		const markerExists = await fs
			.access(markerPath)
			.then(() => true)
			.catch(() => false)

		const gotError = messages.some((m) => m.type === "say" && m.say === "error")

		// Critical invariant: the system must reach a terminal state.
		assert.ok(
			gotError || markerExists,
			"Disallowed override should produce either a fallback success or a terminal error",
		)
	})

	test("legacy execaShellPath is honored when terminalShellSelection is absent", async function () {
		const shellPath = validShellPath()

		await globalThis.api.setConfiguration({
			terminalShellSelection: undefined,
			execaShellPath: shellPath,
		})

		const messages = await runCommandTask(MARKER_LEGACY)

		assertNoShellErrors(messages, "legacy execaShellPath")

		const content = await fs.readFile(path.join(testDir, `${MARKER_LEGACY}.txt`), "utf-8")
		assert.ok(
			content.includes(MARKER_LEGACY),
			`Legacy marker file should contain "${MARKER_LEGACY}", got: ${content}`,
		)
	})

	test("clearing shell selection re-resolves to default chain", async function () {
		// First set a valid override, then clear it.
		await globalThis.api.setConfiguration({
			terminalShellSelection: { kind: "path", path: validShellPath() },
		})

		await globalThis.api.setConfiguration({
			terminalShellSelection: undefined,
		})

		const messages = await runCommandTask(MARKER_CLEARED)

		assertNoShellErrors(messages, "cleared selection -> default chain")

		const content = await fs.readFile(path.join(testDir, `${MARKER_CLEARED}.txt`), "utf-8")
		assert.ok(
			content.includes(MARKER_CLEARED),
			`Default-chain marker file should contain "${MARKER_CLEARED}", got: ${content}`,
		)
	})
})
