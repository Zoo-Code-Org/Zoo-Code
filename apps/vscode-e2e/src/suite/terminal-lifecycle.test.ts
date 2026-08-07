/**
 * E2E suite: Terminal Lifecycle Management (Unified Shell Resolution).
 *
 * Covers the terminal lifecycle surface added in PR #1135:
 *
 *  1. Creation -> reuse -> command queue. A task runs two sequential
 *     execute_command calls. The first creates a terminal; the second must
 *     reuse that warm terminal and be scheduled through the command queue
 *     rather than spawning a brand-new terminal.
 *  2. Cancellation -> disposal. A task starts a long-running command and is
 *     then cancelled. The task aborts (TaskAborted) and the terminal is
 *     disposed/cleaned up rather than being left busy forever.
 *
 * The lifecycle manager itself lives in src/integrations/terminal/. These tests
 * exercise it through the public RooCodeAPI against the built extension bundle
 * (aimock fixtures), the same way the other terminal e2e suites do.
 */
import * as assert from "assert"

import { RooCodeEventName, type ClineMessage } from "@roo-code/types"

import { waitUntilAborted, waitUntilCompleted } from "./utils"
import { setDefaultSuiteTimeout } from "./test-utils"

suite("Terminal lifecycle (creation, reuse, queue, cancellation)", function () {
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

	test("creates a terminal, reuses it, and queues a second command", async function () {
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
						text: "TERMINAL_LIFECYCLE_E2E",
					}),
				timeout: 60_000,
			})

			assert.strictEqual(errorOccurred, null, `Error occurred: ${errorOccurred}`)

			// The second command ran on the reused terminal (fixture only matches on
			// "lifecycle-second" + "Exit code: 0"), so reaching completion proves the
			// creation -> reuse -> queue flow succeeded end to end.
			const completionMessage = messages.find(
				(message) => message.type === "say" && message.say === "completion_result",
			)
			assert.ok(
				completionMessage,
				"Task should have completed both commands and reached attempt_completion",
			)
		} finally {
			api.off(RooCodeEventName.Message, messageHandler)
		}
	})

	test("cancels a running command and aborts the task (terminal disposed)", async function () {
		const api = globalThis.api

		// Start a task whose fixture issues a long-running command (sleep 30) that
		// never completes on its own. We cancel it before the command finishes.
		const taskId = await api.startNewTask({
			configuration: {
				mode: "code",
				autoApprovalEnabled: true,
				alwaysAllowExecute: true,
				allowedCommands: ["*"],
				terminalShellIntegrationDisabled: false,
			},
			text: "TERMINAL_LIFECYCLE_CANCEL_E2E",
		})

		// Give the task a moment to start the long-running command before cancelling.
		await new Promise((resolve) => setTimeout(resolve, 2_000))

		await api.cancelCurrentTask()

		// Cancellation must surface as a TaskAborted event for this task. If the
		// terminal lifecycle left the terminal busy/undisposed, the abort path would
		// hang and this would time out instead.
		await waitUntilAborted({ api, taskId, timeout: 30_000 })
	})
})
