import type { Anthropic } from "@anthropic-ai/sdk"
import type { Content } from "@google/genai"
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

async function sendHistory(provider: string, history: Anthropic.Messages.MessageParam[]): Promise<Content[]> {
	const options = { apiModelId: "gemini-3.7-flash", geminiApiKey: "test-key" }
	const handler = provider === providerIdentifiers.vertex ? new VertexHandler(options) : new GeminiHandler(options)
	const generate = vi.spyOn(handler["client"].models, "generateContentStream").mockResolvedValue(asyncStreamFrom([]))
	await collectStream(handler.createMessage("System", history, makeCreateMessageMetadata()))

	const contents = generate.mock.calls[0][0].contents
	if (
		!Array.isArray(contents) ||
		!contents.every(
			(content): content is Content => typeof content === "object" && content !== null && "role" in content,
		)
	) {
		throw new Error("Expected a request with Gemini content objects")
	}
	return contents
}

// This property uses the same finite turn domain as GeminiRequestTail.tla.
describe.each([providerIdentifiers.gemini, providerIdentifiers.vertex] as const)("%s request tail", (provider) => {
	it.each(histories().map((history, index) => ({ history, index })))(
		"preserves history and ends with a user turn for history $index",
		async ({ history }) => {
			const original = structuredClone(history)
			const contents = await sendHistory(provider, history)
			const toolIdToName = new Map([["call-1", "read_file"]])
			const converted = history.flatMap((message) =>
				convertAnthropicMessageToGemini(message, { includeThoughtSignatures: true, toolIdToName }),
			)

			expect(contents.at(-1)?.role).toBe("user")
			expect(contents.slice(0, converted.length)).toEqual(converted)
			if (history.at(-1)?.role === "user") {
				expect(contents).toEqual(converted)
			} else {
				expect(contents).toHaveLength(converted.length + 1)
			}
			expect(history).toEqual(original)
		},
	)

	it("appends a nonempty user continuation after assistant text", async () => {
		const contents = await sendHistory(provider, [turns[0], turns[1]])

		expect(contents).toEqual([
			{ role: "user", parts: [{ text: "Start the task" }] },
			{ role: "model", parts: [{ text: "I will read the file" }] },
			{ role: "user", parts: [{ text: "Please continue." }] },
		])
	})

	it.each([
		{ tail: "user", history: [turns[0]], expectedLength: 1 },
		{ tail: "assistant", history: [turns[0], turns[1]], expectedLength: 3 },
	])("ignores trailing reasoning metadata after a $tail turn", async ({ history, expectedLength }) => {
		// Runtime history can contain provider metadata outside the Anthropic message type.
		const withReasoning = [
			...history,
			{ type: "reasoning", text: "Provider metadata" },
		] as Anthropic.Messages.MessageParam[]
		const original = structuredClone(withReasoning)
		const contents = await sendHistory(provider, withReasoning)

		expect(contents.at(-1)?.role).toBe("user")
		expect(contents).toHaveLength(expectedLength)
		expect(contents[0]).toEqual({ role: "user", parts: [{ text: "Start the task" }] })
		if (history.length === 2) {
			expect(contents[1]).toEqual({ role: "model", parts: [{ text: "I will read the file" }] })
		}
		expect(contents).not.toContainEqual(expect.objectContaining({ type: "reasoning" }))
		expect(withReasoning).toEqual(original)
	})
})
