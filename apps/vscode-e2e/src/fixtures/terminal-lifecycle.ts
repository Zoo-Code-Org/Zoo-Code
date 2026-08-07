import { LLMock } from "@copilotkit/aimock"

import { toolResultContains } from "./tool-result"

/**
 * Terminal lifecycle fixtures.
 *
 * The first command (call_terminal_lifecycle_001, echoed "lifecycle-first")
 * completed on a fresh terminal. We respond by issuing a SECOND execute_command.
 * The terminal lifecycle manager should reuse the still-warm terminal and run the
 * second command through the command queue rather than spawning a brand-new
 * terminal. When the second command's result ("lifecycle-second") arrives we
 * finish the task.
 */
export function addTerminalLifecycleFixtures(mock: InstanceType<typeof LLMock>) {
	// First command completed -> issue a second command on the (reused) terminal.
	mock.addFixture({
		match: {
			predicate: (req) =>
				toolResultContains(req, "call_terminal_lifecycle_001", ["lifecycle-first", "Exit code: 0"]),
		},
		response: {
			toolCalls: [
				{
					name: "execute_command",
					arguments: JSON.stringify({ command: "echo lifecycle-second" }),
					id: "call_terminal_lifecycle_002",
				},
			],
		},
	})

	// Second command (run on the reused terminal) completed -> finish the task.
	mock.addFixture({
		match: {
			predicate: (req) =>
				toolResultContains(req, "call_terminal_lifecycle_002", ["lifecycle-second", "Exit code: 0"]),
		},
		response: {
			toolCalls: [
				{
					name: "attempt_completion",
					arguments: JSON.stringify({
						result: "Two commands ran through the terminal lifecycle: creation, reuse, and queueing.",
					}),
					id: "call_terminal_lifecycle_003",
				},
			],
		},
	})

	// Cancellation flow: the long-running command (call_terminal_lifecycle_cancel_001)
	// is intentionally left without a follow-up fixture. The test cancels the task
	// before the command would ever complete, exercising terminal cancellation and
	// disposal. No additional fixtures are needed here.
}
