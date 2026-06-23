const { mockCreateOpenAICompatible } = vi.hoisted(() => ({
	mockCreateOpenAICompatible: vi.fn(() =>
		vi.fn(() => ({
			modelId: "moonshotai/kimi-k2.7-code",
			provider: "novita",
		})),
	),
}))

vi.mock("@ai-sdk/openai-compatible", () => ({
	createOpenAICompatible: mockCreateOpenAICompatible,
}))

import { novitaDefaultModelId, novitaModels } from "@roo-code/types"

import type { ApiHandlerOptions } from "../../../shared/api"

import { NovitaHandler } from "../novita"

describe("NovitaHandler", () => {
	const mockOptions: ApiHandlerOptions = {
		novitaApiKey: "test-api-key",
		apiModelId: "moonshotai/kimi-k2.7-code",
		novitaBaseUrl: "https://api.novita.ai/openai",
	}

	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("initializes the OpenAI-compatible provider with Novita settings", () => {
		const handler = new NovitaHandler(mockOptions)

		expect(handler).toBeInstanceOf(NovitaHandler)
		expect(mockCreateOpenAICompatible).toHaveBeenCalledWith(
			expect.objectContaining({
				name: "novita",
				baseURL: "https://api.novita.ai/openai",
				apiKey: "test-api-key",
			}),
		)
		expect(handler.getModel().id).toBe("moonshotai/kimi-k2.7-code")
	})

	it("uses default base URL and model when not provided", () => {
		const handler = new NovitaHandler({ novitaApiKey: "test-api-key" })

		expect(mockCreateOpenAICompatible).toHaveBeenCalledWith(
			expect.objectContaining({
				baseURL: "https://api.novita.ai/openai",
			}),
		)
		expect(handler.getModel().id).toBe(novitaDefaultModelId)
		expect(handler.getModel().info).toBe(novitaModels[novitaDefaultModelId])
	})

	it("returns the requested model ID with default model info for unknown models", () => {
		const handler = new NovitaHandler({
			...mockOptions,
			apiModelId: "provider/new-model",
		})

		const model = handler.getModel()
		expect(model.id).toBe("provider/new-model")
		expect(model.info).toBe(novitaModels[novitaDefaultModelId])
	})

	it("applies custom model max tokens and temperature settings", () => {
		const handler = new NovitaHandler({
			...mockOptions,
			modelMaxTokens: 2048,
			modelTemperature: 0.3,
		})

		const model = handler.getModel()
		expect(model.temperature).toBe(0.3)
	})
})
