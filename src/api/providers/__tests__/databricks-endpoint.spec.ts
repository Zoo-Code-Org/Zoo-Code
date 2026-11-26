// npx vitest run api/providers/__tests__/databricks-endpoint.spec.ts

import { isDatabricksEndpoint } from "../utils/databricks-endpoint"
import { OpenAiHandler } from "../openai"
import { ApiHandlerOptions } from "../../../shared/api"
import { makeApiHandlerOptions, makeCreateMessageMetadata } from "../../../test-utils/api"
import { asyncStreamFrom, collectStream } from "../../../test-utils/stream"

const mockCreate = vitest.fn()

vitest.mock("openai", () => {
	const mockConstructor = vitest.fn()
	return {
		__esModule: true,
		default: mockConstructor.mockImplementation(function (options: { baseURL: string }) {
			return {
				baseURL: options.baseURL,
				chat: {
					completions: {
						create: mockCreate.mockImplementation(async (requestOptions: { stream?: boolean }) => {
							if (!requestOptions.stream) {
								return {
									id: "test-completion",
									choices: [
										{
											message: { role: "assistant", content: "Test response", refusal: null },
											finish_reason: "stop",
											index: 0,
										},
									],
									usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
								}
							}

							return asyncStreamFrom([
								{
									choices: [{ delta: { content: "Test response" }, index: 0 }],
									usage: null,
								},
								{
									choices: [{ delta: {}, index: 0 }],
									usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
								},
							])
						}),
					},
				},
			}
		}),
	}
})

vitest.mock("../utils/timeout-config", () => ({
	getApiRequestTimeout: vitest.fn().mockReturnValue(300_000),
}))

function makeHandler(baseUrl: string, modelId: string, streaming: boolean): OpenAiHandler {
	const options: ApiHandlerOptions = makeApiHandlerOptions({
		openAiApiKey: "test-api-key",
		openAiModelId: modelId,
		openAiBaseUrl: baseUrl,
		openAiStreamingEnabled: streaming,
	})
	return new OpenAiHandler(options)
}

describe("isDatabricksEndpoint", () => {
	it.each([
		["AWS workspace host", "https://dbc-12345-abcd.cloud.databricks.com/serving-endpoints"],
		["Azure workspace host", "https://adb-1111111111111111.1.azuredatabricks.net/serving-endpoints"],
		["GovCloud workspace host", "https://dbc-gov.cloud.databricks.us/serving-endpoints"],
		["Azure GovCloud workspace host", "https://adb-1.1.azuredatabricks.us/serving-endpoints"],
		["serving-endpoints route on a custom domain", "https://gw.corp.example/serving-endpoints/my-ep/invocations"],
		["host suffix match is case-insensitive", "https://DBC-1.CLOUD.DATABRICKS.COM/serving-endpoints"],
		["surrounding whitespace is tolerated", "  https://gw.corp.example/serving-endpoints  "],
	])("detects a Databricks endpoint: %s", (_name, baseUrl) => {
		expect(isDatabricksEndpoint(baseUrl)).toBe(true)
	})

	it.each([
		["undefined", undefined],
		["empty string", ""],
		["not a URL", "not a url"],
		["OpenAI API", "https://api.openai.com/v1"],
		["localhost gateway", "http://localhost:3001/v1"],
		["apex host without subdomain", "https://databricks.com/v1"],
		["prefix lookalike host", "https://evildatabricks.com/v1"],
		["non-serving path on a custom domain", "https://gw.corp.example/invocations"],
	])("does not detect a Databricks endpoint: %s", (_name, baseUrl) => {
		expect(isDatabricksEndpoint(baseUrl)).toBe(false)
	})
})

describe("OpenAiHandler Databricks request bodies", () => {
	const ROUTES = [
		{ name: "streaming chat completion", modelId: "gpt-4", streaming: true },
		{ name: "non-streaming chat completion", modelId: "gpt-4", streaming: false },
		{ name: "o-series streaming completion", modelId: "o4-mini", streaming: true },
		{ name: "o-series non-streaming completion", modelId: "o4-mini", streaming: false },
	] as const

	const DATABRICKS_BASE_URL = "https://adb-1111111111111111.1.azuredatabricks.net/serving-endpoints"
	const OPENAI_BASE_URL = "https://api.openai.com/v1"

	beforeEach(() => {
		mockCreate.mockClear()
	})

	it.each(ROUTES)(
		"never sends parallel_tool_calls to a Databricks endpoint ($name)",
		async ({ modelId, streaming }) => {
			const handler = makeHandler(DATABRICKS_BASE_URL, modelId, streaming)

			await collectStream(
				handler.createMessage(
					"system prompt",
					[{ role: "user", content: "hello" }],
					makeCreateMessageMetadata({ parallelToolCalls: true }),
				),
			)

			expect(mockCreate).toHaveBeenCalledTimes(1)
			const body = mockCreate.mock.calls[0][0]
			expect(body).not.toHaveProperty("parallel_tool_calls")
		},
	)

	it.each(ROUTES)("keeps parallel_tool_calls on a plain OpenAI endpoint ($name)", async ({ modelId, streaming }) => {
		const handler = makeHandler(OPENAI_BASE_URL, modelId, streaming)

		await collectStream(
			handler.createMessage(
				"system prompt",
				[{ role: "user", content: "hello" }],
				makeCreateMessageMetadata({ parallelToolCalls: false }),
			),
		)

		const body = mockCreate.mock.calls[0][0]
		expect(body).toHaveProperty("parallel_tool_calls", false)
	})
})
