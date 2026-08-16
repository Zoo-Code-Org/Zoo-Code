import { LLMock } from "@copilotkit/aimock"

import { toolResultContains } from "./tool-result"

export function addTerminalReuseShellRaceFixtures(mock: InstanceType<typeof LLMock>) {
	// First command completes — model issues a second command on the same terminal.
	mock.addFixture({
		match: {
			predicate: (req) => {
				const messages = Array.isArray(req?.messages) ? req.messages : []
				const lastToolMsg = messages.filter((message) => message?.role === "tool").at(-1)

				return (
					lastToolMsg?.tool_call_id === "call_terminal_reuse_001" &&
					toolResultContains(req, "call_terminal_reuse_001", [
						"Command was submitted in the VS Code terminal",
					])
				)
			},
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
			predicate: (req) => {
				const messages = Array.isArray(req?.messages) ? req.messages : []
				const lastToolMsg = messages.filter((message) => message?.role === "tool").at(-1)

				return (
					lastToolMsg?.tool_call_id === "call_terminal_reuse_002" &&
					toolResultContains(req, "call_terminal_reuse_002", [
						"Command was submitted in the VS Code terminal",
					])
				)
			},
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
