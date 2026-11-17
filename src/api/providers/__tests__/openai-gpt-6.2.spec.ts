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

	it("sends tools through native Responses and replaces an unsupported effort", async () => {
		const handler = new OpenAiNativeHandler({ apiModelId, openAiNativeApiKey: "test-key", reasoningEffort: "none" })
		const [body] = await requestTool(handler)
		expect(body).toMatchObject({
			model: apiModelId,
			max_output_tokens: 128_000,
			reasoning: { effort: "medium" },
			tools: [{ type: "function", name: "list_files", strict: true }],
		})
		expect(body).not.toHaveProperty("temperature")
	})

	it("sends subscription tools and the session header through Responses Lite", async () => {
		vi.spyOn(openAiCodexOAuthManager, "getAccessToken").mockResolvedValue("test-token")
		vi.spyOn(openAiCodexOAuthManager, "getAccountId").mockResolvedValue("test-account")
		const handler = new OpenAiCodexHandler({ apiModelId, openAiCodexServiceTier: "priority" })
		const [body, options] = await requestTool(handler)
		expect(body).toMatchObject({
			model: apiModelId,
			service_tier: "priority",
			reasoning: { effort: "low", context: "all_turns" },
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
