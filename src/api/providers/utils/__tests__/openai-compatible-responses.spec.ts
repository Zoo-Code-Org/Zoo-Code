import { openAiModelInfoSaneDefaults } from "@roo-code/types"
import { buildResponsesRequest } from "../openai-compatible-responses"
import { expectNoLoneSurrogates } from "../../../../test-utils/surrogates"

type RequestInput = Parameters<typeof buildResponsesRequest>[0]

const cases = [true, false, undefined].flatMap((streaming) =>
	[undefined, 456].flatMap((maxTokens) => [true, false].map((reasoning) => ({ streaming, maxTokens, reasoning }))),
)

it.each(cases)(
	"preserves request invariants without mutating explicit inputs: %j",
	({ streaming, maxTokens, reasoning }) => {
		const input: RequestInput = {
			options: {
				openAiModelId: "deployment",
				openAiStreamingEnabled: streaming,
				includeMaxTokens: true,
				modelMaxTokens: maxTokens,
			},
			modelInfo: { ...openAiModelInfoSaneDefaults, maxTokens: 1000 },
			reasoning: reasoning ? { reasoning_effort: "high" } : undefined,
			systemPrompt: "prompt\ud800😀",
			messages: [{ role: "user", content: [{ type: "text", text: "history\udfff" }] }],
			tools: [
				{ type: "function", function: { name: "read_file", parameters: { type: "object" }, strict: false } },
			],
			extraBody: { model: "wrong", stream: !streaming, service_tier: "flex" },
		}
		const before = structuredClone(input)
		Object.freeze(input.options)
		Object.freeze(input.modelInfo)
		Object.freeze(input.messages)
		Object.freeze(input.tools)
		Object.freeze(input.extraBody)
		const body = buildResponsesRequest(input)
		expect(body).toMatchObject({
			model: "deployment",
			stream: streaming !== false,
			store: false,
			service_tier: "flex",
			max_output_tokens: maxTokens ?? 1000,
			tools: [{ type: "function", name: "read_file", strict: false }],
		})
		expect(body.reasoning?.effort).toBe(reasoning ? "high" : undefined)
		expectNoLoneSurrogates(body)
		expect(body.instructions).toContain("😀")
		expect(input).toEqual(before)
		expect(buildResponsesRequest(input)).toEqual(body)
	},
)
