// npx vitest run src/api/providers/__tests__/opencode-go.spec.ts

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

import { opencodeGoDefaultModelId, opencodeGoModels, isOpencodeGoAnthropicFormatModel } from "@roo-code/types"

import { OpencodeGoHandler } from "../opencode-go"
import { getModels } from "../fetchers/modelCache"
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
			// Use the native registry entry so capability flags (reasoning
			// effort, preserveReasoning, prompt cache) are exercised.
			"glm-5.1": { ...opencodeGoModels["glm-5.1"] },
			// Anthropic-format model used to exercise the /v1/messages path.
			"qwen3.7-max": { ...opencodeGoModels["qwen3.7-max"] },
		})
	}),
	getModelsFromCache: vitest.fn().mockReturnValue(undefined),
}))

const mockCreate = vitest.fn()
const mockAnthropicCreate = vitest.fn()

;(OpenAI as any).mockImplementation(function () {
	return {
		chat: { completions: { create: mockCreate } },
	}
})

vitest.mock("@anthropic-ai/sdk", () => ({
	Anthropic: vitest.fn(function () {
		return {
			messages: {
				create: mockAnthropicCreate,
			},
		}
	}),
}))

describe("OpencodeGoHandler", () => {
	const mockOptions: ApiHandlerOptions = {
		opencodeGoApiKey: "test-key",
		opencodeGoModelId: "glm-5.1",
	}

	beforeEach(() => {
		vitest.clearAllMocks()
		mockCreate.mockClear()
		mockAnthropicCreate.mockClear()
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

	it("initializes an Anthropic client rooted at /zen/go (SDK appends /v1/messages)", () => {
		new OpencodeGoHandler(mockOptions)
		expect(Anthropic).toHaveBeenCalledWith(
			expect.objectContaining({
				// The Anthropic SDK posts to `/v1/messages`, so the base URL must
				// NOT include the trailing `/v1` used by the OpenAI client.
				baseURL: "https://opencode.ai/zen/go",
				apiKey: "test-key",
			}),
		)
	})

	describe("fetchModel", () => {
		it("returns the configured model info with native capability flags", async () => {
			const handler = new OpencodeGoHandler(mockOptions)
			const result = await handler.fetchModel()
			expect(result.id).toBe("glm-5.1")
			// Native registry values for glm-5.1.
			expect(result.info.maxTokens).toBe(131_072)
			expect(result.info.contextWindow).toBe(204_800)
			expect(result.info.supportsPromptCache).toBe(true)
			expect(result.info.supportsReasoningEffort).toEqual(["disable", "medium"])
			expect(result.info.preserveReasoning).toBe(true)
			expect(result.info.supportsMaxTokens).toBe(true)
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

		it("requests a streaming completion with usage included and native max tokens", async () => {
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
					// glm-5.1 maxTokens is 131_072 (native registry value).
					max_completion_tokens: 131_072,
					temperature: expect.any(Number),
				}),
				expect.objectContaining({ signal: expect.any(AbortSignal) }),
			)
		})

		// The OpenAI completion path does not inject reasoning_effort —
		// reasoning is controlled server-side by the Go gateway.
		it("does not inject reasoning_effort into OpenAI-style requests", async () => {
			const handler = new OpencodeGoHandler(mockOptions)
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Hi" }]
			for await (const _chunk of handler.createMessage("sys", messages)) {
				void _chunk // drain
			}

			const callArgs = mockCreate.mock.calls[0][0] as Record<string, unknown>
			expect(callArgs.reasoning_effort).toBeUndefined()
		})

		it("omits reasoning_effort when the user disables reasoning", async () => {
			const handler = new OpencodeGoHandler({ ...mockOptions, reasoningEffort: "disable" })
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Hi" }]
			for await (const _chunk of handler.createMessage("sys", messages)) {
				void _chunk // drain
			}

			const callArgs = mockCreate.mock.calls[0][0] as Record<string, unknown>
			expect(callArgs.reasoning_effort).toBeUndefined()
		})

		it("uses convertToR1Format for preserveReasoning models to keep interleaved thinking", async () => {
			const handler = new OpencodeGoHandler(mockOptions)
			const messages: Anthropic.Messages.MessageParam[] = [
				{
					role: "user",
					content: [{ type: "text", text: "Hi" }],
				},
			]
			for await (const _chunk of handler.createMessage("sys", messages)) {
				void _chunk // drain
			}

			const callArgs = mockCreate.mock.calls[0][0] as { messages: Array<{ role: string }> }
			// The system prompt is prepended, then the R1-converted user message.
			expect(callArgs.messages[0]).toEqual({ role: "system", content: "sys" })
			// convertToR1Format keeps a single user turn as one user message.
			expect(callArgs.messages.filter((m) => m.role === "user")).toHaveLength(1)
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

		it("uses convertToOpenAiMessages for non-preserveReasoning models", async () => {
			// kimi-k2.6 has no preserveReasoning flag, so messages bypass
			// convertToR1Format and go through the plain OpenAI converter.
			vitest.mocked(getModels).mockImplementationOnce(async () => ({
				"kimi-k2.6": { ...opencodeGoModels["kimi-k2.6"] },
			}))
			mockCreate.mockImplementationOnce(async () => ({
				[Symbol.asyncIterator]: async function* () {
					yield { choices: [{ delta: { content: "Hi" }, index: 0 }] }
					yield {
						choices: [{ delta: {}, index: 0 }],
						usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
					}
				},
			}))

			const handler = new OpencodeGoHandler({ ...mockOptions, opencodeGoModelId: "kimi-k2.6" })
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Hi" }]

			for await (const _chunk of handler.createMessage("sys", messages)) {
				void _chunk
			}

			const callArgs = mockCreate.mock.calls[0][0] as { messages: Array<{ role: string }> }
			expect(callArgs.messages[0]).toEqual({ role: "system", content: "sys" })
			// A single user turn stays a single user message after OpenAI conversion.
			expect(callArgs.messages.filter((m) => m.role === "user")).toHaveLength(1)
		})

		it("emits a usage chunk with zeroed tokens when the stream reports no usage", async () => {
			mockCreate.mockImplementationOnce(async () => ({
				[Symbol.asyncIterator]: async function* () {
					yield { choices: [{ delta: { content: "Hi" }, index: 0 }] }
					yield {
						choices: [{ delta: {}, index: 0 }],
						usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
					}
				},
			}))

			const handler = new OpencodeGoHandler(mockOptions)
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Hi" }]

			const chunks: any[] = []
			for await (const chunk of handler.createMessage("sys", messages)) {
				chunks.push(chunk)
			}

			expect(chunks).toContainEqual({ type: "usage", inputTokens: 0, outputTokens: 0 })
		})

		it("uses native model maxTokens even with includeMaxTokens set", async () => {
			const handler = new OpencodeGoHandler({ ...mockOptions, includeMaxTokens: true, modelMaxTokens: 999 })
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Hi" }]

			for await (const _chunk of handler.createMessage("sys", messages)) {
				void _chunk
			}

			// OpenAI path uses info.maxTokens directly (131_072); includeMaxTokens
			// only affects the Anthropic-format path.
			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({ max_completion_tokens: 131_072 }),
				expect.objectContaining({ signal: expect.any(AbortSignal) }),
			)
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
					// glm-5.1 maxTokens is 131_072 (native registry value).
					max_completion_tokens: 131_072,
				}),
				expect.objectContaining({ signal: expect.any(AbortSignal) }),
			)
		})

		it("wraps errors with an Opencode Go-specific message", async () => {
			mockCreate.mockRejectedValue(new Error("boom"))
			const handler = new OpencodeGoHandler(mockOptions)
			await expect(handler.completePrompt("ping")).rejects.toThrow("Opencode Go completion error: boom")
		})

		it("rethrows non-Error values without wrapping", async () => {
			mockCreate.mockRejectedValue("raw string error")
			const handler = new OpencodeGoHandler(mockOptions)
			await expect(handler.completePrompt("ping")).rejects.toBe("raw string error")
		})
	})
})
