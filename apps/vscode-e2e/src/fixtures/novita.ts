import { LLMock, type ChatCompletionRequest } from "@copilotkit/aimock"

function requestIncludes(req: ChatCompletionRequest, text: string) {
	const messages = Array.isArray(req?.messages) ? req.messages : []

	return JSON.stringify(messages).includes(text)
}

function hasToolMessage(req: ChatCompletionRequest) {
	const messages = Array.isArray(req?.messages) ? req.messages : []

	return messages.some((message) => message?.role === "tool")
}

function isInitialNovitaToolProbe(req: ChatCompletionRequest) {
	return requestIncludes(req, "novita-e2e:tool-use") && !hasToolMessage(req)
}

function hasNovitaReadFileResult(req: ChatCompletionRequest) {
	const messages = Array.isArray(req?.messages) ? req.messages : []

	return messages.some((message) => {
		return message?.role === "tool" && message.tool_call_id === "call_novita_read"
	})
}

export function addNovitaFixtures(mock: InstanceType<typeof LLMock>) {
	mock.addFixture({
		match: {
			model: "moonshotai/kimi-k2.7-code",
			predicate: hasNovitaReadFileResult,
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

	mock.addFixture({
		match: {
			model: "moonshotai/kimi-k2.7-code",
			predicate: isInitialNovitaToolProbe,
		},
		response: {
			toolCalls: [
				{
					name: "read_file",
					arguments: JSON.stringify({ path: "novita-e2e-marker.txt" }),
					id: "call_novita_read",
				},
			],
		},
	})
}
