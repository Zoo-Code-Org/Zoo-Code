import { LLMock } from "@copilotkit/aimock"

import { toolResultContains } from "./tool-result"

export function addNovitaFixtures(mock: InstanceType<typeof LLMock>) {
	mock.addFixture({
		match: {
			model: "moonshotai/kimi-k2.7-code",
			toolCallId: "call_novita_read",
			predicate: (req) => toolResultContains(req, "call_novita_read", ["NOVITA_E2E_MARKER"]),
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
