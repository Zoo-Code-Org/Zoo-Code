/**
 * Regression test: terminal reuse after a zero-chunk command.
 *
 * After the idle-timeout self-finalization path fires for a zero-chunk
 * { ... }-wrapped multiline command, the task issues a second execute_command
 * that reuses the same VS Code terminal. This verifies:
 *
 *  1. The stale-execution guard (ownExecution check) correctly ignores the
 *     late onDidEndTerminalShellExecution from the first command when the
 *     second command is already running on the reused terminal.
 *  2. The second command also completes (via the same idle-timeout path),
 *     confirming the terminal is in a clean state after reuse.
 *
 * See: https://github.com/Zoo-Code-Org/Zoo-Code/issues/800
 */
import * as assert from "assert"

import { RooCodeEventName, type ClineMessage } from "@roo-code/types"

import { waitUntilCompleted } from "../utils"
import { setDefaultSuiteTimeout } from "../test-utils"

suite("Terminal reuse after zero-chunk shell race", function () {
	if (process.platform !== "linux") {
		return
	}

	setDefaultSuiteTimeout(this)

	setup(async () => {
		try {
			await globalThis.api.cancelCurrentTask()
		} catch {
			// task may not be running
		}
	})

	teardown(async () => {
		try {
			await globalThis.api.cancelCurrentTask()
		} catch {
			// task may not be running
		}
	})

	test("completes two sequential zero-chunk commands on a reused terminal", async function () {
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

		const startedAt = Date.now()

		try {
			// Two commands, each with 3s idle timeout, plus overhead — 30s is comfortable.
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
						text: "TERMINAL_REUSE_SHELL_RACE_E2E",
					}),
				timeout: 60_000,
			})

			const elapsedMs = Date.now() - startedAt

			assert.strictEqual(errorOccurred, null, `Error occurred: ${errorOccurred}`)

			const completionMessage = messages.find(
				(message) => message.type === "say" && message.say === "completion_result",
			)
			assert.ok(
				completionMessage,
				`Task should have completed both commands and reached attempt_completion (elapsed: ${elapsedMs}ms)`,
			)
		} finally {
			api.off(RooCodeEventName.Message, messageHandler)
		}
	})
})
