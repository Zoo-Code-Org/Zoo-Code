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

/** Flattens every argument of every console.error call into one searchable string. */
const loggedText = (spy: { mock: { calls: unknown[][] } }) =>
	spy.mock.calls
		.flat()
		.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg)))
		.join("\n")

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
				ioIntelligenceModelId: "deepseek-ai/DeepSeek-V3.2",
			}).createMessage("sys", messages),
		)
		expect(mockCreate).toHaveBeenCalledWith(
			expect.objectContaining({ model: "deepseek-ai/DeepSeek-V3.2" }),
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

	it("preserves a zero cache-read count instead of coercing it away", async () => {
		mockCreate.mockResolvedValue(
			asyncStreamFrom([
				{
					choices: [],
					usage: {
						prompt_tokens: 20,
						completion_tokens: 10,
						prompt_tokens_details: { cached_tokens: 0 },
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
				cacheReadTokens: 0,
			},
		])
	})

	it("redacts the API key from streaming errors and from the logged error", async () => {
		const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		try {
			mockCreate.mockRejectedValue(new Error("upstream rejected secret-key"))
			const handler = new IOIntelligenceHandler({
				ioIntelligenceApiKey: "secret-key",
				ioIntelligenceModelId: "meta-llama/Llama-3.3-70B-Instruct",
			})
			await expect(collectStream(handler.createMessage("sys", messages))).rejects.toMatchObject({
				message: "IO Intelligence streaming error: upstream rejected [REDACTED]",
			})
			// The error handler logs message + stack before the transformer runs,
			// so the key must already be gone from both.
			expect(consoleErrorSpy).toHaveBeenCalledWith(
				"[IO Intelligence] API error:",
				expect.objectContaining({
					message: "upstream rejected [REDACTED]",
					stack: expect.stringContaining("[REDACTED]"),
				}),
			)
			expect(loggedText(consoleErrorSpy)).not.toContain("secret-key")
		} finally {
			consoleErrorSpy.mockRestore()
		}
	})

	it("redacts the API key from the SDK's raw error metadata before it is logged", async () => {
		const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		try {
			// The OpenAI SDK attaches the upstream body as `error.metadata.raw`,
			// which the error handler prefers over `message` when logging.
			mockCreate.mockRejectedValue(
				Object.assign(new Error("Request failed"), {
					error: { metadata: { raw: '{"detail":"invalid key secret-key"}' } },
				}),
			)
			const handler = new IOIntelligenceHandler({
				ioIntelligenceApiKey: "secret-key",
				ioIntelligenceModelId: "meta-llama/Llama-3.3-70B-Instruct",
			})
			await expect(collectStream(handler.createMessage("sys", messages))).rejects.toMatchObject({
				message: 'IO Intelligence streaming error: {"detail":"invalid key [REDACTED]"}',
			})
			expect(consoleErrorSpy).toHaveBeenCalledWith(
				"[IO Intelligence] API error:",
				expect.objectContaining({ message: '{"detail":"invalid key [REDACTED]"}' }),
			)
			expect(loggedText(consoleErrorSpy)).not.toContain("secret-key")
		} finally {
			consoleErrorSpy.mockRestore()
		}
	})

	it("redacts the API key from non-Error rejections and their log line", async () => {
		const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		try {
			mockCreate.mockRejectedValue("upstream rejected secret-key")
			const handler = new IOIntelligenceHandler({
				ioIntelligenceApiKey: "secret-key",
				ioIntelligenceModelId: "meta-llama/Llama-3.3-70B-Instruct",
			})
			await expect(collectStream(handler.createMessage("sys", messages))).rejects.toMatchObject({
				message: "IO Intelligence streaming error: upstream rejected [REDACTED]",
			})
			expect(consoleErrorSpy).toHaveBeenCalledWith(
				"[IO Intelligence] Non-Error exception:",
				"upstream rejected [REDACTED]",
			)
			expect(loggedText(consoleErrorSpy)).not.toContain("secret-key")
		} finally {
			consoleErrorSpy.mockRestore()
		}
	})

	it("completePrompt wraps upstream errors without a configured key", async () => {
		const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		try {
			mockCreate.mockRejectedValue(new Error("boom"))
			const handler = new IOIntelligenceHandler({ ioIntelligenceModelId: "meta-llama/Llama-3.3-70B-Instruct" })
			await expect(handler.completePrompt("ping")).rejects.toMatchObject({
				message: "IO Intelligence completion error: boom",
			})
		} finally {
			consoleErrorSpy.mockRestore()
		}
	})

	it("completePrompt without options forwards no request options", async () => {
		mockCreate.mockResolvedValue({
			choices: [{ message: { role: "assistant", content: "ok" } }],
		})
		const handler = new IOIntelligenceHandler({ ioIntelligenceModelId: "meta-llama/Llama-3.3-70B-Instruct" })
		expect(await handler.completePrompt("ping")).toBe("ok")
		// The OpenAI SDK rejects a present-but-undefined `timeout` key, so a bare
		// call must not pass request options at all.
		expect(mockCreate.mock.calls[0][1]).toBeUndefined()
	})

	it("completePrompt forwards abort and timeout options when provided", async () => {
		mockCreate.mockResolvedValue({
			choices: [{ message: { role: "assistant", content: "ok" } }],
		})
		const signal = new AbortController().signal
		const handler = new IOIntelligenceHandler({ ioIntelligenceModelId: "meta-llama/Llama-3.3-70B-Instruct" })
		await handler.completePrompt("ping", { abortSignal: signal, timeoutMs: 5_000 })
		expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ stream: false }), { signal, timeout: 5_000 })
	})

	it("completePrompt forwards the configured temperature", async () => {
		mockCreate.mockResolvedValue({
			choices: [{ message: { role: "assistant", content: "ok" } }],
		})
		const handler = new IOIntelligenceHandler({
			ioIntelligenceModelId: "meta-llama/Llama-3.3-70B-Instruct",
			modelTemperature: 0.7,
		})
		expect(await handler.completePrompt("ping")).toBe("ok")
		expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ stream: false, temperature: 0.7 }), undefined)
	})
})
