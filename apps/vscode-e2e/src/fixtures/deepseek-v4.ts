import type { ChatCompletionRequest } from "@copilotkit/aimock"
import { LLMock } from "@copilotkit/aimock"

// DeepSeek V4 fixtures: Turn-1 (read_file tool call) + Turn-2 (attempt_completion).
//
// The test writes a marker file to the workspace root, then asks the model to
// read it via read_file. Turn 1 must return a read_file tool call with the
// correct file path; Turn 2 must return attempt_completion with the marker text.
//
// Turn-1 matching: the request contains the probeTag (e.g.
// "deepseek-v4-e2e:deepseek-v4-flash:reasoning-on") in the user message AND
// has NO tool-result messages yet (first turn).
//
// Turn-2 matching: the request's last tool message has a tool_call_id matching
// the Turn-1 call ID. aimock v1.16.4+ changed toolCallId matching to require
// the very last message to be the tool message, but Roo Code appends
// <environment_details> as a user message after tool results, so we use a
// predicate that scans all tool messages instead of relying on the built-in
// toolCallId matcher.
const fixtures = [
	{
		model: "deepseek-v4-flash",
		probeTag: "deepseek-v4-e2e:deepseek-v4-flash:reasoning-on",
		fileName: "deepseek-v4-e2e-deepseek-v4-flash-reasoning-on.txt",
		result: "DEEPSEEK_V4_MARKER_deepseek_v4_flash_reasoning_on",
		readId: "call_dsv4_flash_on_read",
		doneId: "call_dsv4_flash_on_done",
	},
	{
		model: "deepseek-v4-flash",
		probeTag: "deepseek-v4-e2e:deepseek-v4-flash:reasoning-off",
		fileName: "deepseek-v4-e2e-deepseek-v4-flash-reasoning-off.txt",
		result: "DEEPSEEK_V4_MARKER_deepseek_v4_flash_reasoning_off",
		readId: "call_dsv4_flash_off_read",
		doneId: "call_dsv4_flash_off_done",
	},
	{
		model: "deepseek-v4-pro",
		probeTag: "deepseek-v4-e2e:deepseek-v4-pro:reasoning-on",
		fileName: "deepseek-v4-e2e-deepseek-v4-pro-reasoning-on.txt",
		result: "DEEPSEEK_V4_MARKER_deepseek_v4_pro_reasoning_on",
		readId: "call_dsv4_pro_on_read",
		doneId: "call_dsv4_pro_on_done",
	},
	{
		model: "deepseek-v4-pro",
		probeTag: "deepseek-v4-e2e:deepseek-v4-pro:reasoning-off",
		fileName: "deepseek-v4-e2e-deepseek-v4-pro-reasoning-off.txt",
		result: "DEEPSEEK_V4_MARKER_deepseek_v4_pro_reasoning_off",
		readId: "call_dsv4_pro_off_read",
		doneId: "call_dsv4_pro_off_done",
	},
]

export function addDeepSeekV4Fixtures(mock: InstanceType<typeof LLMock>) {
	for (const fixture of fixtures) {
		// Turn 1: No tool results yet. Return read_file tool call.
		mock.addFixture({
			match: {
				predicate: (req: ChatCompletionRequest) => {
					const messages = Array.isArray(req?.messages) ? req.messages : []
					const hasToolResult = messages.some((m) => m?.role === "tool")
					return req?.model === fixture.model && !hasToolResult && JSON.stringify(req).includes(fixture.probeTag)
				},
			},
			response: {
				toolCalls: [
					{
						name: "read_file",
						arguments: JSON.stringify({ path: fixture.fileName }),
						id: fixture.readId,
					},
				],
			},
		})

		// Turn 2: Tool result with our readId. Return attempt_completion with marker.
		mock.addFixture({
			match: {
				predicate: (req: ChatCompletionRequest) => {
					const messages = Array.isArray(req?.messages) ? req.messages : []
					const lastToolMsg = messages.filter((m) => m?.role === "tool").at(-1)
					return req?.model === fixture.model && lastToolMsg?.tool_call_id === fixture.readId
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
