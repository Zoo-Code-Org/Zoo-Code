import { LLMock } from "@copilotkit/aimock"
import type { ChatCompletionRequest } from "@copilotkit/aimock"

export const QUEUED_API_INPUT_PROMPT = "QUEUED_API_INPUT_APPROVAL: Run the marker command."
export const QUEUED_API_INPUT_MARKER_FILE = "queued-api-input-marker.txt"
export const QUEUED_API_INPUT_MESSAGE = "Steering note from the API."
export const QUEUED_API_INPUT_RESPONSE_LATENCY_MS = 2_000

const COMMAND_CALL_ID = "call_queued_api_input_command_001"

export function addQueuedApiInputFixtures(mock: InstanceType<typeof LLMock>) {
	mock.addFixture({
		match: {
			predicate: (req: ChatCompletionRequest) => {
				const messages = Array.isArray(req?.messages) ? req.messages : []
				const lastUser = messages.filter((m) => m?.role === "user").at(-1)
				return JSON.stringify(lastUser?.content ?? "").includes(QUEUED_API_INPUT_PROMPT)
			},
		},
		streamingProfile: { ttft: QUEUED_API_INPUT_RESPONSE_LATENCY_MS },
		response: {
			toolCalls: [
				{
					name: "execute_command",
					arguments: JSON.stringify({ command: `touch ${QUEUED_API_INPUT_MARKER_FILE}` }),
					id: COMMAND_CALL_ID,
				},
			],
		},
	})

	mock.addFixture({
		match: {
			predicate: (req: ChatCompletionRequest) => {
				const messages = Array.isArray(req?.messages) ? req.messages : []
				return messages.filter((m) => m?.role === "tool").at(-1)?.tool_call_id === COMMAND_CALL_ID
			},
		},
		response: {
			toolCalls: [
				{
					name: "attempt_completion",
					arguments: JSON.stringify({ result: "Ran the marker command." }),
					id: "call_queued_api_input_completion_002",
				},
			],
		},
	})
}
