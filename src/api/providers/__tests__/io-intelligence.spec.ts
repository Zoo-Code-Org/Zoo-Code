vi.mock("vscode", () => ({
	workspace: { getConfiguration: () => ({ get: (_key: string, defaultValue?: unknown) => defaultValue }) },
}))

import { Anthropic } from "@anthropic-ai/sdk"
import OpenAI from "openai"

import { ioIntelligenceDefaultModelId, providerIdentifiers } from "@roo-code/types"

import { buildApiHandler } from "../../index"
import { asyncStreamFrom, collectStream } from "../../../test-utils/stream"
import { IOIntelligenceHandler } from "../io-intelligence"
import { getModels } from "../fetchers/modelCache"

vi.mock("openai")
vi.mock("../fetchers/modelCache", () => ({
	getModels: vi.fn().mockResolvedValue({
		"meta-llama/Llama-3.3-70B-Instruct": {
			maxTokens: 8192,
			contextWindow: 128000,
			supportsImages: false,
			supportsPromptCache: false,
		},
	}),
	getModelsFromCache: vi.fn(),
	refreshModels: vi.fn().mockResolvedValue({}),
}))

const mockCreate = vi.fn()
vi.mocked(OpenAI).mockImplementation(function () {
	return { chat: { completions: { create: mockCreate } } } as unknown as OpenAI
})

const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Hello" }]

describe("IOIntelligenceHandler", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.mocked(getModels).mockResolvedValue({
			"meta-llama/Llama-3.3-70B-Instruct": {
				maxTokens: 8192,
				contextWindow: 128000,
				supportsImages: false,
				supportsPromptCache: false,
			},
		})
		mockCreate.mockResolvedValue(asyncStreamFrom([]))
	})

	it("is constructed by the backend provider registry", () => {
		expect(buildApiHandler({ apiProvider: providerIdentifiers.ioIntelligence })).toBeInstanceOf(
			IOIntelligenceHandler,
		)
	})

	it("resolves the default model when none is configured", async () => {
		const handler = new IOIntelligenceHandler({})
		await collectStream(handler.createMessage("system", messages))
		expect(mockCreate).toHaveBeenCalledWith(
			expect.objectContaining({ model: ioIntelligenceDefaultModelId }),
			expect.objectContaining({ signal: undefined }),
		)
	})

	it("uses the configured model id and streams text, reasoning, and tool calls", async () => {
		mockCreate.mockResolvedValue(
			asyncStreamFrom([
				{ choices: [{ delta: { content: "answer" } }] },
				{ choices: [{ delta: { reasoning_content: "thinking" } }] },
				{
					choices: [
						{
							delta: {
								tool_calls: [
									{ index: 0, id: "call-1", function: { name: "read_file", arguments: '{"path":' } },
								],
							},
						},
					],
				},
			]),
		)
		const chunks = await collectStream(
			new IOIntelligenceHandler({
				ioIntelligenceModelId: "meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8",
			}).createMessage("sys", messages),
		)
		expect(mockCreate).toHaveBeenCalledWith(
			expect.objectContaining({ model: "meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8" }),
			expect.objectContaining({ signal: undefined }),
		)
		expect(chunks).toEqual([
			{ type: "text", text: "answer" },
			{ type: "reasoning", text: "thinking" },
			{ type: "tool_call_partial", index: 0, id: "call-1", name: "read_file", arguments: '{"path":' },
		])
	})

	it("forwards native tools, usage streaming, max_tokens, and cancellation", async () => {
		const signal = new AbortController().signal
		const tools: OpenAI.Chat.ChatCompletionTool[] = [
			{ type: "function", function: { name: "read_file", description: "Read", parameters: { type: "object" } } },
		]
		const handler = new IOIntelligenceHandler({
			ioIntelligenceModelId: "meta-llama/Llama-3.3-70B-Instruct",
			modelTemperature: 0.7,
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
				max_tokens: 8192,
				temperature: 0.7,
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

	it("maps usage from the final chunk", async () => {
		mockCreate.mockResolvedValue(
			asyncStreamFrom([
				{
					choices: [],
					usage: {
						prompt_tokens: 20,
						completion_tokens: 10,
						prompt_tokens_details: { cached_tokens: 5 },
					},
				},
			]),
		)
		expect(
			await collectStream(
				new IOIntelligenceHandler({ ioIntelligenceModelId: "meta-llama/Llama-3.3-70B-Instruct" }).createMessage(
					"sys",
					messages,
				),
			),
		).toEqual([
			{
				type: "usage",
				inputTokens: 20,
				outputTokens: 10,
				cacheReadTokens: 5,
			},
		])
	})

	it("redacts the API key from streaming errors", async () => {
		mockCreate.mockRejectedValue(new Error("upstream rejected secret-key"))
		const handler = new IOIntelligenceHandler({
			ioIntelligenceApiKey: "secret-key",
			ioIntelligenceModelId: "meta-llama/Llama-3.3-70B-Instruct",
		})
		await expect(collectStream(handler.createMessage("sys", messages))).rejects.toMatchObject({
			message: "IO Intelligence streaming error: upstream rejected [REDACTED]",
		})
	})
})
