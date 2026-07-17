import type { ChatCompletionRequest } from "@copilotkit/aimock"
import { LLMock } from "@copilotkit/aimock"

// Turn-2 completion fixtures for DeepSeek V4 tests.
// Uses lastToolMsg.tool_call_id to scope each fixture — aimock v1.16.4+ changed
// toolCallId matching to require the very last message to be the tool message,
// but Roo Code appends <environment_details> as a user message after tool results.
const turn2Fixtures = [
	{
		toolCallId: "call_dsv4_flash_on_read",
		model: "deepseek-v4-flash",
		result: "DEEPSEEK_V4_MARKER_deepseek_v4_flash_reasoning_on",
		doneId: "call_dsv4_flash_on_done",
	},
	{
		toolCallId: "call_dsv4_flash_off_read",
		model: "deepseek-v4-flash",
		result: "DEEPSEEK_V4_MARKER_deepseek_v4_flash_reasoning_off",
		doneId: "call_dsv4_flash_off_done",
	},
	{
		toolCallId: "call_dsv4_pro_on_read",
		model: "deepseek-v4-pro",
		result: "DEEPSEEK_V4_MARKER_deepseek_v4_pro_reasoning_on",
		doneId: "call_dsv4_pro_on_done",
	},
	{
		toolCallId: "call_dsv4_pro_off_read",
		model: "deepseek-v4-pro",
		result: "DEEPSEEK_V4_MARKER_deepseek_v4_pro_reasoning_off",
		doneId: "call_dsv4_pro_off_done",
	},
]

export function addDeepSeekV4Fixtures(mock: InstanceType<typeof LLMock>) {
	for (const fixture of turn2Fixtures) {
		mock.addFixture({
			match: {
				predicate: (req: ChatCompletionRequest) => {
					const messages = Array.isArray(req?.messages) ? req.messages : []
					const lastToolMsg = messages.filter((m) => m?.role === "tool").at(-1)
					return req?.model === fixture.model && lastToolMsg?.tool_call_id === fixture.toolCallId
				},
			},
			response: {
				toolCalls: [
					{
						name: "attempt_completion",
						arguments: JSON.stringify({ result: fixture.result }),
						id: fixture.doneId,
					},
				],
			},
		})
	}
}
