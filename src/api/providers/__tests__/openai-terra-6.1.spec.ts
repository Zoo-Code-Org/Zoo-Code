vitest.mock("@roo-code/telemetry", () => ({
	TelemetryService: { instance: { captureException: vitest.fn() } },
}))

import type { ApiHandlerOptions } from "../../../shared/api"
import { openAiCodexOAuthManager } from "../../../integrations/openai-codex/oauth"
import { asyncStreamFrom, collectStream } from "../../../test-utils/stream"
import { OpenAiNativeHandler } from "../openai-native"
import { OpenAiCodexHandler } from "../openai-codex"

const reasoningCases: { options: ApiHandlerOptions; native: string | undefined; codex: string }[] = [
	{ options: {}, native: "medium", codex: "low" },
	{ options: { reasoningEffort: "none" }, native: "none", codex: "low" },
	{ options: { reasoningEffort: "minimal" }, native: "medium", codex: "low" },
	{ options: { reasoningEffort: "disable" }, native: undefined, codex: "low" },
	{ options: { enableReasoningEffort: false }, native: undefined, codex: "low" },
	...(["low", "medium", "high", "xhigh", "max"] as const).map((effort) => ({
		options: { reasoningEffort: effort },
		native: effort,
		codex: effort,
	})),
]

describe("GPT-6.1 Terra requests", () => {
	afterEach(() => vitest.restoreAllMocks())

	it.each(reasoningCases)("uses supported reasoning for $options", ({ options, native, codex }) => {
		const settings = { apiModelId: "gpt-6.1-terra", openAiNativeApiKey: "test-key", ...options }
		const nativeHandler = new OpenAiNativeHandler(settings)
		const codexHandler = new OpenAiCodexHandler(settings)
		expect(nativeHandler.getModel().id).toBe("gpt-6.1-terra")
		expect(codexHandler.getModel().id).toBe("gpt-6.1-terra")
		expect(nativeHandler["getReasoningEffort"](nativeHandler.getModel())).toBe(native)
		expect(codexHandler["getReasoningEffort"](codexHandler.getModel())).toBe(codex)
	})

	it("builds native Responses tool requests with verified pricing and no temperature", () => {
		const handler = new OpenAiNativeHandler({
			apiModelId: "gpt-6.1-terra",
			openAiNativeApiKey: "test-key",
			openAiNativeServiceTier: "priority",
			modelTemperature: 0.7,
		})
		const model = handler.getModel()
		const body = handler["buildRequestBody"](model, [], "System", "low", handler["getReasoningEffort"](model), {
			taskId: "terra-task",
			tools: [
				{ type: "function", function: { name: "read_file", parameters: { type: "object", properties: {} } } },
			],
		})
		expect(body).toMatchObject({
			model: "gpt-6.1-terra",
			max_output_tokens: 128_000,
			reasoning: { effort: "medium" },
			service_tier: "priority",
			tools: [{ type: "function", name: "read_file", strict: true }],
		})
		expect(body).not.toHaveProperty("temperature")
		expect(handler["applyServiceTierPricing"](model.info, "priority")).toMatchObject({
			inputPrice: 2,
			outputPrice: 10,
			cacheReadsPrice: 0.1,
			cacheWritesPrice: 2.5,
		})
	})

	it("routes Codex tool requests through Responses Lite with Fast mode and required reasoning", async () => {
		const handler = new OpenAiCodexHandler({
			apiModelId: "gpt-6.1-terra",
			reasoningEffort: "none",
			openAiCodexServiceTier: "priority",
		})
		vitest.spyOn(openAiCodexOAuthManager, "getAccessToken").mockResolvedValue("test-token")
		vitest.spyOn(openAiCodexOAuthManager, "getAccountId").mockResolvedValue("test-account")
		const create = vitest.fn().mockResolvedValue(asyncStreamFrom([]))
		Reflect.set(handler, "client", { responses: { create } })
		await collectStream(
			handler.createMessage("System", [{ role: "user", content: "Read the file" }], {
				taskId: "terra-task",
				tools: [
					{
						type: "function",
						function: { name: "read_file", parameters: { type: "object", properties: {} } },
					},
				],
			}),
		)
		expect(create).toHaveBeenCalledWith(
			expect.objectContaining({
				model: "gpt-6.1-terra",
				service_tier: "priority",
				prompt_cache_key: "terra-task",
				reasoning: { effort: "low", summary: "auto", context: "all_turns" },
				tool_choice: "auto",
				parallel_tool_calls: false,
				input: expect.arrayContaining([
					expect.objectContaining({
						type: "additional_tools",
						tools: [expect.objectContaining({ type: "function", name: "read_file" })],
					}),
				]),
			}),
			expect.objectContaining({
				headers: expect.objectContaining({
					"x-openai-internal-codex-responses-lite": "true",
					"session-id": "terra-task",
				}),
			}),
		)
		const body = create.mock.calls[0][0]
		expect(body).not.toHaveProperty("instructions")
		expect(body).not.toHaveProperty("tools")
		expect(body).not.toHaveProperty("max_output_tokens")
		expect(body).not.toHaveProperty("temperature")
	})
})
