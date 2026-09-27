/**
 * Regression guard for the idle-timeout-during-shell-initialization race:
 * on a cold terminal, onDidStartTerminalShellExecution can fire AFTER the
 * 3-second idle window. Without the guard added in TerminalProcess.run(),
 * the IDLE_SENTINEL path self-finalizes before the command starts executing,
 * silently dropping its output.
 *
 * The fix: when IDLE_SENTINEL fires but the shell_execution_started event has
 * not been received, continue waiting (re-arm the idle timer) up to
 * Shell Integration Timeout ms. Only self-finalize once the event has arrived
 * OR the full timeout is exhausted.
 *
 * NOTE on cold-zsh first-command zero-chunks: VSCode's execution.read() API
 * has known reliability issues on "basic" shell integration (documented in
 * https://github.com/microsoft/vscode/issues/242897). On a cold zsh terminal
 * the very first command may produce zero stream chunks even though the
 * command ran successfully — this is a VSCode API limitation, not a Zoo Code
 * bug. The model typically retries and captures output on the second attempt
 * (warm terminal). This test verifies the guard prevents a PREMATURE
 * self-finalize and that the model eventually receives "cold-init-ok" output
 * (either on the first or a retry attempt).
 *
 * See: https://github.com/Zoo-Code-Org/Zoo-Code/issues/800
 */
import * as assert from "assert"

import { RooCodeEventName, type ClineMessage } from "@roo-code/types"

import { waitUntilCompleted } from "../utils"
import { setDefaultSuiteTimeout } from "../test-utils"

suite("Cold shell init — idle timeout must not misfire before shell starts", function () {
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

	test("captures output from a multiline command on a fresh terminal", async function () {
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
						text: "COLD_SHELL_INIT_E2E",
					}),
				timeout: 60_000,
			})

			const elapsedMs = Date.now() - startedAt

			assert.strictEqual(errorOccurred, null, `Error occurred: ${errorOccurred}`)

			// The fixture only responds with attempt_completion once its predicate
			// confirms "cold-init-ok" and "Exit code: 0" are in the tool result.
			// If the idle timeout misfired (premature self-finalize), the output
			// would be empty/unknown and the predicate would never match.
			const completionMessage = messages.find(
				(message) => message.type === "say" && message.say === "completion_result",
			)
			assert.ok(
				completionMessage,
				`Task should have reached attempt_completion with real output (elapsed: ${elapsedMs}ms). ` +
					`If this timed out, the idle timeout may have misfired before onDidStartTerminalShellExecution fired.`,
			)
		} finally {
			api.off(RooCodeEventName.Message, messageHandler)
		}
	})
})
