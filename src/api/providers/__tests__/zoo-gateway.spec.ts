// npx vitest run src/api/providers/__tests__/zoo-gateway.spec.ts

vitest.mock("vscode", () => ({}))

import OpenAI from "openai"

import { zooGatewayDefaultModelId, ZOO_GATEWAY_DEFAULT_TEMPERATURE } from "@roo-code/types"

import { ZooGatewayHandler } from "../zoo-gateway"
import { ApiHandlerOptions } from "../../../shared/api"
import { Package } from "../../../shared/package"

vitest.mock("openai")
vitest.mock("delay", () => ({ default: vitest.fn(() => Promise.resolve()) }))
vitest.mock("../fetchers/modelCache", () => ({
	getModels: vitest.fn().mockImplementation(() => {
		return Promise.resolve({
			"anthropic/claude-sonnet-4": {
				maxTokens: 64000,
				contextWindow: 200000,
				supportsImages: true,
				supportsPromptCache: true,
				inputPrice: 3,
				outputPrice: 15,
				cacheWritesPrice: 3.75,
				cacheReadsPrice: 0.3,
				description: "Claude Sonnet 4",
			},
			"anthropic/claude-3.5-haiku": {
				maxTokens: 32000,
				contextWindow: 200000,
				supportsImages: true,
				supportsPromptCache: true,
				inputPrice: 1,
				outputPrice: 5,
				cacheWritesPrice: 1.25,
				cacheReadsPrice: 0.1,
				description: "Claude 3.5 Haiku",
			},
		})
	}),
	getModelsFromCache: vitest.fn().mockReturnValue(undefined),
}))

vitest.mock("../../../services/zoo-code-auth", () => ({
	getZooCodeBaseUrl: vitest.fn(() => "https://www.zoocode.dev"),
}))

vitest.mock("../../transform/caching/vercel-ai-gateway", () => ({
	addCacheBreakpoints: vitest.fn(),
}))

const mockCreate = vitest.fn()

function mockOpenAIClient() {
	vitest.mocked(OpenAI).mockImplementation(
		() =>
			({
				chat: {
					completions: {
						create: mockCreate,
					},
				},
			}) as unknown as OpenAI,
	)
}

mockOpenAIClient()

