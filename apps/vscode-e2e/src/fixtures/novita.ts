import { LLMock, type ChatCompletionRequest } from "@copilotkit/aimock"

function hasMarkerToolResult(req: ChatCompletionRequest) {
	const messages = Array.isArray(req?.messages) ? req.messages : []

	return messages.some((message) => {
		if (message?.role !== "tool" && message?.role !== "user") {
			return false
		}

		return JSON.stringify(message.content ?? "").includes("NOVITA_E2E_MARKER")
	})
}

export function addNovitaFixtures(mock: InstanceType<typeof LLMock>) {
	mock.addFixture({
		match: {
			model: "moonshotai/kimi-k2.7-code",
			predicate: hasMarkerToolResult,
		},
		response: {
			toolCalls: [
				{
					name: "attempt_completion",
					arguments: JSON.stringify({ result: "NOVITA_E2E_MARKER" }),
					id: "call_novita_done",
				},
			],
		},
	})
}
