// npx vitest run src/api/providers/__tests__/opencode-go.spec.ts

// Mock vscode first to avoid import errors
vitest.mock("vscode", () => ({
	workspace: {
		getConfiguration: () => ({
			get: (_key: string, defaultValue?: unknown) => defaultValue,
		}),
	},
}))

import {
	Anthropic,
	APIConnectionTimeoutError as AnthropicTimeoutError,
	APIUserAbortError as AnthropicAbortError,
} from "@anthropic-ai/sdk"
import OpenAI, { APIConnectionTimeoutError, APIUserAbortError } from "openai"

import {
	opencodeGoDefaultModelId,
	opencodeGoModels,
	isOpencodeGoAnthropicFormatModel,
	isOpencodeGoResponsesFormatModel,
} from "@roo-code/types"

import { OpencodeGoHandler } from "../opencode-go"
import { getModels } from "../fetchers/modelCache"
import { ApiHandlerOptions } from "../../../shared/api"
import { asyncStreamFrom, collectStream } from "../../../test-utils/stream"
import { clearAllMocks } from "../../../test-utils/reset"
import { makeCreateMessageMetadata } from "../../../test-utils/api"

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
			// Responses-format model (Zoo-Code-Org/Zoo-Code#1431).
			"gpt-5.6-luna": { ...opencodeGoModels["gpt-5.6-luna"] },
		})
	}),
	refreshModels: vitest.fn().mockImplementation(function () {
		return Promise.resolve({
			"glm-5.1": { ...opencodeGoModels["glm-5.1"] },
			"qwen3.7-max": { ...opencodeGoModels["qwen3.7-max"] },
			"gpt-5.6-luna": { ...opencodeGoModels["gpt-5.6-luna"] },
		})
	}),
	getModelsFromCache: vitest.fn().mockReturnValue(undefined),
}))

const mockCreate = vitest.fn()
const mockAnthropicCreate = vitest.fn()
const mockResponsesCreate = vitest.fn()

;(OpenAI as any).mockImplementation(function () {
	return {
		chat: { completions: { create: mockCreate } },
		responses: { create: mockResponsesCreate },
	}
})

// The real SDK error classes are re-exported alongside the mocked client so
// tests can emulate the SDK's abort/timeout rejections and the provider's
// instanceof checks resolve against the same class identity.
vitest.mock("@anthropic-ai/sdk", async () => {
	const actual = await vi.importActual<typeof import("@anthropic-ai/sdk")>("@anthropic-ai/sdk")
	return {
		...actual,
		Anthropic: vitest.fn(function () {
			return {
				messages: {
					create: mockAnthropicCreate,
				},
			}
		}),
	}
})

