import type { ChatCompletionRequest, ChatMessage } from "@copilotkit/aimock"

import { LLMock } from "@copilotkit/aimock"

function anyToolResultContains(req: ChatCompletionRequest, ...terms: string[]): boolean {
	const messages: ChatMessage[] = Array.isArray(req?.messages) ? req.messages : []
	return messages.some(
		(msg) =>
			msg?.role === "tool" &&
			typeof msg.content === "string" &&
			terms.every((t) => (msg.content as string).includes(t)),
	)
}

export function addColdShellInitFixtures(mock: InstanceType<typeof LLMock>) {
	// On cold zsh terminals the first execution may produce 0 chunks (VSCode
	// execution.read() limitation on basic shell integration — see issue #242897).
	// When the first result is empty, the mock retries the same command so the
	// second attempt (on the now-warm terminal) captures real output.
	mock.addFixture({
		match: {
			// Only retry when the FIRST call (call_cold_shell_init_001) produced an empty result.
			// If the retry call (call_cold_shell_init_003) also came back empty, don't loop —
			// the tool result message says "Do not run the command again automatically."
			predicate: (req: ChatCompletionRequest) => {
				const messages: ChatMessage[] = Array.isArray(req?.messages) ? req.messages : []
				const lastToolMsg = messages.filter((m) => m?.role === "tool").at(-1)
				return (
					lastToolMsg?.tool_call_id === "call_cold_shell_init_001" &&
					!anyToolResultContains(req, "cold-init-ok")
				)
			},
		},
		response: {
			toolCalls: [
				{
					name: "execute_command",
					arguments: JSON.stringify({
						command: "python3 -c \"\nimport sys\nprint('cold-init-ok', file=sys.stdout)\nsys.exit(0)\n\"",
					}),
					id: "call_cold_shell_init_003",
				},
			],
		},
	})

	// Match whichever attempt (first or retry) delivers real output — prove
	// the guard kept the process alive long enough for the output to arrive.
	mock.addFixture({
		match: {
			predicate: (req: ChatCompletionRequest) => anyToolResultContains(req, "cold-init-ok", "Exit code: 0"),
		},
		response: {
			toolCalls: [
				{
					name: "attempt_completion",
					arguments: JSON.stringify({ result: "Cold shell init command completed with real output." }),
					id: "call_cold_shell_init_002",
				},
			],
		},
	})
}
