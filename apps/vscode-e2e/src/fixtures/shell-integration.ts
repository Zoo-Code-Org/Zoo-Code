import { LLMock } from "@copilotkit/aimock"

import { toolResultContains } from "./tool-result"

type ShellIntegrationToolCall = {
	name: "execute_command" | "attempt_completion"
	params: Record<string, unknown>
	id: string
}

type ShellIntegrationFixture = {
	toolCallId: string
	expected: string[]
	toolCalls: ShellIntegrationToolCall[]
}

export function addShellIntegrationResultFixtures(mock: InstanceType<typeof LLMock>) {
	const fixtures: ShellIntegrationFixture[] = [
		{
			toolCallId: "call_shell_integration_path_001",
			expected: ["Exit code: 0"],
			toolCalls: [
				{
					name: "attempt_completion",
					params: { result: "Ran the command using the unified shell path override." },
					id: "call_shell_integration_path_002",
				},
			],
		},
		{
			toolCallId: "call_shell_integration_auto_001",
			expected: ["Exit code: 0"],
			toolCalls: [
				{
					name: "attempt_completion",
					params: { result: "Ran the command using the auto-resolved shell." },
					id: "call_shell_integration_auto_002",
				},
			],
		},
	]

	for (const fixture of fixtures) {
		mock.addFixture({
			match: {
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
