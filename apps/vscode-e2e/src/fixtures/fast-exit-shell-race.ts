import { LLMock } from "@copilotkit/aimock"

import { toolResultContains } from "./tool-result"

export function addFastExitShellRaceResultFixtures(mock: InstanceType<typeof LLMock>) {
	mock.addFixture({
		match: {
			// VSCode drops onDidEndTerminalShellExecution for this command (the race under
			// test), so TerminalProcess.run() only has the D marker itself as proof of
			// completion, never a real exit code (see ExecuteCommandTool.ts's
			// `exitDetails === undefined` branch). Match on the actual stderr output and the
			// specific unknown-exit-status text so this fixture -- and the e2e assertions it
			// drives -- would fail if either the output capture or that fallback wording
			// regressed, instead of passing on any generic "command executed" result.
			predicate: (req) =>
				toolResultContains(req, "call_fast_exit_shell_race_001", [
					"boom",
					"<VSCE exitDetails == undefined: terminal output and command execution status is unknown.>",
				]),
		},
		response: {
			toolCalls: [
				{
					name: "attempt_completion",
					arguments: JSON.stringify({ result: "The script ran and printed 'boom' to stderr." }),
					id: "call_fast_exit_shell_race_002",
				},
			],
		},
	})
}
