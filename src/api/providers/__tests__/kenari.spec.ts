// npx vitest run src/api/providers/__tests__/kenari.spec.ts

// Mock vscode first to avoid import errors
vitest.mock("vscode", () => ({
	workspace: {
		getConfiguration: () => ({
			get: (_key: string, defaultValue?: unknown) => defaultValue,
		}),
	},
}))

import { Anthropic } from "@anthropic-ai/sdk"
import OpenAI from "openai"

import { kenariDefaultModelId } from "@roo-code/types"

import { KenariHandler } from "../kenari"
import { ApiHandlerOptions } from "../../../shared/api"

vitest.mock("openai")
vitest.mock("delay", () => ({ default: vitest.fn(() => Promise.resolve()) }))
vitest.mock("../fetchers/modelCache", () => ({
	getModels: vitest.fn().mockImplementation(() =>
		Promise.resolve({
			"glm-5-2": {
				maxTokens: 32768,
				contextWindow: 1048576,
				supportsImages: false,
				supportsPromptCache: false,
				description: "GLM 5.2",
			},
		}),
	),
	getModelsFromCache: vitest.fn().mockReturnValue(undefined),
}))

const mockCreate = vitest.fn()

;(OpenAI as any).mockImplementation(function () {
	return {
		chat: { completions: { create: mockCreate } },
	}
})

describe("KenariHandler", () => {
	const mockOptions: ApiHandlerOptions = {
		kenariApiKey: "test-key",
		kenariModelId: "glm-5-2",
	}

	beforeEach(() => {
		vitest.clearAllMocks()
		mockCreate.mockClear()
	})

	it("initializes the OpenAI client with the Kenari base URL and key", () => {
		const handler = new KenariHandler(mockOptions)
		expect(handler).toBeInstanceOf(KenariHandler)
		expect(OpenAI).toHaveBeenCalledWith(
			expect.objectContaining({
				baseURL: "https://kenari.id/v1",
				apiKey: "test-key",
			}),
		)
	})

	describe("fetchModel", () => {
		it("returns the configured model info", async () => {
			const handler = new KenariHandler(mockOptions)
			const result = await handler.fetchModel()
			expect(result.id).toBe("glm-5-2")
			expect(result.info.maxTokens).toBe(32768)
			expect(result.info.contextWindow).toBe(1048576)
			expect(result.info.supportsPromptCache).toBe(false)
		})

		it("falls back to the default model id when none is configured", async () => {
			const handler = new KenariHandler({ kenariApiKey: "test-key" })
			const result = await handler.fetchModel()
			expect(result.id).toBe(kenariDefaultModelId)
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
			const handler = new KenariHandler(mockOptions)
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
			const handler = new KenariHandler(mockOptions)
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Hi" }]
			for await (const _chunk of handler.createMessage("sys", messages)) {
				void _chunk // drain
			}

			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					model: "glm-5-2",
					stream: true,
					stream_options: { include_usage: true },
					max_completion_tokens: 32768,
					temperature: expect.any(Number),
				}),
			)
		})
	})

	describe("completePrompt", () => {
		it("returns the message content for a non-streaming completion", async () => {
			mockCreate.mockResolvedValue({ choices: [{ message: { content: "the answer" } }] })
			const handler = new KenariHandler(mockOptions)
			expect(await handler.completePrompt("ping")).toBe("the answer")
			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					model: "glm-5-2",
					stream: false,
					max_completion_tokens: 32768,
				}),
			)
		})

		it("wraps errors with a Kenari-specific message", async () => {
			mockCreate.mockRejectedValue(new Error("boom"))
			const handler = new KenariHandler(mockOptions)
			await expect(handler.completePrompt("ping")).rejects.toThrow("Kenari completion error: boom")
		})
	})
})
