import type { Anthropic } from "@anthropic-ai/sdk"
import type { Content, GenerateContentParameters } from "@google/genai"
import { providerIdentifiers } from "@roo-code/types/provider-identifiers"

import { GeminiHandler } from "../gemini"
import { VertexHandler } from "../vertex"
import { convertAnthropicMessageToGemini } from "../../transform/gemini-format"
import { asyncStreamFrom, collectStream } from "../../../test-utils/stream"
import { makeCreateMessageMetadata } from "../../../test-utils/api"

vi.mock("@roo-code/telemetry", () => ({
	TelemetryService: { instance: { captureException: vi.fn() } },
}))

const turns: Anthropic.Messages.MessageParam[] = [
	{ role: "user", content: "Start the task" },
	{ role: "assistant", content: "I will read the file" },
	{ role: "assistant", content: [{ type: "tool_use", id: "call-1", name: "read_file", input: {} }] },
	{ role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: "file contents" }] },
]

function histories(): Anthropic.Messages.MessageParam[][] {
	const result: Anthropic.Messages.MessageParam[][] = [[turns[0]]]
	let level = result.slice()
	for (let length = 2; length <= 3; length++) {
		level = level.flatMap((history) => turns.map((turn) => [...history, turn]))
		result.push(...level)
	}
	return result.filter((history) =>
		history.every((turn, index) => {
			if (turn === turns[3]) return history[index - 1] === turns[2]
			if (history[index - 1] === turns[2]) return turn === turns[3]
			return true
		}),
	)
}

// This property uses the same finite turn domain as GeminiRequestTail.tla.
describe.each([providerIdentifiers.gemini, providerIdentifiers.vertex] as const)("%s request tail", (provider) => {
	it.each(histories().map((history, index) => ({ history, index })))(
		"preserves history and ends with a user turn for history $index",
		async ({ history }) => {
			const options = { apiModelId: "gemini-3.7-flash", geminiApiKey: "test-key" }
			const handler =
				provider === providerIdentifiers.vertex ? new VertexHandler(options) : new GeminiHandler(options)
			const generate = vi
				.spyOn(handler["client"].models, "generateContentStream")
				.mockResolvedValue(asyncStreamFrom([]))
			const original = structuredClone(history)
			await collectStream(handler.createMessage("System", history, makeCreateMessageMetadata()))

			const request: GenerateContentParameters = generate.mock.calls[0][0]
			const toolIdToName = new Map([["call-1", "read_file"]])
			const converted = history.flatMap((message) =>
				convertAnthropicMessageToGemini(message, { includeThoughtSignatures: true, toolIdToName }),
			)
			const expected: Content[] =
				converted.at(-1)?.role === "model"
					? [...converted, { role: "user", parts: [{ text: "Please continue." }] }]
					: converted
			expect(request.contents).toEqual(expected)
			expect(expected.at(-1)?.role).toBe("user")
			expect(history).toEqual(original)
		},
	)
})
