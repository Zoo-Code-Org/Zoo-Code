import { OpenAiNativeHandler } from "../openai-native"
import { clearAllMocks } from "../../../test-utils/reset"
import { asyncStreamFrom, collectStream } from "../../../test-utils/stream"

const create = vi.hoisted(() => vi.fn())
vi.mock("openai", async () => {
	const { mockOpenAiResponsesClient } = await import("../../../test-utils/api")
	return mockOpenAiResponsesClient(create)
})

const tiers = [undefined, "default", "flex", "priority", "fast"] as const
// Exhaust the model's tier domain on both sides of the long-context threshold.
const cases = (["gpt-6.2-sol", "gpt-6.2-astra"] as const).flatMap((apiModelId) =>
	([undefined, "default", "priority"] as const).flatMap((requested) =>
		tiers.flatMap((actual) =>
			[272_000, 272_001].map((inputTokens) => ({ apiModelId, requested, actual, inputTokens })),
		),
	),
)

describe.each(["sdk", "fetch"] as const)("OpenAI service tier costs via %s", (transport) => {
	afterEach(() => {
		vi.unstubAllGlobals()
		clearAllMocks()
	})

	it.each(cases)(
		"$apiModelId requested=$requested actual=$actual input=$inputTokens",
		async ({ apiModelId, requested, actual, inputTokens }) => {
			const usage = {
				input_tokens: inputTokens,
				output_tokens: 1_000,
				input_tokens_details: {
					cached_tokens: 100_000,
					cache_write_tokens: 50_000,
					cache_write_tokens_details: { ttl_12h_tokens: 20_000 },
				},
			}
			const event = { type: "response.completed", response: { service_tier: actual, usage, output: [] } }
			if (transport === "sdk") {
				create.mockImplementation(() => asyncStreamFrom([event]))
			} else {
				create.mockRejectedValue(new Error("Use fetch fallback"))
				vi.stubGlobal(
					"fetch",
					vi.fn().mockImplementation(
						async () =>
							new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`, {
								headers: { "Content-Type": "text/event-stream" },
							}),
					),
				)
			}
			const handler = new OpenAiNativeHandler({
				openAiNativeApiKey: "test-key",
				apiModelId,
				openAiNativeServiceTier: requested,
			})
			const chunks = await collectStream(handler.createMessage("System", [{ role: "user", content: "Hi" }]))
			const effective = actual === "fast" ? "priority" : (actual ?? requested)
			const priority = effective === "priority"
			const long = inputTokens > 272_000 && (effective === undefined || effective === "default" || priority)
			const scale = (apiModelId === "gpt-6.2-astra" ? 4 : 1) * (priority ? 2 : 1)
			const expected =
				(scale *
					(((inputTokens - 150_000) * 2 + 100_000 * 0.1 + 30_000 * 2.5 + 20_000 * 5) * (long ? 2 : 1) +
						1_000 * 10 * (long ? 1.5 : 1))) /
				1_000_000
			const result = chunks.find((chunk) => chunk.type === "usage")
			expect(result?.totalCost, JSON.stringify({ requested, actual, inputTokens })).toBeCloseTo(expected, 8)
		},
	)
})
