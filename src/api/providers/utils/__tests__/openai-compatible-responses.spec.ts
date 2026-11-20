import { openAiModelInfoSaneDefaults, providerIdentifiers } from "@roo-code/types"
import { buildResponsesRequest } from "../openai-compatible-responses"
import { expectNoLoneSurrogates } from "../../../../test-utils/surrogates"
import { OPENAI_CALL_ID_MAX_LENGTH } from "../../../../utils/tool-id"

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
			reasoningScope: "test-endpoint",
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

function makeInput(overrides: Partial<RequestInput> = {}): RequestInput {
	return {
		options: { openAiModelId: "custom" },
		modelInfo: { ...openAiModelInfoSaneDefaults, maxTokens: 1000 },
		reasoning: undefined,
		systemPrompt: "system",
		messages: [],
		tools: undefined,
		extraBody: {},
		reasoningScope: "test-endpoint",
		...overrides,
	}
}

it.each([
	{ include: true, custom: 0, model: 1000, expected: 1000 },
	{ include: true, custom: undefined, model: 1000, expected: 1000 },
	{ include: true, custom: 456, model: 1000, expected: 456 },
	{ include: false, custom: 456, model: 1000, expected: undefined },
	{ include: undefined, custom: 456, model: 1000, expected: undefined },
	{ include: true, custom: undefined, model: undefined, expected: undefined },
])("honors output limit defaults and omission: %j", ({ include, custom, model, expected }) => {
	const body = buildResponsesRequest(
		makeInput({
			options: { includeMaxTokens: include, modelMaxTokens: custom },
			modelInfo: { ...openAiModelInfoSaneDefaults, maxTokens: model },
		}),
	)
	if (expected === undefined) expect(body).not.toHaveProperty("max_output_tokens")
	else expect(body).toHaveProperty("max_output_tokens", expected)
})

it.each([
	{ supports: true, temperature: 0, expected: 0 },
	{ supports: undefined, temperature: 0, expected: 0 },
	{ supports: false, temperature: 0, expected: undefined },
	{ supports: true, temperature: undefined, expected: undefined },
	{ supports: undefined, temperature: undefined, expected: undefined },
	{ supports: undefined, temperature: 0.4, expected: 0.4 },
	{ supports: false, temperature: 0.4, expected: undefined },
])("honors temperature capability, zero, and omission: %j", ({ supports, temperature, expected }) => {
	const body = buildResponsesRequest(
		makeInput({
			options: { modelTemperature: temperature },
			modelInfo: { ...openAiModelInfoSaneDefaults, supportsTemperature: supports },
		}),
	)
	if (expected === undefined) expect(body).not.toHaveProperty("temperature")
	else expect(body).toHaveProperty("temperature", expected)
})

it.each([undefined, [], [{ type: "custom" as const, custom: { name: "custom", format: { type: "text" as const } } }]])(
	"omits tool controls when no function tools remain: %j",
	(tools) => {
		const body = buildResponsesRequest(
			makeInput({ tools, metadata: { taskId: "task", tool_choice: "required", parallelToolCalls: false } }),
		)
		expect(body).not.toHaveProperty("tools")
		expect(body).not.toHaveProperty("tool_choice")
		expect(body).not.toHaveProperty("parallel_tool_calls")
	},
)

it.each(["auto", "required"] as const)("preserves allowed_tools mode %s and flattens function references", (mode) => {
	const body = buildResponsesRequest(
		makeInput({
			tools: [{ type: "function", function: { name: "read_file" } }],
			metadata: {
				taskId: "task",
				tool_choice: {
					type: "allowed_tools",
					allowed_tools: {
						mode,
						tools: [
							{ type: "function", function: { name: "read_file" } },
							{ type: "custom", name: "other" },
						],
					},
				},
			},
		}),
	)
	expect(body.tool_choice).toEqual({
		type: "allowed_tools",
		mode,
		tools: [
			{ type: "function", name: "read_file" },
			{ type: "custom", name: "other" },
		],
	})
})

it.each([{}, { function: null }, { function: { name: 42 } }, { function: { name: "" } }])(
	"rejects malformed function restrictions: %j",
	(entry) => {
		expect(() =>
			buildResponsesRequest(
				makeInput({
					tools: [{ type: "function", function: { name: "read_file" } }],
					metadata: {
						taskId: "task",
						tool_choice: {
							type: "allowed_tools",
							allowed_tools: { mode: "auto", tools: [{ type: "function", ...entry }] },
						},
					},
				}),
			),
		).toThrow("function name")
	},
)

it.each([true, false])("replays standalone reasoning only with verified ownership: %s", (owned) => {
	const item = { type: "reasoning" as const, id: "rs1", encrypted_content: "opaque", summary: [] }
	const saved = owned
		? { ...item, format: "openai-responses-v1", provider: providerIdentifiers.openai, endpoint: "test-endpoint" }
		: item
	const body = buildResponsesRequest(makeInput({ messages: [saved] }))
	expect(body.input).toEqual(owned ? [item] : [])
})

it("preserves API defaults for tools without strictness or parameters", () => {
	const body = buildResponsesRequest(makeInput({ tools: [{ type: "function", function: { name: "no_args" } }] }))
	expect(body.tools).toEqual([
		{ type: "function", name: "no_args", description: undefined, strict: null, parameters: null },
	])
})

it.each(["o1", "o3", "o4-mini"])(
	"omits temperature for o-series model %s even when a custom value is configured",
	(modelId) => {
		const body = buildResponsesRequest(
			makeInput({
				options: { openAiModelId: modelId, modelTemperature: 0.4 },
				modelInfo: { ...openAiModelInfoSaneDefaults, supportsTemperature: true },
			}),
		)
		expect(body).not.toHaveProperty("temperature")
	},
)

it.each([
	{ modelId: "o1", expected: undefined },
	{ modelId: "o3", expected: undefined },
	{ modelId: "o4-mini", expected: undefined },
	{ modelId: "gpt-5.1", expected: 0.4 },
])("handles Extra Body temperature for model $modelId", ({ modelId, expected }) => {
	const body = buildResponsesRequest(
		makeInput({
			options: { openAiModelId: modelId },
			extraBody: { temperature: 0.4 },
		}),
	)
	if (expected === undefined) expect(body).not.toHaveProperty("temperature")
	else expect(body).toHaveProperty("temperature", expected)
})

it("normalizes both history ID fields to the Responses call_id length limit", () => {
	// History recorded through another provider (e.g. Gemini) can carry tool
	// IDs longer than the Responses call_id limit; both fields must be
	// normalized identically so the call/result pair keeps matching.
	const longId = `call_${"x".repeat(100)}`
	const body = buildResponsesRequest(
		makeInput({
			messages: [
				{ role: "assistant", content: [{ type: "tool_use", id: longId, name: "read_file", input: {} }] },
				{ role: "user", content: [{ type: "tool_result", tool_use_id: longId, content: "ok" }] },
			],
		}),
	)
	const items = body.input as Array<{ type?: string; call_id?: string }>
	const call = items.find((item) => item.type === "function_call")
	const output = items.find((item) => item.type === "function_call_output")
	expect(call?.call_id).toBeDefined()
	expect(call!.call_id!.length).toBeLessThanOrEqual(OPENAI_CALL_ID_MAX_LENGTH)
	expect(output?.call_id).toEqual(call?.call_id)
})
