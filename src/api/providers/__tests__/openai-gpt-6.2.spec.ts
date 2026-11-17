import { openAiCodexOAuthManager } from "../../../integrations/openai-codex/oauth"
import { makeCreateMessageMetadata } from "../../../test-utils/api"
import { asyncStreamFrom, collectStream } from "../../../test-utils/stream"
import { OpenAiCodexHandler } from "../openai-codex"
import { OpenAiNativeHandler } from "../openai-native"

const create = vi.hoisted(() => vi.fn<(body: Record<string, unknown>, options: unknown) => AsyncIterable<unknown>>())

vi.mock("openai", async () => {
	const { mockOpenAiResponsesClient } = await import("../../../test-utils/api")
	return mockOpenAiResponsesClient(create)
})

const reasoningCases = [
	{ selected: "low", native: "low", codex: "low" },
	{ selected: "max", native: "max", codex: "max" },
	{ selected: "none", native: "medium", codex: "low" },
	{ selected: undefined, native: "medium", codex: "low" },
] as const

describe.each(["gpt-6.2-sol", "gpt-6.2-astra"])("%s tool requests", (apiModelId) => {
	beforeEach(() => {
		create.mockReset().mockImplementation(() =>
			asyncStreamFrom([
				{
					type: "response.output_item.done",
					item: { type: "function_call", call_id: "call_1", name: "list_files", arguments: "{}" },
				},
			]),
		)
	})

	afterEach(() => vi.restoreAllMocks())

	async function requestTool(handler: OpenAiNativeHandler | OpenAiCodexHandler) {
		const metadata = makeCreateMessageMetadata({
			tools: [
				{ type: "function", function: { name: "list_files", parameters: { type: "object", properties: {} } } },
			],
		})
		const chunks = await collectStream(
			handler.createMessage("System", [{ role: "user", content: "List files" }], metadata),
		)
		expect(chunks).toContainEqual({ type: "tool_call", id: "call_1", name: "list_files", arguments: "{}" })
		expect(create).toHaveBeenCalledTimes(1)
		return create.mock.calls[0]
	}

	it.each(reasoningCases)("Native sends effort $native for selection $selected", async ({ selected, native }) => {
		const handler = new OpenAiNativeHandler({
			apiModelId,
			openAiNativeApiKey: "test-key",
			reasoningEffort: selected,
		})
		const [body] = await requestTool(handler)
		expect(body).toMatchObject({
			model: apiModelId,
			max_output_tokens: 128_000,
			reasoning: { effort: native },
			tools: [{ type: "function", name: "list_files", strict: true }],
		})
		expect(body).not.toHaveProperty("temperature")
	})

	it.each(reasoningCases)("Codex sends effort $codex for selection $selected", async ({ selected, codex }) => {
		vi.spyOn(openAiCodexOAuthManager, "getAccessToken").mockResolvedValue("test-token")
		vi.spyOn(openAiCodexOAuthManager, "getAccountId").mockResolvedValue("test-account")
		const handler = new OpenAiCodexHandler({
			apiModelId,
			openAiCodexServiceTier: "priority",
			reasoningEffort: selected,
		})
		const [body, options] = await requestTool(handler)
		expect(body).toMatchObject({
			model: apiModelId,
			service_tier: "priority",
			reasoning: { effort: codex, context: "all_turns" },
			input: expect.arrayContaining([
				expect.objectContaining({
					type: "additional_tools",
					tools: [expect.objectContaining({ name: "list_files" })],
				}),
			]),
		})
		expect(options).toMatchObject({
			headers: { "x-openai-internal-codex-responses-lite": "true", "session-id": "test-task" },
		})
		expect(body).not.toHaveProperty("tools")
		expect(body).not.toHaveProperty("max_output_tokens")
	})
})
