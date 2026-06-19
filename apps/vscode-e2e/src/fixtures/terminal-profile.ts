import { LLMock } from "@copilotkit/aimock"

import { toolResultContains } from "./tool-result"

type TerminalProfileToolCall = {
	name: "execute_command" | "attempt_completion"
	params: Record<string, unknown>
	id: string
}

type TerminalProfileFixture = {
	toolCallId: string
	expected: string[]
	toolCalls: TerminalProfileToolCall[]
}

export function addTerminalProfileResultFixtures(mock: InstanceType<typeof LLMock>) {
	const fixtures: TerminalProfileFixture[] = [
		{
			toolCallId: "call_terminal_profile_override_001",
			expected: ["Exit code: 0"],
			toolCalls: [
				{
					name: "attempt_completion",
					params: { result: "Ran the command using the Zoo E2E Bash profile override." },
					id: "call_terminal_profile_override_002",
				},
			],
		},
		{
			toolCallId: "call_terminal_profile_default_001",
			expected: ["Exit code: 0"],
			toolCalls: [
				{
					name: "attempt_completion",
					params: { result: "Ran the command using the default terminal profile." },
					id: "call_terminal_profile_default_002",
				},
			],
		},
	]

	for (const fixture of fixtures) {
		mock.addFixture({
			match: {
				toolCallId: fixture.toolCallId,
				predicate: (req) => toolResultContains(req, fixture.toolCallId, fixture.expected),
			},
			response: {
				toolCalls: fixture.toolCalls.map((toolCall) => ({
					name: toolCall.name,
					arguments: JSON.stringify(toolCall.params),
					id: toolCall.id,
				})),
			},
		})
	}
}
