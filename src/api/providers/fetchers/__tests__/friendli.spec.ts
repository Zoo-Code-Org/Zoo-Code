// npx vitest run api/providers/fetchers/__tests__/friendli.spec.ts

import axios from "axios"

import { openAiModelInfoSaneDefaults } from "@roo-code/types"

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
					{ id: "zai-org/GLM-5.2", mode: "chat", input_modalities: ["text"] },
					{ id: "some/embedding", mode: "embedding" },
				],
			},
		})

		const signal = new AbortController().signal
		const models = await getFriendliModels({ signal })

		expect(axios.get).toHaveBeenCalledWith("https://api.friendli.ai/serverless/v1/models", { signal })
		expect(Object.keys(models)).toEqual(["zai-org/GLM-5.3", "google/gemma-4-31B-it", "zai-org/GLM-5.2"])
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
		// A model without context_length gets the sane default window.
		expect(models["google/gemma-4-31B-it"].contextWindow).toBe(openAiModelInfoSaneDefaults.contextWindow)
		// Missing input_modalities and a text-only list both mean no image input.
		expect(models["google/gemma-4-31B-it"].supportsImages).toBe(false)
		expect(models["zai-org/GLM-5.2"].supportsImages).toBe(false)
	})

	it("accepts null reasoning_options and keeps the catalog", async () => {
		vi.mocked(axios.get).mockResolvedValueOnce({
			data: {
				data: [
					{ id: "vendor/fetched-only", reasoning_options: null },
					{ id: "zai-org/GLM-5.1", reasoning_options: [{ type: "toggle" }] },
				],
			},
		})

		const models = await getFriendliModels()

		expect(Object.keys(models)).toEqual(["vendor/fetched-only", "zai-org/GLM-5.1"])
		expect(models["vendor/fetched-only"].supportsReasoningEffort).toBeUndefined()
		expect(models["vendor/fetched-only"].supportsReasoningBinary).toBeUndefined()
	})

	it("maps toggle-only reasoning to supportsReasoningBinary without inventing an effort", async () => {
		vi.mocked(axios.get).mockResolvedValueOnce({
			data: {
				data: [
					{
						id: "zai-org/GLM-5.1",
						reasoning_options: [{ type: "toggle" }, { type: "budget_tokens", min: -1, max: 202_752 }],
					},
					{
						id: "zai-org/GLM-5.2",
						reasoning_options: [{ type: "toggle" }, { type: "effort", values: ["high", "max"] }],
					},
				],
			},
		})

		const models = await getFriendliModels()

		expect(models["zai-org/GLM-5.1"].supportsReasoningBinary).toBe(true)
		expect(models["zai-org/GLM-5.1"].supportsReasoningEffort).toBeUndefined()
		expect(models["zai-org/GLM-5.1"].reasoningEffort).toBeUndefined()
		// A toggle next to effort levels keeps the effort selector.
		expect(models["zai-org/GLM-5.2"].supportsReasoningBinary).toBeUndefined()
		expect(models["zai-org/GLM-5.2"].supportsReasoningEffort).toEqual(["high", "max"])
	})

	it("defaults to the first supported effort when high is not offered", async () => {
		vi.mocked(axios.get).mockResolvedValueOnce({
			data: {
				data: [
					{
						id: "vendor/no-high",
						reasoning_options: [{ type: "effort", values: ["ultracode", "low", "medium", "max"] }],
					},
				],
			},
		})

		const models = await getFriendliModels()

		expect(models["vendor/no-high"].supportsReasoningEffort).toEqual(["low", "medium", "max"])
		expect(models["vendor/no-high"].reasoningEffort).toBe("low")
	})

	it("keeps reserved upstream IDs as own keys", async () => {
		vi.mocked(axios.get).mockResolvedValueOnce({
			data: {
				data: [
					{ id: "__proto__", context_length: 1000 },
					{ id: "toString", context_length: 2000 },
				],
			},
		})

		const models = await getFriendliModels()

		expect(Object.getPrototypeOf(models)).toBeNull()
		expect(Object.keys(models)).toEqual(["__proto__", "toString"])
		expect(models["__proto__"].contextWindow).toBe(1000)
		expect(models["toString"].contextWindow).toBe(2000)
		expect(models["valueOf"]).toBeUndefined()
	})

	it("rethrows cancellation instead of returning an empty record", async () => {
		const controller = new AbortController()
		controller.abort()
		vi.mocked(axios.get).mockRejectedValueOnce(new Error("canceled"))

		await expect(getFriendliModels({ signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" })
	})

	it("returns an empty record on an invalid response", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {})
		vi.mocked(axios.get).mockResolvedValueOnce({ data: { invalid: true } })

		expect(await getFriendliModels()).toEqual({})
	})

	it("returns an empty record on request failure", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {})
		vi.mocked(axios.get).mockRejectedValueOnce(new Error("Network error"))

		expect(await getFriendliModels()).toEqual({})
	})
})
