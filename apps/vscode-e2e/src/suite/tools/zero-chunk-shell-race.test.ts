/**
 * Regression test for the zero-chunk VSCode shell-integration bug: a multiline
 * command wrapped into `{ ... }` by prepareCommandForShellIntegration causes
 * VSCode to suppress BOTH the stream data AND onDidEndTerminalShellExecution.
 * The for-await loop exits immediately with chunkCount === 0, then the original
 * code hung forever at `await shellExecutionComplete`.
 *
 * Fix: multiline commands are written to a temp script file and executed via
 * `sh /tmp/roo-cmd-*.sh` instead of being wrapped in `{ ... }`. This avoids
 * VSCode's multiline compound-command code path that closes the stream before
 * read() is called. The real output and exit code now reach the model.
 *
 * This is distinct from the fast-exit-shell-race test, which covers the case
 * where VSCode DOES emit stream data including the D marker but never fires
 * onDidEndTerminalShellExecution. Here, without the fix, not even stream data arrives.
 *
 * See: https://github.com/Zoo-Code-Org/Zoo-Code/issues/800
 */
import * as assert from "assert"

import { RooCodeEventName, type ClineMessage } from "@roo-code/types"

import { waitUntilCompleted } from "../utils"
import { setDefaultSuiteTimeout } from "../test-utils"

suite("Zero-chunk shell integration race", function () {
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

	test("completes a zero-chunk multiline command via the real VS Code terminal", async function () {
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
			// The grace timer fires after 1s; the whole run should complete well under
			// 30s. A regression back to the old hang blows the suite timeout (20m) or
			// this explicit timeout, whichever comes first.
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
						text: "ZERO_CHUNK_SHELL_RACE_E2E",
					}),
				timeout: 60_000,
			})

			const elapsedMs = Date.now() - startedAt

			assert.strictEqual(errorOccurred, null, `Error occurred: ${errorOccurred}`)

			// The mock fixture only responds with attempt_completion once its predicate
			// confirms the tool result contains 'boom' and 'Exit code: 1' — proof that
			// the temp-script fix caused the stream to deliver real output.
			const completionMessage = messages.find(
				(message) => message.type === "say" && message.say === "completion_result",
			)
			assert.ok(
				completionMessage,
				`Task should have reached attempt_completion with real output (elapsed: ${elapsedMs}ms). ` +
					`If this timed out, the multiline command may still be hitting the zero-chunk VSCode bug.`,
			)
		} finally {
			api.off(RooCodeEventName.Message, messageHandler)
		}
	})
})
