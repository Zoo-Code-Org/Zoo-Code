// npx vitest run api/providers/fetchers/__tests__/umans.spec.ts

import axios from "axios"

import { getUmansModels } from "../umans"

vi.mock("axios")
const mockAxiosGet = vi.mocked(axios.get)

describe("getUmansModels", () => {
	it("parses Umans model metadata and pricing", async () => {
		mockAxiosGet
			.mockResolvedValueOnce({
				data: {
					"umans-flash": {
						name: "umans-flash",
						display_name: "Umans Flash",
						description: "Fast coding model",
						capabilities: {
							max_completion_tokens: 262144,
							recommended_max_tokens: 32768,
							context_window: 262144,
							supports_vision: true,
							reasoning: {
								supported: true,
								can_disable: true,
								levels: ["none", "low", "medium", "high"],
								default_level: "medium",
							},
						},
					},
				},
			})
			.mockResolvedValueOnce({
				data: {
					data: [
						{
							id: "umans-flash",
							pricing: { input: 0.15, output: 1.0 },
						},
					],
				},
			})

		const models = await getUmansModels()

		expect(mockAxiosGet).toHaveBeenNthCalledWith(1, "https://api.code.umans.ai/v1/models/info")
		expect(mockAxiosGet).toHaveBeenNthCalledWith(2, "https://api.code.umans.ai/v1/models")
		expect(models["umans-flash"]).toEqual({
			maxTokens: 32768,
			contextWindow: 262144,
			supportsImages: true,
			supportsPromptCache: false,
			supportsMaxTokens: true,
			supportsReasoningEffort: ["none", "low", "medium", "high"],
			reasoningEffort: "medium",
			inputPrice: 0.15,
			outputPrice: 1,
			description: "Fast coding model",
		})
	})
})
