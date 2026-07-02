import { LLMock, type ChatCompletionRequest } from "@copilotkit/aimock"

function requestIncludes(req: ChatCompletionRequest, text: string) {
	const messages = Array.isArray(req?.messages) ? req.messages : []

	return JSON.stringify(messages).includes(text)
}

function isInitialNovitaToolProbe(req: ChatCompletionRequest) {
	return (
		requestIncludes(req, "novita-e2e:tool-use") &&
		!requestIncludes(req, "call_novita_read") &&
		!requestIncludes(req, "NOVITA_E2E_MARKER") &&
		!requestIncludes(req, "[ERROR] You did not use a tool in your previous response!")
	)
}

function hasNovitaReadFileResult(req: ChatCompletionRequest) {
	return requestIncludes(req, "call_novita_read")
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
