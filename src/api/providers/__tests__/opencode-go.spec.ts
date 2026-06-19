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
					// glm-5.1 maxTokens (131_072) is clamped to 20% of its 204_800
					// context window => 40_960.
					max_completion_tokens: 40_960,
					temperature: expect.any(Number),
				}),
			)
		})

		it("forwards the model's default reasoning_effort for reasoning-capable models", async () => {
			const handler = new OpencodeGoHandler(mockOptions)
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Hi" }]
			for await (const _chunk of handler.createMessage("sys", messages)) {
				void _chunk // drain
			}

			// glm-5.1 advertises supportsReasoningEffort with a default of "medium".
			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					model: "glm-5.1",
					reasoning_effort: "medium",
				}),
			)
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

		it("honors includeMaxTokens/modelMaxTokens override for max_completion_tokens", async () => {
			const handler = new OpencodeGoHandler({ ...mockOptions, includeMaxTokens: true, modelMaxTokens: 999 })
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Hi" }]

			for await (const _chunk of handler.createMessage("sys", messages)) {
				void _chunk
			}

			expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ max_completion_tokens: 999 }))
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
					// glm-5.1 maxTokens (131_072) clamped to 20% of 204_800 => 40_960.
					max_completion_tokens: 40_960,
					reasoning_effort: "medium",
				}),
			)
		})

		it("wraps errors with an Opencode Go-specific message", async () => {
			mockCreate.mockRejectedValue(new Error("boom"))
			const handler = new OpencodeGoHandler(mockOptions)
			await expect(handler.completePrompt("ping")).rejects.toThrow("Opencode Go completion error: boom")
		})

		it("rethrows non-Error values unchanged", async () => {
			mockCreate.mockRejectedValue("not an error")
			const handler = new OpencodeGoHandler(mockOptions)
			await expect(handler.completePrompt("ping")).rejects.toBe("not an error")
		})

		it("returns an empty string when no content is returned", async () => {
			mockCreate.mockResolvedValue({ choices: [] })
			const handler = new OpencodeGoHandler(mockOptions)
			expect(await handler.completePrompt("ping")).toBe("")
		})

		it("honors includeMaxTokens/modelMaxTokens override for max_completion_tokens", async () => {
			mockCreate.mockResolvedValue({ choices: [{ message: { content: "ok" } }] })
			const handler = new OpencodeGoHandler({ ...mockOptions, includeMaxTokens: true, modelMaxTokens: 4321 })
			await handler.completePrompt("ping")
			expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ max_completion_tokens: 4321 }))
		})
	})

	describe("Anthropic-format models (qwen3.7-max)", () => {
		// qwen3.7-max is only reachable via the Anthropic Messages endpoint
		// (/v1/messages); sending it to /v1/chat/completions is what produces
		// "401 Model qwen3.7-max is not supported for format oa-compat".
		const anthropicOptions: ApiHandlerOptions = {
			opencodeGoApiKey: "test-key",
			opencodeGoModelId: "qwen3.7-max",
		}

		beforeEach(() => {
			mockAnthropicCreate.mockImplementation(async () => ({
				[Symbol.asyncIterator]: async function* () {
					yield {
						type: "message_start",
						message: {
							usage: {
								input_tokens: 10,
								output_tokens: 0,
								cache_creation_input_tokens: 2,
								cache_read_input_tokens: 3,
							},
						},
					}
					yield {
						type: "content_block_start",
						index: 0,
						content_block: { type: "text", text: "" },
					}
					yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } }
					yield {
						type: "content_block_start",
						index: 1,
						content_block: { type: "tool_use", id: "toolu_1", name: "read_file", input: {} },
					}
					yield {
						type: "content_block_delta",
						index: 1,
						delta: { type: "input_json_delta", partial_json: '{"path":' },
					}
					yield { type: "content_block_stop", index: 1 }
					yield { type: "message_delta", usage: { output_tokens: 5 } }
					yield { type: "message_stop" }
				},
			}))
		})

		it("routes the request through the Anthropic /v1/messages client, not chat completions", async () => {
			const handler = new OpencodeGoHandler(anthropicOptions)
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Hi" }]

			for await (const _chunk of handler.createMessage("sys", messages)) {
				void _chunk // drain
			}

			expect(mockAnthropicCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					model: "qwen3.7-max",
					stream: true,
					system: expect.arrayContaining([expect.objectContaining({ type: "text", text: "sys" })]),
				}),
			)
			// The OpenAI chat completions endpoint must NOT be used for this model.
			expect(mockCreate).not.toHaveBeenCalled()
		})

		it("streams text, tool-call, usage and cost chunks from the Anthropic stream", async () => {
			const handler = new OpencodeGoHandler(anthropicOptions)
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Hi" }]

			const chunks: any[] = []
			for await (const chunk of handler.createMessage("sys", messages)) {
				chunks.push(chunk)
			}

			expect(chunks).toContainEqual({ type: "text", text: "Hello" })
			expect(chunks).toContainEqual({
				type: "tool_call_partial",
				index: 1,
				id: "toolu_1",
				name: "read_file",
				arguments: undefined,
			})
			expect(chunks).toContainEqual({
				type: "tool_call_partial",
				index: 1,
				id: undefined,
				name: undefined,
				arguments: '{"path":',
			})
			// message_start usage (with cache tokens) ...
			expect(chunks).toContainEqual({
				type: "usage",
				inputTokens: 10,
				outputTokens: 0,
				cacheWriteTokens: 2,
				cacheReadTokens: 3,
			})
			// ... message_delta output tokens ...
			expect(chunks).toContainEqual({ type: "usage", inputTokens: 0, outputTokens: 5 })
			// ... and a final cost chunk. Assert totalCost > 0 (not just
			// defined) so CI catches the output-token accumulation regression —
			// without accumulation the cost would be computed from
			// outputTokens: 0 and report ~$0.
			expect(chunks.some((c) => c.type === "usage" && typeof c.totalCost === "number" && c.totalCost > 0)).toBe(
				true,
			)
		})

		it("applies cache-control breakpoints when the model supports prompt caching", async () => {
			const handler = new OpencodeGoHandler(anthropicOptions)
			const messages: Anthropic.Messages.MessageParam[] = [
				{ role: "user", content: "first" },
				{ role: "assistant", content: "ok" },
				{ role: "user", content: "second" },
			]

			for await (const _chunk of handler.createMessage("sys", messages)) {
				void _chunk // drain
			}

			const callArgs = mockAnthropicCreate.mock.calls[0][0] as {
				system: Array<{ cache_control?: unknown }>
				messages: Array<{ content: unknown }>
			}
			// qwen3.7-max advertises supportsPromptCache, so the system prompt
			// gets an ephemeral cache_control breakpoint.
			expect(callArgs.system[0].cache_control).toEqual({ type: "ephemeral" })
		})

		it("completePrompt uses the Anthropic messages endpoint and returns text content", async () => {
			mockAnthropicCreate.mockResolvedValue({
				content: [{ type: "text", text: "the answer" }],
			})

			const handler = new OpencodeGoHandler(anthropicOptions)
			expect(await handler.completePrompt("ping")).toBe("the answer")
			expect(mockAnthropicCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					model: "qwen3.7-max",
					stream: false,
					messages: [{ role: "user", content: "ping" }],
					// qwen3.7-max maxTokens (65_536) clamped to 20% of its 1M
					// context window (200_000) => 65_536. includeMaxTokens is off,
					// so the model default is used.
					max_tokens: 65_536,
				}),
			)
			expect(mockCreate).not.toHaveBeenCalled()
		})

		it("completePrompt honors includeMaxTokens/modelMaxTokens override for max_tokens", async () => {
			mockAnthropicCreate.mockResolvedValue({
				content: [{ type: "text", text: "ok" }],
			})

			const handler = new OpencodeGoHandler({
				...anthropicOptions,
				includeMaxTokens: true,
				modelMaxTokens: 2048,
			})
			await handler.completePrompt("ping")
			expect(mockAnthropicCreate).toHaveBeenCalledWith(expect.objectContaining({ max_tokens: 2048 }))
		})

		it("completePrompt rethrows non-Error values unchanged from the Anthropic path", async () => {
			mockAnthropicCreate.mockRejectedValue("not an error")
			const handler = new OpencodeGoHandler(anthropicOptions)
			await expect(handler.completePrompt("ping")).rejects.toBe("not an error")
		})

		it("completePrompt returns an empty string when no text content is returned", async () => {
			mockAnthropicCreate.mockResolvedValue({ content: [{ type: "tool_use", id: "x", name: "n", input: {} }] })
			const handler = new OpencodeGoHandler(anthropicOptions)
			expect(await handler.completePrompt("ping")).toBe("")
		})

		it("omits tools and tool_choice from the Anthropic request when no tools are provided", async () => {
			const handler = new OpencodeGoHandler(anthropicOptions)
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Hi" }]

			for await (const _chunk of handler.createMessage("sys", messages)) {
				void _chunk
			}

			const callArgs = mockAnthropicCreate.mock.calls[0][0] as Record<string, unknown>
			// Disable-tools path: with no tools, neither field is sent so the
			// gateway doesn't force a tool-use-only turn.
			expect(callArgs.tools).toBeUndefined()
			expect(callArgs.tool_choice).toBeUndefined()
		})

		it("includes tools and tool_choice in the Anthropic request when tools are provided", async () => {
			const handler = new OpencodeGoHandler(anthropicOptions)
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Hi" }]
			const tools: OpenAI.Chat.ChatCompletionTool[] = [
				{
					type: "function",
					function: {
						name: "read_file",
						description: "read a file",
						parameters: { type: "object", properties: {} },
					},
				},
			]

			for await (const _chunk of handler.createMessage("sys", messages, { taskId: "test-task", tools })) {
				void _chunk
			}

			const callArgs = mockAnthropicCreate.mock.calls[0][0] as Record<string, unknown>
			expect(Array.isArray(callArgs.tools)).toBe(true)
			expect((callArgs.tools as unknown[]).length).toBe(1)
			expect(callArgs.tool_choice).toBeDefined()
		})

		it("skips cache-control breakpoints when the Anthropic-format model does not support prompt caching", async () => {
			vitest.mocked(getModels).mockImplementationOnce(async () => ({
				"qwen3.7-max": { ...opencodeGoModels["qwen3.7-max"], supportsPromptCache: false },
			}))

			const handler = new OpencodeGoHandler(anthropicOptions)
			const messages: Anthropic.Messages.MessageParam[] = [
				{ role: "user", content: "first" },
				{ role: "assistant", content: "ok" },
				{ role: "user", content: "second" },
			]

			for await (const _chunk of handler.createMessage("sys", messages)) {
				void _chunk
			}

			const callArgs = mockAnthropicCreate.mock.calls[0][0] as {
				system: Array<{ cache_control?: unknown }>
				messages: Array<{ cache_control?: unknown }>
			}
			expect(callArgs.system[0].cache_control).toBeUndefined()
			expect(callArgs.messages.every((m) => m.cache_control === undefined)).toBe(true)
		})

		it("applies cache-control to the last block of array-content user messages", async () => {
			const handler = new OpencodeGoHandler(anthropicOptions)
			const messages: Anthropic.Messages.MessageParam[] = [
				{ role: "user", content: [{ type: "text", text: "first" }] },
				{ role: "assistant", content: "ok" },
				{
					role: "user",
					content: [
						{ type: "text", text: "part-a" },
						{ type: "text", text: "part-b" },
					],
				},
			]

			for await (const _chunk of handler.createMessage("sys", messages)) {
				void _chunk
			}

			const callArgs = mockAnthropicCreate.mock.calls[0][0] as { messages: Array<{ content: any }> }
			const lastUserMsg = callArgs.messages[callArgs.messages.length - 1]
			const blocks = lastUserMsg.content as any[]
			// Only the final content block of the last user message is cached.
			expect(blocks[blocks.length - 1].cache_control).toEqual({ type: "ephemeral" })
			expect(blocks[0].cache_control).toBeUndefined()
		})

		it("leaves messages unchanged when there are no user messages to cache", async () => {
			const handler = new OpencodeGoHandler(anthropicOptions)
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "assistant", content: "only assistant" }]

			for await (const _chunk of handler.createMessage("sys", messages)) {
				void _chunk
			}

			const callArgs = mockAnthropicCreate.mock.calls[0][0] as {
				messages: Array<{ cache_control?: unknown }>
			}
			expect(callArgs.messages.every((m) => m.cache_control === undefined)).toBe(true)
		})

		it("streams thinking content blocks and thinking deltas", async () => {
			mockAnthropicCreate.mockImplementationOnce(async () => ({
				[Symbol.asyncIterator]: async function* () {
					yield { type: "message_start", message: { usage: { input_tokens: 5, output_tokens: 0 } } }
					// index 0: thinking block (no leading newline at index 0).
					yield {
						type: "content_block_start",
						index: 0,
						content_block: { type: "thinking", thinking: "initial thought" },
					}
					yield {
						type: "content_block_delta",
						index: 0,
						delta: { type: "thinking_delta", thinking: " more" },
					}
					// index 1: text block gets a leading newline separator.
					yield { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }
					yield { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "answer" } }
					// index 2: a second thinking block also gets a newline separator.
					yield {
						type: "content_block_start",
						index: 2,
						content_block: { type: "thinking", thinking: "second thought" },
					}
					yield { type: "message_delta", usage: { output_tokens: 3 } }
					yield { type: "message_stop" }
				},
			}))

			const handler = new OpencodeGoHandler(anthropicOptions)
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Hi" }]

			const chunks: any[] = []
			for await (const chunk of handler.createMessage("sys", messages)) {
				chunks.push(chunk)
			}

			// index 0 thinking block (no leading newline separator at index 0).
			expect(chunks).toContainEqual({ type: "reasoning", text: "initial thought" })
			expect(chunks).toContainEqual({ type: "reasoning", text: " more" })
			// index 1 text block gets a leading newline separator.
			expect(chunks).toContainEqual({ type: "text", text: "\n" })
			expect(chunks).toContainEqual({ type: "text", text: "answer" })
			// index 2 thinking block gets a leading newline separator.
			expect(chunks).toContainEqual({ type: "reasoning", text: "\n" })
			expect(chunks).toContainEqual({ type: "reasoning", text: "second thought" })
		})

		it("honors includeMaxTokens/modelMaxTokens override for the streaming Anthropic max_tokens", async () => {
			const handler = new OpencodeGoHandler({
				...anthropicOptions,
				includeMaxTokens: true,
				modelMaxTokens: 8192,
			})
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Hi" }]

			for await (const _chunk of handler.createMessage("sys", messages)) {
				void _chunk
			}

			expect(mockAnthropicCreate).toHaveBeenCalledWith(expect.objectContaining({ max_tokens: 8192 }))
		})

		it("falls back to the model max_tokens when includeMaxTokens is on but modelMaxTokens is unset", async () => {
			const handler = new OpencodeGoHandler({ ...anthropicOptions, includeMaxTokens: true })
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Hi" }]

			for await (const _chunk of handler.createMessage("sys", messages)) {
				void _chunk
			}

			// qwen3.7-max maxTokens (65_536) clamped to 20% of 1M context => 65_536.
			expect(mockAnthropicCreate).toHaveBeenCalledWith(expect.objectContaining({ max_tokens: 65_536 }))
		})

		it("accumulates output tokens across message_delta events into the final cost", async () => {
			mockAnthropicCreate.mockImplementationOnce(async () => ({
				[Symbol.asyncIterator]: async function* () {
					yield { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 0 } } }
					yield { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }
					yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } }
					yield { type: "message_delta", usage: { output_tokens: 4 } }
					yield { type: "message_delta", usage: { output_tokens: 6 } }
					yield { type: "message_stop" }
				},
			}))

			const handler = new OpencodeGoHandler(anthropicOptions)
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Hi" }]

			const chunks: any[] = []
			for await (const chunk of handler.createMessage("sys", messages)) {
				chunks.push(chunk)
			}

			const costChunk = chunks.find((c) => c.type === "usage" && c.totalCost !== undefined)
			expect(costChunk).toBeDefined()
			// qwen3.7-max: input $2.5/M, output $7.5/M. Accumulated output
			// tokens (4 + 6 = 10) must feed the cost calc — without the
			// accumulation fix this would only reflect the 10 input tokens
			// (0.000025) instead of input + output (0.0001).
			expect(costChunk.totalCost).toBeCloseTo((10 * 2.5 + 10 * 7.5) / 1_000_000, 10)
		})

		it("does not yield a cost chunk when the stream reports no token usage", async () => {
			mockAnthropicCreate.mockImplementationOnce(async () => ({
				[Symbol.asyncIterator]: async function* () {
					yield { type: "message_start", message: { usage: { input_tokens: 0, output_tokens: 0 } } }
					yield { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }
					yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } }
					yield { type: "message_delta", usage: { output_tokens: 0 } }
					yield { type: "message_stop" }
				},
			}))

			const handler = new OpencodeGoHandler(anthropicOptions)
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Hi" }]

			const chunks: any[] = []
			for await (const chunk of handler.createMessage("sys", messages)) {
				chunks.push(chunk)
			}

			expect(chunks.some((c) => c.type === "usage" && c.totalCost !== undefined)).toBe(false)
		})

		it("completePrompt wraps Anthropic errors with an Opencode Go-specific message", async () => {
			mockAnthropicCreate.mockRejectedValue(new Error("boom"))
			const handler = new OpencodeGoHandler(anthropicOptions)
			await expect(handler.completePrompt("ping")).rejects.toThrow("Opencode Go completion error: boom")
		})

		it("wraps pre-stream Anthropic errors from createMessage with an Opencode Go-specific message", async () => {
			// Pre-stream failures (401, 429, network) reject the create() call
			// before any chunk is emitted; they must be wrapped consistently
			// with completePrompt rather than propagating raw.
			mockAnthropicCreate.mockRejectedValue(new Error("rate limited"))
			const handler = new OpencodeGoHandler(anthropicOptions)
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Hi" }]
			await expect(async () => {
				for await (const _chunk of handler.createMessage("sys", messages)) {
					void _chunk
				}
			}).rejects.toThrow("Opencode Go completion error: rate limited")
		})
	})

	describe("isOpencodeGoAnthropicFormatModel", () => {
		it("classifies Qwen and MiniMax Go models as Anthropic-format", () => {
			expect(isOpencodeGoAnthropicFormatModel("qwen3.7-max")).toBe(true)
			expect(isOpencodeGoAnthropicFormatModel("qwen3.7-plus")).toBe(true)
			expect(isOpencodeGoAnthropicFormatModel("qwen3.6-plus")).toBe(true)
			expect(isOpencodeGoAnthropicFormatModel("minimax-m3")).toBe(true)
			expect(isOpencodeGoAnthropicFormatModel("minimax-m2.7")).toBe(true)
			expect(isOpencodeGoAnthropicFormatModel("minimax-m2.5")).toBe(true)
		})

		it("classifies OpenAI-compatible Go models as non-Anthropic-format", () => {
			expect(isOpencodeGoAnthropicFormatModel("glm-5.2")).toBe(false)
			expect(isOpencodeGoAnthropicFormatModel("kimi-k2.6")).toBe(false)
			expect(isOpencodeGoAnthropicFormatModel("deepseek-v4-pro")).toBe(false)
			expect(isOpencodeGoAnthropicFormatModel("mimo-v2.5")).toBe(false)
		})

		it("defaults unknown model IDs to the OpenAI-compatible format", () => {
			expect(isOpencodeGoAnthropicFormatModel("some-unknown-model")).toBe(false)
		})
	})
})