describe("OpencodeGoHandler", () => {
	const mockOptions: ApiHandlerOptions = {
		opencodeGoApiKey: "test-key",
		opencodeGoModelId: "glm-5.1",
	}

	beforeEach(() => {
		clearAllMocks()
		mockCreate.mockClear()
		mockAnthropicCreate.mockClear()
		mockResponsesCreate.mockClear()
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
			mockCreate.mockImplementation(async () =>
				asyncStreamFrom([
					{
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
					},
					{
						choices: [{ delta: {}, index: 0 }],
						usage: {
							prompt_tokens: 12,
							completion_tokens: 7,
							total_tokens: 19,
							prompt_tokens_details: { cached_tokens: 4 },
						},
					},
				]),
			)
		})

		it("streams text, reasoning, tool-call and usage chunks", async () => {
			const handler = new OpencodeGoHandler(mockOptions)
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Hi" }]

			const chunks = await collectStream(handler.createMessage("You are helpful.", messages))

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
			await collectStream(handler.createMessage("sys", messages))

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
				expect.objectContaining({ signal: expect.any(AbortSignal) }),
			)
		})

		it("forwards the model's default reasoning_effort for reasoning-capable models", async () => {
			const handler = new OpencodeGoHandler(mockOptions)
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Hi" }]
			await collectStream(handler.createMessage("sys", messages))

			// glm-5.1 advertises supportsReasoningEffort with a default of "medium".
			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					model: "glm-5.1",
					reasoning_effort: "medium",
				}),
				expect.objectContaining({ signal: expect.any(AbortSignal) }),
			)
		})

		it("omits reasoning_effort when the user disables reasoning", async () => {
			const handler = new OpencodeGoHandler({ ...mockOptions, reasoningEffort: "disable" })
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Hi" }]
			await collectStream(handler.createMessage("sys", messages))

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
			await collectStream(handler.createMessage("sys", messages))

			const callArgs = mockCreate.mock.calls[0][0] as { messages: Array<{ role: string }> }
			// The system prompt is prepended, then the R1-converted user message.
			expect(callArgs.messages[0]).toEqual({ role: "system", content: "sys" })
			// convertToR1Format keeps a single user turn as one user message.
			expect(callArgs.messages.filter((m) => m.role === "user")).toHaveLength(1)
		})

		it("streams reasoning chunks from delta.reasoning_content", async () => {
			mockCreate.mockImplementationOnce(async () =>
				asyncStreamFrom([
					{ choices: [{ delta: { reasoning_content: "thinking..." }, index: 0 }] },
					{ choices: [{ delta: { content: "answer" }, index: 0 }] },
					{
						choices: [{ delta: {}, index: 0 }],
						usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
					},
				]),
			)

			const handler = new OpencodeGoHandler(mockOptions)
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Hi" }]

			const chunks = await collectStream(handler.createMessage("sys", messages))

			expect(chunks).toContainEqual({ type: "reasoning", text: "thinking..." })
		})

		it("falls back to delta.reasoning when reasoning_content is absent", async () => {
			mockCreate.mockImplementationOnce(async () =>
				asyncStreamFrom([
					{ choices: [{ delta: { reasoning: "router-style thought" }, index: 0 }] },
					{
						choices: [{ delta: {}, index: 0 }],
						usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
					},
				]),
			)

			const handler = new OpencodeGoHandler(mockOptions)
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Hi" }]

			const chunks = await collectStream(handler.createMessage("sys", messages))

			expect(chunks).toContainEqual({ type: "reasoning", text: "router-style thought" })
		})

		it("prefers delta.reasoning_content over delta.reasoning when both are present", async () => {
			mockCreate.mockImplementationOnce(async () =>
				asyncStreamFrom([
					{
						choices: [
							{
								delta: {
									reasoning_content: "primary thought",
									reasoning: "fallback thought",
								},
								index: 0,
							},
						],
					},
					{
						choices: [{ delta: {}, index: 0 }],
						usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
					},
				]),
			)

			const handler = new OpencodeGoHandler(mockOptions)
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Hi" }]

			const chunks = await collectStream(handler.createMessage("sys", messages))

			const reasoningChunks = chunks.filter((chunk) => chunk.type === "reasoning")
			expect(reasoningChunks).toEqual([{ type: "reasoning", text: "primary thought" }])
		})

		it("uses convertToOpenAiMessages for non-preserveReasoning models", async () => {
			// kimi-k2.6 has no preserveReasoning flag, so messages bypass
			// convertToR1Format and go through the plain OpenAI converter.
			vitest.mocked(getModels).mockImplementationOnce(async () => ({
				"kimi-k2.6": { ...opencodeGoModels["kimi-k2.6"] },
			}))
			mockCreate.mockImplementationOnce(async () =>
				asyncStreamFrom([
					{ choices: [{ delta: { content: "Hi" }, index: 0 }] },
					{
						choices: [{ delta: {}, index: 0 }],
						usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
					},
				]),
			)

			const handler = new OpencodeGoHandler({ ...mockOptions, opencodeGoModelId: "kimi-k2.6" })
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Hi" }]

			await collectStream(handler.createMessage("sys", messages))

			const callArgs = mockCreate.mock.calls[0][0] as { messages: Array<{ role: string }> }
			expect(callArgs.messages[0]).toEqual({ role: "system", content: "sys" })
			// A single user turn stays a single user message after OpenAI conversion.
			expect(callArgs.messages.filter((m) => m.role === "user")).toHaveLength(1)
		})

		it("emits a usage chunk with zeroed tokens when the stream reports no usage", async () => {
			mockCreate.mockImplementationOnce(async () =>
				asyncStreamFrom([
					{ choices: [{ delta: { content: "Hi" }, index: 0 }] },
					{
						choices: [{ delta: {}, index: 0 }],
						usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
					},
				]),
			)

			const handler = new OpencodeGoHandler(mockOptions)
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Hi" }]

			const chunks = await collectStream(handler.createMessage("sys", messages))

			expect(chunks).toContainEqual({ type: "usage", inputTokens: 0, outputTokens: 0 })
		})

		it("honors includeMaxTokens/modelMaxTokens override for max_completion_tokens", async () => {
			const handler = new OpencodeGoHandler({ ...mockOptions, includeMaxTokens: true, modelMaxTokens: 999 })
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Hi" }]

			await collectStream(handler.createMessage("sys", messages))

			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({ max_completion_tokens: 999 }),
				expect.objectContaining({ signal: expect.any(AbortSignal) }),
			)
		})

		it("rethrows non-abort errors from the OpenAI stream unchanged", async () => {
			// A mid-stream failure that is not an abort (e.g. a connection
			// reset) must propagate unchanged — the catch only normalizes
			// aborts to a DOM-standard AbortError.
			const streamError = new Error("connection reset")
			mockCreate.mockImplementation(async () =>
				(async function* () {
					yield { choices: [{ delta: { content: "partial" }, index: 0 }], index: 0 }
					throw streamError
				})(),
			)

			const handler = new OpencodeGoHandler(mockOptions)

			const error = await collectStream(handler.createMessage("sys", [{ role: "user", content: "hi" }])).then(
				() => undefined,
				(e: unknown) => e,
			)

			expect(error).toBe(streamError)
		})
	})

	describe("createMessage abort signal bridging", () => {
		it("rejects with an AbortError when the external signal is already aborted", async () => {
			mockCreate.mockImplementation(async () => {
				throw new DOMException("The operation was aborted.", "AbortError")
			})

			const handler = new OpencodeGoHandler(mockOptions)
			const controller = new AbortController()
			controller.abort()

			const stream = handler.createMessage(
				"sys",
				[{ role: "user", content: "hi" }],
				makeCreateMessageMetadata({ abortSignal: controller.signal }),
			)

			await expect(collectStream(stream)).rejects.toMatchObject({ name: "AbortError" })
		})

		it("aborts the in-flight request when the external signal fires mid-stream", async () => {
			let capturedSignal: AbortSignal | undefined
			mockCreate.mockImplementation(async (_params: unknown, options: { signal?: AbortSignal }) => {
				capturedSignal = options?.signal
				return (async function* () {
					yield {
						choices: [{ delta: { content: "partial" }, index: 0 }],
						index: 0,
					}
					await new Promise((_resolve, reject) => {
						const onAbort = () => reject(new DOMException("The operation was aborted.", "AbortError"))
						options?.signal?.addEventListener("abort", onAbort, { once: true })
					})
				})()
			})

			const handler = new OpencodeGoHandler(mockOptions)
			const controller = new AbortController()

			const consumed = collectStream(
				handler.createMessage(
					"sys",
					[{ role: "user", content: "hi" }],
					makeCreateMessageMetadata({ abortSignal: controller.signal }),
				),
			)

			// Let the request start and the first chunk be yielded before aborting.
			await new Promise((resolve) => setTimeout(resolve, 25))
			controller.abort()

			await expect(consumed).rejects.toMatchObject({ name: "AbortError" })
			expect(capturedSignal?.aborted).toBe(true)
		})

		it("detaches the bridged abort listener when the request completes normally", async () => {
			// The listener is added with { once: true }, so it only detaches on
			// abort. A task-scoped signal spanning many requests must not
			// accumulate a listener per request: assert explicit removal after a
			// normal (non-aborted) completion.
			mockCreate.mockImplementation(async () =>
				asyncStreamFrom([
					{
						choices: [{ delta: { content: "ok" }, index: 0 }],
						index: 0,
					},
					{
						choices: [{ delta: {}, index: 0 }],
						index: 0,
						usage: { prompt_tokens: 2, completion_tokens: 3 },
					},
				]),
			)

			const handler = new OpencodeGoHandler(mockOptions)
			const controller = new AbortController()
			const removeListenerSpy = vi.spyOn(controller.signal, "removeEventListener")

			const stream = handler.createMessage(
				"sys",
				[{ role: "user", content: "hi" }],
				makeCreateMessageMetadata({ abortSignal: controller.signal }),
			)

			const chunks = await collectStream(stream)
			expect(chunks).toContainEqual({ type: "text", text: "ok" })
			expect(removeListenerSpy).toHaveBeenCalledWith("abort", expect.any(Function))
			expect(controller.signal.aborted).toBe(false)
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
				{},
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
			expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ max_completion_tokens: 4321 }), {})
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
			mockAnthropicCreate.mockImplementation(async () =>
				asyncStreamFrom([
					{
						type: "message_start",
						message: {
							usage: {
								input_tokens: 10,
								output_tokens: 0,
								cache_creation_input_tokens: 2,
								cache_read_input_tokens: 3,
							},
						},
					},
					{
						type: "content_block_start",
						index: 0,
						content_block: { type: "text", text: "" },
					},
					{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
					{
						type: "content_block_start",
						index: 1,
						content_block: { type: "tool_use", id: "toolu_1", name: "read_file", input: {} },
					},
					{
						type: "content_block_delta",
						index: 1,
						delta: { type: "input_json_delta", partial_json: '{"path":' },
					},
					{ type: "content_block_stop", index: 1 },
					{ type: "message_delta", usage: { output_tokens: 5 } },
					{ type: "message_stop" },
				]),
			)
		})

		it("routes the request through the Anthropic /v1/messages client, not chat completions", async () => {
			const handler = new OpencodeGoHandler(anthropicOptions)
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Hi" }]

			await collectStream(handler.createMessage("sys", messages))

			expect(mockAnthropicCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					model: "qwen3.7-max",
					stream: true,
					system: expect.arrayContaining([expect.objectContaining({ type: "text", text: "sys" })]),
				}),
				expect.objectContaining({ signal: expect.any(AbortSignal) }),
			)
			// The OpenAI chat completions endpoint must NOT be used for this model.
			expect(mockCreate).not.toHaveBeenCalled()
		})

		it("streams text, tool-call, usage and cost chunks from the Anthropic stream", async () => {
			const handler = new OpencodeGoHandler(anthropicOptions)
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Hi" }]

			const chunks = await collectStream(handler.createMessage("sys", messages))

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

			await collectStream(handler.createMessage("sys", messages))

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
				undefined,
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
			expect(mockAnthropicCreate).toHaveBeenCalledWith(expect.objectContaining({ max_tokens: 2048 }), undefined)
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

		it("completePrompt passes abort signal through to Anthropic client", async () => {
			mockAnthropicCreate.mockResolvedValue({ content: [{ type: "text", text: "response" }] })
			const controller = new AbortController()
			const handler = new OpencodeGoHandler(anthropicOptions)
			await handler.completePrompt("ping", { abortSignal: controller.signal })
			expect(mockAnthropicCreate).toHaveBeenCalledWith(expect.objectContaining({ model: expect.any(String) }), {
				signal: controller.signal,
			})
		})

		it("completePrompt passes both signal and timeoutMs through to Anthropic client", async () => {
			mockAnthropicCreate.mockResolvedValue({ content: [{ type: "text", text: "response" }] })
			const controller = new AbortController()
			const handler = new OpencodeGoHandler(anthropicOptions)
			await handler.completePrompt("ping", { abortSignal: controller.signal, timeoutMs: 10000 })
			expect(mockAnthropicCreate).toHaveBeenCalledWith(expect.objectContaining({ model: expect.any(String) }), {
				signal: controller.signal,
				timeout: 10000,
			})
		})

		it("completePrompt passes only timeoutMs when no signal is provided", async () => {
			mockAnthropicCreate.mockResolvedValue({ content: [{ type: "text", text: "response" }] })
			const handler = new OpencodeGoHandler(anthropicOptions)
			await handler.completePrompt("ping", { timeoutMs: 5000 })
			expect(mockAnthropicCreate).toHaveBeenCalledWith(expect.objectContaining({ model: expect.any(String) }), {
				timeout: 5000,
			})
		})

		it("completePrompt omits the timeout option when timeoutMs is 0 (Anthropic path)", async () => {
			// The SDK treats timeout: 0 as an immediate abort, so the "disabled"
			// value must never be forwarded — assert the absence of the option.
			mockAnthropicCreate.mockResolvedValue({ content: [{ type: "text", text: "response" }] })
			const handler = new OpencodeGoHandler(anthropicOptions)
			await handler.completePrompt("ping", { timeoutMs: 0 })
			const call = mockAnthropicCreate.mock.calls[mockAnthropicCreate.mock.calls.length - 1]
			const requestOptions = call[1] as { timeout?: number } | undefined
			// When no option is forwarded the provider omits the SDK options
			// argument entirely, so absence means: undefined arg OR an arg
			// without a timeout key.
			expect(Object.keys(requestOptions ?? {})).not.toContain("timeout")
		})

		it("completePrompt preserves abort identity when the caller aborts (Anthropic path)", async () => {
			// Emulate the Anthropic SDK: an aborted request signal rejects with
			// APIUserAbortError ("Request was aborted." — the trailing period would
			// fail task-level abort detection, so the provider must normalize it).
			mockAnthropicCreate.mockImplementation(async (_params: unknown, options: { signal?: AbortSignal }) => {
				if (options?.signal?.aborted) {
					throw new AnthropicAbortError()
				}
				throw new Error("boom")
			})
			const handler = new OpencodeGoHandler(anthropicOptions)
			const controller = new AbortController()
			controller.abort()

			const error = await handler.completePrompt("ping", { abortSignal: controller.signal }).then(
				() => undefined,
				(e: unknown) => e,
			)
			expect(error).toMatchObject({ name: "AbortError" })
			expect((error as Error).message.endsWith("aborted")).toBe(true)
			expect((error as Error).message).not.toContain("completion error")
		})

		it("completePrompt surfaces request timeouts as an AbortError (Anthropic path)", async () => {
			// Emulate the Anthropic SDK: when the request timeout fires, the SDK
			// surfaces APIConnectionTimeoutError ("Request timed out.") once retries
			// are exhausted — verified against @anthropic-ai/sdk against a hung server.
			mockAnthropicCreate.mockImplementation(async (_params: unknown, options: { timeout?: number }) => {
				await new Promise((resolve) => setTimeout(resolve, options?.timeout ?? 50))
				throw new AnthropicTimeoutError()
			})
			const handler = new OpencodeGoHandler(anthropicOptions)

			const error = await handler.completePrompt("ping", { timeoutMs: 50 }).then(
				() => undefined,
				(e: unknown) => e,
			)
			expect(error).toMatchObject({ name: "AbortError" })
			expect((error as Error).message.endsWith("aborted")).toBe(true)
			expect((error as Error).message).not.toContain("completion error")
		})

		it("completePrompt works without options (backward compatible, Anthropic path)", async () => {
			mockAnthropicCreate.mockResolvedValue({ content: [{ type: "text", text: "response" }] })
			const handler = new OpencodeGoHandler(anthropicOptions)
			const result = await handler.completePrompt("ping")
			expect(result).toBe("response")
			expect(mockAnthropicCreate).toHaveBeenCalledWith(
				expect.objectContaining({ model: expect.any(String) }),
				undefined,
			)
		})

		describe("completePrompt (OpenAI path)", () => {
			const openaiOptions: ApiHandlerOptions = {
				opencodeGoApiKey: "test-key",
				apiModelId: "glm-5.1", // OpenAI-format model
			}

			beforeEach(() => {
				vitest.clearAllMocks()
			})

			it("completePrompt returns text for OpenAI path", async () => {
				mockCreate.mockResolvedValueOnce({
					choices: [{ message: { content: "response" } }],
				})

				const handler = new OpencodeGoHandler(openaiOptions)
				expect(await handler.completePrompt("ping")).toBe("response")
				expect(mockCreate).toHaveBeenCalledWith(
					expect.objectContaining({ model: expect.any(String), stream: false }),
					{}, // empty object when no options
				)
			})

			it("completePrompt passes abort signal through to OpenAI client", async () => {
				mockCreate.mockResolvedValueOnce({
					choices: [{ message: { content: "response" } }],
				})
				const controller = new AbortController()
				const handler = new OpencodeGoHandler(openaiOptions)

				await handler.completePrompt("ping", { abortSignal: controller.signal })
				expect(mockCreate).toHaveBeenCalledWith(
					expect.objectContaining({ model: expect.any(String), stream: false }),
					{ signal: controller.signal },
				)
			})

			it("completePrompt passes both signal and timeoutMs through to OpenAI client", async () => {
				mockCreate.mockResolvedValueOnce({
					choices: [{ message: { content: "response" } }],
				})
				const controller = new AbortController()
				const handler = new OpencodeGoHandler(openaiOptions)

				await handler.completePrompt("ping", { abortSignal: controller.signal, timeoutMs: 10000 })
				expect(mockCreate).toHaveBeenCalledWith(
					expect.objectContaining({ model: expect.any(String), stream: false }),
					{ signal: controller.signal, timeout: 10000 },
				)
			})

			it("completePrompt passes only timeoutMs when no signal is provided", async () => {
				mockCreate.mockResolvedValueOnce({
					choices: [{ message: { content: "response" } }],
				})
				const handler = new OpencodeGoHandler(openaiOptions)

				await handler.completePrompt("ping", { timeoutMs: 5000 })
				expect(mockCreate).toHaveBeenCalledWith(
					expect.objectContaining({ model: expect.any(String), stream: false }),
					{ timeout: 5000 },
				)
			})

			it("completePrompt omits the timeout option when timeoutMs is 0 (OpenAI path)", async () => {
				// The OpenAI SDK treats timeout: 0 as an immediate abort, so the
				// "disabled" value must never be forwarded — assert the absence of
				// the option.
				mockCreate.mockResolvedValueOnce({
					choices: [{ message: { content: "response" } }],
				})
				const handler = new OpencodeGoHandler(openaiOptions)
				await handler.completePrompt("ping", { timeoutMs: 0 })
				const call = mockCreate.mock.calls[mockCreate.mock.calls.length - 1]
				const requestOptions = call[1] as { timeout?: number } | undefined
				expect(requestOptions).not.toHaveProperty("timeout")
			})

			it("completePrompt preserves abort identity when the caller aborts (OpenAI path)", async () => {
				// Emulate the OpenAI SDK: an aborted request signal rejects with
				// APIUserAbortError ("Request was aborted." — the trailing period would
				// fail task-level abort detection, so the provider must normalize it).
				mockCreate.mockImplementation(async (_params: unknown, options: { signal?: AbortSignal }) => {
					if (options?.signal?.aborted) {
						throw new APIUserAbortError()
					}
					throw new Error("boom")
				})
				const handler = new OpencodeGoHandler(openaiOptions)
				const controller = new AbortController()
				controller.abort()

				const error = await handler.completePrompt("ping", { abortSignal: controller.signal }).then(
					() => undefined,
					(e: unknown) => e,
				)
				expect(error).toMatchObject({ name: "AbortError" })
				expect((error as Error).message.endsWith("aborted")).toBe(true)
				expect((error as Error).message).not.toContain("completion error")
			})

			it("completePrompt surfaces request timeouts as an AbortError (OpenAI path)", async () => {
				// Emulate the OpenAI SDK: when the request timeout fires, the SDK
				// surfaces APIConnectionTimeoutError ("Request timed out.") once retries
				// are exhausted — verified against openai v5.23.2 against a hung server.
				mockCreate.mockImplementation(async (_params: unknown, options: { timeout?: number }) => {
					await new Promise((resolve) => setTimeout(resolve, options?.timeout ?? 50))
					throw new APIConnectionTimeoutError()
				})
				const handler = new OpencodeGoHandler(openaiOptions)

				const error = await handler.completePrompt("ping", { timeoutMs: 50 }).then(
					() => undefined,
					(e: unknown) => e,
				)
				expect(error).toMatchObject({ name: "AbortError" })
				expect((error as Error).message.endsWith("aborted")).toBe(true)
				expect((error as Error).message).not.toContain("completion error")
			})

			it("completePrompt works without options (backward compatible, OpenAI path)", async () => {
				mockCreate.mockResolvedValueOnce({
					choices: [{ message: { content: "response" } }],
				})
				const handler = new OpencodeGoHandler(openaiOptions)

				const result = await handler.completePrompt("ping")
				expect(result).toBe("response")
				expect(mockCreate).toHaveBeenCalledWith(
					expect.objectContaining({ model: expect.any(String), stream: false }),
					{}, // empty object when no options
				)
			})
		})
		it("omits tools and tool_choice from the Anthropic request when no tools are provided", async () => {
			const handler = new OpencodeGoHandler(anthropicOptions)
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Hi" }]

			await collectStream(handler.createMessage("sys", messages))

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

			await collectStream(handler.createMessage("sys", messages, { taskId: "test-task", tools }))

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

			await collectStream(handler.createMessage("sys", messages))

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

			await collectStream(handler.createMessage("sys", messages))

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

			await collectStream(handler.createMessage("sys", messages))

			const callArgs = mockAnthropicCreate.mock.calls[0][0] as {
				messages: Array<{ cache_control?: unknown }>
			}
			expect(callArgs.messages.every((m) => m.cache_control === undefined)).toBe(true)
		})

		it("streams thinking content blocks and thinking deltas", async () => {
			mockAnthropicCreate.mockImplementationOnce(async () =>
				asyncStreamFrom([
					{ type: "message_start", message: { usage: { input_tokens: 5, output_tokens: 0 } } },
					{
						type: "content_block_start",
						index: 0,
						content_block: { type: "thinking", thinking: "initial thought" },
					},
					{
						type: "content_block_delta",
						index: 0,
						delta: { type: "thinking_delta", thinking: " more" },
					},
					{ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
					{ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "answer" } },
					{
						type: "content_block_start",
						index: 2,
						content_block: { type: "thinking", thinking: "second thought" },
					},
					{ type: "message_delta", usage: { output_tokens: 3 } },
					{ type: "message_stop" },
				]),
			)

			const handler = new OpencodeGoHandler(anthropicOptions)
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Hi" }]

			const chunks = await collectStream(handler.createMessage("sys", messages))

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

			await collectStream(handler.createMessage("sys", messages))

			expect(mockAnthropicCreate).toHaveBeenCalledWith(
				expect.objectContaining({ max_tokens: 8192 }),
				expect.objectContaining({ signal: expect.any(AbortSignal) }),
			)
		})

		it("falls back to the model max_tokens when includeMaxTokens is on but modelMaxTokens is unset", async () => {
			const handler = new OpencodeGoHandler({ ...anthropicOptions, includeMaxTokens: true })
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Hi" }]

			await collectStream(handler.createMessage("sys", messages))

			// qwen3.7-max maxTokens (65_536) clamped to 20% of 1M context => 65_536.
			expect(mockAnthropicCreate).toHaveBeenCalledWith(
				expect.objectContaining({ max_tokens: 65_536 }),
				expect.objectContaining({ signal: expect.any(AbortSignal) }),
			)
		})

		it("accumulates output tokens across message_delta events into the final cost", async () => {
			mockAnthropicCreate.mockImplementationOnce(async () =>
				asyncStreamFrom([
					{ type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 0 } } },
					{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
					{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
					{ type: "message_delta", usage: { output_tokens: 4 } },
					{ type: "message_delta", usage: { output_tokens: 6 } },
					{ type: "message_stop" },
				]),
			)

			const handler = new OpencodeGoHandler(anthropicOptions)
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Hi" }]

			const chunks = await collectStream(handler.createMessage("sys", messages))

			const costChunk = chunks.find((c) => c.type === "usage" && "totalCost" in c && c.totalCost !== undefined)
			if (!costChunk || costChunk.type !== "usage") {
				throw new Error("Expected usage chunk with cost")
			}
			// qwen3.7-max: input $2.5/M, output $7.5/M. Accumulated output
			// tokens (4 + 6 = 10) must feed the cost calc — without the
			// accumulation fix this would only reflect the 10 input tokens
			// (0.000025) instead of input + output (0.0001).
			expect(costChunk.totalCost).toBeCloseTo((10 * 2.5 + 10 * 7.5) / 1_000_000, 10)
		})

		it("does not yield a cost chunk when the stream reports no token usage", async () => {
			mockAnthropicCreate.mockImplementationOnce(async () =>
				asyncStreamFrom([
					{ type: "message_start", message: { usage: { input_tokens: 0, output_tokens: 0 } } },
					{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
					{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
					{ type: "message_delta", usage: { output_tokens: 0 } },
					{ type: "message_stop" },
				]),
			)

			const handler = new OpencodeGoHandler(anthropicOptions)
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Hi" }]

			const chunks = await collectStream(handler.createMessage("sys", messages))

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
				await collectStream(handler.createMessage("sys", messages))
			}).rejects.toThrow("Opencode Go completion error: rate limited")
		})

		it("preserves abort identity for aborted Anthropic requests from createMessage", async () => {
			// A cancelled /v1/messages request (the SDK rejects with
			// APIUserAbortError) must surface as a DOM-standard AbortError, not
			// the wrapped "completion error" reserved for other failures.
			mockAnthropicCreate.mockRejectedValue(new AnthropicAbortError())
			const handler = new OpencodeGoHandler(anthropicOptions)
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Hi" }]
			await expect(async () => {
				await collectStream(handler.createMessage("sys", messages))
			}).rejects.toMatchObject({
				name: "AbortError",
				message: "The Opencode Go request was aborted",
			})
		})
	})

	describe("Responses-format models (gpt-5.6-luna)", () => {
		// gpt-5.6-luna is Responses-only on the Go gateway: its chat-completions
		// adapter fails with an opaque HTTP 500 (Zoo-Code-Org/Zoo-Code#1431),
		// so the handler must route it through /v1/responses and never fall
		// back to chat completions.
		const lunaOptions: ApiHandlerOptions = {
			opencodeGoApiKey: "test-key",
			opencodeGoModelId: "gpt-5.6-luna",
		}

		beforeEach(() => {
			mockResponsesCreate.mockImplementation(async () =>
				asyncStreamFrom([
					{ type: "response.output_text.delta", delta: "Hello" },
					{ type: "response.reasoning_summary_text.delta", delta: "thinking" },
					{
						type: "response.completed",
						response: {
							usage: {
								input_tokens: 10,
								output_tokens: 5,
							},
						},
					},
				]),
			)
		})

		it("forwards the abort signal to the streaming Responses request", async () => {
			const handler = new OpencodeGoHandler(lunaOptions)
			const controller = new AbortController()
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Hi" }]

			await collectStream(
				handler.createMessage("sys", messages, { taskId: "test-task", abortSignal: controller.signal }),
			)

			expect(mockResponsesCreate.mock.calls[0][1]).toEqual({ signal: controller.signal })
		})

		it("closes the Responses iterator when the consumer stops early", async () => {
			const iterator = {
				next: vitest.fn().mockResolvedValueOnce({
					done: false,
					value: { type: "response.output_text.delta", delta: "partial" },
				}),
				return: vitest.fn().mockResolvedValue({ done: true, value: undefined }),
				[Symbol.asyncIterator]() {
					return this
				},
			}
			mockResponsesCreate.mockResolvedValue(iterator)
			const handler = new OpencodeGoHandler(lunaOptions)
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Hi" }]
			const responseStream = handler.createMessage("sys", messages)

			await expect(responseStream.next()).resolves.toEqual({
				done: false,
				value: { type: "text", text: "partial" },
			})
			await responseStream.return(undefined)

			expect(iterator.return).toHaveBeenCalledTimes(2)
		})

		it("preserves the stream error when iterator cleanup fails", async () => {
			const circular: { self?: unknown } = {}
			circular.self = circular
			const iterator = {
				next: vitest.fn().mockResolvedValueOnce({
					done: false,
					value: {
						type: "response.output_item.done",
						item: { type: "function_call", call_id: "call_1", name: "read_file", arguments: circular },
					},
				}),
				return: vitest.fn().mockRejectedValue(new Error("cleanup failed")),
				[Symbol.asyncIterator]() {
					return this
				},
			}
			mockResponsesCreate.mockResolvedValue(iterator)
			const handler = new OpencodeGoHandler(lunaOptions)
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Hi" }]

			await expect(collectStream(handler.createMessage("sys", messages))).rejects.toThrow("circular")
			expect(iterator.return).toHaveBeenCalled()
		})

		it("stops an in-flight Responses iterator when its abort signal rejects the read", async () => {
			const controller = new AbortController()
			let rejectNext: ((reason?: unknown) => void) | undefined
			const iterator = {
				next: vitest.fn().mockImplementation(
					() =>
						new Promise((_resolve, reject) => {
							rejectNext = reject
							controller.signal.addEventListener("abort", () => reject(new Error("request aborted")), {
								once: true,
							})
						}),
				),
				return: vitest.fn().mockResolvedValue({ done: true, value: undefined }),
				[Symbol.asyncIterator]() {
					return this
				},
			}
			mockResponsesCreate.mockImplementation(async (_body: unknown, options: { signal?: AbortSignal }) => {
				options.signal?.addEventListener("abort", () => rejectNext?.(new Error("request aborted")), {
					once: true,
				})
				return iterator
			})
			const handler = new OpencodeGoHandler(lunaOptions)
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Hi" }]
			const responseStream = handler.createMessage("sys", messages, {
				taskId: "test-task",
				abortSignal: controller.signal,
			})
			const nextPromise = responseStream.next()
			await vitest.waitFor(() => expect(mockResponsesCreate).toHaveBeenCalled())
			controller.abort()

			await expect(nextPromise).rejects.toThrow("request aborted")
			expect(iterator.return).toHaveBeenCalled()
		})

		it("rethrows non-Error Responses streaming failures unchanged", async () => {
			mockResponsesCreate.mockRejectedValue("stream failure")
			const handler = new OpencodeGoHandler(lunaOptions)
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Hi" }]

			await expect(collectStream(handler.createMessage("sys", messages))).rejects.toBe("stream failure")
		})

		it("routes the request through responses.create, not chat completions or Anthropic messages", async () => {
			const handler = new OpencodeGoHandler(lunaOptions)
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Hi" }]

			await collectStream(handler.createMessage("sys", messages))

			expect(mockResponsesCreate).toHaveBeenCalledTimes(1)
			expect(mockCreate).not.toHaveBeenCalled()
			expect(mockAnthropicCreate).not.toHaveBeenCalled()
		})

		it("streams text and reasoning chunks from the Responses event stream", async () => {
			const handler = new OpencodeGoHandler(lunaOptions)
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Hi" }]

			const chunks = await collectStream(handler.createMessage("sys", messages))

			expect(chunks).toContainEqual({ type: "text", text: "Hello" })
			expect(chunks).toContainEqual({ type: "reasoning", text: "thinking" })
		})

		it("sends the system prompt as top-level instructions with stream/store flags", async () => {
			const handler = new OpencodeGoHandler(lunaOptions)
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Hi" }]

			await collectStream(handler.createMessage("sys", messages))

			const callArgs = mockResponsesCreate.mock.calls[0][0] as Record<string, unknown>
			expect(callArgs.model).toBe("gpt-5.6-luna")
			expect(callArgs.instructions).toBe("sys")
			expect(callArgs.stream).toBe(true)
			expect(callArgs.store).toBe(false)
			const input = callArgs.input as unknown[]
			expect(input.some((item) => (item as { role?: string }).role === "system")).toBe(false)
			// The gateway rejects temperature for Responses-format models.
			expect(callArgs.temperature).toBeUndefined()
			// No tools were provided, so no tools/tool_choice are sent.
			expect(callArgs.tools).toBeUndefined()
		})

		it("converts messages to the Responses input shape for a tool_use/tool_result round-trip", async () => {
			const handler = new OpencodeGoHandler(lunaOptions)
			const messages: Anthropic.Messages.MessageParam[] = [
				{ role: "user", content: "List the files" },
				{
					role: "assistant",
					content: [{ type: "tool_use", id: "toolu_1", name: "read_file", input: { path: "a.ts" } }],
				},
				{
					role: "user",
					content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "file contents" }],
				},
			]

			await collectStream(handler.createMessage("sys", messages))

			const callArgs = mockResponsesCreate.mock.calls[0][0] as Record<string, unknown>
			expect(callArgs.input).toEqual([
				{ role: "user", content: [{ type: "input_text", text: "List the files" }] },
				{ type: "function_call", call_id: "toolu_1", name: "read_file", arguments: '{"path":"a.ts"}' },
				{ type: "function_call_output", call_id: "toolu_1", output: "file contents" },
			])
		})

		it("flattens Chat Completions-shaped tools into Responses function tools", async () => {
			const handler = new OpencodeGoHandler(lunaOptions)
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Hi" }]
			const tools: OpenAI.Chat.ChatCompletionTool[] = [
				{
					type: "function",
					function: {
						name: "read_file",
						description: "read a file",
						parameters: { type: "object", properties: { path: { type: "string" } } },
					},
				},
			]

			await collectStream(handler.createMessage("sys", messages, { taskId: "test-task", tools }))

			const callArgs = mockResponsesCreate.mock.calls[0][0] as Record<string, unknown>
			expect(callArgs.tools).toEqual([
				{
					type: "function",
					name: "read_file",
					description: "read a file",
					parameters: expect.objectContaining({
						type: "object",
						additionalProperties: false,
						required: ["path"],
					}),
					strict: true,
				},
			])
			expect(callArgs.tool_choice).toBe("auto")
			expect(callArgs.parallel_tool_calls).toBe(true)
		})

		it("streams tool-call partials and emits unstreamed calls from output_item.done", async () => {
			mockResponsesCreate.mockImplementationOnce(async () =>
				asyncStreamFrom([
					{
						type: "response.function_call_arguments.delta",
						call_id: "call_1",
						name: "read_file",
						delta: '{"path":',
						index: 0,
					},
					{
						type: "response.output_item.done",
						item: {
							type: "function_call",
							call_id: "call_1",
							name: "read_file",
							arguments: '{"path":"a.ts"}',
						},
					},
					{
						type: "response.output_item.done",
						item: { type: "function_call", call_id: "call_2", name: "list_files", arguments: "{}" },
					},
				]),
			)

			const handler = new OpencodeGoHandler(lunaOptions)
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Hi" }]

			const chunks = await collectStream(handler.createMessage("sys", messages))

			const partials = chunks.filter((c) => c.type === "tool_call_partial")
			expect(partials).toHaveLength(1)
			expect(partials[0]).toMatchObject({ id: "call_1", name: "read_file", arguments: '{"path":' })

			// call_1 was streamed via deltas, so output_item.done must not
			// duplicate it; call_2 only appeared in output_item.done.
			const completes = chunks.filter((c) => c.type === "tool_call")
			expect(completes).toHaveLength(1)
			expect(completes[0]).toMatchObject({ id: "call_2", name: "list_files", arguments: "{}" })
		})

		it("emits a usage chunk with cache tokens and cost from response.completed", async () => {
			mockResponsesCreate.mockImplementationOnce(async () =>
				asyncStreamFrom([
					{
						type: "response.completed",
						response: {
							usage: {
								input_tokens: 100,
								output_tokens: 50,
								input_tokens_details: { cached_tokens: 40 },
								output_tokens_details: { reasoning_tokens: 20 },
							},
						},
					},
				]),
			)

			const handler = new OpencodeGoHandler(lunaOptions)
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Hi" }]

			const chunks = await collectStream(handler.createMessage("sys", messages))

			const usageChunk = chunks.find((c) => c.type === "usage")
			if (!usageChunk || usageChunk.type !== "usage") {
				throw new Error("Expected usage chunk")
			}
			expect(usageChunk.inputTokens).toBe(100)
			expect(usageChunk.outputTokens).toBe(50)
			expect(usageChunk.cacheReadTokens).toBe(40)
			expect(usageChunk.reasoningTokens).toBe(20)
			// Luna Go pricing: https://opencode.ai/docs/zen/#pricing
			// input $0.20/M, output $1.20/M, cache reads $0.02/M.
			// 60 non-cached input + 40 cached reads + 50 output tokens (under 272k).
			expect(usageChunk.totalCost).toBeCloseTo((60 * 0.2 + 40 * 0.02 + 50 * 1.2) / 1_000_000, 10)
		})

		it("supports named and string tool choices and disables parallel calls", async () => {
			const handler = new OpencodeGoHandler(lunaOptions)
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Hi" }]
			const tools: OpenAI.Chat.ChatCompletionTool[] = [
				{ type: "function", function: { name: "read_file", parameters: { type: "object" } } },
			]

			await collectStream(
				handler.createMessage("sys", messages, {
					taskId: "test-task",
					tools,
					tool_choice: { type: "function", function: { name: "read_file" } },
					parallelToolCalls: false,
				}),
			)
			let callArgs = mockResponsesCreate.mock.calls[0][0] as Record<string, unknown>
			expect(callArgs.tool_choice).toEqual({ type: "function", name: "read_file" })
			expect(callArgs.parallel_tool_calls).toBe(false)

			mockResponsesCreate.mockImplementationOnce(async () =>
				asyncStreamFrom([
					{ type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
				]),
			)
			await collectStream(
				handler.createMessage("sys", messages, {
					taskId: "test-task",
					tools,
					tool_choice: "required",
				}),
			)
			callArgs = mockResponsesCreate.mock.calls[1][0] as Record<string, unknown>
			expect(callArgs.tool_choice).toBe("required")
		})

		it("omits max_output_tokens when no max token limit is available", async () => {
			mockResponsesCreate.mockImplementationOnce(async () =>
				asyncStreamFrom([
					{ type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
				]),
			)
			vitest.mocked(getModels).mockResolvedValueOnce({
				"gpt-5.6-luna": { ...opencodeGoModels["gpt-5.6-luna"], maxTokens: undefined },
			})
			const handler = new OpencodeGoHandler(lunaOptions)
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Hi" }]

			await collectStream(handler.createMessage("sys", messages))

			const callArgs = mockResponsesCreate.mock.calls[0][0] as Record<string, unknown>
			expect(callArgs.max_output_tokens).toBeUndefined()
		})

		it.each(["cache_creation_input_tokens", "cache_write_tokens"] as const)(
			"normalizes %s as cache-write usage and includes it in the total cost",
			async (cacheWriteField) => {
				mockResponsesCreate.mockImplementationOnce(async () =>
					asyncStreamFrom([
						{
							type: "response.completed",
							response: {
								usage: {
									input_tokens: 100,
									output_tokens: 50,
									[cacheWriteField]: 20,
								},
							},
						},
					]),
				)
				const handler = new OpencodeGoHandler(lunaOptions)
				const chunks = await collectStream(handler.createMessage("sys", [{ role: "user", content: "Hi" }]))
				const usageChunk = chunks.find((chunk) => chunk.type === "usage")
				if (!usageChunk || usageChunk.type !== "usage") throw new Error("Expected usage chunk")
				expect(usageChunk.cacheWriteTokens).toBe(20)
				expect(usageChunk.totalCost).toBeCloseTo((80 * 0.2 + 50 * 1.2 + 20 * 0.25) / 1_000_000, 10)
			},
		)

		it("maps the model default reasoning effort to reasoning.effort", async () => {
			const handler = new OpencodeGoHandler(lunaOptions)
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Hi" }]

			await collectStream(handler.createMessage("sys", messages))

			const callArgs = mockResponsesCreate.mock.calls[0][0] as Record<string, unknown>
			expect(callArgs.reasoning).toEqual({ effort: "medium" })
		})

		it("omits reasoning when the user disables reasoning effort", async () => {
			const handler = new OpencodeGoHandler({ ...lunaOptions, reasoningEffort: "disable" })
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Hi" }]

			await collectStream(handler.createMessage("sys", messages))

			const callArgs = mockResponsesCreate.mock.calls[0][0] as Record<string, unknown>
			expect(callArgs.reasoning).toBeUndefined()
		})

		it("maps max tokens to max_output_tokens (GPT-5 models bypass the 20% clamp)", async () => {
			const handler = new OpencodeGoHandler(lunaOptions)
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Hi" }]

			await collectStream(handler.createMessage("sys", messages))

			const callArgs = mockResponsesCreate.mock.calls[0][0] as Record<string, unknown>
			expect(callArgs.max_output_tokens).toBe(128_000)
		})

		it("honors includeMaxTokens/modelMaxTokens override for max_output_tokens", async () => {
			const handler = new OpencodeGoHandler({ ...lunaOptions, includeMaxTokens: true, modelMaxTokens: 5_000 })
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Hi" }]

			await collectStream(handler.createMessage("sys", messages))

			const callArgs = mockResponsesCreate.mock.calls[0][0] as Record<string, unknown>
			expect(callArgs.max_output_tokens).toBe(5_000)
		})

		it.each([{ output_text: "" }, {}])(
			"returns an empty string when completePrompt output_text is empty or absent",
			async (response) => {
				mockResponsesCreate.mockResolvedValue(response)
				const handler = new OpencodeGoHandler(lunaOptions)

				await expect(handler.completePrompt("ping")).resolves.toBe("")
			},
		)

		it("rethrows non-Error completePrompt failures unchanged", async () => {
			mockResponsesCreate.mockRejectedValue("completion failure")
			const handler = new OpencodeGoHandler(lunaOptions)

			await expect(handler.completePrompt("ping")).rejects.toBe("completion failure")
		})

		it("rejects non-streaming Responses completion when the abort signal fires", async () => {
			const controller = new AbortController()
			const request = new Promise<never>((_resolve, reject) => {
				controller.signal.addEventListener("abort", () => reject(new Error("request aborted")), { once: true })
			})
			mockResponsesCreate.mockReturnValue(request)
			const handler = new OpencodeGoHandler(lunaOptions)
			const completion = handler.completePrompt("ping", { abortSignal: controller.signal })

			await vitest.waitFor(() => expect(mockResponsesCreate).toHaveBeenCalled())
			controller.abort()

			await expect(completion).rejects.toThrow("request aborted")
		})

		it("completePrompt calls responses.create and returns output_text", async () => {
			mockResponsesCreate.mockResolvedValue({ output_text: "Hello!" })
			const handler = new OpencodeGoHandler(lunaOptions)

			const result = await handler.completePrompt("ping")

			expect(result).toBe("Hello!")
			expect(mockCreate).not.toHaveBeenCalled()
			const callArgs = mockResponsesCreate.mock.calls[0][0] as Record<string, unknown>
			expect(callArgs.model).toBe("gpt-5.6-luna")
			expect(callArgs.store).toBe(false)
			// completePrompt has no system prompt, so no instructions are sent.
			expect(callArgs.instructions).toBeUndefined()
			expect(callArgs.input).toEqual([{ role: "user", content: [{ type: "input_text", text: "ping" }] }])
			expect(callArgs.temperature).toBeUndefined()
		})

		it("forwards Responses-specific max_output_tokens and reasoning in completePrompt", async () => {
			mockResponsesCreate.mockResolvedValue({ output_text: "Hello!" })
			const handler = new OpencodeGoHandler({ ...lunaOptions, includeMaxTokens: true, modelMaxTokens: 7_500 })

			await handler.completePrompt("ping")

			const callArgs = mockResponsesCreate.mock.calls[0][0] as Record<string, unknown>
			expect(callArgs.max_output_tokens).toBe(7_500)
			expect(callArgs.reasoning).toEqual({ effort: "medium" })
		})

		it("omits reasoning in completePrompt when reasoning effort is disabled", async () => {
			mockResponsesCreate.mockResolvedValue({ output_text: "Hello!" })
			const handler = new OpencodeGoHandler({ ...lunaOptions, reasoningEffort: "disable" })

			await handler.completePrompt("ping")

			const callArgs = mockResponsesCreate.mock.calls[0][0] as Record<string, unknown>
			expect(callArgs.reasoning).toBeUndefined()
		})

		it("forwards the abort signal to the non-streaming Responses request", async () => {
			mockResponsesCreate.mockResolvedValue({ output_text: "Hello!" })
			const handler = new OpencodeGoHandler(lunaOptions)
			const controller = new AbortController()

			await handler.completePrompt("ping", { abortSignal: controller.signal })

			expect(mockResponsesCreate.mock.calls[0][1]).toEqual({ signal: controller.signal })
			expect(mockCreate).not.toHaveBeenCalled()
		})

		it("completePrompt wraps errors with an Opencode Go-specific message", async () => {
			mockResponsesCreate.mockRejectedValue(new Error("boom"))
			const handler = new OpencodeGoHandler(lunaOptions)
			await expect(handler.completePrompt("ping")).rejects.toThrow("Opencode Go completion error: boom")
		})

		it("wraps pre-stream responses.create errors from createMessage with an Opencode Go-specific message", async () => {
			mockResponsesCreate.mockRejectedValue(new Error("internal server error"))
			const handler = new OpencodeGoHandler(lunaOptions)
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Hi" }]
			await expect(async () => {
				await collectStream(handler.createMessage("sys", messages))
			}).rejects.toThrow("Opencode Go completion error: internal server error")
		})

		it("classifies gpt-5.6-luna as Responses-format and other models as not", () => {
			expect(isOpencodeGoResponsesFormatModel("gpt-5.6-luna")).toBe(true)
			expect(isOpencodeGoResponsesFormatModel("glm-5.3")).toBe(false)
			expect(isOpencodeGoResponsesFormatModel("qwen3.7-max")).toBe(false)
			expect(isOpencodeGoResponsesFormatModel("some-unknown-model")).toBe(false)
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
			expect(isOpencodeGoAnthropicFormatModel("glm-5.3")).toBe(false)
			expect(isOpencodeGoAnthropicFormatModel("kimi-k2.6")).toBe(false)
			expect(isOpencodeGoAnthropicFormatModel("deepseek-v4-pro")).toBe(false)
			expect(isOpencodeGoAnthropicFormatModel("mimo-v2.5")).toBe(false)
		})

		it("defaults unknown model IDs to the OpenAI-compatible format", () => {
			expect(isOpencodeGoAnthropicFormatModel("some-unknown-model")).toBe(false)
		})
	})
})