describe("ZooGatewayHandler", () => {
	const mockOptions: ApiHandlerOptions = {
		zooSessionToken: "zoo_ext_test_token",
		zooGatewayModelId: "anthropic/claude-sonnet-4",
	}

	beforeEach(() => {
		vitest.clearAllMocks()
		mockCreate.mockClear()
		mockOpenAIClient()
	})

	describe("constructor", () => {
		it("requires authentication before constructing the client", () => {
			expect(() => new ZooGatewayHandler({})).toThrow(
				"Zoo Gateway requires authentication. Please sign in to Zoo Code first.",
			)
			expect(OpenAI).not.toHaveBeenCalled()
		})

		it("initializes OpenAI with Zoo enrichment headers and session token", () => {
			const handler = new ZooGatewayHandler({
				...mockOptions,
				zooGatewayBaseUrl: "https://staging.zoocode.dev/api/gateway/v1",
			})

			expect(handler).toBeInstanceOf(ZooGatewayHandler)
			expect(OpenAI).toHaveBeenCalledWith({
				baseURL: "https://staging.zoocode.dev/api/gateway/v1",
				apiKey: mockOptions.zooSessionToken,
				defaultHeaders: expect.objectContaining({
					"HTTP-Referer": "https://github.com/RooVetGit/Roo-Cline",
					"X-Title": "Roo Code",
					"X-Zoo-Editor": "vscode",
					"X-Zoo-Extension-Version": Package.version,
				}),
			})
		})

		it("defaults the gateway base URL from getZooCodeBaseUrl", () => {
			new ZooGatewayHandler(mockOptions)

			expect(OpenAI).toHaveBeenCalledWith(
				expect.objectContaining({
					baseURL: "https://www.zoocode.dev/api/gateway/v1",
				}),
			)
		})
	})

	describe("fetchModel", () => {
		it("returns configured model info", async () => {
			const handler = new ZooGatewayHandler(mockOptions)
			const result = await handler.fetchModel()

			expect(result.id).toBe(mockOptions.zooGatewayModelId)
			expect(result.info.maxTokens).toBe(64000)
			expect(result.info.supportsPromptCache).toBe(true)
		})

		it("falls back to the default model when none is configured", async () => {
			const handler = new ZooGatewayHandler({ zooSessionToken: "zoo_ext_test_token" })
			const result = await handler.fetchModel()

			expect(result.id).toBe(zooGatewayDefaultModelId)
		})
	})

	describe("createMessage", () => {
		beforeEach(() => {
			mockCreate.mockImplementation(async () => ({
				[Symbol.asyncIterator]: async function* () {
					yield {
						choices: [{ delta: { content: "Test response" }, index: 0 }],
						usage: null,
					}
					yield {
						choices: [{ delta: {}, index: 0 }],
						usage: {
							prompt_tokens: 10,
							completion_tokens: 5,
							total_tokens: 15,
							cache_creation_input_tokens: 2,
							prompt_tokens_details: { cached_tokens: 3 },
							cost: 0.005,
						},
					}
				},
			}))
		})

		it("streams text and usage chunks", async () => {
			const handler = new ZooGatewayHandler(mockOptions)
			const stream = handler.createMessage("You are helpful.", [{ role: "user", content: "Hello" }])

			const chunks = []
			for await (const chunk of stream) {
				chunks.push(chunk)
			}

			expect(chunks).toEqual([
				{ type: "text", text: "Test response" },
				{
					type: "usage",
					inputTokens: 10,
					outputTokens: 5,
					cacheWriteTokens: 2,
					cacheReadTokens: 3,
					totalCost: 0.005,
				},
			])
		})

		it("forwards task and mode metadata as request headers", async () => {
			const handler = new ZooGatewayHandler(mockOptions)

			await handler.createMessage("prompt", [], { taskId: "task-123", mode: "code" }).next()

			expect(mockCreate).toHaveBeenCalledWith(
				expect.any(Object),
				expect.objectContaining({
					headers: {
						"X-Zoo-Task-ID": "task-123",
						"X-Zoo-Mode": "code",
					},
				}),
			)
		})

		it("uses custom temperature when provided", async () => {
			const handler = new ZooGatewayHandler({
				...mockOptions,
				modelTemperature: 0.5,
			})

			await handler.createMessage("prompt", [{ role: "user", content: "Hi" }]).next()

			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					temperature: 0.5,
				}),
				expect.any(Object),
			)
		})

		it("uses the default temperature when none is provided", async () => {
			const handler = new ZooGatewayHandler(mockOptions)

			await handler.createMessage("prompt", [{ role: "user", content: "Hi" }]).next()

			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					temperature: ZOO_GATEWAY_DEFAULT_TEMPERATURE,
				}),
				expect.any(Object),
			)
		})

		it("adds cache breakpoints for supported models", async () => {
			const { addCacheBreakpoints } = await import("../../transform/caching/vercel-ai-gateway")
			const handler = new ZooGatewayHandler({
				...mockOptions,
				zooGatewayModelId: "anthropic/claude-3.5-haiku",
			})

			await handler.createMessage("prompt", [{ role: "user", content: "Hi" }]).next()

			expect(addCacheBreakpoints).toHaveBeenCalled()
		})

		it("yields tool_call_partial chunks when streaming tool calls", async () => {
			mockCreate.mockImplementation(async () => ({
				[Symbol.asyncIterator]: async function* () {
					yield {
						choices: [
							{
								delta: {
									tool_calls: [
										{
											index: 0,
											id: "call_123",
											function: { name: "test_tool", arguments: '{"arg1":' },
										},
									],
								},
								index: 0,
							},
						],
					}
				},
			}))

			const handler = new ZooGatewayHandler(mockOptions)
			const chunks = []
			for await (const chunk of handler.createMessage("prompt", [])) {
				chunks.push(chunk)
			}

			expect(chunks).toEqual([
				{
					type: "tool_call_partial",
					index: 0,
					id: "call_123",
					name: "test_tool",
					arguments: '{"arg1":',
				},
			])
		})
	})

	describe("completePrompt", () => {
		beforeEach(() => {
			mockCreate.mockImplementation(async () => ({
				choices: [{ message: { role: "assistant", content: "Test completion response" } }],
			}))
		})

		it("returns completion text from the gateway", async () => {
			const handler = new ZooGatewayHandler(mockOptions)

			const result = await handler.completePrompt("Complete this: Hello")

			expect(result).toBe("Test completion response")
			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					model: "anthropic/claude-sonnet-4",
					messages: [{ role: "user", content: "Complete this: Hello" }],
					stream: false,
					temperature: ZOO_GATEWAY_DEFAULT_TEMPERATURE,
					max_completion_tokens: 64000,
				}),
			)
		})

		it("wraps errors with a Zoo Gateway prefix", async () => {
			const handler = new ZooGatewayHandler(mockOptions)
			mockCreate.mockImplementation(() => {
				throw new Error("upstream failure")
			})

			await expect(handler.completePrompt("Test")).rejects.toThrow(
				"Zoo Gateway completion error: upstream failure",
			)
		})

		it("returns an empty string when the model returns no content", async () => {
			const handler = new ZooGatewayHandler(mockOptions)
			mockCreate.mockImplementation(async () => ({
				choices: [{ message: { role: "assistant", content: null } }],
			}))

			await expect(handler.completePrompt("Test")).resolves.toBe("")
		})
	})
})
