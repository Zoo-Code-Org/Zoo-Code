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
import { getModels } from "../fetchers/modelCache"
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

		it("yields nothing for a chunk whose delta has no content, reasoning or tool calls", async () => {
			mockCreate.mockImplementation(async () => ({
				[Symbol.asyncIterator]: async function* () {
					yield { choices: [{ delta: {}, index: 0 }], usage: null }
					yield { choices: [], usage: null }
				},
			}))

			const handler = new KenariHandler(mockOptions)
			const chunks = []
			for await (const chunk of handler.createMessage("sys", [{ role: "user", content: "Hi" }])) {
				chunks.push(chunk)
			}

			expect(chunks).toEqual([])
		})

		it("streams tool call chunks even when the function name and arguments are missing", async () => {
			mockCreate.mockImplementation(async () => ({
				[Symbol.asyncIterator]: async function* () {
					yield {
						choices: [{ delta: { tool_calls: [{ index: 1 }] }, index: 0 }],
						usage: null,
					}
				},
			}))

			const handler = new KenariHandler(mockOptions)
			const chunks = []
			for await (const chunk of handler.createMessage("sys", [{ role: "user", content: "Hi" }])) {
				chunks.push(chunk)
			}

			expect(chunks).toEqual([
				{
					type: "tool_call_partial",
					index: 1,
					id: undefined,
					name: undefined,
					arguments: undefined,
				},
			])
		})

		it("reports undefined cache reads when usage has no prompt_tokens_details", async () => {
			mockCreate.mockImplementation(async () => ({
				[Symbol.asyncIterator]: async function* () {
					yield {
						choices: [{ delta: {}, index: 0 }],
						usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
					}
				},
			}))

			const handler = new KenariHandler(mockOptions)
			const chunks = []
			for await (const chunk of handler.createMessage("sys", [{ role: "user", content: "Hi" }])) {
				chunks.push(chunk)
			}

			expect(chunks).toEqual([
				{
					type: "usage",
					inputTokens: 3,
					outputTokens: 2,
					cacheReadTokens: undefined,
				},
			])
		})

		it("skips the reasoning chunk when reasoning_content is an empty string", async () => {
			mockCreate.mockImplementation(async () => ({
				[Symbol.asyncIterator]: async function* () {
					yield {
						choices: [{ delta: { content: "Hi", reasoning_content: "" }, index: 0 }],
						usage: null,
					}
				},
			}))

			const handler = new KenariHandler(mockOptions)
			const chunks = []
			for await (const chunk of handler.createMessage("sys", [{ role: "user", content: "Hi" }])) {
				chunks.push(chunk)
			}

			expect(chunks).toEqual([{ type: "text", text: "Hi" }])
		})

		it("emits reasoning from the OpenRouter-style `reasoning` field when reasoning_content is absent", async () => {
			mockCreate.mockImplementation(async () => ({
				[Symbol.asyncIterator]: async function* () {
					yield {
						choices: [{ delta: { content: "Hi", reasoning: "thinking…" }, index: 0 }],
						usage: null,
					}
				},
			}))

			const handler = new KenariHandler(mockOptions)
			const chunks = []
			for await (const chunk of handler.createMessage("sys", [{ role: "user", content: "Hi" }])) {
				chunks.push(chunk)
			}

			expect(chunks).toContainEqual({ type: "reasoning", text: "thinking…" })
		})

		it("omits temperature for models that do not support it", async () => {
			vitest.mocked(getModels).mockResolvedValueOnce({
				"openai/o3-mini": {
					maxTokens: 4096,
					contextWindow: 128000,
					supportsImages: false,
					supportsPromptCache: false,
					description: "o3-mini via Kenari",
				},
			})

			const handler = new KenariHandler({ kenariApiKey: "test-key", kenariModelId: "openai/o3-mini" })
			for await (const _chunk of handler.createMessage("sys", [{ role: "user", content: "Hi" }])) {
				void _chunk // drain
			}

			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					model: "openai/o3-mini",
					temperature: undefined,
				}),
			)
		})

		it("sends an explicitly configured model temperature", async () => {
			const handler = new KenariHandler({ ...mockOptions, modelTemperature: 0.7 })
			for await (const _chunk of handler.createMessage("sys", [{ role: "user", content: "Hi" }])) {
				void _chunk // drain
			}

			expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ temperature: 0.7 }))
		})

		it("honors metadata.parallelToolCalls false", async () => {
			const handler = new KenariHandler(mockOptions)
			for await (const _chunk of handler.createMessage("sys", [{ role: "user", content: "Hi" }], {
				taskId: "task-1",
				parallelToolCalls: false,
			})) {
				void _chunk // drain
			}

			expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ parallel_tool_calls: false }))
		})

		it("reports zero usage when the upstream counts are zero", async () => {
			mockCreate.mockImplementation(async () => ({
				[Symbol.asyncIterator]: async function* () {
					yield {
						choices: [{ delta: { content: "x" }, index: 0 }],
						usage: { prompt_tokens: 0, completion_tokens: 0 },
					}
				},
			}))

			const handler = new KenariHandler(mockOptions)
			const chunks = []
			for await (const chunk of handler.createMessage("sys", [{ role: "user", content: "Hi" }])) {
				chunks.push(chunk)
			}

			expect(chunks).toContainEqual({
				type: "usage",
				inputTokens: 0,
				outputTokens: 0,
				cacheReadTokens: undefined,
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

		it("returns an empty string when the completion has no content", async () => {
			mockCreate.mockResolvedValue({ choices: [{ message: { content: null } }] })
			const handler = new KenariHandler(mockOptions)
			expect(await handler.completePrompt("ping")).toBe("")
		})

		it("wraps errors with a Kenari-specific message", async () => {
			mockCreate.mockRejectedValue(new Error("boom"))
			const handler = new KenariHandler(mockOptions)
			await expect(handler.completePrompt("ping")).rejects.toThrow("Kenari completion error: boom")
		})

		it("re-throws non-Error rejections unchanged", async () => {
			mockCreate.mockRejectedValue("string failure")
			const handler = new KenariHandler(mockOptions)
			await expect(handler.completePrompt("ping")).rejects.toBe("string failure")
		})

		it("omits temperature for models that do not support it", async () => {
			vitest.mocked(getModels).mockResolvedValueOnce({
				"openai/o3-mini": {
					maxTokens: 4096,
					contextWindow: 128000,
					supportsImages: false,
					supportsPromptCache: false,
					description: "o3-mini via Kenari",
				},
			})
			mockCreate.mockResolvedValue({ choices: [{ message: { content: "ok" } }] })

			const handler = new KenariHandler({ kenariApiKey: "test-key", kenariModelId: "openai/o3-mini" })
			expect(await handler.completePrompt("ping")).toBe("ok")

			const callArgs = mockCreate.mock.calls[0][0]
			expect(callArgs.model).toBe("openai/o3-mini")
			expect("temperature" in callArgs).toBe(false)
		})
	})
})
