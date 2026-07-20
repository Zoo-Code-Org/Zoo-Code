import { LLMock } from "@copilotkit/aimock"

import { toolResultContains } from "./tool-result"

export function addLongRuningSilentCommandFixtures(mock: InstanceType<typeof LLMock>) {
	// `sleep 5` produces no output and completes normally via onDidEndTerminalShellExecution.
	// The idle timeout must NOT fire here — it must only fire on zero-chunk commands where
	// the stream stays open AND the event is delayed (the { ... }-wrapped multiline bug).
	// For `sleep 5`, the stream stays open (so the idle timer is never active after the
	// first chunk — but actually sleep 5 may produce no chunks either). The distinction
	// is that `sleep 5` DOES receive onDidEndTerminalShellExecution promptly after exit,
	// which breaks the loop via DONE_SENTINEL before the 3s idle timer fires.
	mock.addFixture({
		match: {
			predicate: (req) =>
				toolResultContains(req, "call_long_running_silent_001", [
					// sleep exits with code 0 — the normal exit status path
					"Exit code: 0",
				]),
		},
		response: {
			toolCalls: [
				{
					name: "attempt_completion",
					arguments: JSON.stringify({ result: "The sleep command completed successfully." }),
					id: "call_long_running_silent_002",
				},
			],
		},
	})
}
