import { getKimiCodeModels, mapKimiCodeModel } from "../kimi-code"

describe("Kimi Code model discovery", () => {
	beforeEach(() => vi.restoreAllMocks())

	it("maps official model fields", () => {
		expect(
			mapKimiCodeModel({
				id: "kimi-test",
				context_length: 131072,
				supports_reasoning: true,
				supports_image_in: true,
				display_name: "Kimi Test",
			}),
		).toMatchObject({
			contextWindow: 131072,
			supportsReasoningBinary: true,
			supportsImages: true,
			displayName: "Kimi Test",
		})
	})

	it("uses bearer auth for GET /models", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ data: [{ id: "kimi-for-coding", context_length: 262144 }] }), {
				status: 200,
			}),
		)
		const models = await getKimiCodeModels("secret-token")
		expect(models).toHaveProperty("kimi-for-coding")
		expect(fetch).toHaveBeenCalledWith(
			"https://api.kimi.com/coding/v1/models",
			expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer secret-token" }) }),
		)
	})
})
