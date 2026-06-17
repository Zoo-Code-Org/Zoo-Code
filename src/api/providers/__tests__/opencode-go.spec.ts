// npx vitest run src/api/providers/__tests__/opencode-go.spec.ts

// Mock vscode first to avoid import errors
vitest.mock("vscode", () => ({}))

import { Anthropic } from "@anthropic-ai/sdk"
import OpenAI from "openai"

import { opencodeGoDefaultModelId } from "@roo-code/types"

import { OpencodeGoHandler } from "../opencode-go"
import { ApiHandlerOptions } from "../../../shared/api"

vitest.mock("openai")
vitest.mock("delay", () => ({
	default: vitest.fn(function () {
		return Promise.resolve()
	}),
}))
vitest.mock("../fetchers/modelCache", () => ({
	getModels: vitest.fn().mockImplementation(function () {
		return Promise.resolve({
			"glm-5.1": {
				maxTokens: 32768,
				contextWindow: 200000,
				supportsImages: false,
				supportsPromptCache: false,
				description: "GLM 5.1",
			},
		})
	}),
	getModelsFromCache: vitest.fn().mockReturnValue(undefined),
}))

const mockCreate = vitest.fn()

;(OpenAI as any).mockImplementation(function () {
	return {
		chat: { completions: { create: mockCreate } },
	}
})

