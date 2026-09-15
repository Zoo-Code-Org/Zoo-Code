// pnpm --filter roo-cline test api/providers/__tests__/openrouter.spec.ts

vitest.mock("vscode", () => ({
	workspace: {
		getConfiguration: () => ({
			get: (_key: string, defaultValue?: unknown) => defaultValue,
		}),
	},
}))

vitest.mock("../utils/timeout-config", () => ({
	getApiRequestTimeout: vitest.fn().mockReturnValue(300_000),
}))

const MOCK_TIMEOUT_MS = 300_000

import { Anthropic } from "@anthropic-ai/sdk"
import OpenAI from "openai"

import { providerIdentifiers, type ModelRecord } from "@roo-code/types"

import { OpenRouterHandler } from "../openrouter"
import { Package } from "../../../shared/package"
import { makeApiHandlerOptions, makeCreateMessageMetadata } from "../../../test-utils/api"
import { asyncStreamFrom, collectStream } from "../../../test-utils/stream"
import { collectStreamAndParseToolCalls } from "../../../test-utils/native-tool-call-stream"
import { clearAllMocks } from "../../../test-utils/reset"
import { settlesWithin } from "../../../test-utils/promise"

vitest.mock("openai")
vitest.mock("delay", () => ({
	default: vitest.fn(function () {
		return Promise.resolve()
	}),
}))

const mockCaptureException = vitest.fn()

vitest.mock("@roo-code/telemetry", () => ({
	TelemetryService: {
		instance: {
			captureException: (...args: unknown[]) => mockCaptureException(...args),
		},
	},
}))

vitest.mock("../fetchers/modelCache", () => ({
	getModels: vitest.fn().mockImplementation(function () {
		return Promise.resolve({
			"anthropic/claude-sonnet-4": {
				maxTokens: 8192,
				contextWindow: 200000,
				supportsImages: true,
				supportsPromptCache: true,
				inputPrice: 3,
				outputPrice: 15,
				cacheWritesPrice: 3.75,
				cacheReadsPrice: 0.3,
				description: "Claude 3.7 Sonnet",
				thinking: false,
			},
			"anthropic/claude-sonnet-4.5": {
				maxTokens: 8192,
				contextWindow: 200000,
				supportsImages: true,
				supportsPromptCache: true,
				inputPrice: 3,
				outputPrice: 15,
				cacheWritesPrice: 3.75,
				cacheReadsPrice: 0.3,
				description: "Claude 4.5 Sonnet",
				thinking: false,
			},
			"anthropic/claude-3.7-sonnet:thinking": {
				maxTokens: 128000,
				contextWindow: 200000,
				supportsImages: true,
				supportsPromptCache: true,
				inputPrice: 3,
				outputPrice: 15,
				cacheWritesPrice: 3.75,
				cacheReadsPrice: 0.3,
				description: "Claude 3.7 Sonnet with thinking",
			},
			"openai/gpt-4o": {
				maxTokens: 16384,
				contextWindow: 128000,
				supportsImages: true,
				supportsPromptCache: false,
				inputPrice: 2.5,
				outputPrice: 10,
				description: "GPT-4o",
			},
			"openai/o1": {
				maxTokens: 100000,
				contextWindow: 200000,
				supportsImages: true,
				supportsPromptCache: false,
				inputPrice: 15,
				outputPrice: 60,
				description: "OpenAI o1",
				excludedTools: ["existing_excluded"],
				includedTools: ["existing_included"],
			},
		})
	}),
	refreshModels: vitest.fn(async (options) => {
		const { getModels } = await import("../fetchers/modelCache")
		return getModels(options)
	}),
}))

const ABORT_SETTLE_MS = 150

