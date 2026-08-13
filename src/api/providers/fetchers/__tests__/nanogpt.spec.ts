import axios from "axios"

import { NANOGPT_BASE_URL, nanoGptDefaultModelInfo } from "@roo-code/types"

import { getNanoGptModels, parseNanoGptModel } from "../nanogpt"

vi.mock("axios")

describe("NanoGPT model fetcher", () => {
	beforeEach(() => vi.clearAllMocks())

	it("requests the detailed catalog with optional Bearer authorization", async () => {
		vi.mocked(axios.get).mockResolvedValue({ data: { data: [] } })
		await getNanoGptModels("key-a")
		expect(axios.get).toHaveBeenCalledWith(`${NANOGPT_BASE_URL}/models?detailed=true`, {
			headers: { Authorization: "Bearer key-a" },
			timeout: 10_000,
		})
	})

	it("supports unauthenticated catalog requests", async () => {
		vi.mocked(axios.get).mockResolvedValue({ data: { data: [] } })
		await getNanoGptModels()
		expect(axios.get).toHaveBeenCalledWith(`${NANOGPT_BASE_URL}/models?detailed=true`, {
			headers: undefined,
			timeout: 10_000,
		})
	})

	it("maps detailed metadata and exact per-million pricing for multiple models", async () => {
		vi.mocked(axios.get).mockResolvedValue({
			data: {
				unknown_top_level: true,
				data: [
					{
						id: "vision-model",
						name: "Vision Model",
						description: "Detailed description",
						context_length: 1_050_000,
						max_output_tokens: 128_000,
						capabilities: { vision: true, tool_calling: true, unknown: "allowed" },
						pricing: {
							prompt: 2.5,
							completion: 10,
							cacheReadInputPer1kTokens: 0.001,
							cacheWriteInputPer1kTokens: 0.002,
							unknown: 1,
						},
						unknown: "allowed",
					},
					{ id: "text-model", capabilities: { vision: false } },
				],
			},
		})

		const models = await getNanoGptModels()
		expect(Object.keys(models)).toEqual(["vision-model", "text-model"])
		expect(models["vision-model"]).toEqual({
			contextWindow: 1_050_000,
			maxTokens: 128_000,
			supportsPromptCache: false,
			supportsImages: true,
			displayName: "Vision Model",
			description: "Detailed description",
			inputPrice: 2.5,
			outputPrice: 10,
			cacheReadsPrice: 1,
			cacheWritesPrice: 2,
		})
		expect(models["text-model"].supportsImages).toBe(false)
	})

	it("skips malformed records and models explicitly lacking tool calling", async () => {
		vi.mocked(axios.get).mockResolvedValue({
			data: {
				data: [
					{ id: "eligible" },
					{ missing: "id" },
					{ id: "chat-only", capabilities: { tool_calling: false } },
				],
			},
		})
		const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined)
		expect(await getNanoGptModels()).toEqual({
			eligible: {
				contextWindow: nanoGptDefaultModelInfo.contextWindow,
				maxTokens: nanoGptDefaultModelInfo.maxTokens,
				supportsPromptCache: false,
			},
		})
		expect(warning).toHaveBeenCalledOnce()
		warning.mockRestore()
	})

	it.each([{ data: null }, [], null])("returns no models for invalid top-level data %#", async (data) => {
		vi.mocked(axios.get).mockResolvedValue({ data })
		const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined)
		expect(await getNanoGptModels()).toEqual({})
		warning.mockRestore()
	})

	it.each([new Error("network unavailable"), "network unavailable"])(
		"returns no models on network failure",
		async (error) => {
			vi.mocked(axios.get).mockRejectedValue(error)
			const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)
			expect(await getNanoGptModels()).toEqual({})
			consoleError.mockRestore()
		},
	)

	it("rejects negative numeric metadata without leaking the API key in errors", async () => {
		vi.mocked(axios.get)
			.mockResolvedValueOnce({
				data: {
					data: [
						{ id: "valid-free", pricing: { prompt: 0, completion: 0 } },
						{ id: "invalid-price", pricing: { prompt: -1 } },
					],
				},
			})
			.mockRejectedValueOnce(new Error("upstream rejected secret-key"))
		const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined)
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)

		expect(await getNanoGptModels("secret-key")).toEqual({
			"valid-free": expect.objectContaining({ inputPrice: 0, outputPrice: 0 }),
		})
		expect(await getNanoGptModels("secret-key")).toEqual({})
		expect(consoleError).toHaveBeenLastCalledWith("Error fetching NanoGPT models: upstream rejected [REDACTED]")

		warning.mockRestore()
		consoleError.mockRestore()
	})

	it("does not invent absent optional metadata", () => {
		const info = parseNanoGptModel({ id: "minimal" })
		expect(info).toEqual({
			contextWindow: nanoGptDefaultModelInfo.contextWindow,
			maxTokens: nanoGptDefaultModelInfo.maxTokens,
			supportsPromptCache: false,
		})
	})
})
