import { LLMock } from "@copilotkit/aimock"

import { toolResultContains } from "./tool-result"

type ExecuteCommandToolCall = {
	name: "execute_command" | "attempt_completion"
	params: Record<string, unknown>
	id: string
}

type ExecuteCommandFixture = {
	toolCallId: string
	expected: string[]
	toolCalls: ExecuteCommandToolCall[]
}

export function addExecuteCommandResultFixtures(mock: InstanceType<typeof LLMock>) {
	const fixtures: ExecuteCommandFixture[] = [
		{
			toolCallId: "call_execute_command_simple_001",
			expected: ["Command executed in terminal within working directory '", "Exit code: 0\nOutput:\n"],
			toolCalls: [
				{
					name: "attempt_completion",
					params: {
						result: "Ran the echo command and created `execute-command-tool-fixture/simple-echo.txt`.",
					},
					id: "call_execute_command_simple_002",
				},
			],
		},
		{
			toolCallId: "call_execute_command_cwd_001",
			expected: ["execute-command-tool-fixture/custom-cwd'. Exit code: 0", "Output:\n"],
			toolCalls: [
				{
					name: "attempt_completion",
					params: {
						result: "Ran the command inside `execute-command-tool-fixture/custom-cwd` and created `output.txt`.",
					},
					id: "call_execute_command_cwd_002",
				},
			],
		},
		{
			toolCallId: "call_execute_command_multi_001",
			expected: ["Command executed in terminal within working directory '", "Exit code: 0\nOutput:\n"],
			toolCalls: [
				{
					name: "execute_command",
					params: {
						command: "printf 'Line 2\\n' >> execute-command-tool-fixture/multi-command.txt",
					},
					id: "call_execute_command_multi_002",
				},
			],
		},
		{
			toolCallId: "call_execute_command_multi_002",
			expected: ["Command executed in terminal within working directory '", "Exit code: 0\nOutput:\n"],
			toolCalls: [
				{
					name: "attempt_completion",
					params: {
						result: "Ran both commands and populated `execute-command-tool-fixture/multi-command.txt` with two lines.",
					},
					id: "call_execute_command_multi_003",
				},
			],
		},
		{
			toolCallId: "call_execute_command_long_running_001",
			expected: ["Exit code: 0", "Command completed after delay"],
			toolCalls: [
				{
					name: "attempt_completion",
					params: {
						result: "The delayed command completed and printed `Command completed after delay`.",
					},
					id: "call_execute_command_long_running_002",
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