describe("OpenRouterHandler", () => {
	const mockOptions = makeApiHandlerOptions({
		openRouterApiKey: "test-key",
		openRouterModelId: "anthropic/claude-sonnet-4",
	})

	beforeEach(() => clearAllMocks())

	it("initializes with correct options", () => {
		const handler = new OpenRouterHandler(mockOptions)
		expect(handler).toBeInstanceOf(OpenRouterHandler)

		expect(OpenAI).toHaveBeenCalledWith({
			baseURL: "https://openrouter.ai/api/v1",
			apiKey: mockOptions.openRouterApiKey,
			defaultHeaders: {
				"HTTP-Referer": "https://github.com/Zoo-Code-Org/Zoo-Code",
				"X-Title": "Zoo Code",
				"User-Agent": `ZooCode/${Package.version}`,
			},
			timeout: MOCK_TIMEOUT_MS,
		})
	})

	describe("fetchModel", () => {
		it("returns correct model info when options are provided", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const result = await handler.fetchModel()

			expect(result).toMatchObject({
				id: mockOptions.openRouterModelId,
				maxTokens: 8192,
				temperature: 0,
				reasoningEffort: undefined,
				topP: undefined,
			})
		})

		it("returns default model info when options are not provided", async () => {
			const handler = new OpenRouterHandler({})
			const result = await handler.fetchModel()
			expect(result.id).toBe("anthropic/claude-sonnet-4.5")
			expect(result.info.supportsPromptCache).toBe(true)
		})

		it("honors custom maxTokens for thinking models", async () => {
			const handler = new OpenRouterHandler(
				makeApiHandlerOptions({
					openRouterApiKey: "test-key",
					openRouterModelId: "anthropic/claude-3.7-sonnet:thinking",
					modelMaxTokens: 32_768,
					modelMaxThinkingTokens: 16_384,
				}),
			)

			const result = await handler.fetchModel()
			// With the new clamping logic, 128000 tokens (64% of 200000 context window)
			// gets clamped to 20% of context window: 200000 * 0.2 = 40000
			expect(result.maxTokens).toBe(40000)
			expect(result.reasoningBudget).toBeUndefined()
			expect(result.temperature).toBe(0)
		})

		it("does not honor custom maxTokens for non-thinking models", async () => {
			const handler = new OpenRouterHandler(
				makeApiHandlerOptions({
					...mockOptions,
					modelMaxTokens: 32_768,
					modelMaxThinkingTokens: 16_384,
				}),
			)

			const result = await handler.fetchModel()
			expect(result.maxTokens).toBe(8192)
			expect(result.reasoningBudget).toBeUndefined()
			expect(result.temperature).toBe(0)
		})

		it("adds excludedTools and includedTools for OpenAI models", async () => {
			const handler = new OpenRouterHandler(
				makeApiHandlerOptions({
					openRouterApiKey: "test-key",
					openRouterModelId: "openai/gpt-4o",
				}),
			)

			const result = await handler.fetchModel()
			expect(result.id).toBe("openai/gpt-4o")
			expect(result.info.excludedTools).toContain("apply_diff")
			expect(result.info.excludedTools).toContain("write_to_file")
			expect(result.info.includedTools).toContain("apply_patch")
		})

		it("merges excludedTools and includedTools with existing values for OpenAI models", async () => {
			const handler = new OpenRouterHandler(
				makeApiHandlerOptions({
					openRouterApiKey: "test-key",
					openRouterModelId: "openai/o1",
				}),
			)

			const result = await handler.fetchModel()
			expect(result.id).toBe("openai/o1")
			// Should have the new exclusions
			expect(result.info.excludedTools).toContain("apply_diff")
			expect(result.info.excludedTools).toContain("write_to_file")
			// Should preserve existing exclusions
			expect(result.info.excludedTools).toContain("existing_excluded")
			// Should have the new inclusions
			expect(result.info.includedTools).toContain("apply_patch")
			// Should preserve existing inclusions
			expect(result.info.includedTools).toContain("existing_included")
		})

		it("does not add excludedTools or includedTools for non-OpenAI models", async () => {
			const handler = new OpenRouterHandler(
				makeApiHandlerOptions({
					openRouterApiKey: "test-key",
					openRouterModelId: "anthropic/claude-sonnet-4",
				}),
			)

			const result = await handler.fetchModel()
			expect(result.id).toBe("anthropic/claude-sonnet-4")
			// Should NOT have the tool exclusions/inclusions
			expect(result.info.excludedTools).toBeUndefined()
			expect(result.info.includedTools).toBeUndefined()
		})
	})

	describe("createMessage", () => {
		it("generates correct stream chunks", async () => {
			const handler = new OpenRouterHandler(mockOptions)

			const mockStream = asyncStreamFrom([
				{
					id: mockOptions.openRouterModelId,
					choices: [{ delta: { content: "test response" } }],
				},
				{
					id: "test-id",
					choices: [{ delta: {} }],
					usage: { prompt_tokens: 10, completion_tokens: 20, cost: 0.001 },
				},
			])

			// Mock OpenAI chat.completions.create
			const mockCreate = vitest.fn().mockResolvedValue(mockStream)

			;(OpenAI as any).prototype.chat = {
				completions: { create: mockCreate },
			} as any

			const systemPrompt = "test system prompt"
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user" as const, content: "test message" }]

			const chunks = await collectStream(handler.createMessage(systemPrompt, messages))

			// Verify stream chunks
			expect(chunks).toHaveLength(2) // One text chunk and one usage chunk
			expect(chunks[0]).toEqual({ type: "text", text: "test response" })
			expect(chunks[1]).toEqual({ type: "usage", inputTokens: 10, outputTokens: 20, totalCost: 0.001 })

			// Verify OpenAI client was called with correct parameters.
			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					max_tokens: 8192,
					messages: [
						{
							content: [
								{ cache_control: { type: "ephemeral" }, text: "test system prompt", type: "text" },
							],
							role: "system",
						},
						{
							content: [{ cache_control: { type: "ephemeral" }, text: "test message", type: "text" }],
							role: "user",
						},
					],
					model: "anthropic/claude-sonnet-4",
					stream: true,
					stream_options: { include_usage: true },
					temperature: 0,
					top_p: undefined,
				}),
				{
					headers: { "x-anthropic-beta": "fine-grained-tool-streaming-2025-05-14" },
					signal: expect.any(AbortSignal),
				},
			)
		})

		it("adds cache control for supported models", async () => {
			const handler = new OpenRouterHandler(
				makeApiHandlerOptions({
					...mockOptions,
					openRouterModelId: "anthropic/claude-3.5-sonnet",
				}),
			)

			const mockStream = asyncStreamFrom([
				{
					id: "test-id",
					choices: [{ delta: { content: "test response" } }],
				},
			])

			const mockCreate = vitest.fn().mockResolvedValue(mockStream)
			;(OpenAI as any).prototype.chat = {
				completions: { create: mockCreate },
			} as any

			const messages: Anthropic.Messages.MessageParam[] = [
				{ role: "user", content: "message 1" },
				{ role: "assistant", content: "response 1" },
				{ role: "user", content: "message 2" },
			]

			await handler.createMessage("test system", messages).next()

			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					messages: expect.arrayContaining([
						expect.objectContaining({
							role: "system",
							content: expect.arrayContaining([
								expect.objectContaining({ cache_control: { type: "ephemeral" } }),
							]),
						}),
					]),
				}),
				{
					headers: { "x-anthropic-beta": "fine-grained-tool-streaming-2025-05-14" },
					signal: expect.any(AbortSignal),
				},
			)
		})

		it("handles API errors and captures telemetry", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const mockStream = asyncStreamFrom([{ error: { message: "API Error", code: 500 } }])

			const mockCreate = vitest.fn().mockResolvedValue(mockStream)
			;(OpenAI as any).prototype.chat = {
				completions: { create: mockCreate },
			} as any

			const generator = handler.createMessage("test", [])
			await expect(generator.next()).rejects.toThrow("OpenRouter API Error 500: API Error")

			expect(mockCaptureException).toHaveBeenCalledWith(
				expect.objectContaining({
					message: "API Error",
					provider: providerIdentifiers.openrouter,
					modelId: mockOptions.openRouterModelId,
					operation: "createMessage",
					errorCode: 500,
					status: 500,
				}),
			)
		})

		it("captures telemetry when createMessage throws an exception", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const mockCreate = vitest.fn().mockRejectedValue(new Error("Connection failed"))
			;(OpenAI as any).prototype.chat = {
				completions: { create: mockCreate },
			} as any

			const generator = handler.createMessage("test", [])
			await expect(generator.next()).rejects.toThrow()

			expect(mockCaptureException).toHaveBeenCalledWith(
				expect.objectContaining({
					message: "Connection failed",
					provider: providerIdentifiers.openrouter,
					modelId: mockOptions.openRouterModelId,
					operation: "createMessage",
				}),
			)
		})

		it("passes SDK exceptions with status 429 to telemetry (filtering happens in PostHogTelemetryClient)", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const error = new Error("Rate limit exceeded: free-models-per-day") as any
			error.status = 429

			const mockCreate = vitest.fn().mockRejectedValue(error)
			;(OpenAI as any).prototype.chat = {
				completions: { create: mockCreate },
			} as any

			const generator = handler.createMessage("test", [])
			await expect(generator.next()).rejects.toThrow("Rate limit exceeded")

			expect(mockCaptureException).toHaveBeenCalledWith(
				expect.objectContaining({
					message: "Rate limit exceeded: free-models-per-day",
					provider: providerIdentifiers.openrouter,
					modelId: mockOptions.openRouterModelId,
					operation: "createMessage",
				}),
			)
		})

		it("passes SDK exceptions with 429 in message to telemetry (filtering happens in PostHogTelemetryClient)", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const error = new Error("429 Rate limit exceeded: free-models-per-day")
			const mockCreate = vitest.fn().mockRejectedValue(error)
			;(OpenAI as any).prototype.chat = {
				completions: { create: mockCreate },
			} as any

			const generator = handler.createMessage("test", [])
			await expect(generator.next()).rejects.toThrow("429 Rate limit exceeded")

			expect(mockCaptureException).toHaveBeenCalledWith(
				expect.objectContaining({
					message: "429 Rate limit exceeded: free-models-per-day",
					provider: providerIdentifiers.openrouter,
					modelId: mockOptions.openRouterModelId,
					operation: "createMessage",
				}),
			)
		})

		it("passes SDK exceptions containing 'rate limit' to telemetry (filtering happens in PostHogTelemetryClient)", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const error = new Error("Request failed due to rate limit")
			const mockCreate = vitest.fn().mockRejectedValue(error)
			;(OpenAI as any).prototype.chat = {
				completions: { create: mockCreate },
			} as any

			const generator = handler.createMessage("test", [])
			await expect(generator.next()).rejects.toThrow("rate limit")

			expect(mockCaptureException).toHaveBeenCalledWith(
				expect.objectContaining({
					message: "Request failed due to rate limit",
					provider: providerIdentifiers.openrouter,
					modelId: mockOptions.openRouterModelId,
					operation: "createMessage",
				}),
			)
		})

		it("passes 429 rate limit errors from stream to telemetry (filtering happens in PostHogTelemetryClient)", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const mockStream = asyncStreamFrom([{ error: { message: "Rate limit exceeded", code: 429 } }])

			const mockCreate = vitest.fn().mockResolvedValue(mockStream)
			;(OpenAI as any).prototype.chat = {
				completions: { create: mockCreate },
			} as any

			const generator = handler.createMessage("test", [])
			await expect(generator.next()).rejects.toThrow("OpenRouter API Error 429: Rate limit exceeded")

			expect(mockCaptureException).toHaveBeenCalledWith(
				expect.objectContaining({
					message: "Rate limit exceeded",
					provider: providerIdentifiers.openrouter,
					modelId: mockOptions.openRouterModelId,
					operation: "createMessage",
					errorCode: 429,
					status: 429,
				}),
			)
		})

		it("yields tool_call_end events when finish_reason is tool_calls", async () => {
			// Import NativeToolCallParser to set up state
			const { NativeToolCallParser } = await import("../../../core/assistant-message/NativeToolCallParser")

			const handler = new OpenRouterHandler(mockOptions)

			const mockStream = asyncStreamFrom([
				{
					id: "test-id",
					choices: [
						{
							delta: {
								tool_calls: [
									{
										index: 0,
										id: "call_openrouter_test",
										function: { name: "read_file", arguments: '{"path":"test.ts"}' },
									},
								],
							},
							index: 0,
						},
					],
				},
				{
					id: "test-id",
					choices: [
						{
							delta: {},
							finish_reason: "tool_calls",
							index: 0,
						},
					],
					usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
				},
			])

			const mockCreate = vitest.fn().mockResolvedValue(mockStream)
			;(OpenAI as any).prototype.chat = {
				completions: { create: mockCreate },
			} as any

			const generator = handler.createMessage("test", [])
			const parserScope = NativeToolCallParser.createScope()
			const chunks = []

			for await (const chunk of generator) {
				// Simulate what Task.ts does: when we receive tool_call_partial,
				// process it through NativeToolCallParser to populate rawChunkTracker
				if (chunk.type === "tool_call_partial") {
					NativeToolCallParser.processRawChunk(
						{
							index: chunk.index,
							id: chunk.id,
							name: chunk.name,
							arguments: chunk.arguments,
						},
						parserScope,
					)
				}
				chunks.push(chunk)
			}

			// Should have tool_call_partial and tool_call_end
			const partialChunks = chunks.filter((chunk) => chunk.type === "tool_call_partial")
			const endChunks = chunks.filter((chunk) => chunk.type === "tool_call_end")

			expect(partialChunks).toHaveLength(1)
			expect(endChunks).toHaveLength(1)
			expect(endChunks[0].id).toBe("call_openrouter_test")
		})

		it("emits completion only for identified calls and clears completed IDs", async () => {
			const toolCall = (id?: string) => ({
				id: "stream",
				choices: [
					{
						delta: {
							tool_calls: [
								{ index: 0, id, function: { name: "read_file", arguments: '{"path":"test.ts"}' } },
							],
						},
						index: 0,
					},
				],
			})
			const mockCreate = vitest
				.fn()
				.mockResolvedValueOnce(
					asyncStreamFrom([
						toolCall(),
						{ id: "stream", choices: [{ delta: {}, finish_reason: "tool_calls", index: 0 }] },
					]),
				)
				.mockResolvedValueOnce(
					asyncStreamFrom([
						toolCall("call_openrouter_stop"),
						{ id: "stream", choices: [{ delta: {}, finish_reason: "stop", index: 0 }] },
					]),
				)
				.mockResolvedValueOnce(
					asyncStreamFrom([
						toolCall("call_openrouter_once"),
						{ id: "stream", choices: [{ delta: {}, finish_reason: "tool_calls", index: 0 }] },
						{ id: "stream", choices: [{ delta: {}, finish_reason: "tool_calls", index: 0 }] },
					]),
				)
			Object.defineProperty(OpenAI.prototype, "chat", {
				configurable: true,
				value: { completions: { create: mockCreate } },
			})
			const handler = new OpenRouterHandler(mockOptions)

			const idlessChunks = await collectStream(handler.createMessage("idless", []))
			const stoppedChunks = await collectStream(handler.createMessage("stopped", []))
			const completedChunks = await collectStream(handler.createMessage("completed", []))

			expect(idlessChunks.filter((chunk) => chunk.type === "tool_call_end")).toEqual([])
			expect(stoppedChunks.filter((chunk) => chunk.type === "tool_call_end")).toEqual([])
			expect(completedChunks.filter((chunk) => chunk.type === "tool_call_end")).toEqual([
				{ type: "tool_call_end", id: "call_openrouter_once" },
			])
		})

		it("isolates overlapping tool-call finalization between provider streams", async () => {
			let releaseFirstStream: (() => void) | undefined
			let markFirstStreamPaused: (() => void) | undefined
			const firstStreamRelease = new Promise<void>((resolve) => {
				releaseFirstStream = resolve
			})
			const firstStreamPaused = new Promise<void>((resolve) => {
				markFirstStreamPaused = resolve
			})
			const firstStream = async function* () {
				yield {
					id: "stream-a",
					choices: [
						{
							delta: {
								tool_calls: [
									{
										index: 0,
										id: "call_openrouter_a",
										function: { name: "read_file", arguments: '{"path":"a' },
									},
								],
							},
							index: 0,
						},
					],
				}
				markFirstStreamPaused?.()
				await firstStreamRelease
				yield {
					id: "stream-a",
					choices: [{ delta: {}, finish_reason: "tool_calls", index: 0 }],
				}
			}
			const secondStream = asyncStreamFrom([
				{
					id: "stream-b",
					choices: [
						{
							delta: {
								tool_calls: [
									{
										index: 0,
										id: "call_openrouter_b",
										function: { name: "read_file", arguments: '{"path":"b' },
									},
								],
							},
							index: 0,
						},
					],
				},
				{ id: "stream-b", choices: [{ delta: {}, finish_reason: "tool_calls", index: 0 }] },
			])
			const mockCreate = vitest.fn().mockResolvedValueOnce(firstStream()).mockResolvedValueOnce(secondStream)
			Object.defineProperty(OpenAI.prototype, "chat", {
				configurable: true,
				value: { completions: { create: mockCreate } },
			})
			const handler = new OpenRouterHandler(mockOptions)

			const firstChunksPromise = collectStreamAndParseToolCalls(handler.createMessage("first", []))
			await firstStreamPaused
			const secondChunks = await collectStreamAndParseToolCalls(handler.createMessage("second", []))
			releaseFirstStream?.()
			const firstChunks = await firstChunksPromise

			expect(secondChunks.chunks.filter((chunk) => chunk.type === "tool_call_end")).toEqual([
				{ type: "tool_call_end", id: "call_openrouter_b" },
			])
			expect(firstChunks.chunks.filter((chunk) => chunk.type === "tool_call_end")).toEqual([
				{ type: "tool_call_end", id: "call_openrouter_a" },
			])
			expect(firstChunks.parserEvents).toEqual([
				{ type: "tool_call_start", id: "call_openrouter_a", name: "read_file" },
				{ type: "tool_call_delta", id: "call_openrouter_a", delta: '{"path":"a' },
			])
			expect(secondChunks.parserEvents).toEqual([
				{ type: "tool_call_start", id: "call_openrouter_b", name: "read_file" },
				{ type: "tool_call_delta", id: "call_openrouter_b", delta: '{"path":"b' },
			])
		})

		it("throws an OpenRouter API error for a streamed error chunk and reports telemetry", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const mockCreate = vitest.fn().mockResolvedValue(
				asyncStreamFrom([
					{ id: "1", choices: [{ delta: { content: "ok" } }] },
					{
						id: "1",
						error: {
							message: "Upstream failed",
							code: 500,
							metadata: { raw: '{"message":"upstream: boom"}' },
						},
					},
				]),
			)
			// The auto-mocked OpenAI client is injected via a structural type to avoid `any` casts.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			client.chat = { completions: { create: mockCreate } }

			const stream = handler.createMessage("system", [{ role: "user" as const, content: "hi" }])

			await expect(collectStream(stream)).rejects.toThrow("OpenRouter API Error 500: upstream: boom")
			expect(mockCaptureException).toHaveBeenCalledWith(
				expect.objectContaining({
					message: "upstream: boom",
					provider: providerIdentifiers.openrouter,
					modelId: "anthropic/claude-sonnet-4",
					operation: "createMessage",
				}),
			)
		})
		it("rejects with AbortError when the external signal is pre-aborted", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const mockCreate = vitest.fn().mockResolvedValue({ choices: [{ message: { content: "response" } }] })
			// The auto-mocked OpenAI client is injected via a structural type to avoid `any` casts.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			client.chat = { completions: { create: mockCreate } }

			// The constructor loads models in the background; the pre-aborted path must fail
			// fast without starting a second discovery lookup.
			const { getModels } = await import("../fetchers/modelCache")
			const lookupsBefore = vitest.mocked(getModels).mock.calls.length

			const controller = new AbortController()
			controller.abort()
			const metadata = makeCreateMessageMetadata({ abortSignal: controller.signal })

			await expect(
				handler.createMessage("test", [{ role: "user" as const, content: "hi" }], metadata).next(),
			).rejects.toMatchObject({
				name: "AbortError",
				message: "The OpenRouter request was aborted",
			})
			expect(mockCreate).not.toHaveBeenCalled()
			expect(vitest.mocked(getModels).mock.calls.length).toBe(lookupsBefore)
		})

		it("rejects with AbortError when the external signal aborts during deferred model discovery", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const controller = new AbortController()

			const mockCreate = vitest.fn()
			// The auto-mocked OpenAI client is injected via a structural type to avoid `any` casts.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			client.chat = { completions: { create: mockCreate } }

			// Model discovery is deferred: capture the resolver and settle it only at the end of
			// the test, so the abort deterministically lands while the lookup is still pending.
			// The barrier below (instead of a fixed sleep) synchronizes on the lookup starting.
			let resolveModelLookup!: (models: ModelRecord) => void
			const deferredModelLookup = new Promise<ModelRecord>((resolve) => {
				resolveModelLookup = resolve
			})
			let notifyLookupStarted!: () => void
			const lookupStarted = new Promise<void>((resolve) => {
				notifyLookupStarted = resolve
			})
			const { getModels } = await import("../fetchers/modelCache")
			vitest.mocked(getModels).mockImplementationOnce(() => {
				notifyLookupStarted()
				return deferredModelLookup
			})

			const metadata = makeCreateMessageMetadata({ abortSignal: controller.signal })
			const generator = handler.createMessage("test", [{ role: "user" as const, content: "hi" }], metadata)

			const nextPromise = generator.next()
			await settlesWithin(lookupStarted, ABORT_SETTLE_MS)
			controller.abort()

			await expect(settlesWithin(nextPromise, ABORT_SETTLE_MS)).rejects.toMatchObject({
				name: "AbortError",
				message: "The OpenRouter request was aborted",
			})
			expect(mockCreate).not.toHaveBeenCalled()

			// Settle the abandoned lookup so it cannot outlive the test.
			resolveModelLookup({})
		})

		it("aborts the in-flight stream and rejects with AbortError when the external signal aborts", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const controller = new AbortController()

			let requestSignal: AbortSignal | undefined
			const mockCreate = vitest
				.fn()
				.mockImplementation(async (_params: unknown, options?: { signal?: AbortSignal }) => {
					requestSignal = options?.signal
					// Emulate the OpenAI SDK: the first chunk arrives, then the in-flight
					// response body rejects once the request signal aborts.
					return (async function* () {
						yield { id: "1", choices: [{ delta: { content: "first" } }] }
						await new Promise<void>((resolve) => {
							expect(requestSignal).toBeDefined()
							if (requestSignal!.aborted) {
								resolve()
							} else {
								requestSignal!.addEventListener("abort", () => resolve(), { once: true })
							}
						})
						const abortError = new Error("The user aborted a request")
						abortError.name = "AbortError"
						throw abortError
					})()
				})
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			client.chat = { completions: { create: mockCreate } }

			const metadata = makeCreateMessageMetadata({ abortSignal: controller.signal })
			const generator = handler.createMessage("test", [{ role: "user" as const, content: "hi" }], metadata)

			const chunks: unknown[] = []
			const iteration = (async () => {
				for await (const chunk of generator) {
					chunks.push(chunk)
					if (chunk.type === "text") {
						// Abort while the stream is still in flight.
						controller.abort()
					}
				}
			})()

			await expect(settlesWithin(iteration, ABORT_SETTLE_MS)).rejects.toMatchObject({
				name: "AbortError",
				message: "The OpenRouter request was aborted",
			})
			expect(chunks).toContainEqual({ type: "text", text: "first" })
		})
		it("cancels the in-flight stream when the consumer abandons the generator", async () => {
			const handler = new OpenRouterHandler(mockOptions)

			// Emulate the OpenAI SDK: the first chunk arrives, then the response body
			// stalls until the request signal aborts — no further chunk arrives on its own.
			let requestSignal: AbortSignal | undefined
			const mockCreate = vitest
				.fn()
				.mockImplementation(async (_params: unknown, options?: { signal?: AbortSignal }) => {
					requestSignal = options?.signal
					return (async function* () {
						yield { id: "1", choices: [{ delta: { content: "first" } }] }
						await new Promise<void>((resolve) => {
							expect(requestSignal).toBeDefined()
							if (requestSignal!.aborted) {
								resolve()
							} else {
								requestSignal!.addEventListener("abort", () => resolve(), { once: true })
							}
						})
						yield { id: "2", choices: [{ delta: { content: "second" } }] }
					})()
				})
			// The auto-mocked OpenAI client is injected via a structural type to avoid `any` casts.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			client.chat = { completions: { create: mockCreate } }

			const generator = handler.createMessage("test", [{ role: "user" as const, content: "hi" }])

			const first = await settlesWithin(generator.next(), ABORT_SETTLE_MS)
			expect(first.value).toEqual({ type: "text", text: "first" })
			expect(requestSignal?.aborted).toBe(false)

			// Abandon the generator mid-stream: the finally block must abort the per-request
			// controller so the in-flight stream is cancelled instead of lingering until
			// the client-level timeout.
			await settlesWithin(generator.return(undefined), ABORT_SETTLE_MS)
			expect(requestSignal?.aborted).toBe(true)
		})
		it("does not emit buffered chunks after a mid-stream abort (iterator keeps delivering)", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const controller = new AbortController()

			// Simulate openai@5.23.2 delivering a buffered chunk after the abort has already
			// fired, then ending the iterator normally (no throw).
			let requestSignal: AbortSignal | undefined
			const mockCreate = vitest
				.fn()
				.mockImplementation(async (_params: unknown, options?: { signal?: AbortSignal }) => {
					requestSignal = options?.signal
					return (async function* () {
						yield { id: "1", choices: [{ delta: { content: "partial" } }] }
						// Wait for the abort instead of polling: the buffered chunk is delivered
						// once the request signal aborts.
						await new Promise<void>((resolve) => {
							expect(requestSignal).toBeDefined()
							if (requestSignal!.aborted) {
								resolve()
							} else {
								requestSignal!.addEventListener("abort", () => resolve(), { once: true })
							}
						})
						yield { id: "2", choices: [{ delta: { content: "after-abort" } }] }
					})()
				})
			// The auto-mocked OpenAI client is injected via a structural type to avoid `any` casts.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			client.chat = { completions: { create: mockCreate } }

			const metadata = makeCreateMessageMetadata({ abortSignal: controller.signal })
			const generator = handler.createMessage("test", [{ role: "user" as const, content: "hi" }], metadata)

			const first = await generator.next()
			expect(first.value).toEqual({ type: "text", text: "partial" })
			// Abort mid-stream, after the first chunk has been yielded.
			controller.abort()

			// The buffered second chunk must not be emitted, and the generator must reject
			// with the provider AbortError.
			await expect(settlesWithin(generator.next(), ABORT_SETTLE_MS)).rejects.toMatchObject({
				name: "AbortError",
				message: "The OpenRouter request was aborted",
			})
		})
		it("registers the external abort listener with { once: true } and removes the exact reference on completion", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const mockCreate = vitest
				.fn()
				.mockResolvedValue(asyncStreamFrom([{ id: "1", choices: [{ delta: { content: "ok" } }] }]))
			// The auto-mocked OpenAI client is injected via a structural type to avoid `any` casts.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			client.chat = { completions: { create: mockCreate } }

			const controller = new AbortController()
			const addSpy = vi.spyOn(controller.signal, "addEventListener")
			const removeSpy = vi.spyOn(controller.signal, "removeEventListener")
			const metadata = makeCreateMessageMetadata({ abortSignal: controller.signal })

			const stream = handler.createMessage("test", [{ role: "user" as const, content: "hi" }], metadata)
			await collectStream(stream)

			// The listener must be registered once with self-removal, and the exact
			// registered reference must be removed once the request completes.
			const registeredListener = addSpy.mock.calls[0]?.[1]
			expect(registeredListener).toBeTypeOf("function")
			expect(addSpy).toHaveBeenCalledWith("abort", registeredListener, { once: true })
			expect(removeSpy).toHaveBeenCalledWith("abort", registeredListener)
			addSpy.mockRestore()
			removeSpy.mockRestore()
		})

		it("resets the reasoning_details accumulator between requests on the same handler", async () => {
			const handler = new OpenRouterHandler(
				makeApiHandlerOptions({
					...mockOptions,
					openRouterModelId: "google/gemini-2.5-pro",
				}),
			)
			const mockCreate = vitest.fn()
			// The auto-mocked OpenAI client is injected via a structural type to avoid `any` casts.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			client.chat = { completions: { create: mockCreate } }

			// Request 1: a Gemini stream with reasoning_details populates the handler's
			// accumulator when the stream completes.
			mockCreate.mockResolvedValueOnce(
				asyncStreamFrom([
					{
						id: "1",
						choices: [
							{ delta: { reasoning_details: [{ index: 0, type: "reasoning.text", text: "thinking" }] } },
						],
					},
					{ id: "2", choices: [{ delta: { content: "answer" } }] },
				]),
			)
			await collectStream(handler.createMessage("test", [{ role: "user" as const, content: "hi" }]))
			expect(handler.getReasoningDetails()?.length ?? 0).toBeGreaterThan(0)

			// Request 2 on the same handler must start from an empty accumulator so the
			// previous request's details cannot leak into the next one.
			mockCreate.mockResolvedValueOnce(asyncStreamFrom([{ id: "1", choices: [{ delta: { content: "ok" } }] }]))
			await collectStream(handler.createMessage("test", [{ role: "user" as const, content: "hi" }]))
			expect(handler.getReasoningDetails()).toBeUndefined()
		})

		it("excludes reasoning for Gemini 2.5 Pro models by default", async () => {
			const handler = new OpenRouterHandler(
				makeApiHandlerOptions({
					...mockOptions,
					openRouterModelId: "google/gemini-2.5-pro-preview",
				}),
			)
			const mockCreate = vitest
				.fn()
				.mockResolvedValue(asyncStreamFrom([{ id: "1", choices: [{ delta: { content: "ok" } }] }]))
			// The auto-mocked OpenAI client is injected via a structural type to avoid `any` casts.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			client.chat = { completions: { create: mockCreate } }

			const stream = handler.createMessage("system", [{ role: "user" as const, content: "hi" }])
			await collectStream(stream)

			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({ reasoning: { exclude: true } }),
				expect.any(Object),
			)
		})

		it("excludes reasoning for the non-preview Gemini 2.5 Pro model by default", async () => {
			const handler = new OpenRouterHandler(
				makeApiHandlerOptions({
					...mockOptions,
					openRouterModelId: "google/gemini-2.5-pro",
				}),
			)
			const mockCreate = vitest
				.fn()
				.mockResolvedValue(asyncStreamFrom([{ id: "1", choices: [{ delta: { content: "ok" } }] }]))
			// The auto-mocked OpenAI client is injected via a structural type to avoid `any` casts.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			client.chat = { completions: { create: mockCreate } }

			const stream = handler.createMessage("system", [{ role: "user" as const, content: "hi" }])
			await collectStream(stream)

			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({ reasoning: { exclude: true } }),
				expect.any(Object),
			)
		})

		it("does not inject reasoning exclusion for non-Gemini models without configured reasoning", async () => {
			const handler = new OpenRouterHandler(
				makeApiHandlerOptions({
					...mockOptions,
					openRouterModelId: "openai/gpt-4o",
				}),
			)
			const mockCreate = vitest
				.fn()
				.mockResolvedValue(asyncStreamFrom([{ id: "1", choices: [{ delta: { content: "ok" } }] }]))
			// The auto-mocked OpenAI client is injected via a structural type to avoid `any` casts.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			client.chat = { completions: { create: mockCreate } }

			const stream = handler.createMessage("system", [{ role: "user" as const, content: "hi" }])
			await collectStream(stream)

			const params = mockCreate.mock.calls[0][0] as { reasoning?: unknown }
			expect(params.reasoning).toBeUndefined()
		})

		it("keeps user-configured reasoning for Gemini 2.5 Pro models instead of overriding it", async () => {
			const handler = new OpenRouterHandler(
				makeApiHandlerOptions({
					...mockOptions,
					openRouterModelId: "google/gemini-2.5-pro",
					enableReasoningEffort: true,
				}),
			)
			const mockCreate = vitest
				.fn()
				.mockResolvedValue(asyncStreamFrom([{ id: "1", choices: [{ delta: { content: "ok" } }] }]))
			// The auto-mocked OpenAI client is injected via a structural type to avoid `any` casts.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			client.chat = { completions: { create: mockCreate } }

			// The constructor already consumed the default model-cache mock; serve a Gemini
			// entry that advertises reasoning-budget support to fetchModel so getModelParams
			// resolves a user reasoning budget for this request.
			const { getModels } = await import("../fetchers/modelCache")
			vitest.mocked(getModels).mockImplementationOnce(async () => ({
				"google/gemini-2.5-pro": {
					maxTokens: 65536,
					contextWindow: 1048576,
					supportsPromptCache: false,
					supportsReasoningBudget: true,
				},
			}))

			const stream = handler.createMessage("system", [{ role: "user" as const, content: "hi" }])
			await collectStream(stream)

			const params = mockCreate.mock.calls[0][0] as { reasoning?: { max_tokens?: number; exclude?: boolean } }
			expect(params.reasoning).toEqual({ max_tokens: 128 })
		})

		it("omits the anthropic beta header for non-Anthropic models", async () => {
			const handler = new OpenRouterHandler(
				makeApiHandlerOptions({
					...mockOptions,
					openRouterModelId: "openai/gpt-4o",
				}),
			)
			const mockCreate = vitest
				.fn()
				.mockResolvedValue(asyncStreamFrom([{ id: "1", choices: [{ delta: { content: "ok" } }] }]))
			// The auto-mocked OpenAI client is injected via a structural type to avoid `any` casts.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			client.chat = { completions: { create: mockCreate } }

			const stream = handler.createMessage("system", [{ role: "user" as const, content: "hi" }])
			await collectStream(stream)

			const params = mockCreate.mock.calls[0][0] as { messages: { role: string; content: unknown }[] }
			expect(params.messages[0]).toEqual({ role: "system", content: "system" })

			const options = mockCreate.mock.calls[0][1] as { headers?: Record<string, string>; signal?: AbortSignal }
			expect(options).not.toHaveProperty("headers")
			expect(options.signal).toBeInstanceOf(AbortSignal)
		})

		it("uses user role for the system prompt with DeepSeek R1 models", async () => {
			const handler = new OpenRouterHandler(
				makeApiHandlerOptions({
					...mockOptions,
					openRouterModelId: "deepseek/deepseek-r1",
				}),
			)
			const mockCreate = vitest
				.fn()
				.mockResolvedValue(asyncStreamFrom([{ id: "1", choices: [{ delta: { content: "ok" } }] }]))
			// The auto-mocked OpenAI client is injected via a structural type to avoid `any` casts.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			client.chat = { completions: { create: mockCreate } }

			const stream = handler.createMessage("system prompt", [{ role: "user" as const, content: "hi" }])
			await collectStream(stream)

			const params = mockCreate.mock.calls[0][0] as { messages: { role: string; content: unknown }[] }
			expect(params.messages[0].role).toBe("user")
			expect(params.messages.map((m) => m.role)).not.toContain("system")
		})

		it("uses user role for the system prompt with Perplexity Sonar Reasoning", async () => {
			const handler = new OpenRouterHandler(
				makeApiHandlerOptions({
					...mockOptions,
					openRouterModelId: "perplexity/sonar-reasoning",
				}),
			)
			const mockCreate = vitest
				.fn()
				.mockResolvedValue(asyncStreamFrom([{ id: "1", choices: [{ delta: { content: "ok" } }] }]))
			// The auto-mocked OpenAI client is injected via a structural type to avoid `any` casts.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			client.chat = { completions: { create: mockCreate } }

			const stream = handler.createMessage("system prompt", [{ role: "user" as const, content: "hi" }])
			await collectStream(stream)

			const params = mockCreate.mock.calls[0][0] as { messages: { role: string; content: unknown }[] }
			expect(params.messages[0].role).toBe("user")
			expect(params.messages.map((m) => m.role)).not.toContain("system")
		})

		it("pins provider order and only for a specific openRouterSpecificProvider", async () => {
			const handler = new OpenRouterHandler(
				makeApiHandlerOptions({
					...mockOptions,
					openRouterSpecificProvider: providerIdentifiers.anthropic,
				}),
			)
			const mockCreate = vitest
				.fn()
				.mockResolvedValue(asyncStreamFrom([{ id: "1", choices: [{ delta: { content: "ok" } }] }]))
			// The auto-mocked OpenAI client is injected via a structural type to avoid `any` casts.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			client.chat = { completions: { create: mockCreate } }

			const stream = handler.createMessage("system", [{ role: "user" as const, content: "hi" }])
			await collectStream(stream)

			const params = mockCreate.mock.calls[0][0] as {
				provider?: { order?: string[]; only?: string[]; allow_fallbacks?: boolean }
			}
			expect(params.provider).toEqual({
				order: [providerIdentifiers.anthropic],
				only: [providerIdentifiers.anthropic],
				allow_fallbacks: false,
			})
		})

		it("omits the provider option when openRouterSpecificProvider is [default]", async () => {
			const handler = new OpenRouterHandler(
				makeApiHandlerOptions({
					...mockOptions,
					openRouterSpecificProvider: "[default]",
				}),
			)
			const mockCreate = vitest
				.fn()
				.mockResolvedValue(asyncStreamFrom([{ id: "1", choices: [{ delta: { content: "ok" } }] }]))
			// The auto-mocked OpenAI client is injected via a structural type to avoid `any` casts.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			client.chat = { completions: { create: mockCreate } }

			const stream = handler.createMessage("system", [{ role: "user" as const, content: "hi" }])
			await collectStream(stream)

			const params = mockCreate.mock.calls[0][0] as { provider?: unknown }
			expect(params).not.toHaveProperty("provider")
		})

		it("omits the provider option when openRouterSpecificProvider is unset", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const mockCreate = vitest
				.fn()
				.mockResolvedValue(asyncStreamFrom([{ id: "1", choices: [{ delta: { content: "ok" } }] }]))
			// The auto-mocked OpenAI client is injected via a structural type to avoid `any` casts.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			client.chat = { completions: { create: mockCreate } }

			const stream = handler.createMessage("system", [{ role: "user" as const, content: "hi" }])
			await collectStream(stream)

			const params = mockCreate.mock.calls[0][0] as { provider?: unknown }
			expect(params).not.toHaveProperty("provider")
		})

		it("injects a fake encrypted reasoning block for Gemini tool calls without encrypted reasoning", async () => {
			const handler = new OpenRouterHandler(
				makeApiHandlerOptions({
					...mockOptions,
					openRouterModelId: "google/gemini-2.5-flash",
				}),
			)
			const mockCreate = vitest
				.fn()
				.mockResolvedValue(asyncStreamFrom([{ id: "1", choices: [{ delta: { content: "ok" } }] }]))
			// The auto-mocked OpenAI client is injected via a structural type to avoid `any` casts.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			client.chat = { completions: { create: mockCreate } }

			// reasoning_details is an OpenRouter extension field round-tripped on assistant
			// messages; the Anthropic SDK types do not include it, hence the structural cast.
			const assistantMessage = {
				role: "assistant" as const,
				content: [{ type: "tool_use" as const, id: "toolu_01", name: "get_weather", input: { city: "SF" } }],
				reasoning_details: [{ type: "reasoning.text", id: "toolu_01", text: "thinking", index: 0 }],
			}
			const stream = handler.createMessage("system", [
				assistantMessage as unknown as Anthropic.Messages.MessageParam,
			])
			await collectStream(stream)

			const params = mockCreate.mock.calls[0][0] as {
				messages: {
					role: string
					tool_calls?: { id: string }[]
					reasoning_details?: { type: string; id: string; data: string }[]
				}[]
			}
			const assistant = params.messages.find((m) => m.role === "assistant")
			expect(assistant?.tool_calls).toHaveLength(1)
			const encrypted = assistant?.reasoning_details?.find((d) => d.type === "reasoning.encrypted")
			expect(encrypted).toMatchObject({
				id: "toolu_01",
				data: "skip_thought_signature_validator",
				format: "google-gemini-v1",
				index: 0,
			})
		})

		it("keeps the matching reasoning detail when sanitizing Gemini tool call messages", async () => {
			const handler = new OpenRouterHandler(
				makeApiHandlerOptions({
					...mockOptions,
					openRouterModelId: "google/gemini-2.5-flash",
				}),
			)
			const mockCreate = vitest
				.fn()
				.mockResolvedValue(asyncStreamFrom([{ id: "1", choices: [{ delta: { content: "ok" } }] }]))
			// The auto-mocked OpenAI client is injected via a structural type to avoid `any` casts.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			client.chat = { completions: { create: mockCreate } }

			const assistantMessage = {
				role: "assistant" as const,
				content: [{ type: "tool_use" as const, id: "toolu_01", name: "get_weather", input: { city: "SF" } }],
				reasoning_details: [{ type: "reasoning.text", id: "toolu_01", text: "thinking", index: 0 }],
			}
			const stream = handler.createMessage("system", [
				assistantMessage as unknown as Anthropic.Messages.MessageParam,
			])
			await collectStream(stream)

			const params = mockCreate.mock.calls[0][0] as {
				messages: {
					role: string
					tool_calls?: { id: string }[]
					reasoning_details?: { type: string; id?: string; text?: string }[]
				}[]
			}
			const assistant = params.messages.find((m) => m.role === "assistant")
			expect(assistant?.tool_calls).toHaveLength(1)
			const textDetail = assistant?.reasoning_details?.find((d) => d.type === "reasoning.text")
			expect(textDetail).toMatchObject({ id: "toolu_01", text: "thinking" })
			const encrypted = assistant?.reasoning_details?.find((d) => d.type === "reasoning.encrypted")
			expect(encrypted).toMatchObject({ id: "toolu_01" })
		})

		it("drops tool calls without reasoning details but keeps the content for Gemini messages", async () => {
			const handler = new OpenRouterHandler(
				makeApiHandlerOptions({
					...mockOptions,
					openRouterModelId: "google/gemini-2.5-flash",
				}),
			)
			const mockCreate = vitest
				.fn()
				.mockResolvedValue(asyncStreamFrom([{ id: "1", choices: [{ delta: { content: "ok" } }] }]))
			// The auto-mocked OpenAI client is injected via a structural type to avoid `any` casts.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			client.chat = { completions: { create: mockCreate } }

			const assistantMessage = {
				role: "assistant" as const,
				content: [
					{ type: "text" as const, text: "kept content" },
					{ type: "tool_use" as const, id: "toolu_02", name: "get_weather", input: { city: "NY" } },
				],
			}
			const stream = handler.createMessage("system", [
				assistantMessage as unknown as Anthropic.Messages.MessageParam,
			])
			await collectStream(stream)

			const params = mockCreate.mock.calls[0][0] as {
				messages: { role: string; content?: unknown; tool_calls?: unknown }[]
			}
			const assistant = params.messages.find((m) => m.role === "assistant")
			expect(assistant).toBeDefined()
			expect(assistant?.content).toBe("kept content")
			expect(assistant).not.toHaveProperty("tool_calls")
		})

		it("drops tool calls without a matching reasoning detail id for Gemini messages", async () => {
			const handler = new OpenRouterHandler(
				makeApiHandlerOptions({
					...mockOptions,
					openRouterModelId: "google/gemini-2.5-flash",
				}),
			)
			const mockCreate = vitest
				.fn()
				.mockResolvedValue(asyncStreamFrom([{ id: "1", choices: [{ delta: { content: "ok" } }] }]))
			// The auto-mocked OpenAI client is injected via a structural type to avoid `any` casts.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			client.chat = { completions: { create: mockCreate } }

			const assistantMessage = {
				role: "assistant" as const,
				content: [
					{ type: "tool_use" as const, id: "toolu_03", name: "get_weather", input: { city: "SF" } },
					{ type: "tool_use" as const, id: "toolu_04", name: "search", input: { q: "x" } },
				],
				reasoning_details: [{ type: "reasoning.text", id: "toolu_03", text: "thinking", index: 0 }],
			}
			const stream = handler.createMessage("system", [
				assistantMessage as unknown as Anthropic.Messages.MessageParam,
			])
			await collectStream(stream)

			const params = mockCreate.mock.calls[0][0] as {
				messages: { role: string; tool_calls?: { id: string }[] }[]
			}
			const assistant = params.messages.find((m) => m.role === "assistant")
			expect(assistant?.tool_calls).toHaveLength(1)
			expect(assistant?.tool_calls?.[0].id).toBe("toolu_03")
		})

		it("accumulates and yields reasoning_details from streamed chunks", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const mockCreate = vitest.fn().mockResolvedValue(
				asyncStreamFrom([
					{ id: "1", choices: [{ delta: { reasoning: "top-level thinking" } }] },
					{
						id: "2",
						choices: [
							{ delta: { reasoning_details: [{ type: "reasoning.text", index: 0, text: "thinking " }] } },
						],
					},
					{
						id: "3",
						choices: [
							{
								delta: {
									reasoning_details: [
										{
											type: "reasoning.text",
											index: 0,
											text: "more",
											id: "r1",
											format: "google-gemini-v1",
											signature: "sig",
										},
									],
								},
							},
						],
					},
					{
						id: "4",
						choices: [
							{ delta: { reasoning_details: [{ type: "reasoning.summary", index: 1, summary: "sum" }] } },
						],
					},
					{ id: "5", choices: [{ delta: { content: "hello" } }] },
					{
						id: "6",
						choices: [
							{
								delta: {
									reasoning_details: [{ type: "reasoning.summary", index: 1, summary: " more" }],
								},
							},
						],
					},
					{
						id: "7",
						choices: [
							{ delta: { reasoning_details: [{ type: "reasoning.encrypted", index: 2, data: "enc-" }] } },
						],
					},
					{
						id: "8",
						choices: [
							{
								delta: {
									reasoning_details: [{ type: "reasoning.encrypted", index: 2, data: "rypted" }],
								},
							},
						],
					},
				]),
			)
			// The auto-mocked OpenAI client is injected via a structural type to avoid `any` casts.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			client.chat = { completions: { create: mockCreate } }

			const chunks = await collectStream(
				handler.createMessage("system", [{ role: "user" as const, content: "hi" }]),
			)

			expect(chunks).toContainEqual({ type: "reasoning", text: "top-level thinking" })
			expect(chunks).toContainEqual({ type: "reasoning", text: "thinking " })
			expect(chunks).toContainEqual({ type: "reasoning", text: "sum" })
			expect(chunks).toContainEqual({ type: "reasoning", text: " more" })
			expect(chunks).toContainEqual({ type: "text", text: "hello" })

			const details = handler.getReasoningDetails()
			expect(details).toHaveLength(3)
			expect(details?.find((d) => d.type === "reasoning.summary")?.summary).toBe("sum more")
			expect(details?.find((d) => d.type === "reasoning.encrypted")?.data).toBe("enc-rypted")
		})

		it("ignores chunks with empty choices", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const mockCreate = vitest.fn().mockResolvedValue(
				asyncStreamFrom([
					{ id: "1", choices: [] },
					{ id: "1", choices: [{ delta: { content: "ok" } }] },
				]),
			)
			// The auto-mocked OpenAI client is injected via a structural type to avoid `any` casts.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			client.chat = { completions: { create: mockCreate } }

			const chunks = await collectStream(
				handler.createMessage("system", [{ role: "user" as const, content: "hi" }]),
			)
			expect(chunks).toContainEqual({ type: "text", text: "ok" })
		})

		it("keeps id, format and signature from the first reasoning chunk on updates", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const mockCreate = vitest.fn().mockResolvedValue(
				asyncStreamFrom([
					{
						id: "1",
						choices: [
							{
								delta: {
									reasoning_details: [
										{
											type: "reasoning.text",
											index: 0,
											id: "det-1",
											format: "google-gemini-v1",
											signature: "sig-1",
										},
									],
								},
							},
						],
					},
					{
						id: "1",
						choices: [
							{ delta: { reasoning_details: [{ type: "reasoning.text", index: 0, text: "more" }] } },
						],
					},
				]),
			)
			// The auto-mocked OpenAI client is injected via a structural type to avoid `any` casts.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			client.chat = { completions: { create: mockCreate } }

			await collectStream(handler.createMessage("system", [{ role: "user" as const, content: "hi" }]))

			const details = handler.getReasoningDetails()
			expect(details).toHaveLength(1)
			expect(details?.[0]).toMatchObject({
				type: "reasoning.text",
				text: "more",
				id: "det-1",
				format: "google-gemini-v1",
				signature: "sig-1",
				index: 0,
			})
		})

		it("initializes empty accumulator entries without undefined prefixes", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const mockCreate = vitest.fn().mockResolvedValue(
				asyncStreamFrom([
					{ id: "1", choices: [{ delta: { reasoning_details: [{ type: "reasoning.text", index: 0 }] } }] },
					{
						id: "1",
						choices: [{ delta: { reasoning_details: [{ type: "reasoning.text", index: 0, text: "t0" }] } }],
					},
					{ id: "1", choices: [{ delta: { reasoning_details: [{ type: "reasoning.text", index: 1 }] } }] },
					{
						id: "1",
						choices: [
							{ delta: { reasoning_details: [{ type: "reasoning.text", index: 1, summary: "s1" }] } },
						],
					},
					{ id: "1", choices: [{ delta: { reasoning_details: [{ type: "reasoning.text", index: 2 }] } }] },
					{
						id: "1",
						choices: [{ delta: { reasoning_details: [{ type: "reasoning.text", index: 2, data: "d2" }] } }],
					},
				]),
			)
			// The auto-mocked OpenAI client is injected via a structural type to avoid `any` casts.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			client.chat = { completions: { create: mockCreate } }

			await collectStream(handler.createMessage("system", [{ role: "user" as const, content: "hi" }]))

			const details = handler.getReasoningDetails()
			expect(details).toHaveLength(3)
			expect(details?.find((d) => d.index === 0)?.text).toBe("t0")
			expect(details?.find((d) => d.index === 1)?.summary).toBe("s1")
			expect(details?.find((d) => d.index === 2)?.data).toBe("d2")
		})

		it("groups reasoning details without an explicit index under index 0", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const mockCreate = vitest.fn().mockResolvedValue(
				asyncStreamFrom([
					{ id: "1", choices: [{ delta: { reasoning_details: [{ type: "reasoning.text", text: "a" }] } }] },
					{
						id: "1",
						choices: [{ delta: { reasoning_details: [{ type: "reasoning.text", text: "b", index: 0 }] } }],
					},
				]),
			)
			// The auto-mocked OpenAI client is injected via a structural type to avoid `any` casts.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			client.chat = { completions: { create: mockCreate } }

			await collectStream(handler.createMessage("system", [{ role: "user" as const, content: "hi" }]))

			const details = handler.getReasoningDetails()
			expect(details).toHaveLength(1)
			expect(details?.[0]?.text).toBe("ab")
			expect(details?.[0]?.index).toBe(0)
		})

		it("accumulates reasoning text and summary with the same index separately", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const mockCreate = vitest.fn().mockResolvedValue(
				asyncStreamFrom([
					{
						id: "1",
						choices: [{ delta: { reasoning_details: [{ type: "reasoning.text", index: 0, text: "a" }] } }],
					},
					{
						id: "1",
						choices: [
							{ delta: { reasoning_details: [{ type: "reasoning.summary", index: 0, summary: "s" }] } },
						],
					},
				]),
			)
			// The auto-mocked OpenAI client is injected via a structural type to avoid `any` casts.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			client.chat = { completions: { create: mockCreate } }

			const chunks = await collectStream(
				handler.createMessage("system", [{ role: "user" as const, content: "hi" }]),
			)
			expect(chunks).toContainEqual({ type: "reasoning", text: "a" })

			const details = handler.getReasoningDetails()
			expect(details).toHaveLength(1)
			expect(details?.[0]?.text).toBe("a")
		})

		it("does not yield displayable reasoning for encrypted-only details", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const mockCreate = vitest.fn().mockResolvedValue(
				asyncStreamFrom([
					{
						id: "1",
						choices: [
							{ delta: { reasoning_details: [{ type: "reasoning.encrypted", index: 0, data: "enc" }] } },
						],
					},
					{ id: "1", choices: [{ delta: { content: "ok" } }] },
				]),
			)
			// The auto-mocked OpenAI client is injected via a structural type to avoid `any` casts.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			client.chat = { completions: { create: mockCreate } }

			const chunks = await collectStream(
				handler.createMessage("system", [{ role: "user" as const, content: "hi" }]),
			)
			expect(chunks).toContainEqual({ type: "text", text: "ok" })
			expect(chunks).not.toContainEqual(expect.objectContaining({ type: "reasoning" }))

			const details = handler.getReasoningDetails()
			expect(details).toHaveLength(1)
			expect(details?.[0]?.data).toBe("enc")
		})

		it("ignores non-array reasoning_details values", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const mockCreate = vitest.fn().mockResolvedValue(
				asyncStreamFrom([
					{ id: "1", choices: [{ delta: { reasoning_details: "not-an-array" } }] },
					{ id: "1", choices: [{ delta: { content: "ok" } }] },
				]),
			)
			// The auto-mocked OpenAI client is injected via a structural type to avoid `any` casts.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			client.chat = { completions: { create: mockCreate } }

			const chunks = await collectStream(
				handler.createMessage("system", [{ role: "user" as const, content: "hi" }]),
			)
			expect(chunks).toContainEqual({ type: "text", text: "ok" })
			expect(handler.getReasoningDetails()).toBeUndefined()
		})

		it("ignores object reasoning_details values", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const mockCreate = vitest.fn().mockResolvedValue(
				asyncStreamFrom([
					{ id: "1", choices: [{ delta: { reasoning_details: { bogus: true } } }] },
					{ id: "1", choices: [{ delta: { content: "ok" } }] },
				]),
			)
			// The auto-mocked OpenAI client is injected via a structural type to avoid `any` casts.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			client.chat = { completions: { create: mockCreate } }

			const chunks = await collectStream(
				handler.createMessage("system", [{ role: "user" as const, content: "hi" }]),
			)
			expect(chunks).toContainEqual({ type: "text", text: "ok" })
			expect(handler.getReasoningDetails()).toBeUndefined()
		})

		it("rejects with AbortError when the external signal aborts during request creation", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const controller = new AbortController()

			// Deterministic synchronization (mirrors the Requesty test): the mock notifies the
			// test when the request actually starts, so the abort lands after create() began
			// instead of racing a fixed sleep that a slow runner can lose.
			let notifyCreateStarted!: () => void
			const createStarted = new Promise<void>((resolve) => {
				notifyCreateStarted = resolve
			})
			const mockCreate = vitest
				.fn()
				.mockImplementation(async (_params: unknown, options?: { signal?: AbortSignal }) => {
					notifyCreateStarted()
					// Emulate the OpenAI SDK: the pending request rejects when the signal aborts.
					await new Promise<void>((resolve) => {
						if (options?.signal?.aborted) {
							resolve()
						} else {
							options?.signal?.addEventListener("abort", () => resolve(), { once: true })
						}
					})
					const abortError = new Error("The user aborted a request")
					abortError.name = "AbortError"
					throw abortError
				})
			// The auto-mocked OpenAI client is injected via a structural type to avoid `any` casts.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			client.chat = { completions: { create: mockCreate } }

			const metadata = makeCreateMessageMetadata({ abortSignal: controller.signal })
			const generator = handler.createMessage("system", [{ role: "user" as const, content: "hi" }], metadata)

			const nextPromise = generator.next()
			// Abort only once create() has actually started.
			await createStarted
			controller.abort()

			await expect(nextPromise).rejects.toMatchObject({
				name: "AbortError",
				message: "The OpenRouter request was aborted",
			})
		})

		it("normalizes Mistral tool call ids in tool result messages", async () => {
			const handler = new OpenRouterHandler(
				makeApiHandlerOptions({
					...mockOptions,
					openRouterModelId: "Mistral/mixtral-large",
				}),
			)
			const mockCreate = vitest
				.fn()
				.mockResolvedValue(asyncStreamFrom([{ id: "1", choices: [{ delta: { content: "ok" } }] }]))
			// The auto-mocked OpenAI client is injected via a structural type to avoid `any` casts.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			client.chat = { completions: { create: mockCreate } }

			const stream = handler.createMessage("system", [
				{
					role: "user" as const,
					content: [
						{ type: "text" as const, text: "hi" },
						{ type: "tool_result" as const, tool_use_id: "toolu_123456789", content: "tool result ok" },
					],
				},
			])
			await collectStream(stream)

			const params = mockCreate.mock.calls[0][0] as {
				messages: { role: string; tool_call_id?: string; content: unknown }[]
			}
			const toolMessage = params.messages.find((m) => m.role === "tool")
			expect(toolMessage).toMatchObject({ role: "tool", tool_call_id: "toolu1234", content: "tool result ok" })
		})

		it("uses user role for the system prompt with suffixed DeepSeek R1 model ids", async () => {
			const handler = new OpenRouterHandler(
				makeApiHandlerOptions({
					...mockOptions,
					openRouterModelId: "deepseek/deepseek-r1-0528",
				}),
			)
			const mockCreate = vitest
				.fn()
				.mockResolvedValue(asyncStreamFrom([{ id: "1", choices: [{ delta: { content: "ok" } }] }]))
			// The auto-mocked OpenAI client is injected via a structural type to avoid `any` casts.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			client.chat = { completions: { create: mockCreate } }

			const stream = handler.createMessage("system prompt", [
				{ role: "assistant" as const, content: "earlier reply" },
			])
			await collectStream(stream)

			const params = mockCreate.mock.calls[0][0] as { messages: { role: string; content: unknown }[] }
			expect(params.messages[0]).toMatchObject({ role: "user", content: "system prompt" })
			expect(params.messages[1]).toMatchObject({ role: "assistant", content: "earlier reply" })
			expect(params.messages.some((m) => m.role === "system")).toBe(false)
		})

		it("adds gemini cache breakpoints and the default max tokens for google/gemini models", async () => {
			const handler = new OpenRouterHandler(
				makeApiHandlerOptions({
					...mockOptions,
					openRouterModelId: "google/gemini-2.5-flash",
				}),
			)
			const mockCreate = vitest
				.fn()
				.mockResolvedValue(asyncStreamFrom([{ id: "1", choices: [{ delta: { content: "ok" } }] }]))
			// The auto-mocked OpenAI client is injected via a structural type to avoid `any` casts.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			client.chat = { completions: { create: mockCreate } }

			const stream = handler.createMessage("sys-k1", [{ role: "user" as const, content: "hello" }])
			await collectStream(stream)

			const params = mockCreate.mock.calls[0][0] as {
				messages: { role: string; content: unknown }[]
				max_tokens?: number
			}
			expect(params.messages[0]).toEqual({
				role: "system",
				content: [{ type: "text", text: "sys-k1", cache_control: { type: "ephemeral" } }],
			})
			expect(params.messages[1]).toEqual({ role: "user", content: [{ type: "text", text: "hello" }] })
			expect(params.max_tokens).toBe(8192)
		})

		it("skips gemini sanitization for non-google gemini model ids", async () => {
			const handler = new OpenRouterHandler(
				makeApiHandlerOptions({
					...mockOptions,
					openRouterModelId: "openai/gemini-2.5-flash",
				}),
			)
			const mockCreate = vitest
				.fn()
				.mockResolvedValue(asyncStreamFrom([{ id: "1", choices: [{ delta: { content: "ok" } }] }]))
			// The auto-mocked OpenAI client is injected via a structural type to avoid `any` casts.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			client.chat = { completions: { create: mockCreate } }

			// No reasoning_details at all: gemini sanitization would drop this tool call, so a
			// surviving tool call proves the sanitization path was skipped.
			const assistantMessage = {
				role: "assistant" as const,
				content: [{ type: "tool_use" as const, id: "toolu_k2", name: "lookup", input: {} }],
			}
			const stream = handler.createMessage("system", [
				assistantMessage as unknown as Anthropic.Messages.MessageParam,
			])
			await collectStream(stream)

			const params = mockCreate.mock.calls[0][0] as {
				messages: { role: string; tool_calls?: unknown[]; reasoning_details?: unknown[] }[]
			}
			const assistant = params.messages.find((m) => m.role === "assistant")
			expect(assistant?.tool_calls).toHaveLength(1)
			expect(assistant).not.toHaveProperty("reasoning_details")
		})

		it("does not inject fake encrypted reasoning when the assistant already carries encrypted details", async () => {
			const handler = new OpenRouterHandler(
				makeApiHandlerOptions({
					...mockOptions,
					openRouterModelId: "google/gemini-2.5-flash",
				}),
			)
			const mockCreate = vitest
				.fn()
				.mockResolvedValue(asyncStreamFrom([{ id: "1", choices: [{ delta: { content: "ok" } }] }]))
			// The auto-mocked OpenAI client is injected via a structural type to avoid `any` casts.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			client.chat = { completions: { create: mockCreate } }

			// The first assistant mixes a text detail with an encrypted one; the second carries
			// only encrypted details so the every()/==/-!== variants each diverge somewhere.
			const assistantOne = {
				role: "assistant" as const,
				content: [
					{ type: "tool_use" as const, id: "toolu_05", name: "lookup_a", input: {} },
					{ type: "tool_use" as const, id: "toolu_06", name: "lookup_b", input: {} },
				],
				reasoning_details: [
					{ type: "reasoning.text", id: "toolu_05", text: "t", index: 0 },
					{ type: "reasoning.encrypted", id: "toolu_06", data: "orig-enc", index: 1 },
				],
			}
			const assistantTwo = {
				role: "assistant" as const,
				content: [
					{ type: "tool_use" as const, id: "toolu_07", name: "lookup_c", input: {} },
					{ type: "tool_use" as const, id: "toolu_08", name: "lookup_d", input: {} },
				],
				reasoning_details: [
					{ type: "reasoning.encrypted", id: "toolu_07", data: "enc-7", index: 0 },
					{ type: "reasoning.encrypted", id: "toolu_08", data: "enc-8", index: 1 },
				],
			}
			const stream = handler.createMessage("system", [
				assistantOne as unknown as Anthropic.Messages.MessageParam,
				assistantTwo as unknown as Anthropic.Messages.MessageParam,
			])
			await collectStream(stream)

			const params = mockCreate.mock.calls[0][0] as {
				messages: {
					role: string
					tool_calls?: { id: string }[]
					reasoning_details?: { type: string; data?: string }[]
				}[]
			}
			const assistants = params.messages.filter((m) => m.role === "assistant")
			expect(assistants).toHaveLength(2)
			expect(assistants[0].tool_calls).toHaveLength(2)
			const firstEncrypted =
				assistants[0].reasoning_details?.filter((d) => d.type === "reasoning.encrypted") ?? []
			expect(firstEncrypted).toHaveLength(1)
			expect(firstEncrypted[0]).toMatchObject({ data: "orig-enc" })
			expect(assistants[1].tool_calls).toHaveLength(2)
			const secondEncrypted =
				assistants[1].reasoning_details?.filter((d) => d.type === "reasoning.encrypted") ?? []
			expect(secondEncrypted).toHaveLength(2)
		})

		it("keeps the last usage chunk when later chunks carry no usage", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const mockCreate = vitest.fn().mockResolvedValue(
				asyncStreamFrom([
					{
						id: "1",
						choices: [],
						usage: {
							prompt_tokens: 10,
							completion_tokens: 5,
							cost: 2,
							cost_details: { upstream_inference_cost: 3 },
						},
					},
					{ id: "2", choices: [{ delta: { content: "ok" } }] },
				]),
			)
			// The auto-mocked OpenAI client is injected via a structural type to avoid `any` casts.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			client.chat = { completions: { create: mockCreate } }

			const chunks = await collectStream(
				handler.createMessage("system", [{ role: "user" as const, content: "hi" }]),
			)
			const usage = chunks.find((c) => c.type === "usage")
			expect(usage).toMatchObject({ type: "usage", inputTokens: 10, outputTokens: 5, totalCost: 5 })
		})

		it("merges id, format and signature into an existing reasoning detail", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const mockCreate = vitest.fn().mockResolvedValue(
				asyncStreamFrom([
					{
						id: "1",
						choices: [
							{ delta: { reasoning_details: [{ type: "reasoning.text", index: 0, text: "start" }] } },
						],
					},
					{
						id: "2",
						choices: [
							{
								delta: {
									reasoning_details: [
										{
											type: "reasoning.text",
											index: 0,
											text: "more",
											id: "det-1",
											format: "google-gemini-v1",
											signature: "sig-1",
										},
									],
								},
							},
						],
					},
					{ id: "3", choices: [{ delta: { content: "ok" } }] },
				]),
			)
			// The auto-mocked OpenAI client is injected via a structural type to avoid `any` casts.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			client.chat = { completions: { create: mockCreate } }

			const chunks = await collectStream(
				handler.createMessage("system", [{ role: "user" as const, content: "hi" }]),
			)
			expect(chunks).toContainEqual({ type: "reasoning", text: "start" })
			const details = handler.getReasoningDetails()
			expect(details).toHaveLength(1)
			expect(details?.[0]).toMatchObject({
				type: "reasoning.text",
				text: "startmore",
				id: "det-1",
				format: "google-gemini-v1",
				signature: "sig-1",
				index: 0,
			})
		})

		it("ignores non-string text and summary values in reasoning details", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const mockCreate = vitest.fn().mockResolvedValue(
				asyncStreamFrom([
					{
						id: "1",
						choices: [
							{
								delta: {
									reasoning_details: [
										{ type: "reasoning.encrypted", index: 0, text: "secret", data: "enc" },
										{ type: "reasoning.text", index: 1, text: 5 },
										{ type: "reasoning.text", index: 2, summary: "leak" },
										{ type: "reasoning.summary", index: 3, summary: 7 },
										{ type: "reasoning.summary", index: 4, summary: "sum-ok" },
										{ type: "reasoning.text", index: 5, text: "text-ok" },
									],
								},
							},
						],
					},
					{ id: "2", choices: [{ delta: { content: "ok" } }] },
				]),
			)
			// The auto-mocked OpenAI client is injected via a structural type to avoid `any` casts.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			client.chat = { completions: { create: mockCreate } }

			const chunks = await collectStream(
				handler.createMessage("system", [{ role: "user" as const, content: "hi" }]),
			)
			expect(chunks.filter((c) => c.type === "reasoning")).toEqual([
				{ type: "reasoning", text: "sum-ok" },
				{ type: "reasoning", text: "text-ok" },
			])
		})

		it("yields top-level reasoning only for non-empty string values", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const mockCreate = vitest.fn().mockResolvedValue(
				asyncStreamFrom([
					{ id: "1", choices: [{ delta: { reasoning: 5 } }] },
					{ id: "2", choices: [{ delta: { reasoning: "" } }] },
					{ id: "3", choices: [{ delta: { reasoning: "top" } }] },
					{ id: "4", choices: [{ delta: { content: "ok" } }] },
				]),
			)
			// The auto-mocked OpenAI client is injected via a structural type to avoid `any` casts.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			client.chat = { completions: { create: mockCreate } }

			const chunks = await collectStream(
				handler.createMessage("system", [{ role: "user" as const, content: "hi" }]),
			)
			expect(chunks.filter((c) => c.type === "reasoning")).toEqual([{ type: "reasoning", text: "top" }])
			expect(chunks).toContainEqual({ type: "text", text: "ok" })
		})

		it("skips top-level reasoning once reasoning details have yielded displayable text", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const mockCreate = vitest.fn().mockResolvedValue(
				asyncStreamFrom([
					{
						id: "1",
						choices: [
							{ delta: { reasoning_details: [{ type: "reasoning.text", index: 0, text: "det" }] } },
						],
					},
					{ id: "2", choices: [{ delta: { reasoning: "top" } }] },
					{ id: "3", choices: [{ delta: { content: "ok" } }] },
				]),
			)
			// The auto-mocked OpenAI client is injected via a structural type to avoid `any` casts.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			client.chat = { completions: { create: mockCreate } }

			const chunks = await collectStream(
				handler.createMessage("system", [{ role: "user" as const, content: "hi" }]),
			)
			expect(chunks.filter((c) => c.type === "reasoning")).toEqual([{ type: "reasoning", text: "det" }])
			expect(chunks).toContainEqual({ type: "text", text: "ok" })
		})

		it("ignores non-array tool_calls values in stream deltas", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const mockCreate = vitest.fn().mockResolvedValue(
				asyncStreamFrom([
					{ id: "1", choices: [{ delta: { tool_calls: "nope", content: "x" } }] },
					{ id: "2", choices: [{ delta: { content: "ok" } }] },
				]),
			)
			// The auto-mocked OpenAI client is injected via a structural type to avoid `any` casts.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			client.chat = { completions: { create: mockCreate } }

			const chunks = await collectStream(
				handler.createMessage("system", [{ role: "user" as const, content: "hi" }]),
			)
			expect(chunks.some((c) => c.type === "tool_call_partial")).toBe(false)
			expect(chunks).toContainEqual({ type: "text", text: "x" })
		})

		it("emits tool_call_partial chunks for tool calls without a function payload", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const mockCreate = vitest.fn().mockResolvedValue(
				asyncStreamFrom([
					{ id: "1", choices: [{ delta: { tool_calls: [{ index: 0, id: "c1" }], content: "x" } }] },
					{ id: "2", choices: [{ delta: { content: "ok" } }] },
				]),
			)
			// The auto-mocked OpenAI client is injected via a structural type to avoid `any` casts.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			client.chat = { completions: { create: mockCreate } }

			const chunks = await collectStream(
				handler.createMessage("system", [{ role: "user" as const, content: "hi" }]),
			)
			expect(chunks).toContainEqual(expect.objectContaining({ type: "tool_call_partial", id: "c1", index: 0 }))
		})

		it("reports OpenRouter structured errors in createMessage with telemetry", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const mockCreate = vitest.fn().mockRejectedValueOnce({
				error: {
					message: "Model not found",
					code: 404,
					metadata: { raw: '{"message":"upstream: model not found"}' },
				},
			})
			// The auto-mocked OpenAI client is injected via a structural type to avoid `any` casts.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			client.chat = { completions: { create: mockCreate } }

			const generator = handler.createMessage("system", [{ role: "user" as const, content: "hi" }])

			await expect(generator.next()).rejects.toThrow(/completion error/)
			expect(mockCaptureException).toHaveBeenCalledTimes(1)
		})

		it("prefers the raw metadata message over the SDK error message in createMessage telemetry", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const mockCreate = vitest.fn().mockRejectedValueOnce({
				error: {
					message: "Model not found",
					code: 404,
					metadata: { raw: '{"message":"upstream: model not found"}' },
				},
			})
			// The auto-mocked OpenAI client is injected via a structural type to avoid `any` casts.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			client.chat = { completions: { create: mockCreate } }

			const generator = handler.createMessage("system", [{ role: "user" as const, content: "hi" }])

			await expect(generator.next()).rejects.toThrow(/completion error/)
			expect(mockCaptureException).toHaveBeenCalledWith(
				expect.objectContaining({
					message: "upstream: model not found",
					provider: providerIdentifiers.openrouter,
					modelId: "anthropic/claude-sonnet-4",
					operation: "createMessage",
					status: 404,
				}),
			)
		})

		it("falls back to the SDK error message in createMessage telemetry when no raw metadata is present", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const mockCreate = vitest.fn().mockRejectedValueOnce({
				error: {
					message: "Model not found",
					code: 404,
				},
			})
			// The auto-mocked OpenAI client is injected via a structural type to avoid `any` casts.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			client.chat = { completions: { create: mockCreate } }

			const generator = handler.createMessage("system", [{ role: "user" as const, content: "hi" }])

			await expect(generator.next()).rejects.toThrow(/completion error/)
			expect(mockCaptureException).toHaveBeenCalledWith(
				expect.objectContaining({
					message: "Model not found",
					provider: providerIdentifiers.openrouter,
					modelId: "anthropic/claude-sonnet-4",
					operation: "createMessage",
				}),
			)
		})

		it("falls back to an unknown error in createMessage telemetry when no message is available", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const mockCreate = vitest.fn().mockRejectedValueOnce({
				error: {
					code: 500,
				},
			})
			// The auto-mocked OpenAI client is injected via a structural type to avoid `any` casts.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			client.chat = { completions: { create: mockCreate } }

			const generator = handler.createMessage("system", [{ role: "user" as const, content: "hi" }])

			await expect(generator.next()).rejects.toThrow(/completion error/)
			expect(mockCaptureException).toHaveBeenCalledWith(
				expect.objectContaining({
					message: "Unknown error",
					provider: providerIdentifiers.openrouter,
					modelId: "anthropic/claude-sonnet-4",
					operation: "createMessage",
				}),
			)
		})
	})

	describe("completePrompt", () => {
		it("returns correct response", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const mockResponse = { choices: [{ message: { content: "test completion" } }] }

			const mockCreate = vitest.fn().mockResolvedValue(mockResponse)
			;(OpenAI as any).prototype.chat = {
				completions: { create: mockCreate },
			} as any

			const result = await handler.completePrompt("test prompt")

			expect(result).toBe("test completion")

			expect(mockCreate).toHaveBeenCalledWith(
				{
					model: mockOptions.openRouterModelId,
					max_tokens: 8192,
					temperature: 0,
					messages: [{ role: "user", content: "test prompt" }],
					stream: false,
				},
				{ headers: { "x-anthropic-beta": "fine-grained-tool-streaming-2025-05-14" } },
			)
		})

		it("handles API errors and captures telemetry", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const mockError = {
				error: {
					message: "API Error",
					code: 500,
				},
			}

			const mockCreate = vitest.fn().mockResolvedValue(mockError)
			;(OpenAI as any).prototype.chat = {
				completions: { create: mockCreate },
			} as any

			await expect(handler.completePrompt("test prompt")).rejects.toThrow("OpenRouter API Error 500: API Error")

			// Verify telemetry was captured
			expect(mockCaptureException).toHaveBeenCalledWith(
				expect.objectContaining({
					message: "API Error",
					provider: providerIdentifiers.openrouter,
					modelId: mockOptions.openRouterModelId,
					operation: "completePrompt",
					errorCode: 500,
					status: 500,
				}),
			)
		})

		it("handles unexpected errors and captures telemetry", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const error = new Error("Unexpected error")
			const mockCreate = vitest.fn().mockRejectedValue(error)
			;(OpenAI as any).prototype.chat = {
				completions: { create: mockCreate },
			} as any

			await expect(handler.completePrompt("test prompt")).rejects.toThrow("Unexpected error")

			// Verify telemetry was captured (filtering now happens inside PostHogTelemetryClient)
			expect(mockCaptureException).toHaveBeenCalledWith(
				expect.objectContaining({
					message: "Unexpected error",
					provider: providerIdentifiers.openrouter,
					modelId: mockOptions.openRouterModelId,
					operation: "completePrompt",
				}),
			)
		})

		it("passes SDK exceptions with status 429 to telemetry (filtering happens in PostHogTelemetryClient)", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const error = new Error("Rate limit exceeded: free-models-per-day") as any
			error.status = 429
			const mockCreate = vitest.fn().mockRejectedValue(error)
			;(OpenAI as any).prototype.chat = {
				completions: { create: mockCreate },
			} as any

			await expect(handler.completePrompt("test prompt")).rejects.toThrow("Rate limit exceeded")

			// captureException is called, but PostHogTelemetryClient filters out 429 errors internally
			expect(mockCaptureException).toHaveBeenCalledWith(
				expect.objectContaining({
					message: "Rate limit exceeded: free-models-per-day",
					provider: providerIdentifiers.openrouter,
					modelId: mockOptions.openRouterModelId,
					operation: "completePrompt",
				}),
			)
		})

		it("passes SDK exceptions with 429 in message to telemetry (filtering happens in PostHogTelemetryClient)", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const error = new Error("429 Rate limit exceeded: free-models-per-day")
			const mockCreate = vitest.fn().mockRejectedValue(error)
			;(OpenAI as any).prototype.chat = {
				completions: { create: mockCreate },
			} as any

			await expect(handler.completePrompt("test prompt")).rejects.toThrow("429 Rate limit exceeded")

			// captureException is called, but PostHogTelemetryClient filters out 429 errors internally
			expect(mockCaptureException).toHaveBeenCalledWith(
				expect.objectContaining({
					message: "429 Rate limit exceeded: free-models-per-day",
					provider: providerIdentifiers.openrouter,
					modelId: mockOptions.openRouterModelId,
					operation: "completePrompt",
				}),
			)
		})

		it("passes SDK exceptions containing 'rate limit' to telemetry (filtering happens in PostHogTelemetryClient)", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const error = new Error("Request failed due to rate limit")
			const mockCreate = vitest.fn().mockRejectedValue(error)
			;(OpenAI as any).prototype.chat = {
				completions: { create: mockCreate },
			} as any

			await expect(handler.completePrompt("test prompt")).rejects.toThrow("rate limit")

			// captureException is called, but PostHogTelemetryClient filters out rate limit errors internally
			expect(mockCaptureException).toHaveBeenCalledWith(
				expect.objectContaining({
					message: "Request failed due to rate limit",
					provider: providerIdentifiers.openrouter,
					modelId: mockOptions.openRouterModelId,
					operation: "completePrompt",
				}),
			)
		})

		it("passes 429 rate limit errors from response to telemetry (filtering happens in PostHogTelemetryClient)", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const mockError = {
				error: {
					message: "Rate limit exceeded",
					code: 429,
				},
			}

			const mockCreate = vitest.fn().mockResolvedValue(mockError)
			;(OpenAI as any).prototype.chat = {
				completions: { create: mockCreate },
			} as any

			await expect(handler.completePrompt("test prompt")).rejects.toThrow(
				"OpenRouter API Error 429: Rate limit exceeded",
			)

			// captureException is called, but PostHogTelemetryClient filters out 429 errors internally
			expect(mockCaptureException).toHaveBeenCalledWith(
				expect.objectContaining({
					message: "Rate limit exceeded",
					provider: providerIdentifiers.openrouter,
					modelId: mockOptions.openRouterModelId,
					operation: "completePrompt",
					errorCode: 429,
					status: 429,
				}),
			)
		})
		it("should pass abort signal through to client", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const controller = new AbortController()
			const mockCreate = vitest.fn().mockResolvedValue({ choices: [{ message: { content: "response" } }] })
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			client.chat = { completions: { create: mockCreate } }

			await handler.completePrompt("test prompt", { abortSignal: controller.signal })
			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({ model: expect.any(String) }),
				expect.objectContaining({ signal: controller.signal }),
			)
		})

		it("should pass timeout through to client", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const mockCreate = vitest.fn().mockResolvedValue({ choices: [{ message: { content: "response" } }] })
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			client.chat = { completions: { create: mockCreate } }

			await handler.completePrompt("test prompt", { timeoutMs: 5000 })
			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({ model: expect.any(String) }),
				expect.objectContaining({ timeout: 5000 }),
			)
		})

		it("should work without options (backward compatible)", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const mockCreate = vitest.fn().mockResolvedValue({ choices: [{ message: { content: "response" } }] })
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			client.chat = { completions: { create: mockCreate } }

			const result = await handler.completePrompt("test prompt")
			expect(result).toBe("response")
		})

		it("omits the anthropic beta header for non-Anthropic models", async () => {
			const handler = new OpenRouterHandler(
				makeApiHandlerOptions({
					...mockOptions,
					openRouterModelId: "openai/gpt-4o",
				}),
			)
			const mockCreate = vitest.fn().mockResolvedValue({ choices: [{ message: { content: "response" } }] })
			// The auto-mocked OpenAI client is injected via a structural type to avoid `any` casts.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			client.chat = { completions: { create: mockCreate } }

			await handler.completePrompt("test prompt")
			const options = mockCreate.mock.calls[0][1] as { headers?: Record<string, string> }
			expect(options).not.toHaveProperty("headers")
		})

		it("omits the signal and timeout options when timeoutMs is zero and no signal is provided", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const mockCreate = vitest.fn().mockResolvedValue({ choices: [{ message: { content: "response" } }] })
			// The auto-mocked OpenAI client is injected via a structural type to avoid `any` casts.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			client.chat = { completions: { create: mockCreate } }

			await handler.completePrompt("test prompt", { timeoutMs: 0 })
			const options = mockCreate.mock.calls[0][1] as { signal?: AbortSignal; timeout?: number }
			expect(options).not.toHaveProperty("signal")
			expect(options).not.toHaveProperty("timeout")
		})

		it("propagates non-abort model-discovery failures from completePrompt", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const mockCreate = vitest.fn().mockResolvedValue({ choices: [{ message: { content: "response" } }] })
			// The auto-mocked OpenAI client is injected via a structural type to avoid `any` casts.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			client.chat = { completions: { create: mockCreate } }

			// The constructor's background discovery consumed the default mock; make the next
			// lookup (completePrompt's own fetchModel) reject with a non-abort failure.
			const { getModels } = await import("../fetchers/modelCache")
			vitest.mocked(getModels).mockRejectedValueOnce(new Error("discovery failed"))

			await expect(handler.completePrompt("test prompt")).rejects.toThrow("discovery failed")
			expect(mockCreate).not.toHaveBeenCalled()
		})

		it("maps an abort-named model-discovery failure to a canonical AbortError in completePrompt", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const mockCreate = vitest.fn().mockResolvedValue({ choices: [{ message: { content: "response" } }] })
			// The auto-mocked OpenAI client is injected via a structural type to avoid `any` casts.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			client.chat = { completions: { create: mockCreate } }

			// The constructor's background discovery consumed the default mock; make the next
			// lookup (completePrompt's own fetchModel) reject with an abort-named failure.
			const { getModels } = await import("../fetchers/modelCache")
			vitest.mocked(getModels).mockRejectedValueOnce(Object.assign(new Error("aborted"), { name: "AbortError" }))

			await expect(handler.completePrompt("test prompt")).rejects.toMatchObject({
				name: "AbortError",
				message: "The OpenRouter request was aborted",
			})
			expect(mockCreate).not.toHaveBeenCalled()
		})

		it("rejects with AbortError when the request aborts before a late result lands", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const controller = new AbortController()

			// Deterministic synchronization: the mock notifies the test when create() has been
			// called, so the abort lands after model discovery instead of racing it.
			let notifyCreateStarted!: () => void
			const createStarted = new Promise<void>((resolve) => {
				notifyCreateStarted = resolve
			})
			let resolveCreate!: (value: unknown) => void
			const mockCreate = vitest.fn().mockImplementation(() => {
				notifyCreateStarted()
				return new Promise((resolve) => {
					resolveCreate = resolve
				})
			})
			// The auto-mocked OpenAI client is injected via a structural type to avoid `any` casts.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			client.chat = { completions: { create: mockCreate } }

			const promise = handler.completePrompt("test prompt", { abortSignal: controller.signal })
			await createStarted
			controller.abort()
			resolveCreate({ choices: [{ message: { content: "late result" } }] })

			await expect(promise).rejects.toMatchObject({
				name: "AbortError",
				message: "The OpenRouter request was aborted",
			})
		})

		it("rejects with AbortError when the signal is pre-aborted", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const mockCreate = vitest.fn().mockResolvedValue({ choices: [{ message: { content: "response" } }] })
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			client.chat = { completions: { create: mockCreate } }

			const controller = new AbortController()
			controller.abort()

			await expect(
				handler.completePrompt("test prompt", { abortSignal: controller.signal }),
			).rejects.toMatchObject({
				name: "AbortError",
				message: "The OpenRouter request was aborted",
			})
			// The pre-abort guard rejects before any model lookup beyond the constructor's own.
			const { getModels } = await import("../fetchers/modelCache")
			expect(vitest.mocked(getModels).mock.calls.length).toBe(1)
		})

		it("rejects with AbortError when aborted mid-flight", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const controller = new AbortController()

			const mockCreate = vitest
				.fn()
				.mockImplementation(async (_params: unknown, options?: { signal?: AbortSignal }) => {
					// Emulate the OpenAI SDK: the in-flight request rejects when the signal aborts.
					await new Promise<void>((resolve) => {
						if (options?.signal?.aborted) {
							resolve()
						} else {
							options?.signal?.addEventListener("abort", () => resolve(), { once: true })
						}
					})
					const abortError = new Error("The user aborted a request")
					abortError.name = "AbortError"
					throw abortError
				})
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			client.chat = { completions: { create: mockCreate } }

			const promise = handler.completePrompt("test prompt", { abortSignal: controller.signal })
			controller.abort()

			await expect(promise).rejects.toMatchObject({
				name: "AbortError",
				message: "The OpenRouter request was aborted",
			})
		})
		it("rejects with AbortError when only a timeout is provided and it elapses", async () => {
			// Non-Anthropic model: also exercises the no-beta-header branch of requestOptions.
			const handler = new OpenRouterHandler(
				makeApiHandlerOptions({
					...mockOptions,
					openRouterModelId: "openai/gpt-4o",
				}),
			)
			const mockCreate = vitest
				.fn()
				.mockImplementation(async (_params: unknown, options?: { signal?: AbortSignal }) => {
					// Emulate the OpenAI SDK: the in-flight request rejects when the signal times out.
					await new Promise<void>((resolve) => {
						if (options?.signal?.aborted) {
							resolve()
						} else {
							options?.signal?.addEventListener("abort", () => resolve(), { once: true })
						}
					})
					const timeoutError = new Error("TimeoutError: Request timed out.")
					timeoutError.name = "TimeoutError"
					throw timeoutError
				})
			// The auto-mocked OpenAI client is injected via a structural type to avoid `any` casts.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			client.chat = { completions: { create: mockCreate } }

			await expect(handler.completePrompt("test prompt", { timeoutMs: 50 })).rejects.toMatchObject({
				name: "AbortError",
			})
		})

		it("rejects with AbortError when both an abort signal and a timeout are provided", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const controller = new AbortController()

			// Deterministic synchronization: the mock notifies the test when the request
			// actually starts, so the abort lands mid-flight (after model lookup) instead of
			// winning the race at model discovery on a slow runner.
			let notifyCreateStarted!: () => void
			const createStarted = new Promise<void>((resolve) => {
				notifyCreateStarted = resolve
			})
			let requestSignal: AbortSignal | undefined
			const mockCreate = vitest
				.fn()
				.mockImplementation(async (_params: unknown, options?: { signal?: AbortSignal }) => {
					notifyCreateStarted()
					requestSignal = options?.signal
					await new Promise<void>((resolve) => {
						if (options?.signal?.aborted) {
							resolve()
						} else {
							options?.signal?.addEventListener("abort", () => resolve(), { once: true })
						}
					})
					const abortError = new Error("The user aborted a request")
					abortError.name = "AbortError"
					throw abortError
				})
			// The auto-mocked OpenAI client is injected via a structural type to avoid `any` casts.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			client.chat = { completions: { create: mockCreate } }

			const promise = handler.completePrompt("test prompt", {
				abortSignal: controller.signal,
				timeoutMs: 100_000,
			})
			// Abort only once create() has actually started (after model lookup).
			await createStarted
			controller.abort()

			await expect(promise).rejects.toMatchObject({
				name: "AbortError",
				message: "The OpenRouter request was aborted",
			})
			// The SDK received a merged signal (not the caller's signal) plus the timeout.
			expect(requestSignal).toBeDefined()
			expect(requestSignal).not.toBe(controller.signal)
			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({ model: expect.any(String) }),
				expect.objectContaining({ timeout: 100_000 }),
			)
		})
	})
})