describe("OpencodeGoHandler", () => {
	const mockOptions: ApiHandlerOptions = {
		opencodeGoApiKey: "test-key",
		opencodeGoModelId: "glm-5.1",
	}

	beforeEach(() => {
		vitest.clearAllMocks()
		mockCreate.mockClear()
	})

	it("initializes the OpenAI client with the Opencode Go base URL and key", () => {
		const handler = new OpencodeGoHandler(mockOptions)
		expect(handler).toBeInstanceOf(OpencodeGoHandler)
		expect(OpenAI).toHaveBeenCalledWith(
			expect.objectContaining({
				baseURL: "https://opencode.ai/zen/go/v1",
				apiKey: "test-key",
			}),
		)
	})

	describe("fetchModel", () => {
		it("returns the configured model info", async () => {
			const handler = new OpencodeGoHandler(mockOptions)
			const result = await handler.fetchModel()
			expect(result.id).toBe("glm-5.1")
			expect(result.info.maxTokens).toBe(32768)
			expect(result.info.contextWindow).toBe(200000)
			expect(result.info.supportsPromptCache).toBe(false)
		})

		it("falls back to the default model id when none is configured", async () => {
			const handler = new OpencodeGoHandler({ opencodeGoApiKey: "test-key" })
			const result = await handler.fetchModel()
			expect(result.id).toBe(opencodeGoDefaultModelId)
		})
	})

	describe("createMessage", () => {
		beforeEach(() => {
			mockCreate.mockImplementation(async () => ({
				[Symbol.asyncIterator]: async function* () {
					yield {
						choices: [
							{
								delta: {
									content: "Hello",
									reasoning_content: "thinking…",
									tool_calls: [
										{
											index: 0,
											id: "call_1",
											function: { name: "read_file", arguments: '{"path":' },
										},
									],
								},
								index: 0,
							},
						],
						usage: null,
					}
					yield {
						choices: [{ delta: {}, index: 0 }],
						usage: {
							prompt_tokens: 12,
							completion_tokens: 7,
							total_tokens: 19,
							prompt_tokens_details: { cached_tokens: 4 },
						},
					}
				},
			}))
		})

		it("streams text, reasoning, tool-call and usage chunks", async () => {
			const handler = new OpencodeGoHandler(mockOptions)
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Hi" }]

			const chunks = []
			for await (const chunk of handler.createMessage("You are helpful.", messages)) {
				chunks.push(chunk)
			}

			expect(chunks).toContainEqual({ type: "text", text: "Hello" })
			expect(chunks).toContainEqual({ type: "reasoning", text: "thinking…" })
			expect(chunks).toContainEqual({
				type: "tool_call_partial",
				index: 0,
				id: "call_1",
				name: "read_file",
				arguments: '{"path":',
			})
			expect(chunks).toContainEqual({
				type: "usage",
				inputTokens: 12,
				outputTokens: 7,
				cacheReadTokens: 4,
			})
		})

		it("requests a streaming completion with usage included", async () => {
			const handler = new OpencodeGoHandler(mockOptions)
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Hi" }]
			for await (const _chunk of handler.createMessage("sys", messages)) {
				void _chunk // drain
			}

			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					model: "glm-5.1",
					stream: true,
					stream_options: { include_usage: true },
					max_completion_tokens: 32768,
					temperature: expect.any(Number),
				}),
			)
		})

		it("streams reasoning chunks from delta.reasoning_content", async () => {
			mockCreate.mockImplementationOnce(async () => ({
				[Symbol.asyncIterator]: async function* () {
					yield { choices: [{ delta: { reasoning_content: "thinking..." }, index: 0 }] }
					yield { choices: [{ delta: { content: "answer" }, index: 0 }] }
					yield {
						choices: [{ delta: {}, index: 0 }],
						usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
					}
				},
			}))

			const handler = new OpencodeGoHandler(mockOptions)
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Hi" }]

			const chunks: any[] = []
			for await (const chunk of handler.createMessage("sys", messages)) {
				chunks.push(chunk)
			}

			expect(chunks).toContainEqual({ type: "reasoning", text: "thinking..." })
		})

		it("falls back to delta.reasoning when reasoning_content is absent", async () => {
			mockCreate.mockImplementationOnce(async () => ({
				[Symbol.asyncIterator]: async function* () {
					yield { choices: [{ delta: { reasoning: "router-style thought" }, index: 0 }] }
					yield {
						choices: [{ delta: {}, index: 0 }],
						usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
					}
				},
			}))

			const handler = new OpencodeGoHandler(mockOptions)
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Hi" }]

			const chunks: any[] = []
			for await (const chunk of handler.createMessage("sys", messages)) {
				chunks.push(chunk)
			}

			expect(chunks).toContainEqual({ type: "reasoning", text: "router-style thought" })
		})

		it("prefers delta.reasoning_content over delta.reasoning when both are present", async () => {
			mockCreate.mockImplementationOnce(async () => ({
				[Symbol.asyncIterator]: async function* () {
					yield {
						choices: [
							{
								delta: {
									reasoning_content: "primary thought",
									reasoning: "fallback thought",
								},
								index: 0,
							},
						],
					}
					yield {
						choices: [{ delta: {}, index: 0 }],
						usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
					}
				},
			}))

			const handler = new OpencodeGoHandler(mockOptions)
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Hi" }]

			const chunks: any[] = []
			for await (const chunk of handler.createMessage("sys", messages)) {
				chunks.push(chunk)
			}

			const reasoningChunks = chunks.filter((chunk) => chunk.type === "reasoning")
			expect(reasoningChunks).toEqual([{ type: "reasoning", text: "primary thought" }])
		})
	})

	describe("completePrompt", () => {
		it("returns the message content for a non-streaming completion", async () => {
			mockCreate.mockResolvedValue({ choices: [{ message: { content: "the answer" } }] })
			const handler = new OpencodeGoHandler(mockOptions)
			expect(await handler.completePrompt("ping")).toBe("the answer")
			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					model: "glm-5.1",
					stream: false,
					max_completion_tokens: 32768,
				}),
			)
		})

		it("wraps errors with an Opencode Go-specific message", async () => {
			mockCreate.mockRejectedValue(new Error("boom"))
			const handler = new OpencodeGoHandler(mockOptions)
			await expect(handler.completePrompt("ping")).rejects.toThrow("Opencode Go completion error: boom")
		})
	})
})
