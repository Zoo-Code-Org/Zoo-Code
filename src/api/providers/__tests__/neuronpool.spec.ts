// npx vitest run src/api/providers/__tests__/neuronpool.spec.ts

import OpenAI from "openai"
import { Anthropic } from "@anthropic-ai/sdk"

import { type NeuronPoolModelId, neuronpoolDefaultModelId, neuronpoolModels } from "@roo-code/types"

import {
	NeuronPoolHandler,
	NEURONPOOL_DEFAULT_BASE_URL,
	neuronpoolDefaultBaseUrl,
	stripTrailingSlashes,
} from "../neuronpool"

const LIVE_WORKER_BASE_URL = ["https://neuronpool.damnknee.workers.dev", "v1"].join("/")

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

describe("neuronpoolDefaultBaseUrl", () => {
	it("returns the live Worker /v1 URL", () => {
		expect(neuronpoolDefaultBaseUrl()).toBe(LIVE_WORKER_BASE_URL)
		expect(NEURONPOOL_DEFAULT_BASE_URL).toBe(LIVE_WORKER_BASE_URL)
	})
})

describe("stripTrailingSlashes", () => {
	it("leaves a URL without trailing slashes unchanged", () => {
		expect(stripTrailingSlashes(LIVE_WORKER_BASE_URL)).toBe(LIVE_WORKER_BASE_URL)
	})

	it("strips one or many trailing slashes without regex backtracking", () => {
		expect(stripTrailingSlashes("https://example.test/v1/")).toBe("https://example.test/v1")
		expect(stripTrailingSlashes("https://example.test/v1" + "/".repeat(64))).toBe("https://example.test/v1")
	})

	it("treats empty and slash-only strings as empty", () => {
		expect(stripTrailingSlashes("")).toBe("")
		expect(stripTrailingSlashes("/")).toBe("")
		expect(stripTrailingSlashes("///")).toBe("")
	})

	it("does not strip trailing characters that are not slashes", () => {
		expect(stripTrailingSlashes("https://example.test/v1 ")).toBe("https://example.test/v1 ")
		expect(stripTrailingSlashes("https://example.test/v1.")).toBe("https://example.test/v1.")
	})
})

describe("NeuronPoolHandler", () => {
	let handler: NeuronPoolHandler

	beforeEach(() => {
		vi.clearAllMocks()
		handler = new NeuronPoolHandler({ neuronpoolApiKey: "test-neuronpool-api-key" })
	})

	it("should use the live Worker base URL by default", () => {
		new NeuronPoolHandler({ neuronpoolApiKey: "test-neuronpool-api-key" })
		expect(OpenAI).toHaveBeenCalledWith(expect.objectContaining({ baseURL: LIVE_WORKER_BASE_URL }))
	})

	it("should fall back to the live Worker URL when the custom base URL is empty", () => {
		new NeuronPoolHandler({
			neuronpoolApiKey: "test-neuronpool-api-key",
			neuronpoolBaseUrl: "",
		})
		expect(OpenAI).toHaveBeenCalledWith(expect.objectContaining({ baseURL: LIVE_WORKER_BASE_URL }))
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

	it("should fall back to apiKey when neuronpoolApiKey is omitted", () => {
		new NeuronPoolHandler({ apiKey: "fallback-api-key" })
		expect(OpenAI).toHaveBeenCalledWith(expect.objectContaining({ apiKey: "fallback-api-key" }))
	})

	it("should throw when neither neuronpoolApiKey nor apiKey is set", () => {
		expect(() => new NeuronPoolHandler({})).toThrow("API key is required")
	})

	it("sets the provider name to NeuronPool", () => {
		expect((handler as unknown as { providerName: string }).providerName).toBe("NeuronPool")
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

	it("should fall back to the default model when the id is unknown", () => {
		const handlerWithUnknown = new NeuronPoolHandler({
			apiModelId: "not-a-neuronpool-model",
			neuronpoolApiKey: "test-neuronpool-api-key",
		})
		const model = handlerWithUnknown.getModel()
		expect(model.id).toBe(neuronpoolDefaultModelId)
		expect(model.info).toEqual(neuronpoolModels[neuronpoolDefaultModelId])
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
		expect(callArgs.temperature).toBe(0)
	})
})
