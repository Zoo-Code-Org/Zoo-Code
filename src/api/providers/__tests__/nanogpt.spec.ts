vi.mock("vscode", () => ({
	workspace: { getConfiguration: () => ({ get: (_key: string, defaultValue?: unknown) => defaultValue }) },
}))

import { Anthropic } from "@anthropic-ai/sdk"
import OpenAI from "openai"

import { nanoGptDefaultModelId, providerIdentifiers } from "@roo-code/types"

import { buildApiHandler } from "../../index"
import { asyncStreamFrom, collectStream } from "../../../test-utils/stream"
import { NanoGptHandler } from "../nanogpt"
import { getModels } from "../fetchers/modelCache"

vi.mock("openai")
vi.mock("../fetchers/modelCache", () => ({
	getModels: vi.fn().mockResolvedValue({
		"model:thinking": {
			maxTokens: 128000,
			contextWindow: 1050000,
			supportsImages: true,
			supportsPromptCache: false,
			supportsReasoningEffort: ["low", "medium", "high"],
		},
	}),
	refreshModels: vi.fn().mockResolvedValue({
		"model:thinking": {
			maxTokens: 128000,
			contextWindow: 1050000,
			supportsImages: true,
			supportsPromptCache: false,
			supportsReasoningEffort: ["low", "medium", "high"],
		},
	}),
	getModelsFromCache: vi.fn(),
}))

const mockCreate = vi.fn()
vi.mocked(OpenAI).mockImplementation(function () {
	return { chat: { completions: { create: mockCreate } } } as unknown as OpenAI
})

const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Hello" }]

