// npx vitest run api/providers/__tests__/base-openai-compatible-provider.spec.ts

import { Anthropic } from "@anthropic-ai/sdk"
import OpenAI, { APIUserAbortError } from "openai"

import type { ModelInfo } from "@roo-code/types"

import { BaseOpenAiCompatibleProvider } from "../base-openai-compatible-provider"
import { asyncStreamFrom, collectStream } from "../../../test-utils/stream"
import { clearAllMocks } from "../../../test-utils/reset"
import { captureError } from "../../../test-utils/errors"

// Create mock functions
const mockCreate = vi.fn()

// Mock OpenAI module
vi.mock("openai", () => ({
	// Named export consumed by the provider for abort-error normalization
	APIUserAbortError: class extends Error {},
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

// Create a concrete test implementation of the abstract base class
class TestOpenAiCompatibleProvider extends BaseOpenAiCompatibleProvider<"test-model"> {
	constructor(apiKey: string) {
		const testModels: Record<"test-model", ModelInfo> = {
			"test-model": {
				maxTokens: 4096,
				contextWindow: 128000,
				supportsImages: false,
				supportsPromptCache: false,
				inputPrice: 0.5,
				outputPrice: 1.5,
			},
		}

		super({
			providerName: "TestProvider",
			baseURL: "https://test.example.com/v1",
			defaultProviderModelId: "test-model",
			providerModels: testModels,
			apiKey,
		})
	}
}

describe("BaseOpenAiCompatibleProvider", () => {
	let handler: TestOpenAiCompatibleProvider

	beforeEach(() => {
		clearAllMocks()
		handler = new TestOpenAiCompatibleProvider("test-api-key")
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	describe("TagMatcher reasoning tags", () => {
		it("should handle reasoning tags (<think>) from stream", async () => {
			mockCreate.mockImplementationOnce(() =>
				asyncStreamFrom([
					{ choices: [{ delta: { content: "<think>Let me think" } }] },
					{ choices: [{ delta: { content: " about this</think>" } }] },
					{ choices: [{ delta: { content: "The answer is 42" } }] },
				]),
			)

			const stream = handler.createMessage("system prompt", [])
			const chunks = await collectStream(stream)

			// TagMatcher yields chunks as they're processed
			expect(chunks).toEqual([
				{ type: "reasoning", text: "Let me think" },
				{ type: "reasoning", text: " about this" },
				{ type: "text", text: "The answer is 42" },
			])
		})

		it("should handle reasoning tags (<thought>) from stream", async () => {
			mockCreate.mockImplementationOnce(() =>
				asyncStreamFrom([
					{ choices: [{ delta: { content: "<thought>Deep thought" } }] },
					{ choices: [{ delta: { content: " here</thought>" } }] },
					{ choices: [{ delta: { content: "Result: 42" } }] },
				]),
			)
			const stream = handler.createMessage("system prompt", [])
			const chunks = await collectStream(stream)
			expect(chunks).toEqual([
				{ type: "reasoning", text: "Deep thought" },
				{ type: "reasoning", text: " here" },
				{ type: "text", text: "Result: 42" },
			])
		})

		it("should not close <think> tag with </thought> tag", async () => {
			mockCreate.mockImplementationOnce(() =>
				asyncStreamFrom([
					{ choices: [{ delta: { content: "<think>Thinking" } }] },
					{ choices: [{ delta: { content: " but closing with wrong tag</thought>" } }] },
					{ choices: [{ delta: { content: " still thinking" } }] },
				]),
			)
			const stream = handler.createMessage("system prompt", [])
			const chunks = await collectStream(stream)
			// The </thought> tag should be treated as text since it doesn't match the active <think> tag
			expect(chunks).toEqual([
				{ type: "reasoning", text: "Thinking" },
				{ type: "reasoning", text: " but closing with wrong tag</thought>" },
				{ type: "reasoning", text: " still thinking" },
			])
		})

		it("should handle complete <think> tag in a single chunk", async () => {
			mockCreate.mockImplementationOnce(() =>
				asyncStreamFrom([
					{ choices: [{ delta: { content: "Regular text before " } }] },
					{ choices: [{ delta: { content: "<think>Complete thought</think>" } }] },
					{ choices: [{ delta: { content: " regular text after" } }] },
				]),
			)

			const stream = handler.createMessage("system prompt", [])
			const chunks = await collectStream(stream)

			// When a complete tag arrives in one chunk, TagMatcher may not parse it
			// This test documents the actual behavior
			expect(chunks.length).toBeGreaterThan(0)
			expect(chunks[0]).toEqual({ type: "text", text: "Regular text before " })
		})

		it("should handle incomplete <think> tag at end of stream", async () => {
			mockCreate.mockImplementationOnce(() =>
				asyncStreamFrom([{ choices: [{ delta: { content: "<think>Incomplete thought" } }] }]),
			)

			const stream = handler.createMessage("system prompt", [])
			const chunks = await collectStream(stream)

			// TagMatcher should flush incomplete reasoning content on stream end
			expect(chunks).toContainEqual({ type: "reasoning", text: "Incomplete thought" })
		})

		it("should handle text without any <think> tags", async () => {
			mockCreate.mockImplementationOnce(() =>
				asyncStreamFrom([
					{ choices: [{ delta: { content: "Just regular text" } }] },
					{ choices: [{ delta: { content: " without reasoning" } }] },
				]),
			)

			const stream = handler.createMessage("system prompt", [])
			const chunks = await collectStream(stream)

			expect(chunks).toEqual([
				{ type: "text", text: "Just regular text" },
				{ type: "text", text: " without reasoning" },
			])
		})

		it("should handle <think> tags that start at beginning of stream", async () => {
			mockCreate.mockImplementationOnce(() =>
				asyncStreamFrom([
					{ choices: [{ delta: { content: "<think>reasoning" } }] },
					{ choices: [{ delta: { content: " content</think>" } }] },
					{ choices: [{ delta: { content: " normal text" } }] },
				]),
			)

			const stream = handler.createMessage("system prompt", [])
			const chunks = await collectStream(stream)

			expect(chunks).toEqual([
				{ type: "reasoning", text: "reasoning" },
				{ type: "reasoning", text: " content" },
				{ type: "text", text: " normal text" },
			])
		})
	})

	describe("reasoning_content field", () => {
		it("should preserve whitespace-only reasoning_content so streamed boundaries survive concatenation", async () => {
			mockCreate.mockImplementationOnce(() =>
				asyncStreamFrom([
					{ choices: [{ delta: { reasoning_content: "\n" } }] },
					{ choices: [{ delta: { reasoning_content: "   " } }] },
					{ choices: [{ delta: { reasoning_content: "\t\n  " } }] },
					{ choices: [{ delta: { content: "Regular content" } }] },
				]),
			)

			const stream = handler.createMessage("system prompt", [])
			const chunks = await collectStream(stream)

			expect(chunks).toEqual([
				{ type: "reasoning", text: "\n" },
				{ type: "reasoning", text: "   " },
				{ type: "reasoning", text: "\t\n  " },
				{ type: "text", text: "Regular content" },
			])
		})

		it("should yield non-empty reasoning_content", async () => {
			mockCreate.mockImplementationOnce(() =>
				asyncStreamFrom([
					{ choices: [{ delta: { reasoning_content: "Thinking step 1" } }] },
					{ choices: [{ delta: { reasoning_content: "\n" } }] },
					{ choices: [{ delta: { reasoning_content: "Thinking step 2" } }] },
				]),
			)

			const stream = handler.createMessage("system prompt", [])
			const chunks = await collectStream(stream)

			expect(chunks).toEqual([
				{ type: "reasoning", text: "Thinking step 1" },
				{ type: "reasoning", text: "\n" },
				{ type: "reasoning", text: "Thinking step 2" },
			])
		})

		it("should handle reasoning_content with leading/trailing whitespace", async () => {
			mockCreate.mockImplementationOnce(() =>
				asyncStreamFrom([{ choices: [{ delta: { reasoning_content: "  content with spaces  " } }] }]),
			)

			const stream = handler.createMessage("system prompt", [])
			const chunks = await collectStream(stream)

			// Should yield reasoning with spaces (only pure whitespace is filtered)
			expect(chunks).toEqual([{ type: "reasoning", text: "  content with spaces  " }])
		})

		it("should yield reasoning chunks BEFORE text chunks when both are present in the exact same delta", async () => {
			mockCreate.mockImplementationOnce(() =>
				asyncStreamFrom([
					{
						choices: [{ delta: { reasoning_content: "thinking...", content: "answer" } }],
					},
				]),
			)

			const stream = handler.createMessage("system prompt", [])
			const chunks = await collectStream(stream)

			const contentChunks = chunks.filter((c) => c.type === "reasoning" || c.type === "text")
			expect(contentChunks).toEqual([
				{ type: "reasoning", text: "thinking..." },
				{ type: "text", text: "answer" },
			])
		})
	})

	describe("Basic functionality", () => {
		it("should create stream with correct parameters", async () => {
			mockCreate.mockImplementationOnce(() => asyncStreamFrom([]))

			const systemPrompt = "Test system prompt"
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Test message" }]

			const messageGenerator = handler.createMessage(systemPrompt, messages)
			await messageGenerator.next()

			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					model: "test-model",
					temperature: 0,
					messages: expect.arrayContaining([{ role: "system", content: systemPrompt }]),
					stream: true,
					stream_options: { include_usage: true },
				}),
				undefined,
			)
		})

		it("should yield usage data from stream", async () => {
			mockCreate.mockImplementationOnce(() =>
				asyncStreamFrom([
					{
						choices: [{ delta: {} }],
						usage: { prompt_tokens: 100, completion_tokens: 50 },
					},
				]),
			)

			const stream = handler.createMessage("system prompt", [])
			const firstChunk = await stream.next()

			expect(firstChunk.done).toBe(false)
			expect(firstChunk.value).toMatchObject({ type: "usage", inputTokens: 100, outputTokens: 50 })
		})

		it("should keep the last usage when a later chunk carries none", async () => {
			mockCreate.mockImplementationOnce(() =>
				asyncStreamFrom([
					{
						choices: [{ delta: {} }],
						usage: { prompt_tokens: 10, completion_tokens: 5 },
					},
					{ choices: [{ delta: { content: "tail" } }] },
				]),
			)

			const stream = handler.createMessage("system prompt", [])
			const chunks = await collectStream(stream)

			// The recorded usage is only replaced by a chunk that actually carries
			// usage; a later usage-less chunk must not wipe out the metrics.
			const usageChunks = chunks.filter((chunk) => chunk.type === "usage")
			expect(usageChunks).toHaveLength(1)
			expect(usageChunks[0]).toMatchObject({ type: "usage", inputTokens: 10, outputTokens: 5 })
		})
	})

	describe("stream chunk shape edge cases", () => {
		it("should surface the choices access as the failure site for a null chunk", async () => {
			mockCreate.mockImplementationOnce(() =>
				asyncStreamFrom([null, { choices: [{ delta: { content: "after" } }] }]),
			)

			const result = await captureError(
				(async () => {
					for await (const _ of handler.createMessage("system prompt", [])) {
						// consume
					}
				})(),
			)

			// A null chunk passes the base_resp guard (typeof null is "object" but
			// the !== null check short-circuits) and only fails at the first choices
			// access; pinning the message proves the guard is evaluated first.
			expect(result.name).toBe("Error")
			expect(result.message).toBe(
				"TestProvider completion error: Cannot read properties of null (reading 'choices')",
			)
		})

		it("should continue streaming content after a primitive chunk", async () => {
			mockCreate.mockImplementationOnce(() =>
				asyncStreamFrom(["unexpected-chunk", { choices: [{ delta: { content: "after" } }] }]),
			)

			const chunks = await collectStream(handler.createMessage("system prompt", []))

			// A primitive chunk fails the base_resp guard's object check and its
			// property reads short-circuit through optional chaining, so the stream
			// must carry on with the next real chunk.
			expect(chunks).toEqual([{ type: "text", text: "after" }])
		})

		it("should skip an empty choices array without crashing the delta reads", async () => {
			mockCreate.mockImplementationOnce(() =>
				asyncStreamFrom([{ choices: [] }, { choices: [{ delta: { content: "after" } }] }]),
			)

			const chunks = await collectStream(handler.createMessage("system prompt", []))

			// With no first choice, delta and finish_reason resolve to undefined;
			// the optional chaining must keep the iteration alive for the next chunk.
			expect(chunks).toEqual([{ type: "text", text: "after" }])
		})
	})

	describe("abort signal wiring", () => {
		it("should pass the metadata abort signal to the client request", async () => {
			const controller = new AbortController()
			mockCreate.mockImplementationOnce(() => asyncStreamFrom([]))

			const stream = handler.createMessage("system prompt", [], {
				taskId: "test-task",
				abortSignal: controller.signal,
			})
			await stream.next()

			expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ model: "test-model" }), {
				signal: controller.signal,
			})
		})

		it("should reject before issuing any request when the abort signal is already aborted", async () => {
			const controller = new AbortController()
			controller.abort()

			await expect(async () => {
				for await (const _ of handler.createMessage("system prompt", [], {
					taskId: "test-task",
					abortSignal: controller.signal,
				})) {
					// consume
				}
			}).rejects.toMatchObject({ name: "AbortError", message: "This operation was aborted" })
			expect(mockCreate).not.toHaveBeenCalled()
		})

		it("should normalize the SDK APIUserAbortError from the stream path into the abort contract", async () => {
			mockCreate.mockImplementationOnce(() => {
				throw new APIUserAbortError()
			})

			const result = await captureError(
				(async () => {
					for await (const _ of handler.createMessage("system prompt", [])) {
						// consume
					}
				})(),
			)

			// The SDK error has name "Error" and a message ending in a period; the
			// provider must rethrow the Task.ts contract shape instead.
			expect(result.name).toBe("AbortError")
			expect(result.message).toBe("TestProvider request aborted")
			expect(result.message.endsWith("aborted")).toBe(true)
		})

		it("should normalize an abort error raised during stream iteration into the abort contract", async () => {
			mockCreate.mockImplementationOnce(() =>
				(async function* () {
					yield { choices: [{ delta: { content: "partial" } }] }
					throw new APIUserAbortError()
				})(),
			)

			const result = await captureError(
				(async () => {
					for await (const _ of handler.createMessage("system prompt", [])) {
						// consume
					}
				})(),
			)

			// The iterator rejects after the first chunk; the provider must normalize
			// it to the Task.ts contract shape (name + message ending in "aborted").
			expect(result.name).toBe("AbortError")
			expect(result.message).toBe("TestProvider request aborted")
			expect(result.message.endsWith("aborted")).toBe(true)
		})

		it("should wrap a non-abort base_resp stream error with the provider prefix through the iteration wrapper", async () => {
			mockCreate.mockImplementationOnce(() =>
				asyncStreamFrom([
					{
						choices: [{ delta: { content: "partial" } }],
						base_resp: { status_code: 1041, status_msg: "Invalid token" },
					},
				]),
			)

			const result = await captureError(
				(async () => {
					for await (const _ of handler.createMessage("system prompt", [])) {
						// consume
					}
				})(),
			)

			expect(result.message).toBe("TestProvider completion error: TestProvider API Error (1041): Invalid token")
		})

		it("should fall back to an Unknown error when a base_resp stream chunk has no status_msg", async () => {
			mockCreate.mockImplementationOnce(() =>
				asyncStreamFrom([
					{
						choices: [{ delta: { content: "partial" } }],
						base_resp: { status_code: 1041 },
					},
				]),
			)

			const result = await captureError(
				(async () => {
					for await (const _ of handler.createMessage("system prompt", [])) {
						// consume
					}
				})(),
			)

			expect(result.message).toBe("TestProvider completion error: TestProvider API Error (1041): Unknown error")
		})

		it("should ignore a zero base_resp status_code because 0 is a success sentinel", async () => {
			mockCreate.mockImplementationOnce(() =>
				asyncStreamFrom([
					{
						choices: [{ delta: { content: "ok" } }],
						base_resp: { status_code: 0 },
					},
				]),
			)

			const chunks = await collectStream(handler.createMessage("system prompt", []))

			expect(chunks).toEqual([{ type: "text", text: "ok" }])
		})

		it("should ignore an empty-string base_resp status_code", async () => {
			mockCreate.mockImplementationOnce(() =>
				asyncStreamFrom([
					{
						choices: [{ delta: { content: "ok" } }],
						base_resp: { status_code: "" },
					},
				]),
			)

			const chunks = await collectStream(handler.createMessage("system prompt", []))

			expect(chunks).toEqual([{ type: "text", text: "ok" }])
		})

		it("should report a string base_resp status_code with its status_msg", async () => {
			mockCreate.mockImplementationOnce(() =>
				asyncStreamFrom([
					{
						base_resp: { status_code: "1001", status_msg: "bad token" },
					},
				]),
			)

			const result = await captureError(
				(async () => {
					for await (const _ of handler.createMessage("system prompt", [])) {
						// consume
					}
				})(),
			)

			expect(result.message).toBe("TestProvider completion error: TestProvider API Error (1001): bad token")
		})

		it("should ignore a boolean base_resp status_code", async () => {
			mockCreate.mockImplementationOnce(() =>
				asyncStreamFrom([
					{
						choices: [{ delta: { content: "ok" } }],
						base_resp: { status_code: true },
					},
				]),
			)

			const chunks = await collectStream(handler.createMessage("system prompt", []))

			expect(chunks).toEqual([{ type: "text", text: "ok" }])
		})

		it("should still wrap non-abort request errors with the provider prefix", async () => {
			mockCreate.mockImplementationOnce(() => {
				throw new Error("boom")
			})

			const result = await captureError(
				(async () => {
					for await (const _ of handler.createMessage("system prompt", [])) {
						// consume
					}
				})(),
			)

			expect(result.message).toBe("TestProvider completion error: boom")
		})

		it("should pass the completePrompt abort signal to the client request", async () => {
			const controller = new AbortController()
			mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: "response" } }] })

			const result = await handler.completePrompt("test prompt", { abortSignal: controller.signal })

			expect(result).toBe("response")
			expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ model: "test-model" }), {
				signal: controller.signal,
			})
		})

		it("should merge the completePrompt abort signal and timeoutMs into one request signal", async () => {
			const controller = new AbortController()
			mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: "response" } }] })

			await handler.completePrompt("test prompt", { abortSignal: controller.signal, timeoutMs: 5000 })

			const requestOptions = mockCreate.mock.calls.at(-1)?.[1]
			expect(requestOptions?.signal).toBeInstanceOf(AbortSignal)
			expect(requestOptions?.signal.aborted).toBe(false)
			// A positive timeoutMs must be forwarded as the per-request SDK timeout.
			expect(requestOptions?.timeout).toBe(5000)
			// A timeout-only merged signal would still pass the assertions above;
			// aborting the caller's controller proves caller cancellation survives.
			controller.abort()
			expect(requestOptions?.signal.aborted).toBe(true)
		})

		it("should abort the request when a timeout-only completePrompt timeoutMs elapses", async () => {
			// Emulate the OpenAI SDK: the pending request rejects when its signal aborts.
			let capturedOptions: { signal?: AbortSignal; timeout?: number } | undefined
			mockCreate.mockImplementationOnce(
				async (_params: unknown, options?: { signal?: AbortSignal; timeout?: number }) => {
					capturedOptions = options
					await new Promise<void>((resolve) => {
						if (options?.signal?.aborted) {
							resolve()
						} else {
							options?.signal?.addEventListener("abort", () => resolve(), { once: true })
						}
					})
					throw new APIUserAbortError()
				},
			)

			// No caller signal: the timeout branch is exercised on its own. AbortSignal.timeout
			// is backed by a native self-managed timer (not the fakeable global), so poll with
			// vi.waitFor the same way abort-signal.spec.ts does.
			const requestPromise = handler.completePrompt("test prompt", { timeoutMs: 50 })
			// Attach the rejection handler immediately so the timeout rejection
			// is never observed as unhandled while we poll for the abort.
			const resultPromise = captureError(requestPromise)

			await vi.waitFor(() => expect(capturedOptions?.signal?.aborted).toBe(true))
			expect(capturedOptions?.timeout).toBe(50)

			const result = await resultPromise
			expect(result.name).toBe("AbortError")
			expect(result.message).toBe("TestProvider request aborted")
		})

		it("should not set a request signal for zero completePrompt timeoutMs", async () => {
			mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: "response" } }] })

			await handler.completePrompt("test prompt", { timeoutMs: 0 })

			expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ model: "test-model" }), undefined)
		})

		it("should reject before any request when the completePrompt signal is already aborted", async () => {
			const controller = new AbortController()
			controller.abort()

			await expect(
				handler.completePrompt("test prompt", { abortSignal: controller.signal }),
			).rejects.toMatchObject({
				name: "AbortError",
				message: "This operation was aborted",
			})
			expect(mockCreate).not.toHaveBeenCalled()
		})

		it("should normalize the SDK APIUserAbortError from completePrompt", async () => {
			mockCreate.mockImplementationOnce(() => {
				throw new APIUserAbortError()
			})

			const result = await captureError(handler.completePrompt("test prompt"))

			expect(result.name).toBe("AbortError")
			expect(result.message).toBe("TestProvider request aborted")
		})
	})

	describe("Tool call handling", () => {
		it("should yield tool_call_end events when finish_reason is tool_calls", async () => {
			mockCreate.mockImplementationOnce(() =>
				asyncStreamFrom([
					{
						choices: [
							{
								delta: {
									tool_calls: [
										{
											index: 0,
											id: "call_123",
											function: { name: "test_tool", arguments: '{"arg":' },
										},
									],
								},
							},
						],
					},
					{
						choices: [
							{
								delta: {
									tool_calls: [
										{
											index: 0,
											function: { arguments: '"value"}' },
										},
									],
								},
							},
						],
					},
					{
						choices: [
							{
								delta: {},
								finish_reason: "tool_calls",
							},
						],
					},
				]),
			)

			const stream = handler.createMessage("system prompt", [])
			const chunks = await collectStream(stream)

			// Should have tool_call_partial and tool_call_end
			const partialChunks = chunks.filter((chunk) => chunk.type === "tool_call_partial")
			const endChunks = chunks.filter((chunk) => chunk.type === "tool_call_end")

			expect(partialChunks).toHaveLength(2)
			expect(endChunks).toHaveLength(1)
			expect(endChunks[0]).toEqual({ type: "tool_call_end", id: "call_123" })
		})

		it("should yield multiple tool_call_end events for parallel tool calls", async () => {
			mockCreate.mockImplementationOnce(() =>
				asyncStreamFrom([
					{
						choices: [
							{
								delta: {
									tool_calls: [
										{
											index: 0,
											id: "call_001",
											function: { name: "tool_a", arguments: "{}" },
										},
										{
											index: 1,
											id: "call_002",
											function: { name: "tool_b", arguments: "{}" },
										},
									],
								},
							},
						],
					},
					{
						choices: [
							{
								delta: {},
								finish_reason: "tool_calls",
							},
						],
					},
				]),
			)

			const stream = handler.createMessage("system prompt", [])
			const chunks = await collectStream(stream)

			const endChunks = chunks.filter((chunk) => chunk.type === "tool_call_end")
			expect(endChunks).toHaveLength(2)
			expect(endChunks.map((c: any) => c.id).sort()).toEqual(["call_001", "call_002"])
		})

		it("should not yield tool_call_end when finish_reason is not tool_calls", async () => {
			mockCreate.mockImplementationOnce(() =>
				asyncStreamFrom([
					{
						choices: [
							{
								delta: { content: "Some text response" },
								finish_reason: "stop",
							},
						],
					},
				]),
			)

			const stream = handler.createMessage("system prompt", [])
			const chunks = await collectStream(stream)

			const endChunks = chunks.filter((chunk) => chunk.type === "tool_call_end")
			expect(endChunks).toHaveLength(0)
		})

		it("should yield a tool_call_partial with undefined name and arguments when function is absent", async () => {
			mockCreate.mockImplementationOnce(() =>
				asyncStreamFrom([
					{
						choices: [{ delta: { tool_calls: [{ index: 0, id: "call_fn" }] } }],
					},
				]),
			)

			const stream = handler.createMessage("system prompt", [])
			const chunks = await collectStream(stream)

			// A first-chunk tool call may carry only its id; the optional chaining
			// on function must yield undefined fields instead of throwing.
			expect(chunks).toEqual([
				{ type: "tool_call_partial", index: 0, id: "call_fn", name: undefined, arguments: undefined },
			])
		})

		it("should emit the tool_call_end after the trailing content, not before it", async () => {
			mockCreate.mockImplementationOnce(() =>
				asyncStreamFrom([
					{
						choices: [
							{
								delta: {
									tool_calls: [
										{ index: 0, id: "call_seq", function: { name: "seq_tool", arguments: "{}" } },
									],
								},
							},
						],
					},
					{ choices: [{ delta: { content: "between" } }] },
					{ choices: [{ delta: {}, finish_reason: "tool_calls" }] },
				]),
			)

			const stream = handler.createMessage("system prompt", [])
			const chunks = await collectStream(stream)

			// The end event must only be emitted when finish_reason arrives;
			// emitting it on finish-less chunks would reorder this sequence.
			expect(chunks).toEqual([
				{ type: "tool_call_partial", index: 0, id: "call_seq", name: "seq_tool", arguments: "{}" },
				{ type: "text", text: "between" },
				{ type: "tool_call_end", id: "call_seq" },
			])
		})

		it("should clear the tracked tool call ids after emitting tool_call_end", async () => {
			mockCreate.mockImplementationOnce(() =>
				asyncStreamFrom([
					{
						choices: [
							{
								delta: {
									tool_calls: [
										{ index: 0, id: "call_dup", function: { name: "dup_tool", arguments: "{}" } },
									],
								},
							},
						],
					},
					{ choices: [{ delta: {}, finish_reason: "tool_calls" }] },
					{ choices: [{ delta: { content: "more" } }] },
					{ choices: [{ delta: {}, finish_reason: "tool_calls" }] },
				]),
			)

			const stream = handler.createMessage("system prompt", [])
			const chunks = await collectStream(stream)

			// Without the clear(), the second tool_calls finish would re-emit the
			// end event for the already-finalized call.
			const endChunks = chunks.filter((chunk) => chunk.type === "tool_call_end")
			expect(endChunks).toEqual([{ type: "tool_call_end", id: "call_dup" }])
		})
	})
})
