/**
 * Regression guard: the zero-chunk idle timeout must NOT fire on a legitimate
 * long-running, silent command.
 *
 * The idle timeout in TerminalProcess.run() fires when no stream data arrives
 * within 3s AND no onDidEndTerminalShellExecution event has fired. For the
 * zero-chunk bug ({ ... }-wrapped multiline commands), that event is delayed
 * 60+ seconds, so the 3s timeout is the only way to unblock.
 *
 * For a simple `sleep 5`, VSCode DOES fire onDidEndTerminalShellExecution
 * promptly after the command exits — which breaks the iterator loop via the
 * DONE_SENTINEL path before the 3s idle timer fires. The command should
 * therefore complete with a real exit code (0), not the "exitDetails == undefined"
 * sentinel that indicates the idle-timeout path was taken.
 *
 * If this test regresses (e.g. the idle timeout fires and returns exitDetails==undefined
 * instead of exit code 0), it means the fix would falsely terminate long-running
 * silent commands — the core concern raised when the original 15s idle timeout was reverted.
 *
 * See: https://github.com/Zoo-Code-Org/Zoo-Code/issues/800
 */
import * as assert from "assert"

import { RooCodeEventName, type ClineMessage } from "@roo-code/types"

import { waitUntilCompleted } from "../utils"
import { setDefaultSuiteTimeout } from "../test-utils"

suite("Long-running silent command (idle timeout must not misfire)", function () {
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

	test("completes a 5s silent command with exit code 0, not via idle timeout", async function () {
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
			// sleep 5 takes ~5s; allow plenty of headroom.
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
						text: "LONG_RUNNING_SILENT_COMMAND_E2E",
					}),
				timeout: 60_000,
			})

			const elapsedMs = Date.now() - startedAt

			assert.strictEqual(errorOccurred, null, `Error occurred: ${errorOccurred}`)

			// The mock fixture only matches "Exit code: 0" — if the idle timeout fired
			// instead we'd get "exitDetails == undefined" and the fixture wouldn't match,
			// leaving the task waiting for an API response until the test times out.
			const completionMessage = messages.find(
				(message) => message.type === "say" && message.say === "completion_result",
			)
			assert.ok(
				completionMessage,
				`Task should have completed with exit code 0 (elapsed: ${elapsedMs}ms). ` +
					`If this timed out, the idle timeout likely misfired on a legitimate quiet command.`,
			)

			// Sanity check: should take at least 4s (sleep 5), not 3s (idle timeout).
			assert.ok(
				elapsedMs >= 4_000,
				`Expected elapsed >= 4000ms to confirm sleep 5 ran to completion, got ${elapsedMs}ms. ` +
					`The idle timeout may have fired prematurely.`,
			)
		} finally {
			api.off(RooCodeEventName.Message, messageHandler)
		}
	})
})