describe("NanoGptHandler", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.mocked(getModels).mockResolvedValue({
			"model:thinking": {
				maxTokens: 128000,
				contextWindow: 1050000,
				supportsImages: true,
				supportsPromptCache: false,
				supportsReasoningEffort: ["low", "medium", "high"],
			},
		})
		mockCreate.mockResolvedValue(asyncStreamFrom([]))
	})

	it("is constructed by the backend provider registry", () => {
		expect(buildApiHandler({ apiProvider: providerIdentifiers.nanogpt })).toBeInstanceOf(NanoGptHandler)
	})

	it("keeps the canonical model ID while applying request-only routing", async () => {
		const handler = new NanoGptHandler({ nanoGptModelId: "model:thinking", nanoGptRoutingPreference: "fast" })
		await collectStream(handler.createMessage("system", messages))
		expect(handler.getModel().id).toBe("model:thinking")
		expect(mockCreate).toHaveBeenCalledWith(
			expect.objectContaining({ model: "model:thinking:fast" }),
			expect.anything(),
		)
	})

	it.each([
		["auto", "model:thinking"],
		["fast", "model:thinking:fast"],
		["cheap", "model:thinking:cheap"],
		["latency", "model:thinking:latency"],
		["throughput", "model:thinking:throughput"],
		["tools", "model:thinking:tools"],
	] as const)("sends %s routing", async (preference, expected) => {
		const handler = new NanoGptHandler({ nanoGptModelId: "model:thinking", nanoGptRoutingPreference: preference })
		await collectStream(handler.createMessage("system", messages))
		expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ model: expected }), expect.anything())
	})

	it("requests cache-capable routing without changing the streaming model ID", async () => {
		const handler = new NanoGptHandler({
			nanoGptModelId: "model:thinking",
			nanoGptRoutingPreference: "caching",
		})
		await collectStream(handler.createMessage("system", messages))
		expect(mockCreate).toHaveBeenCalledWith(
			expect.objectContaining({ model: "model:thinking", caching: true, stream: true }),
			expect.anything(),
		)
	})

	it("streams interleaved text, both reasoning variants, and parallel tool calls", async () => {
		mockCreate.mockResolvedValue(
			asyncStreamFrom([
				{ choices: [{ delta: { content: "answer", reasoning: "modern" } }] },
				{ choices: [{ delta: { reasoning_content: "legacy" } }] },
				{
					choices: [
						{
							delta: {
								tool_calls: [
									{ index: 0, id: "call-1", function: { name: "read_file", arguments: '{"path":' } },
									{
										index: 1,
										id: "call-2",
										function: { name: "search_files", arguments: '{"query":' },
									},
								],
							},
						},
					],
				},
			]),
		)
		const chunks = await collectStream(
			new NanoGptHandler({ nanoGptModelId: "model:thinking" }).createMessage("sys", messages),
		)
		expect(chunks).toEqual([
			{ type: "text", text: "answer" },
			{ type: "reasoning", text: "modern" },
			{ type: "reasoning", text: "legacy" },
			{ type: "tool_call_partial", index: 0, id: "call-1", name: "read_file", arguments: '{"path":' },
			{ type: "tool_call_partial", index: 1, id: "call-2", name: "search_files", arguments: '{"query":' },
		])
	})

	it("forwards native tools, choices, usage streaming, max_tokens, reasoning effort, and cancellation", async () => {
		const signal = new AbortController().signal
		const tools: OpenAI.Chat.ChatCompletionTool[] = [
			{ type: "function", function: { name: "read_file", description: "Read", parameters: { type: "object" } } },
		]
		const handler = new NanoGptHandler({
			nanoGptModelId: "model:thinking",
			modelTemperature: 0.7,
			reasoningEffort: "high",
		})
		await collectStream(
			handler.createMessage("sys", messages, {
				taskId: "task",
				tools,
				tool_choice: "required",
				parallelToolCalls: false,
				abortSignal: signal,
			}),
		)
		expect(mockCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				stream: true,
				stream_options: { include_usage: true },
				max_tokens: 128000,
				temperature: 0.7,
				reasoning_effort: "high",
				tools: [
					expect.objectContaining({
						type: "function",
						function: expect.objectContaining({ name: "read_file", description: "Read" }),
					}),
				],
				tool_choice: "required",
				parallel_tool_calls: false,
			}),
			{ signal },
		)
		expect(mockCreate.mock.calls[0][0]).not.toHaveProperty("max_completion_tokens")
	})

	it("keeps Muse Spark tool-result history contiguous across turns", async () => {
		const modelId = "meta/muse-spark-1.2-contributor"
		vi.mocked(getModels).mockResolvedValue({
			[modelId]: {
				maxTokens: 65_536,
				contextWindow: 1_000_000,
				supportsPromptCache: false,
			},
		})
		const tools: OpenAI.Chat.ChatCompletionTool[] = [
			{ type: "function", function: { name: "read_file", parameters: { type: "object" } } },
		]
		const toolHistory: Anthropic.Messages.MessageParam[] = [
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "call_1", name: "read_file", input: { path: "first.txt" } }],
			},
			{
				role: "user",
				content: [
					{ type: "tool_result", tool_use_id: "call_1", content: "first result" },
					{ type: "text", text: "<environment_details>first context</environment_details>" },
				],
			},
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "call_2", name: "read_file", input: { path: "second.txt" } }],
			},
			{
				role: "user",
				content: [
					{ type: "tool_result", tool_use_id: "call_2", content: "second result" },
					{ type: "text", text: "<environment_details>second context</environment_details>" },
				],
			},
		]

		await collectStream(
			new NanoGptHandler({ nanoGptModelId: modelId }).createMessage("sys", toolHistory, {
				taskId: "task",
				tools,
				tool_choice: "auto",
				parallelToolCalls: true,
			}),
		)

		expect(mockCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				model: modelId,
				messages: [
					{ role: "system", content: "sys" },
					expect.objectContaining({ role: "assistant", tool_calls: [expect.anything()] }),
					{
						role: "tool",
						tool_call_id: "call_1",
						content: "first result\n\n<environment_details>first context</environment_details>",
					},
					expect.objectContaining({ role: "assistant", tool_calls: [expect.anything()] }),
					{
						role: "tool",
						tool_call_id: "call_2",
						content: "second result\n\n<environment_details>second context</environment_details>",
					},
				],
				tools: [expect.objectContaining({ function: expect.objectContaining({ name: "read_file" }) })],
				tool_choice: "auto",
				parallel_tool_calls: true,
			}),
			expect.anything(),
		)
	})

	it("omits temperature when it was not explicitly configured", async () => {
		await collectStream(new NanoGptHandler({ nanoGptModelId: "model:thinking" }).createMessage("sys", messages))
		expect(mockCreate.mock.calls[0][0]).not.toHaveProperty("temperature")
	})

	it("keeps unauthenticated catalog fetches public and preserves streaming error metadata while redacting", async () => {
		const errorDetails = [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "10s" }]
		mockCreate.mockRejectedValue(
			Object.assign(new Error("upstream rejected secret-key"), {
				status: 429,
				code: "rate_limit_exceeded",
				errorDetails,
			}),
		)
		const handler = new NanoGptHandler({ nanoGptApiKey: "secret-key", nanoGptModelId: "model:thinking" })
		await expect(collectStream(handler.createMessage("sys", messages))).rejects.toMatchObject({
			message: "NanoGPT streaming error: upstream rejected [REDACTED]",
			status: 429,
			code: "rate_limit_exceeded",
			errorDetails,
		})

		vi.mocked(getModels).mockResolvedValue({})
		mockCreate.mockResolvedValue(asyncStreamFrom([]))
		await collectStream(new NanoGptHandler({ nanoGptModelId: "model:thinking" }).createMessage("sys", messages))
		expect(getModels).toHaveBeenLastCalledWith(
			expect.objectContaining({ provider: providerIdentifiers.nanogpt, apiKey: undefined }),
		)
	})

	it("maps usage with root-field precedence and no reasoning double count", async () => {
		mockCreate.mockResolvedValue(
			asyncStreamFrom([
				{
					choices: [],
					usage: {
						prompt_tokens: 20,
						completion_tokens: 10,
						cache_read_input_tokens: 7,
						cache_creation_input_tokens: 3,
						prompt_tokens_details: { cached_tokens: 5 },
						completion_tokens_details: { reasoning_tokens: 4 },
						reasoning_tokens: 2,
					},
				},
			]),
		)
		expect(
			await collectStream(
				new NanoGptHandler({ nanoGptModelId: "model:thinking" }).createMessage("sys", messages),
			),
		).toEqual([
			{
				type: "usage",
				inputTokens: 20,
				outputTokens: 10,
				cacheReadTokens: 7,
				cacheWriteTokens: 3,
				reasoningTokens: 4,
			},
		])
	})

	it("falls back to nested cache reads and root reasoning tokens", async () => {
		mockCreate.mockResolvedValue(
			asyncStreamFrom([
				{
					choices: [],
					usage: {
						prompt_tokens: 2,
						completion_tokens: 1,
						prompt_tokens_details: { cached_tokens: 1 },
						reasoning_tokens: 1,
					},
				},
			]),
		)
		expect(
			await collectStream(
				new NanoGptHandler({ nanoGptModelId: "model:thinking" }).createMessage("sys", messages),
			),
		).toEqual([
			{
				type: "usage",
				inputTokens: 2,
				outputTokens: 1,
				cacheReadTokens: 1,
				cacheWriteTokens: undefined,
				reasoningTokens: 1,
			},
		])
	})

	describe("completePrompt", () => {
		it("requests cache-capable routing without changing the completion model ID", async () => {
			mockCreate.mockResolvedValue({ choices: [{ message: { content: "response" } }] })
			const handler = new NanoGptHandler({
				nanoGptModelId: "model:thinking",
				nanoGptRoutingPreference: "caching",
			})
			await handler.completePrompt("prompt")
			expect(mockCreate.mock.calls[0][0]).toMatchObject({
				model: "model:thinking",
				caching: true,
				stream: false,
			})
		})

		it("returns normal and empty content", async () => {
			mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: "response" } }] })
			const handler = new NanoGptHandler({ nanoGptModelId: "model:thinking" })
			expect(await handler.completePrompt("prompt")).toBe("response")
			expect(mockCreate.mock.calls[0][0]).toMatchObject({
				model: "model:thinking",
				stream: false,
				max_tokens: 128000,
			})

			mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: null } }] })
			expect(await handler.completePrompt("prompt")).toBe("")
		})

		it("preserves completion error metadata without leaking the API key", async () => {
			const errorDetails = [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "20s" }]
			mockCreate.mockRejectedValue(
				Object.assign(new Error("upstream rejected secret-key"), {
					status: 429,
					code: "rate_limit_exceeded",
					errorDetails,
				}),
			)
			const handler = new NanoGptHandler({ nanoGptApiKey: "secret-key", nanoGptModelId: "model:thinking" })
			await expect(handler.completePrompt("prompt")).rejects.toMatchObject({
				message: "NanoGPT completion error: upstream rejected [REDACTED]",
				status: 429,
				code: "rate_limit_exceeded",
				errorDetails,
			})
		})
	})

	it("uses the documented fallback model", async () => {
		vi.mocked(getModels).mockResolvedValue({})
		const handler = new NanoGptHandler({})
		await collectStream(handler.createMessage("sys", messages))
		expect(mockCreate).toHaveBeenCalledWith(
			expect.objectContaining({ model: nanoGptDefaultModelId }),
			expect.anything(),
		)
	})
})
