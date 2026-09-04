// npx vitest run src/api/providers/__tests__/neuronpool.spec.ts

import OpenAI from "openai"
import { Anthropic } from "@anthropic-ai/sdk"

import { type NeuronPoolModelId, neuronpoolDefaultModelId, neuronpoolModels } from "@roo-code/types"

import { NeuronPoolHandler, NEURONPOOL_DEFAULT_BASE_URL } from "../neuronpool"

const mockCreate = vi.fn()

vi.mock("openai", () => ({
	default: vi.fn(function () {
		return {
			chat: {
				completions: {
					create: mockCreate,
				},
			},
		}
	}),
}))

describe("NeuronPoolHandler", () => {
	let handler: NeuronPoolHandler

	beforeEach(() => {
		vi.clearAllMocks()
		handler = new NeuronPoolHandler({ neuronpoolApiKey: "test-neuronpool-api-key" })
	})

	it("should use the live Worker base URL by default", () => {
		new NeuronPoolHandler({ neuronpoolApiKey: "test-neuronpool-api-key" })
		expect(OpenAI).toHaveBeenCalledWith(expect.objectContaining({ baseURL: NEURONPOOL_DEFAULT_BASE_URL }))
	})

	it("should honor a custom base URL", () => {
		new NeuronPoolHandler({
			neuronpoolApiKey: "test-neuronpool-api-key",
			neuronpoolBaseUrl: "https://example.test/v1/",
		})
		expect(OpenAI).toHaveBeenCalledWith(expect.objectContaining({ baseURL: "https://example.test/v1" }))
	})

	it("should use the provided API key", () => {
		const neuronpoolApiKey = "test-neuronpool-api-key"
		new NeuronPoolHandler({ neuronpoolApiKey })
		expect(OpenAI).toHaveBeenCalledWith(expect.objectContaining({ apiKey: neuronpoolApiKey }))
	})

	it("should return default model when no model is specified", () => {
		const model = handler.getModel()
		expect(model.id).toBe(neuronpoolDefaultModelId)
		expect(model.info).toEqual(neuronpoolModels[neuronpoolDefaultModelId])
	})

	it("should return specified model when valid model is provided", () => {
		const testModelId: NeuronPoolModelId = "llama-3.2-1b-instruct"
		const handlerWithModel = new NeuronPoolHandler({
			apiModelId: testModelId,
			neuronpoolApiKey: "test-neuronpool-api-key",
		})
		const model = handlerWithModel.getModel()
		expect(model.id).toBe(testModelId)
		expect(model.info).toEqual(neuronpoolModels[testModelId])
	})

	it("completePrompt method should return text from NeuronPool API", async () => {
		const expectedResponse = "pong"
		mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: expectedResponse } }] })
		const result = await handler.completePrompt("ping")
		expect(result).toBe(expectedResponse)
	})

	it("should handle errors in completePrompt", async () => {
		const errorMessage = "NeuronPool API error"
		mockCreate.mockRejectedValueOnce(new Error(errorMessage))
		await expect(handler.completePrompt("test prompt")).rejects.toThrow()
	})

	it("createMessage should yield text content from stream", async () => {
		const testContent = "pong"

		mockCreate.mockImplementationOnce(() => {
			return {
				[Symbol.asyncIterator]: () => ({
					next: vi
						.fn()
						.mockResolvedValueOnce({
							done: false,
							value: { choices: [{ delta: { content: testContent } }] },
						})
						.mockResolvedValueOnce({ done: true }),
				}),
			}
		})

		const stream = handler.createMessage("system prompt", [])
		const firstChunk = await stream.next()

		expect(firstChunk.done).toBe(false)
		expect(firstChunk.value).toEqual({ type: "text", text: testContent })
	})

	it("should pass stream + tools through to the OpenAI-compatible API", async () => {
		mockCreate.mockImplementationOnce(() => {
			return {
				[Symbol.asyncIterator]: () => ({
					next: vi.fn().mockResolvedValueOnce({ done: true }),
				}),
			}
		})

		const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Hello" }]
		const stream = handler.createMessage("You are a helpful assistant", messages)
		for await (const _chunk of stream) {
			// drain
		}

		const callArgs = mockCreate.mock.calls[0][0]
		expect(callArgs.model).toBe(neuronpoolDefaultModelId)
		expect(callArgs.stream).toBe(true)
	})
})
