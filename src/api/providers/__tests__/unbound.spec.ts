import { Anthropic } from "@anthropic-ai/sdk"
import OpenAI from "openai"

import type { Mock } from "vitest"

import axios from "axios"

import { UnboundHandler } from "../unbound"
import { getUnboundModels } from "../fetchers/unbound"
import { asyncStreamFrom, collectStream } from "../../../test-utils/stream"
import { clearAllMocks } from "../../../test-utils/reset"

vi.mock("axios")

const mockedAxios = axios as typeof axios & {
	get: Mock
}

vi.mock("openai", () => {
	const createMock = vi.fn()
	return {
		default: vi.fn(function () {
			return {
				chat: {
					completions: {
						create: createMock,
					},
				},
			}
		}),
	}
})

vi.mock("../fetchers/modelCache", () => ({
	getModels: vi.fn().mockResolvedValue({
		"openai/gpt-4o": {
			maxTokens: 4096,
			contextWindow: 128000,
			supportsImages: true,
			supportsPromptCache: false,
			inputPrice: 2.5,
			outputPrice: 10,
			description: "GPT-4o",
		},
	}),
	refreshModels: vi.fn(async (options) => {
		const { getModels } = await import("../fetchers/modelCache")
		return getModels(options)
	}),
}))

describe("UnboundHandler", () => {
	beforeEach(() => {
		clearAllMocks()
	})

	it("identifies itself as Zoo Code in the Unbound request headers", () => {
		new UnboundHandler({
			unboundApiKey: "test-key",
			unboundModelId: "openai/gpt-4o",
		})

		expect(OpenAI).toHaveBeenCalledWith(
			expect.objectContaining({
				defaultHeaders: expect.objectContaining({
					"X-Unbound-Metadata": JSON.stringify({ labels: [{ key: "app", value: "zoo-code" }] }),
				}),
			}),
		)
	})

	it("streams reasoning chunks from delta.reasoning_content", async () => {
		const mockCreate = (OpenAI as unknown as any)().chat.completions.create
		mockCreate.mockResolvedValue(
			asyncStreamFrom([
				{ choices: [{ delta: { reasoning_content: "thinking..." } }] },
				{ choices: [{ delta: { content: "answer" } }] },
				{ choices: [{ delta: {} }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
			]),
		)

		const handler = new UnboundHandler({
			unboundApiKey: "test-key",
			unboundModelId: "openai/gpt-4o",
		})

		const chunks = await collectStream(
			handler.createMessage("system", [{ role: "user", content: "hi" }], {
				taskId: "t",
				tools: [],
			}),
		)

		expect(chunks).toContainEqual({ type: "reasoning", text: "thinking..." })
	})

	it("falls back to delta.reasoning when reasoning_content is absent", async () => {
		const mockCreate = (OpenAI as unknown as any)().chat.completions.create
		mockCreate.mockResolvedValue(
			asyncStreamFrom([
				{ choices: [{ delta: { reasoning: "router-style thought" } }] },
				{ choices: [{ delta: {} }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
			]),
		)

		const handler = new UnboundHandler({
			unboundApiKey: "test-key",
			unboundModelId: "openai/gpt-4o",
		})

		const chunks = await collectStream(
			handler.createMessage("system", [{ role: "user", content: "hi" }], {
				taskId: "t",
				tools: [],
			}),
		)

		expect(chunks).toContainEqual({ type: "reasoning", text: "router-style thought" })
	})

	it("prefers delta.reasoning_content over delta.reasoning when both are present", async () => {
		const mockCreate = (OpenAI as unknown as any)().chat.completions.create

		mockCreate.mockResolvedValue(
			asyncStreamFrom([
				{
					choices: [
						{
							delta: {
								reasoning_content: "primary thought",
								reasoning: "fallback thought",
							},
						},
					],
				},
				{ choices: [{ delta: {} }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
			]),
		)

		const handler = new UnboundHandler({
			unboundApiKey: "test-key",
			unboundModelId: "openai/gpt-4o",
		})

		const chunks = await collectStream(
			handler.createMessage("system", [{ role: "user", content: "hi" }], {
				taskId: "t",
				tools: [],
			}),
		)

		const reasoningChunks = chunks.filter((chunk) => chunk.type === "reasoning")

		expect(reasoningChunks).toEqual([{ type: "reasoning", text: "primary thought" }])
	})

	it("identifies itself as Zoo Code in per-request Unbound metadata", async () => {
		const mockCreate = (OpenAI as unknown as any)().chat.completions.create
		mockCreate.mockResolvedValue(
			asyncStreamFrom([
				{
					choices: [{ delta: { content: "ok" } }],
				},
				{
					choices: [{ delta: {} }],
					usage: { prompt_tokens: 1, completion_tokens: 1 },
				},
			]),
		)

		const handler = new UnboundHandler({
			unboundApiKey: "test-key",
			unboundModelId: "openai/gpt-4o",
		})

		const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "hello" }]
		const stream = handler.createMessage("system", messages, {
			taskId: "task-123",
			mode: "architect",
			tools: [],
		})

		await collectStream(stream)

		expect(mockCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				unbound_metadata: {
					originApp: "zoo-code",
					taskId: "task-123",
					mode: "architect",
				},
			}),
		)
	})

	it("completePrompt returns the response text", async () => {
		const mockCreate = (OpenAI as unknown as any)().chat.completions.create
		mockCreate.mockResolvedValue({
			choices: [{ message: { content: "completed text" } }],
		})

		const handler = new UnboundHandler({
			unboundApiKey: "test-key",
			unboundModelId: "openai/gpt-4o",
		})

		const result = await handler.completePrompt("Write a haiku")
		expect(result).toBe("completed text")
		expect(mockCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				messages: [{ role: "system", content: "Write a haiku" }],
			}),
		)
	})
})

describe("getUnboundModels", () => {
	beforeEach(() => {
		clearAllMocks()
	})

	it.each([{ data: null }, { data: { error: "Invalid request" } }])(
		"returns no models when the API response is not an array: %j",
		async (mockResponse) => {
			const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
			mockedAxios.get.mockResolvedValue(mockResponse)

			const models = await getUnboundModels("test-key")

			expect(models).toEqual({})
			expect(consoleError).toHaveBeenCalledWith(
				"[getUnboundModels] Unexpected response format:",
				mockResponse.data,
			)
		},
	)
})
