import axios from "axios"

import { IO_INTELLIGENCE_BASE_URL, ioIntelligenceDefaultModelInfo } from "@roo-code/types"

import { getIOIntelligenceModels, parseIoIntelligenceModel } from "../io-intelligence"

vi.mock("axios")

describe("IO Intelligence model fetcher", () => {
	beforeEach(() => vi.clearAllMocks())

	it("requests the catalog with optional Bearer authorization", async () => {
		vi.mocked(axios.get).mockResolvedValue({ data: { data: [] } })
		await getIOIntelligenceModels("key-a")
		expect(axios.get).toHaveBeenCalledWith(`${IO_INTELLIGENCE_BASE_URL}/models`, {
			headers: { Authorization: "Bearer key-a" },
			timeout: 10_000,
		})
	})

	it("supports unauthenticated catalog requests", async () => {
		vi.mocked(axios.get).mockResolvedValue({ data: { data: [] } })
		await getIOIntelligenceModels()
		expect(axios.get).toHaveBeenCalledWith(`${IO_INTELLIGENCE_BASE_URL}/models`, {
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
						created: 1_789_049_414,
						owned_by: "io-intelligence",
						max_model_len: null,
						context_window: 262_144,
						max_tokens: 131_072,
						supports_tools: true,
						supports_reasoning: true,
						supports_prompt_cache: true,
						input_modalities: ["text", "image"],
						input_token_price: 0.000000306,
						output_token_price: 0.000001224,
						cache_read_token_price: 0.000000153,
						unknown: "allowed",
					},
					{ id: "text-model", input_modalities: ["text"] },
				],
			},
		})

		const models = await getIOIntelligenceModels()
		expect(Object.keys(models)).toEqual(["vision-model", "text-model"])
		expect(models["vision-model"]).toEqual({
			contextWindow: 262_144,
			maxTokens: 131_072,
			supportsImages: true,
			supportsPromptCache: true,
			displayName: "Vision Model",
			inputPrice: 0.306,
			outputPrice: 1.224,
			cacheReadsPrice: 0.153,
		})
		expect(models["text-model"].supportsImages).toBe(false)
	})

	it("skips malformed records and models explicitly lacking tool support", async () => {
		vi.mocked(axios.get).mockResolvedValue({
			data: {
				data: [{ id: "eligible" }, { missing: "id" }, { id: "chat-only", supports_tools: false }],
			},
		})
		const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined)
		expect(await getIOIntelligenceModels()).toEqual({
			eligible: {
				contextWindow: ioIntelligenceDefaultModelInfo.contextWindow,
				maxTokens: ioIntelligenceDefaultModelInfo.maxTokens,
				supportsImages: false,
				supportsPromptCache: false,
			},
		})
		expect(warning).toHaveBeenCalledOnce()
		warning.mockRestore()
	})

	it("keeps models with null token metadata and prefers context_window over max_model_len", () => {
		expect(
			parseIoIntelligenceModel({ id: "both", max_model_len: 65_536, context_window: 262_144 }).contextWindow,
		).toBe(262_144)

		const info = parseIoIntelligenceModel({
			id: "legacy-entry",
			max_model_len: 65_536,
			context_window: null,
			max_tokens: null,
		})
		expect(info.contextWindow).toBe(65_536)
		expect(info.maxTokens).toBe(ioIntelligenceDefaultModelInfo.maxTokens)
	})

	it.each([{ data: null }, [], null])("returns no models for invalid top-level data %#", async (data) => {
		vi.mocked(axios.get).mockResolvedValue({ data })
		const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined)
		expect(await getIOIntelligenceModels()).toEqual({})
		warning.mockRestore()
	})

	it.each([new Error("network unavailable"), "network unavailable"])(
		"returns no models on network failure",
		async (error) => {
			vi.mocked(axios.get).mockRejectedValue(error)
			const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)
			expect(await getIOIntelligenceModels()).toEqual({})
			consoleError.mockRestore()
		},
	)

	it("rejects negative numeric metadata without leaking the API key in errors", async () => {
		vi.mocked(axios.get)
			.mockResolvedValueOnce({
				data: {
					data: [
						{ id: "valid-free", input_token_price: 0, output_token_price: 0 },
						{ id: "invalid-price", input_token_price: -1 },
					],
				},
			})
			.mockRejectedValueOnce(new Error("upstream rejected secret-key"))
		const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined)
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)

		expect(await getIOIntelligenceModels("secret-key")).toEqual({
			"valid-free": expect.objectContaining({ inputPrice: 0, outputPrice: 0 }),
		})
		expect(await getIOIntelligenceModels("secret-key")).toEqual({})
		expect(consoleError).toHaveBeenLastCalledWith(
			"Error fetching IO Intelligence models: upstream rejected [REDACTED]",
		)

		warning.mockRestore()
		consoleError.mockRestore()
	})

	it("does not invent absent optional metadata", () => {
		const info = parseIoIntelligenceModel({ id: "minimal" })
		expect(info).toEqual({
			contextWindow: ioIntelligenceDefaultModelInfo.contextWindow,
			maxTokens: ioIntelligenceDefaultModelInfo.maxTokens,
			supportsImages: false,
			supportsPromptCache: false,
		})
	})
})
