import { LLMock, type ChatCompletionRequest } from "@copilotkit/aimock"

function requestContains(req: ChatCompletionRequest, ...expected: string[]) {
	const serialized = JSON.stringify(req.messages)
	return expected.every((value) => serialized.includes(value))
}

export function addHookFixtures(mock: InstanceType<typeof LLMock>) {
	mock.addFixture({
		match: {
			predicate: (req) =>
				requestContains(
					req,
					"HOOKS_SESSION_START_E2E",
					'<hook_result id=\\"e2e-session-start\\" phase=\\"sessionStart\\" status=\\"succeeded\\">',
					"HOOK_SESSION_CONTEXT_MARKER",
				),
		},
		response: {
			toolCalls: [
				{
					name: "attempt_completion",
					arguments: JSON.stringify({ result: "The deterministic session hook context reached the model." }),
					id: "call_hooks_session_done_001",
				},
			],
		},
	})

	mock.addFixture({
		match: {
			predicate: (req) => requestContains(req, "HOOKS_PRE_TOOL_BLOCK_E2E", "Pre-tool hook", "blocked read_file"),
		},
		response: {
			toolCalls: [
				{
					name: "attempt_completion",
					arguments: JSON.stringify({ result: "The deterministic pre-tool hook blocked read_file." }),
					id: "call_hooks_block_done_002",
				},
			],
		},
	})
}
