import { LLMock } from "@copilotkit/aimock"

import { toolResultContains } from "./tool-result"

export function addZeroChunkShellRaceResultFixtures(mock: InstanceType<typeof LLMock>) {
	mock.addFixture({
		match: {
			// The multiline command is now written to a temp script file and executed
			// via `sh /tmp/roo-cmd-*.sh` to avoid the VSCode { ... }-wrapping bug that
			// caused the stream to be closed before read() arrived (zero chunks).
			// The real output ('boom' on stderr) and exit code (1) now reach the model.
			predicate: (req) => toolResultContains(req, "call_zero_chunk_shell_race_001", ["boom", "Exit code: 1"]),
		},
		response: {
			toolCalls: [
				{
					name: "attempt_completion",
					arguments: JSON.stringify({ result: "The script ran and printed 'boom' to stderr." }),
					id: "call_zero_chunk_shell_race_002",
				},
			],
		},
	})
}
