import { LLMock } from "@copilotkit/aimock"

import { toolResultContains } from "./tool-result"

export function addTerminalReuseShellRaceFixtures(mock: InstanceType<typeof LLMock>) {
	// First command completes — model issues a second command on the same terminal.
	// With the temp-script fix, both commands now deliver real output.
	mock.addFixture({
		match: {
			predicate: (req) => toolResultContains(req, "call_terminal_reuse_001", ["first", "Exit code: 0"]),
		},
		response: {
			toolCalls: [
				{
					name: "execute_command",
					arguments: JSON.stringify({
						command: "python3 -c \"\nimport sys\nprint('second', file=sys.stderr)\nsys.exit(0)\n\"",
					}),
					id: "call_terminal_reuse_002",
				},
			],
		},
	})

	// Second command on the reused terminal also completes.
	mock.addFixture({
		match: {
			predicate: (req) => toolResultContains(req, "call_terminal_reuse_002", ["second", "Exit code: 0"]),
		},
		response: {
			toolCalls: [
				{
					name: "attempt_completion",
					arguments: JSON.stringify({ result: "Both commands ran on the reused terminal." }),
					id: "call_terminal_reuse_003",
				},
			],
		},
	})
}
