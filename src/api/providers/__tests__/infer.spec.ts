vi.mock("vscode", () => ({
	workspace: { getConfiguration: () => ({ get: (_key: string, defaultValue?: unknown) => defaultValue }) },
}))

import { Anthropic } from "@anthropic-ai/sdk"
import OpenAI from "openai"

import { INFER_BASE_URL, inferDefaultModelId, providerIdentifiers } from "@roo-code/types"

import { buildApiHandler } from "../../index"
import { prepareApiConversationMessage } from "../../../core/task/apiConversationHistory"
import { asyncStreamFrom, collectStream } from "../../../test-utils/stream"
import { clearAllMocks } from "../../../test-utils/reset"
import { InferHandler } from "../infer"
import { getModels } from "../fetchers/modelCache"

const MODEL_ID = "infer/test-model:low-cost"
const MODEL_INFO = { maxTokens: 128_000, contextWindow: 1_000_000, supportsImages: false, supportsPromptCache: true }

vi.mock("openai")
vi.mock("../fetchers/modelCache", () => ({
	getModels: vi.fn(),
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

describe("InferHandler", () => {
	beforeEach(() => {
		clearAllMocks()
		vi.mocked(getModels).mockResolvedValue({ [MODEL_ID]: MODEL_INFO })
		mockCreate.mockResolvedValue(asyncStreamFrom([]))
	})

	it("is constructed by the backend provider registry", () => {
		expect(buildApiHandler({ apiProvider: providerIdentifiers.infer })).toBeInstanceOf(InferHandler)
	})

	it("sends requests to the fixed Infer endpoint with the configured key", () => {
		new InferHandler({ inferApiKey: "test-key" })
		expect(vi.mocked(OpenAI)).toHaveBeenCalledWith(
			expect.objectContaining({ baseURL: INFER_BASE_URL, apiKey: "test-key" }),
		)
	})

	it("resolves the default model when none is configured", async () => {
		const handler = new InferHandler({})
		await collectStream(handler.createMessage("system", messages))
		expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ model: inferDefaultModelId }), {
			signal: undefined,
		})
	})

	it("uses the configured route selector and streams text, reasoning, and tool calls", async () => {
		mockCreate.mockResolvedValue(
			asyncStreamFrom([
				{ choices: [{ delta: { role: "assistant", content: "" } }] },
				{ choices: [{ delta: { reasoning: "thinking" } }] },
				{ choices: [{ delta: { content: "answer" } }] },
				{
					choices: [
						{
							delta: {
								tool_calls: [
									{
										index: 0,
										id: "call-1",
										type: "function",
										function: { name: "read_file", arguments: "" },
									},
								],
							},
						},
					],
				},
				{ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] } }] },
			]),
		)
		const chunks = await collectStream(new InferHandler({ inferModelId: MODEL_ID }).createMessage("sys", messages))
		expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ model: MODEL_ID }), { signal: undefined })
		expect(chunks).toEqual([
			{ type: "reasoning", text: "thinking" },
			{ type: "text", text: "answer" },
			{ type: "tool_call_partial", index: 0, id: "call-1", name: "read_file", arguments: "" },
			{ type: "tool_call_partial", index: 0, id: undefined, name: undefined, arguments: '{"path":' },
		])
	})

	it("forwards native tools, usage streaming, session affinity, and cancellation without an output cap", async () => {
		const signal = new AbortController().signal
		const tools: OpenAI.Chat.ChatCompletionTool[] = [
			{ type: "function", function: { name: "read_file", description: "Read", parameters: { type: "object" } } },
		]
		const handler = new InferHandler({ inferModelId: MODEL_ID, modelTemperature: 0.7 })
		await collectStream(
			handler.createMessage("sys", messages, {
				taskId: "task-1",
				tools,
				tool_choice: "required",
				parallelToolCalls: false,
				abortSignal: signal,
			}),
		)
		expect(mockCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				model: MODEL_ID,
				messages: [
					{ role: "system", content: "sys" },
					{ role: "user", content: "Hello" },
				],
				stream: true,
				stream_options: { include_usage: true },
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
			{ signal, headers: { "X-Session-Affinity": "task-1" } },
		)
		// Infer holds the cost of the output cap before the request, so no cap is sent.
		expect(mockCreate.mock.calls[0][0]).not.toHaveProperty("max_tokens")
		expect(mockCreate.mock.calls[0][0]).not.toHaveProperty("max_completion_tokens")
	})

	it("maps usage, cache writes, and the settled charge from the final chunk", async () => {
		mockCreate.mockResolvedValue(
			asyncStreamFrom([
				{ choices: [{ delta: {}, finish_reason: "stop" }], relay: { customer_cost_usd: 0.0042 } },
				{
					choices: [],
					usage: {
						prompt_tokens: 1000,
						completion_tokens: 50,
						prompt_tokens_details: { cached_tokens: 600, cache_write_tokens: 300 },
					},
					relay: { customer_cost_usd: 0.0042 },
				},
			]),
		)
		expect(
			await collectStream(new InferHandler({ inferModelId: MODEL_ID }).createMessage("sys", messages)),
		).toEqual([
			{
				type: "usage",
				inputTokens: 1000,
				outputTokens: 50,
				cacheReadTokens: 600,
				cacheWriteTokens: 300,
				totalCost: 0.0042,
			},
		])
	})

	it("preserves zero cache counts and omits the charge when the chunk has none", async () => {
		mockCreate.mockResolvedValue(
			asyncStreamFrom([
				{
					choices: [],
					usage: {
						prompt_tokens: 20,
						completion_tokens: 10,
						prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
					},
				},
			]),
		)
		expect(
			await collectStream(new InferHandler({ inferModelId: MODEL_ID }).createMessage("sys", messages)),
		).toEqual([{ type: "usage", inputTokens: 20, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 }])
	})

	it.each(["0.0042", Number.POSITIVE_INFINITY, null])(
		"does not report a charge that is not a finite number (%s)",
		async (charge) => {
			mockCreate.mockResolvedValue(
				asyncStreamFrom([
					{
						choices: [],
						usage: { prompt_tokens: 20, completion_tokens: 10 },
						relay: { customer_cost_usd: charge },
					},
				]),
			)
			const [usage] = await collectStream(
				new InferHandler({ inferModelId: MODEL_ID }).createMessage("sys", messages),
			)
			expect(usage).toEqual({ type: "usage", inputTokens: 20, outputTokens: 10 })
			expect(usage).not.toHaveProperty("totalCost")
		},
	)

	it("redacts the API key from streaming errors and from the logged error", async () => {
		const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		try {
			mockCreate.mockRejectedValue(new Error("upstream rejected secret-key"))
			const handler = new InferHandler({ inferApiKey: "secret-key", inferModelId: MODEL_ID })
			await expect(collectStream(handler.createMessage("sys", messages))).rejects.toMatchObject({
				message: "Infer streaming error: upstream rejected [REDACTED]",
			})
			// The error handler logs message + stack before the transformer runs,
			// so the key must already be gone from both.
			expect(consoleErrorSpy).toHaveBeenCalledWith(
				"[Infer] API error:",
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

	it("serializes and redacts an object-valued raw error body and keeps the status", async () => {
		const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		try {
			mockCreate.mockRejectedValue(
				Object.assign(new Error("Request failed"), {
					status: 402,
					error: { metadata: { raw: { detail: "insufficient credits for secret-key" } } },
				}),
			)
			const handler = new InferHandler({ inferApiKey: "secret-key", inferModelId: MODEL_ID })
			await expect(collectStream(handler.createMessage("sys", messages))).rejects.toMatchObject({
				message: 'Infer streaming error: {"detail":"insufficient credits for [REDACTED]"}',
				status: 402,
			})
			expect(loggedText(consoleErrorSpy)).not.toContain("secret-key")
		} finally {
			consoleErrorSpy.mockRestore()
		}
	})

	it("redacts the API key from non-Error rejections and their log line", async () => {
		const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		try {
			mockCreate.mockRejectedValue("upstream rejected secret-key")
			const handler = new InferHandler({ inferApiKey: "secret-key", inferModelId: MODEL_ID })
			await expect(collectStream(handler.createMessage("sys", messages))).rejects.toMatchObject({
				message: "Infer streaming error: upstream rejected [REDACTED]",
			})
			expect(consoleErrorSpy).toHaveBeenCalledWith("[Infer] Non-Error exception:", "upstream rejected [REDACTED]")
			expect(loggedText(consoleErrorSpy)).not.toContain("secret-key")
		} finally {
			consoleErrorSpy.mockRestore()
		}
	})

	it("completePrompt wraps upstream errors without a configured key", async () => {
		const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		try {
			mockCreate.mockRejectedValue(new Error("boom"))
			const handler = new InferHandler({ inferModelId: MODEL_ID })
			await expect(handler.completePrompt("ping")).rejects.toMatchObject({
				message: "Infer completion error: boom",
			})
		} finally {
			consoleErrorSpy.mockRestore()
		}
	})

	it("completePrompt sends the prompt as a single user message without an output cap", async () => {
		mockCreate.mockResolvedValue({ choices: [{ message: { role: "assistant", content: "ok" } }] })
		const handler = new InferHandler({ inferModelId: MODEL_ID })
		expect(await handler.completePrompt("ping")).toBe("ok")
		// A bare call passes no request options: the OpenAI SDK rejects a present-but-undefined `timeout`.
		expect(mockCreate).toHaveBeenCalledWith(
			{ model: MODEL_ID, messages: [{ role: "user", content: "ping" }], stream: false },
			undefined,
		)
	})

	it("completePrompt returns an empty string when the response has no choices", async () => {
		mockCreate.mockResolvedValue({ choices: [] })
		const handler = new InferHandler({ inferModelId: MODEL_ID })
		expect(await handler.completePrompt("ping")).toBe("")
	})

	it("completePrompt forwards abort and timeout options when provided", async () => {
		mockCreate.mockResolvedValue({ choices: [{ message: { role: "assistant", content: "ok" } }] })
		const signal = new AbortController().signal
		const handler = new InferHandler({ inferModelId: MODEL_ID })
		await handler.completePrompt("ping", { abortSignal: signal, timeoutMs: 5_000 })
		expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ stream: false }), { signal, timeout: 5_000 })
	})

	it.each([0, -5, Number.NaN, Number.POSITIVE_INFINITY])(
		"completePrompt does not forward an unusable timeoutMs (%s)",
		async (timeoutMs) => {
			mockCreate.mockResolvedValue({ choices: [{ message: { role: "assistant", content: "ok" } }] })
			const handler = new InferHandler({ inferModelId: MODEL_ID })
			await handler.completePrompt("ping", { timeoutMs })
			expect(mockCreate.mock.calls[0][1]).toBeUndefined()
		},
	)

	it("does not send the OpenAI Compatible custom headers to the fixed endpoint", () => {
		new InferHandler({ inferApiKey: "test-key", openAiHeaders: { "X-Custom-Header": "leaked" } })
		expect(vi.mocked(OpenAI)).toHaveBeenCalledTimes(1)
		const clientOptions = vi.mocked(OpenAI).mock.calls[0][0]
		expect(clientOptions?.defaultHeaders).not.toHaveProperty("X-Custom-Header")
	})

	it("omits a cleared (null) temperature in both request paths", async () => {
		const handler = new InferHandler({ inferModelId: MODEL_ID, modelTemperature: null })

		await collectStream(handler.createMessage("system", messages))
		expect(mockCreate.mock.calls[0][0]).not.toHaveProperty("temperature")

		mockCreate.mockClear()
		mockCreate.mockResolvedValue({ choices: [{ message: { role: "assistant", content: "ok" } }] })
		expect(await handler.completePrompt("ping")).toBe("ok")
		expect(mockCreate.mock.calls[0][0]).not.toHaveProperty("temperature")
	})

	it("completePrompt forwards the configured temperature", async () => {
		mockCreate.mockResolvedValue({ choices: [{ message: { role: "assistant", content: "ok" } }] })
		const handler = new InferHandler({ inferModelId: MODEL_ID, modelTemperature: 0.7 })
		expect(await handler.completePrompt("ping")).toBe("ok")
		expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ stream: false, temperature: 0.7 }), undefined)
	})

	it.each(["reasoning_effort", "reasoning", "thinking", "include_reasoning"])(
		"sends no %s parameter, even when the profile turns reasoning on",
		async (field) => {
			// Zoo Code cannot send a model's reasoning back to Infer on the next turn, so the
			// handler never asks a model to reason, whatever the profile or the model info says.
			vi.mocked(getModels).mockResolvedValue({
				[MODEL_ID]: {
					...MODEL_INFO,
					supportsReasoningEffort: true,
					reasoningEffort: "high",
					supportsReasoningBudget: true,
				},
			})
			const handler = new InferHandler({
				inferModelId: MODEL_ID,
				enableReasoningEffort: true,
				reasoningEffort: "high",
				modelMaxThinkingTokens: 8_192,
			})

			await collectStream(handler.createMessage("sys", messages))
			mockCreate.mockResolvedValue({ choices: [{ message: { role: "assistant", content: "ok" } }] })
			await handler.completePrompt("ping")

			expect(mockCreate).toHaveBeenCalledTimes(2)
			expect(mockCreate.mock.calls[0][0]).not.toHaveProperty(field)
			expect(mockCreate.mock.calls[1][0]).not.toHaveProperty(field)
		},
	)

	it("keeps no reasoning state for the next turn", () => {
		// Zoo Code sends reasoning_details back only when the handler returned them. The streamed
		// reply has reasoning text only, so the stored assistant turn carries none.
		const stored = prepareApiConversationMessage({
			message: { role: "assistant", content: [{ type: "text", text: "answer" }] },
			reasoning: "thinking",
			api: new InferHandler({ inferModelId: MODEL_ID }),
			apiConfiguration: { apiProvider: providerIdentifiers.infer, inferModelId: MODEL_ID },
			apiConversationHistory: [],
		})

		expect(stored).not.toHaveProperty("reasoning_details")
	})
})
