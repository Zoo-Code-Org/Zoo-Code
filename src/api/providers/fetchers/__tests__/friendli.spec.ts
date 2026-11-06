// npx vitest run api/providers/fetchers/__tests__/friendli.spec.ts

import axios from "axios"

import { getFriendliModels } from "../friendli"

vi.mock("axios")

describe("getFriendliModels", () => {
	it("maps chat models from /v1/models", async () => {
		vi.mocked(axios.get).mockResolvedValueOnce({
			data: {
				data: [
					{
						id: "zai-org/GLM-5.3",
						mode: "chat",
						description: "GLM",
						context_length: 1_048_576,
						max_completion_tokens: 131_072,
						pricing: { input: "0.00000126", output: "0.00000396", input_cache_read: "0.000000234" },
						input_modalities: ["text", "image"],
						reasoning_options: [
							{ type: "effort", values: ["low", "high", "max", "ultracode"] },
							{ type: "budget_tokens", min: -1, max: 1_048_576 },
						],
					},
					{
						id: "google/gemma-4-31B-it",
						mode: "chat",
						pricing: { input: "0.00000014", output: "0.0000004" },
					},
					{ id: "some/embedding", mode: "embedding" },
				],
			},
		})

		const models = await getFriendliModels()

		expect(Object.keys(models)).toEqual(["zai-org/GLM-5.3", "google/gemma-4-31B-it"])
		expect(models["zai-org/GLM-5.3"]).toEqual({
			maxTokens: 131_072,
			contextWindow: 1_048_576,
			supportsImages: true,
			supportsPromptCache: true,
			supportsMaxTokens: true,
			inputPrice: expect.closeTo(1.26),
			outputPrice: expect.closeTo(3.96),
			cacheReadsPrice: expect.closeTo(0.234),
			supportsReasoningEffort: ["low", "high", "max"],
			reasoningEffort: "high",
			description: "GLM",
		})
		expect(models["google/gemma-4-31B-it"].supportsReasoningEffort).toBeUndefined()
		expect(models["google/gemma-4-31B-it"].supportsPromptCache).toBe(false)
	})

	it("returns an empty record on request failure", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {})
		vi.mocked(axios.get).mockRejectedValueOnce(new Error("Network error"))

		expect(await getFriendliModels()).toEqual({})
	})
})
