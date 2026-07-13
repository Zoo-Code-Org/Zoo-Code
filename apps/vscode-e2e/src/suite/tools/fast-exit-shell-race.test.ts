/**
 * Regression test for a real VS Code shell-integration race: a fast-exiting,
 * multi-line command (wrapped by prepareCommandForShellIntegration into a single
 * `{ ... }` shell execution) can complete in the terminal while VS Code never
 * delivers the completion signal -- onDidEndTerminalShellExecution never fires and
 * the shellIntegration.executeCommand().read() stream never closes on its own, even
 * though the ]633;D marker text IS written into the stream.
 *
 * TerminalProcess.run() recovers by detecting the D marker itself directly in the
 * accumulated stream data (independent of the stream/event ever formally confirming
 * completion), then waiting only a brief grace period for the real
 * onDidEndTerminalShellExecution/exit-code event before proceeding without one.
 *
 * This is deliberately narrow: it only self-finalizes on positive proof (the marker
 * text itself), never on a guessed "gone quiet, must be done" timeout -- a genuinely
 * long-running, silent command (a cold `tsc --noEmit`, a build, etc.) is
 * indistinguishable from lost-signal by elapsed time alone, so no such guess is made.
 * If the marker itself is ever lost too, this still hangs, bounded only by the user's
 * own commandExecutionTimeout / the model's agentTimeout at the tool layer.
 *
 * See: https://github.com/microsoft/vscode/issues/316556
 *      https://github.com/microsoft/vscode/issues/250764
 *      https://github.com/microsoft/vscode/issues/254724
 *
 * This exercises the real VS Code integrated terminal (terminalShellIntegrationDisabled:
 * false), not the Execa fallback, since the race lives specifically in VS Code's
 * shell-integration event/stream plumbing.
 */
import * as assert from "assert"

import { RooCodeEventName, type ClineMessage } from "@roo-code/types"

import { waitUntilCompleted } from "../utils"
import { setDefaultSuiteTimeout } from "../test-utils"

suite("Fast-exit shell integration race", function () {
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

	test("completes a fast-exiting multi-line command via the real VS Code terminal", async function () {
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
			// Bounded well under the un-fixed hang (which stalls for the full 60s test
			// timeout with zero output). TerminalProcess.run() detects the D marker itself
			// and only waits a brief grace period (~1s) for the real exit code afterward, so
			// a healthy run finishes in well under 30s; a regression back to the old hang
			// will blow this timeout.
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
						text: "FAST_EXIT_SHELL_RACE_E2E",
					}),
				timeout: 60_000,
			})

			const elapsedMs = Date.now() - startedAt

			assert.strictEqual(errorOccurred, null, `Error occurred: ${errorOccurred}`)

			// The mock's fixture (see fast-exit-shell-race.ts) only responds with
			// attempt_completion once its predicate has already verified the tool result
			// contains the actual 'boom' stderr output AND the specific unknown-exit-status
			// wording -- so reaching completion_result at all is itself proof that content
			// survived the lost completion signal.
			const completionMessage = messages.find(
				(message) => message.type === "say" && message.say === "completion_result",
			)
			assert.ok(
				completionMessage,
				`Task should have reached attempt_completion instead of hanging on the command (elapsed: ${elapsedMs}ms)`,
			)
		} finally {
			api.off(RooCodeEventName.Message, messageHandler)
		}
	})
})
