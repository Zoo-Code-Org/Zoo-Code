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
import { MAX_TIMEOUT_MS } from "../utils/abort-signal"
import { ApiHandlerOptions } from "../../../shared/api"
import { Package } from "../../../shared/package"
import { asyncStreamFrom, collectStream } from "../../../test-utils/stream"
import { clearAllMocks } from "../../../test-utils/reset"
import { makeCreateMessageMetadata } from "../../../test-utils/api"

// The automocked openai module swaps the SDK's error classes for mock constructors, which are not
// Error instances, so only the actual module's class can exercise the name/message arms of the
// provider's abort classification.
async function sdkAbortError(): Promise<Error> {
	const { APIUserAbortError } = await vi.importActual<typeof import("openai")>("openai")
	return new APIUserAbortError()
}

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
			// Responses-format models (Zoo-Code-Org/Zoo-Code#1431 and issue #1979).
			"gpt-5.6-luna": { ...opencodeGoModels["gpt-5.6-luna"] },
			"gpt-6-luna": { ...opencodeGoModels["gpt-6-luna"] },
			"grok-4.6": { ...opencodeGoModels["grok-4.6"] },
			"muse-spark-1.3-contributor": { ...opencodeGoModels["muse-spark-1.3-contributor"] },
			"muse-spark-1.2-contributor": { ...opencodeGoModels["muse-spark-1.2-contributor"] },
		})
	}),
	refreshModels: vitest.fn().mockImplementation(function () {
		return Promise.resolve({
			"glm-5.1": { ...opencodeGoModels["glm-5.1"] },
			"qwen3.7-max": { ...opencodeGoModels["qwen3.7-max"] },
			"gpt-5.6-luna": { ...opencodeGoModels["gpt-5.6-luna"] },
			"gpt-6-luna": { ...opencodeGoModels["gpt-6-luna"] },
			"grok-4.6": { ...opencodeGoModels["grok-4.6"] },
			"muse-spark-1.3-contributor": { ...opencodeGoModels["muse-spark-1.3-contributor"] },
			"muse-spark-1.2-contributor": { ...opencodeGoModels["muse-spark-1.2-contributor"] },
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
				defaultHeaders: expect.objectContaining({ "User-Agent": `ZooCode/${Package.version}` }),
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
				defaultHeaders: expect.objectContaining({ "User-Agent": `ZooCode/${Package.version}` }),
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

		it("sends the stable conversation ID to chat completions", async () => {
			const handler = new OpencodeGoHandler(mockOptions)
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Hi" }]

			await collectStream(handler.createMessage("sys", messages, { taskId: "conversation-123" }))

			expect(mockCreate.mock.calls[0][1]?.headers).toMatchObject({
				"x-opencode-session": "conversation-123",
			})
		})

		it("falls back to a stable per-instance session ID when no taskId is provided", async () => {
			const handler = new OpencodeGoHandler(mockOptions)
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Hi" }]

			await collectStream(handler.createMessage("sys", messages))

			const sessionId = mockCreate.mock.calls[0][1]?.headers["x-opencode-session"]
			expect(sessionId).toEqual(expect.any(String))

			// The same handler instance reuses its session ID across requests.
			await collectStream(handler.createMessage("sys", messages))
			expect(mockCreate.mock.calls[1][1]?.headers["x-opencode-session"]).toBe(sessionId)
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

		it("merges post-tool-result text into the tool message for preserveReasoning models", async () => {
			// convertToR1Format with mergeToolResultText folds text that follows
			// tool_results into the last tool message (interleaved-thinking
			// support) instead of opening a new user message; assert the merged
			// wire shape so the preserveReasoning conversion branch and its
			// mergeToolResultText flag stay kill-tested.
			const handler = new OpencodeGoHandler(mockOptions)
			const messages: Anthropic.Messages.MessageParam[] = [
				{ role: "user", content: "Hi" },
				{
					role: "assistant",
					content: [
						{ type: "text", text: "let me check" },
						{ type: "tool_use", id: "tu_1", name: "read_file", input: { path: "/tmp/x" } },
					],
				},
				{
					role: "user",
					content: [
						{ type: "tool_result", tool_use_id: "tu_1", content: "file-contents" },
						{ type: "text", text: "and here is more context" },
					],
				},
			]

			await collectStream(handler.createMessage("sys", messages))

			const callArgs = mockCreate.mock.calls[0][0] as {
				messages: Array<{ role: string; content?: unknown }>
			}
			const bodyMessages = callArgs.messages
			const toolIndex = bodyMessages.findIndex((m) => m.role === "tool")
			expect(bodyMessages[toolIndex]?.content).toBe("file-contents\n\nand here is more context")
			// No user message may follow the tool message: the trailing text
			// merged into the tool message instead of opening a new user turn.
			expect(bodyMessages.slice(toolIndex + 1).some((m) => m.role === "user")).toBe(false)
		})

		it("keeps post-tool-result text unmerged for non-preserveReasoning models", async () => {
			// The plain OpenAI converter (non-preserveReasoning models) does not
			// merge post-tool-result text into the tool message: the text stays
			// a separate user message. Pin the plain shape so the always-R1
			// direction of the conversion branch stays kill-tested.
			vitest.mocked(getModels).mockImplementationOnce(async () => ({
				"kimi-k2.6": { ...opencodeGoModels["kimi-k2.6"] },
			}))

			const handler = new OpencodeGoHandler({ ...mockOptions, opencodeGoModelId: "kimi-k2.6" })
			const messages: Anthropic.Messages.MessageParam[] = [
				{ role: "user", content: "Hi" },
				{
					role: "assistant",
					content: [
						{ type: "text", text: "let me check" },
						{ type: "tool_use", id: "tu_1", name: "read_file", input: { path: "/tmp/x" } },
					],
				},
				{
					role: "user",
					content: [
						{ type: "tool_result", tool_use_id: "tu_1", content: "file-contents" },
						{ type: "text", text: "and here is more context" },
					],
				},
			]

			await collectStream(handler.createMessage("sys", messages))

			const callArgs = mockCreate.mock.calls[0][0] as {
				messages: Array<{ role: string; content?: unknown }>
			}
			const bodyMessages = callArgs.messages
			const toolIndex = bodyMessages.findIndex((m) => m.role === "tool")
			// Unmerged: the tool message keeps only the tool result content.
			expect(bodyMessages[toolIndex]?.content).toBe("file-contents")
			// ...and the trailing text stays its own user message (array
			// content, the plain converter's shape).
			const trailingUser = bodyMessages.slice(toolIndex + 1).find((m) => m.role === "user")
			expect(trailingUser?.content).toEqual([{ type: "text", text: "and here is more context" }])
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

		it("preserves reasoning across a tool-call continuation for MiMo V2.6 Flash", async () => {
			// Xiaomi's deep-thinking guide requires the reasoning from the assistant
			// turn to be passed back on the tool-call continuation. MiMo V2.6 must
			// therefore convert through convertToR1Format (preserveReasoning) and
			// keep the reasoning -> tool_call -> tool_result history intact.
			vitest.mocked(getModels).mockImplementationOnce(async () => ({
				"mimo-v2.6-flash": { ...opencodeGoModels["mimo-v2.6-flash"] },
			}))
			mockCreate.mockImplementationOnce(async () =>
				asyncStreamFrom([
					{ choices: [{ delta: { content: "Done" }, index: 0 }] },
					{
						choices: [{ delta: {}, index: 0 }],
						usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
					},
				]),
			)

			const handler = new OpencodeGoHandler({ ...mockOptions, opencodeGoModelId: "mimo-v2.6-flash" })
			const messages: Anthropic.Messages.MessageParam[] = [
				{ role: "user", content: "Read the config file" },
				{
					role: "assistant",
					content: [
						{ type: "text", text: "I will read it." },
						{ type: "tool_use", id: "call_mimo_1", name: "read_file", input: { path: "config.json" } },
					],
					reasoning_content: "The user wants the config contents.",
				} as Anthropic.Messages.MessageParam,
				{
					role: "user",
					content: [
						{ type: "tool_result", tool_use_id: "call_mimo_1", content: '{"a":1}' },
						{ type: "text", text: "<environment_details>cwd: /repo</environment_details>" },
					],
				},
			]

			await collectStream(handler.createMessage("sys", messages))

			const callArgs = mockCreate.mock.calls[0][0] as {
				model: string
				messages: Array<Record<string, unknown>>
			}
			expect(callArgs.model).toBe("mimo-v2.6-flash")

			// Index 0 is the system prompt; the converted history follows it.
			expect(callArgs.messages[0]).toEqual({ role: "system", content: "sys" })
			const [, userMessage, assistantMessage, toolMessage] = callArgs.messages
			expect(userMessage).toEqual({ role: "user", content: "Read the config file" })
			// The assistant turn keeps both its reasoning and its tool call.
			expect(assistantMessage).toMatchObject({
				role: "assistant",
				reasoning_content: "The user wants the config contents.",
			})
			expect(assistantMessage.tool_calls).toEqual([
				{
					id: "call_mimo_1",
					type: "function",
					function: { name: "read_file", arguments: '{"path":"config.json"}' },
				},
			])
			// The tool result follows as a tool message, with the trailing
			// environment details merged in so no user turn drops the reasoning.
			expect(toolMessage).toEqual({
				role: "tool",
				tool_call_id: "call_mimo_1",
				content: '{"a":1}\n\n<environment_details>cwd: /repo</environment_details>',
			})
			expect(callArgs.messages.filter((message) => message.role === "user")).toHaveLength(1)
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

		it("sends the unclamped modelMaxTokens override when it exceeds the model ceiling", async () => {
			// getModelMaxOutputTokens clamps the slider override to the model
			// ceiling for supportsMaxTokens models (glm-5.1 reports
			// supportsMaxTokens), but the OpenAI branch sends the raw override
			// (modelMaxTokens || maxTokens): with a ceiling-bounded override the
			// wire value is the unclamped override. Pin that so the
			// includeMaxTokens branch stays kill-tested.
			vitest.mocked(getModels).mockImplementationOnce(async () => ({
				"glm-5.1": { ...opencodeGoModels["glm-5.1"], maxTokens: 500 },
			}))

			const handler = new OpencodeGoHandler({ ...mockOptions, includeMaxTokens: true, modelMaxTokens: 999 })
			await collectStream(handler.createMessage("sys", [{ role: "user", content: "Hi" }]))

			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({ max_completion_tokens: 999 }),
				expect.objectContaining({ signal: expect.any(AbortSignal) }),
			)
		})

		it("sends the clamped maxTokens when includeMaxTokens is off", async () => {
			// With the flag off the body uses the resolved maxTokens, which the
			// shared getModelMaxOutputTokens already clamps to the model ceiling
			// for supportsMaxTokens models.
			vitest.mocked(getModels).mockImplementationOnce(async () => ({
				"glm-5.1": { ...opencodeGoModels["glm-5.1"], maxTokens: 500 },
			}))

			const handler = new OpencodeGoHandler({ ...mockOptions, modelMaxTokens: 999 })
			await collectStream(handler.createMessage("sys", [{ role: "user", content: "Hi" }]))

			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({ max_completion_tokens: 500 }),
				expect.objectContaining({ signal: expect.any(AbortSignal) }),
			)
		})

		it("defaults parallel_tool_calls to true and honors an explicit false", async () => {
			// The OpenAI branch defaults parallel_tool_calls to true when the
			// metadata omits it and forwards an explicit false unchanged; pin
			// both so the nullish default stays kill-tested (the Responses
			// branch has its own assertions).
			const handler = new OpencodeGoHandler(mockOptions)

			await collectStream(handler.createMessage("sys", [{ role: "user", content: "Hi" }]))
			expect(mockCreate.mock.calls[0][0]).toEqual(expect.objectContaining({ parallel_tool_calls: true }))

			await collectStream(
				handler.createMessage(
					"sys",
					[{ role: "user", content: "Hi" }],
					makeCreateMessageMetadata({ parallelToolCalls: false }),
				),
			)
			expect(mockCreate.mock.calls[1][0]).toEqual(expect.objectContaining({ parallel_tool_calls: false }))
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

		it("skips empty choices, empty deltas and tool calls without a function field", async () => {
			// Full-list assertions: a frame without choices[0], a delta without
			// content/tool_calls, and a tool call missing `function` must each
			// contribute nothing except the partial tool call with undefined
			// name/arguments (toEqual ignores undefined-valued keys).
			mockCreate.mockImplementationOnce(async () =>
				asyncStreamFrom([
					{ choices: [], index: 0 },
					{ choices: [{ delta: {}, index: 0 }], index: 0 },
					{
						choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1" }] }, index: 0 }],
						index: 0,
					},
					{
						choices: [{ delta: {}, index: 0 }],
						index: 0,
						usage: { prompt_tokens: 1, completion_tokens: 2 },
					},
				]),
			)

			const handler = new OpencodeGoHandler(mockOptions)
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "hi" }]

			const chunks = await collectStream(handler.createMessage("sys", messages))

			expect(chunks).toEqual([
				{ type: "tool_call_partial", index: 0, id: "call_1" },
				{ type: "usage", inputTokens: 1, outputTokens: 2 },
			])
		})

		it("emits the text delta and the usage chunk with cached tokens from the final frame", async () => {
			mockCreate.mockImplementationOnce(async () =>
				asyncStreamFrom([
					{ choices: [{ delta: { content: "hi" }, index: 0 }], index: 0 },
					{
						choices: [{ delta: {}, index: 0 }],
						index: 0,
						usage: {
							prompt_tokens: 4,
							completion_tokens: 9,
							prompt_tokens_details: { cached_tokens: 6 },
						},
					},
				]),
			)

			const handler = new OpencodeGoHandler(mockOptions)
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "hi" }]

			const chunks = await collectStream(handler.createMessage("sys", messages))

			expect(chunks).toEqual([
				{ type: "text", text: "hi" },
				{ type: "usage", inputTokens: 4, outputTokens: 9, cacheReadTokens: 6 },
			])
		})
	})

	describe("createMessage abort signal bridging", () => {
		it("rejects with an AbortError when the external signal is already aborted", async () => {
			// A pre-aborted request must fail fast before any model-catalog or
			// SDK work starts: the standardized AbortError wins over any
			// resolution failure, and the request itself never begins.
			let capturedSignal: AbortSignal | undefined
			mockCreate.mockImplementation(async (_params: unknown, options: { signal?: AbortSignal }) => {
				capturedSignal = options?.signal
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

			const error = await collectStream(stream).then(
				() => undefined,
				(e: unknown) => e,
			)
			// The fast-fail guard throws before the request starts.
			expect(mockCreate).not.toHaveBeenCalled()
			// Pre-flight cancellation must skip the model catalog entirely:
			// the getModels mock must remain uncalled, not just the SDK create.
			expect(vitest.mocked(getModels)).not.toHaveBeenCalled()
			expect(capturedSignal).toBeUndefined()
			expect(error).toMatchObject({ name: "AbortError" })
			expect((error as Error).message).toBe("The Opencode Go request was aborted")
		})

		it("rejects with the standardized AbortError when the external signal aborts while model resolution is pending", async () => {
			// The model catalog stays pending while the external signal aborts:
			// the resolution race must settle with the standardized AbortError
			// before the lookup is released, and the request itself must never
			// start. A bridge-only fix would let the lookup finish and abort the
			// internal controller after the fact; this gate proves the prompt
			// settles on the abort itself.
			let releaseResolution!: () => void
			const resolutionGate = new Promise<void>((resolve) => {
				releaseResolution = resolve
			})
			// The exact promise the provider awaits, so the test can await the lookup's own
			// settlement instead of guessing how long a parked lookup takes.
			let lookupPromise: Promise<Record<string, unknown>> | undefined
			vitest.mocked(getModels).mockImplementationOnce(() => {
				const parked = (async () => {
					await resolutionGate
					return { "glm-5.1": { ...opencodeGoModels["glm-5.1"] } }
				})()
				lookupPromise = parked
				return parked
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

			// Observable condition: the catalog lookup has been invoked and is parked on the
			// gate, which is what the 10 ms sleep was standing in for.
			await vitest.waitFor(() => expect(vitest.mocked(getModels)).toHaveBeenCalledTimes(1), {
				timeout: 1000,
				interval: 5,
			})
			controller.abort()

			const error = await consumed.then(
				() => undefined,
				(e: unknown) => e,
			)
			try {
				// The catalog lookup was attempted but the prompt must have settled
				// on the abort itself, before the lookup was released: no SDK call.
				expect(vitest.mocked(getModels)).toHaveBeenCalledTimes(1)
				// Deliberately not asserted here: until the finally below has awaited the provider's own
				// lookup promise, a request that starts late from a drained continuation could still be
				// missed. The claim is made once, after that drain.
				expect(error).toMatchObject({ name: "AbortError" })
				expect((error as Error).message).toBe("The Opencode Go request was aborted")
			} finally {
				// Release the parked lookup even when an assertion above threw: leaving the gate shut would
				// strand the very promise the provider awaited, which is the resource this test owns.
				releaseResolution()
				// Observable condition: the parked lookup has actually settled. Awaiting the same
				// promise the provider awaits drains the provider's continuation first, because the
				// provider subscribed to it before this test did; only then is "no late request" a
				// statement about drained state rather than about a 10 ms window.
				await lookupPromise
			}
			expect(mockCreate).not.toHaveBeenCalled()
		})

		it("aborts the request when the caller's signal fires after model resolution but before the bridge", async () => {
			// resolveModelWithAbort removes its listener when the lookup settles. An abort
			// landing in the window before createMessage installs its bridge is caught by
			// the already-aborted guard; without that guard the listener would be attached
			// after the event, the internal controller would stay live, and the request
			// could start without cancellation.
			const controller = new AbortController()
			const handler = new OpencodeGoHandler(mockOptions)
			// The resolution value's id getter fires the abort while createMessage reads
			// the resolved fields - exactly the post-resolution window.
			const resolved = {
				get id() {
					controller.abort()
					return "glm-5.1"
				},
				info: { ...opencodeGoModels["glm-5.1"] },
				format: "openai" as const,
				temperature: undefined,
				reasoningEffort: undefined,
				maxTokens: undefined,
			}
			vi.spyOn(handler as unknown as { resolveModel: () => Promise<unknown> }, "resolveModel").mockResolvedValue(
				resolved,
			)
			mockCreate.mockImplementation(async (_params: unknown, options?: { signal?: AbortSignal }) => {
				// The guard must have aborted the internal controller before the request.
				expect(options?.signal?.aborted).toBe(true)
				throw new APIUserAbortError()
			})

			const error = await collectStream(
				handler.createMessage(
					"sys",
					[{ role: "user", content: "hi" }],
					makeCreateMessageMetadata({ abortSignal: controller.signal }),
				),
			).then(
				() => undefined,
				(e: unknown) => e,
			)

			expect(error).toMatchObject({ name: "AbortError" })
			expect((error as Error).message).toBe("The Opencode Go request was aborted")
		})

		it("propagates a raw model-lookup failure unchanged when no abort signal is present", async () => {
			// Without an abort signal the resolution must not be wrapped or
			// normalized: a catalog failure keeps its own identity so callers
			// can distinguish a lookup failure from a cancellation.
			const lookupError = new Error("catalog offline")
			vitest.mocked(getModels).mockRejectedValueOnce(lookupError)

			const handler = new OpencodeGoHandler(mockOptions)

			const error = await collectStream(handler.createMessage("sys", [{ role: "user", content: "hi" }])).then(
				() => undefined,
				(e: unknown) => e,
			)
			expect(error).toBe(lookupError)
			expect(mockCreate).not.toHaveBeenCalled()
		})

		it("normalizes an abort-flavored model-lookup failure to the provider AbortError", async () => {
			// A lookup that fails with an AbortError-shaped error (e.g. the
			// catalog fetch itself was aborted) must settle with the provider's
			// standardized AbortError, not the raw error shape.
			const abortFlavored = new Error("The operation was aborted.")
			abortFlavored.name = "AbortError"
			vitest.mocked(getModels).mockRejectedValueOnce(abortFlavored)

			const handler = new OpencodeGoHandler(mockOptions)

			const error = await collectStream(handler.createMessage("sys", [{ role: "user", content: "hi" }])).then(
				() => undefined,
				(e: unknown) => e,
			)
			expect(error).not.toBe(abortFlavored)
			expect(error).toMatchObject({ name: "AbortError" })
			expect((error as Error).message).toBe("The Opencode Go request was aborted")
			expect(mockCreate).not.toHaveBeenCalled()
		})

		it("aborts the in-flight request when the external signal fires mid-stream", async () => {
			// The mock polls the INTERNAL controller signal instead of waiting
			// for an "abort" event: bounded polling means the test can never
			// hang if the bridge stops forwarding aborts, and it rejects as
			// soon as the bridge aborts the controller.
			let capturedSignal: AbortSignal | undefined
			let firstChunkDelivered = false
			mockCreate.mockImplementation(async (_params: unknown, options: { signal?: AbortSignal }) => {
				capturedSignal = options?.signal
				return (async function* () {
					yield { choices: [{ delta: { content: "partial" }, index: 0 }], index: 0 }
					// Runs only once the consumer has taken the first chunk and asked for the next
					// one, which is the state the 25 ms sleep was approximating.
					firstChunkDelivered = true
					// Observable condition: the bridge aborted the internal controller. Polling it
					// means a bridge that stops forwarding aborts fails on a printed condition
					// instead of quietly running the stream to its end.
					await vitest.waitFor(() => expect(capturedSignal?.aborted).toBe(true), {
						timeout: 1000,
						interval: 5,
					})
					throw new DOMException("The operation was aborted.", "AbortError")
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

			// Observable condition: the first chunk has been consumed and the stream is asking for
			// the next one; abort mid-stream from there rather than after a fixed 25 ms.
			await vitest.waitFor(() => expect(firstChunkDelivered).toBe(true), { timeout: 1000, interval: 5 })
			controller.abort()

			const error = await consumed.then(
				() => undefined,
				(e: unknown) => e,
			)
			expect(capturedSignal?.aborted).toBe(true)
			expect(error).toMatchObject({ name: "AbortError" })
			expect((error as Error).message).toBe("The Opencode Go request was aborted")
		})

		it("surfaces a cancel when the SDK closes the chat stream without throwing", async () => {
			// The OpenAI SDK swallows the body-read abort and can close the iterator normally instead
			// of throwing: the text already yielded must not be reported as a completed turn, and the
			// loop must not read the chunk it is handed after the cancel.
			let lateChunkReads = 0
			const abortedReader = {
				get choices() {
					lateChunkReads += 1
					return [{ delta: { content: "late" } }]
				},
				index: 0,
			}
			let requestedNextChunk = false
			const controller = new AbortController()
			mockCreate.mockImplementationOnce(async (_params: unknown, options: { signal?: AbortSignal }) => {
				const requestSignal = options?.signal
				return (async function* () {
					yield { choices: [{ delta: { content: "partial" } }], index: 0 }
					// Runs only once the provider has consumed the first chunk and asked for the next one.
					requestedNextChunk = true
					// Observable condition: the bridge aborted the request signal.
					await vitest.waitFor(() => expect(requestSignal?.aborted).toBe(true), {
						timeout: 1000,
						interval: 5,
					})
					// What the SDK hands back after swallowing the abort: a final chunk, no throw.
					yield abortedReader
				})()
			})
			const handler = new OpencodeGoHandler(mockOptions)
			const consumed = collectStream(
				handler.createMessage(
					"sys",
					[{ role: "user", content: "hi" }],
					makeCreateMessageMetadata({ abortSignal: controller.signal }),
				),
			)

			// Observable condition: the provider is parked on the next chunk; cancel from there.
			await vitest.waitFor(() => expect(requestedNextChunk).toBe(true), { timeout: 1000, interval: 5 })
			controller.abort()

			const error = await consumed.then(
				() => undefined,
				(e: unknown) => e,
			)
			expect(error).toMatchObject({ name: "AbortError" })
			expect((error as Error).message).toBe("The Opencode Go request was aborted")
			expect(lateChunkReads).toBe(0) // the loop left before reading the post-cancel chunk
		})

		it.each([
			[
				"Anthropic",
				() => new OpencodeGoHandler({ ...mockOptions, opencodeGoModelId: "qwen3.7-max" }),
				mockAnthropicCreate,
			],
			[
				"Responses",
				() => new OpencodeGoHandler({ ...mockOptions, opencodeGoModelId: "gpt-5.6-luna" }),
				mockResponsesCreate,
			],
			["Chat Completions", () => new OpencodeGoHandler(mockOptions), mockCreate],
		])(
			"settles the %s stream-open wait when the caller aborts during an SDK retry backoff",
			async (_label, makeHandler, createMock) => {
				// The pinned SDKs sleep out a Retry-After backoff inside the create call before they look at
				// the signal, so awaiting that promise alone leaves both the pending first next() and the
				// bridge cleanup waiting for the sleep to end; racing the open settles on the cancel instead.
				let requestSignal: AbortSignal | undefined
				createMock.mockImplementationOnce(
					(_params: unknown, options?: { signal?: AbortSignal }) =>
						new Promise<never>(() => {
							requestSignal = options?.signal
						}),
				)
				const handler = makeHandler() as OpencodeGoHandler
				const controller = new AbortController()

				const settled = collectStream(
					handler.createMessage(
						"sys",
						[{ role: "user", content: "hi" }],
						makeCreateMessageMetadata({ abortSignal: controller.signal }),
					),
				).then(
					() => undefined,
					(e: unknown) => e,
				)

				// Observable condition: the request really started, so the provider is parked on the open. The
				// rejection handler is attached before the poll, so a rejection during readiness is observed.
				await vitest.waitFor(() => expect(requestSignal).toBeInstanceOf(AbortSignal), {
					timeout: 1000,
					interval: 5,
				})
				controller.abort()

				const error = await settled
				expect(requestSignal?.aborted).toBe(true)
				expect(error).toMatchObject({ name: "AbortError" })
				expect((error as Error).message).toBe("The Opencode Go request was aborted")
			},
		)

		it("re-checks the signal before the buffered text item of a reasoning chunk", async () => {
			// One frame carries reasoning plus text. The consumer takes the reasoning item, cancels and
			// asks for the next one, which resumes this generator inside the same iteration: only a guard
			// in front of the buffered item can keep a cancelled turn's text from arriving, because the
			// top-of-loop guard already ran for this chunk.
			mockCreate.mockImplementationOnce(async () =>
				asyncStreamFrom([
					{
						choices: [{ delta: { reasoning_content: "think", content: "answer" }, index: 0 }],
						index: 0,
					},
				]),
			)
			const handler = new OpencodeGoHandler(mockOptions)
			const controller = new AbortController()
			const addEventListenerSpy = vi.spyOn(controller.signal, "addEventListener")
			const removeListenerSpy = vi.spyOn(controller.signal, "removeEventListener")

			const iterator = handler
				.createMessage(
					"sys",
					[{ role: "user", content: "hi" }],
					makeCreateMessageMetadata({ abortSignal: controller.signal }),
				)
				[Symbol.asyncIterator]()

			const first = await iterator.next()
			expect(first.value).toMatchObject({ type: "reasoning", text: "think" })
			// Observable condition: the consumer holds the reasoning item and cancels before pulling the
			// next one.
			controller.abort()

			const settled = await iterator.next().then(
				(result) => result.value,
				(error: unknown) => error,
			)
			expect(settled).toMatchObject({ name: "AbortError" })
			expect((settled as Error).message).toBe("The Opencode Go request was aborted")
			// The bridge is detached by reference on this path too: a cancelled turn must not leave a
			// listener behind on a task-scoped signal.
			const abortAdds = addEventListenerSpy.mock.calls.filter(([event]) => event === "abort")
			const bridgeListener = abortAdds[1]?.[1]
			expect(typeof bridgeListener).toBe("function")
			const removed = removeListenerSpy.mock.calls
				.filter(([event]) => event === "abort")
				.map(([, listener]) => listener)
			expect(removed).toContain(bridgeListener)
		})

		it("re-checks the signal between two tool-call items of one chunk", async () => {
			// Two tool calls arrive in a single delta. A consumer that takes the first partial and cancels
			// must not be handed the second one, so the guard belongs inside the per-item loop.
			mockCreate.mockImplementationOnce(async () =>
				asyncStreamFrom([
					{
						choices: [
							{
								delta: {
									tool_calls: [
										{ index: 0, id: "call-1", function: { name: "read_file", arguments: "{}" } },
										{ index: 1, id: "call-2", function: { name: "list_files", arguments: "{}" } },
									],
								},
								index: 0,
							},
						],
						index: 0,
					},
				]),
			)
			const handler = new OpencodeGoHandler(mockOptions)
			const controller = new AbortController()
			const iterator = handler
				.createMessage(
					"sys",
					[{ role: "user", content: "hi" }],
					makeCreateMessageMetadata({ abortSignal: controller.signal }),
				)
				[Symbol.asyncIterator]()

			const first = await iterator.next()
			expect(first.value).toMatchObject({ type: "tool_call_partial", id: "call-1" })
			controller.abort()

			const settled = await iterator.next().then(
				(result) => result.value,
				(error: unknown) => error,
			)
			expect(settled).toMatchObject({ name: "AbortError" })
			expect((settled as Error).message).toBe("The Opencode Go request was aborted")
		})

		it("re-checks the signal before the usage item of a content and usage chunk", async () => {
			// A cancel must not report usage for the turn it stopped. The usage item follows the text item
			// of the same frame, so only the guard in front of it keeps a cancelled turn's usage out of
			// the stream; without it the consumer is handed usage and then the abort.
			mockCreate.mockImplementationOnce(async () =>
				asyncStreamFrom([
					{
						choices: [{ delta: { content: "answer" }, index: 0 }],
						index: 0,
						usage: { prompt_tokens: 2, completion_tokens: 3 },
					},
				]),
			)
			const handler = new OpencodeGoHandler(mockOptions)
			const controller = new AbortController()
			const iterator = handler
				.createMessage(
					"sys",
					[{ role: "user", content: "hi" }],
					makeCreateMessageMetadata({ abortSignal: controller.signal }),
				)
				[Symbol.asyncIterator]()

			const first = await iterator.next()
			expect(first.value).toMatchObject({ type: "text", text: "answer" })
			controller.abort()

			const settled = await iterator.next().then(
				(result) => result.value,
				(error: unknown) => error,
			)
			expect(settled).toMatchObject({ name: "AbortError" })
			expect((settled as Error).message).toBe("The Opencode Go request was aborted")
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
			const addEventListenerSpy = vi.spyOn(controller.signal, "addEventListener")

			const stream = handler.createMessage(
				"sys",
				[{ role: "user", content: "hi" }],
				makeCreateMessageMetadata({ abortSignal: controller.signal }),
			)

			const chunks = await collectStream(stream)
			expect(chunks).toContainEqual({ type: "text", text: "ok" })
			// Assert the exact listener reference so a bridge that removes a
			// different callback than the one it registered cannot pass.
			// The model-resolution race registers its own "abort" listener on the same signal and detaches
			// it before the request starts, so there are exactly two registrations here and the bridge's is
			// the second one. Naming it by position — and requiring it to differ from the race's callback —
			// means a bridge that stopped registering its own listener cannot satisfy the assertions below
			// by falling back on the race's.
			const abortAddCalls = addEventListenerSpy.mock.calls.filter(([event]) => event === "abort")
			const abortRemoveCalls = removeListenerSpy.mock.calls
				.filter(([event]) => event === "abort")
				.map(([, listener]) => listener)
			expect(abortAddCalls.length).toBe(2)
			const [raceCall, bridgeCall] = abortAddCalls
			const addedListener = bridgeCall?.[1]
			expect(typeof addedListener).toBe("function")
			expect(addedListener).not.toBe(raceCall?.[1])
			// The listener is registered with { once: true } — assert the exact
			// options so a bridge that drops them (and relies on the finally
			// block alone for single-shot semantics) is caught.
			expect(addEventListenerSpy).toHaveBeenCalledWith("abort", addedListener, { once: true })
			// Both listeners are gone by reference: the lookup race's first (its cleanup ran before the
			// request), the bridge's last.
			expect(abortRemoveCalls).toEqual([raceCall?.[1], addedListener])
			expect(controller.signal.aborted).toBe(false)
		})

		it("detaches the bridged abort listener from the Anthropic-format path", async () => {
			// The Anthropic branch (streamAnthropicMessage) has its own finally
			// block that removes the bridged listener; assert explicit removal
			// after a normal (non-aborted) completion on that path too.
			mockAnthropicCreate.mockImplementationOnce(async () =>
				asyncStreamFrom([
					{ type: "message_start", message: { usage: { input_tokens: 1, output_tokens: 0 } } },
					{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
					{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
					{ type: "message_delta", usage: { output_tokens: 1 } },
					{ type: "message_stop" },
				]),
			)

			const handler = new OpencodeGoHandler({
				opencodeGoApiKey: "test-key",
				opencodeGoModelId: "qwen3.7-max",
			})
			const controller = new AbortController()
			const removeListenerSpy = vi.spyOn(controller.signal, "removeEventListener")
			const addEventListenerSpy = vi.spyOn(controller.signal, "addEventListener")

			const stream = handler.createMessage(
				"sys",
				[{ role: "user", content: "hi" }],
				makeCreateMessageMetadata({ abortSignal: controller.signal }),
			)

			const chunks = await collectStream(stream)
			expect(chunks).toContainEqual({ type: "text", text: "ok" })
			// The model-resolution race registers its own "abort" listener on the same signal and detaches
			// it before the request starts, so there are exactly two registrations here and the bridge's is
			// the second one. Naming it by position — and requiring it to differ from the race's callback —
			// means a bridge that stopped registering its own listener cannot satisfy the assertions below
			// by falling back on the race's.
			const abortAddCalls = addEventListenerSpy.mock.calls.filter(([event]) => event === "abort")
			const abortRemoveCalls = removeListenerSpy.mock.calls
				.filter(([event]) => event === "abort")
				.map(([, listener]) => listener)
			expect(abortAddCalls.length).toBe(2)
			const [raceCall, bridgeCall] = abortAddCalls
			const addedListener = bridgeCall?.[1]
			expect(typeof addedListener).toBe("function")
			expect(addedListener).not.toBe(raceCall?.[1])
			expect(addEventListenerSpy).toHaveBeenCalledWith("abort", addedListener, { once: true })
			// Both listeners are gone by reference: the lookup race's first (its cleanup ran before the
			// request), the bridge's last.
			expect(abortRemoveCalls).toEqual([raceCall?.[1], addedListener])
			expect(controller.signal.aborted).toBe(false)
		})

		it("detaches the bridged abort listener when the OpenAI message conversion fails", async () => {
			// The OpenAI branch converts messages and tools before the
			// request; the conversion must run inside the same cleanup scope
			// as the Anthropic and Responses branches so an unstringifiable
			// tool input does not leave the bridged listener attached.
			// A throwing value getter fails the conversion deterministically
			// without depending on cycle detection in sanitizeSurrogatesDeep.
			const failingInput: Record<string, unknown> = {
				get value(): never {
					throw new Error("unstringifiable tool input")
				},
			}

			const handler = new OpencodeGoHandler(mockOptions)
			const controller = new AbortController()
			const removeListenerSpy = vi.spyOn(controller.signal, "removeEventListener")
			const addEventListenerSpy = vi.spyOn(controller.signal, "addEventListener")

			const stream = handler.createMessage(
				"sys",
				[
					{ role: "user", content: "hi" },
					{
						role: "assistant",
						content: [{ type: "tool_use", id: "tu_1", name: "calc", input: failingInput }],
					},
				],
				makeCreateMessageMetadata({ abortSignal: controller.signal }),
			)

			const error = await collectStream(stream).then(
				() => undefined,
				(e: unknown) => e,
			)
			// The conversion failure propagates unchanged (the signal never
			// aborted) and the bridge listener is detached by reference.
			expect(error).toBeInstanceOf(Error)
			expect((error as Error).message).toMatch(/unstringifiable tool input/)
			// The same distinction as the other detach tests: two registrations on the caller's signal, the
			// second one the bridge's, and both detached by reference in that order.
			const abortAddCalls = addEventListenerSpy.mock.calls.filter(([event]) => event === "abort")
			const abortRemoveCalls = removeListenerSpy.mock.calls
				.filter(([event]) => event === "abort")
				.map(([, listener]) => listener)
			expect(abortAddCalls.length).toBe(2)
			const [raceCall, bridgeCall] = abortAddCalls
			const addedListener = bridgeCall?.[1]
			expect(typeof addedListener).toBe("function")
			expect(addedListener).not.toBe(raceCall?.[1])
			expect(abortRemoveCalls).toEqual([raceCall?.[1], addedListener])
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
				expect.objectContaining({
					headers: expect.objectContaining({ "x-opencode-session": expect.any(String) }),
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
			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({ max_completion_tokens: 4321 }),
				expect.objectContaining({
					headers: expect.objectContaining({ "x-opencode-session": expect.any(String) }),
				}),
			)
		})

		it("rejects with the standardized AbortError when the caller aborts while completePrompt is resolving the model", async () => {
			// completePrompt must scope model resolution like createMessage does:
			// a catalog lookup parked on a gate has to settle on the standardized
			// AbortError as soon as the caller's signal fires, without waiting for
			// the lookup to finish and without starting the completion request.
			let releaseResolution!: () => void
			const resolutionGate = new Promise<void>((resolve) => {
				releaseResolution = resolve
			})
			// The exact promise the provider awaits, so the test can await the lookup's own
			// settlement instead of guessing how long a parked lookup takes.
			let lookupPromise: Promise<Record<string, unknown>> | undefined
			vitest.mocked(getModels).mockImplementationOnce(() => {
				const parked = (async () => {
					await resolutionGate
					return { "glm-5.1": { ...opencodeGoModels["glm-5.1"] } }
				})()
				lookupPromise = parked
				return parked
			})

			const handler = new OpencodeGoHandler(mockOptions)
			const controller = new AbortController()

			const completion = handler.completePrompt("ping", { abortSignal: controller.signal })

			// Observable condition: the catalog lookup has been invoked and is parked on the
			// gate, which is what the 10 ms sleep was standing in for.
			await vitest.waitFor(() => expect(vitest.mocked(getModels)).toHaveBeenCalledTimes(1), {
				timeout: 1000,
				interval: 5,
			})
			controller.abort()

			await expect(completion).rejects.toMatchObject({
				name: "AbortError",
				message: "The Opencode Go request was aborted",
			})
			// Deliberately not asserted here: only after awaiting the provider's own lookup promise
			// below is 'no request started' a statement about drained state rather than about timing.
			expect(mockCreate).not.toHaveBeenCalled()

			// Observable condition: the parked lookup has actually settled. Awaiting the same
			// promise the provider awaits drains the provider's continuation first, because the
			// provider subscribed to it before this test did; only then is "no late request" a
			// statement about drained state rather than about a 10 ms window.
			releaseResolution()
			await lookupPromise
			expect(mockCreate).not.toHaveBeenCalled()
		})

		it("rejects with the AbortError before the model lookup when completePrompt gets a pre-aborted signal", async () => {
			const handler = new OpencodeGoHandler(mockOptions)
			const controller = new AbortController()
			controller.abort()

			await expect(handler.completePrompt("ping", { abortSignal: controller.signal })).rejects.toMatchObject({
				name: "AbortError",
				message: "The Opencode Go request was aborted",
			})
			// The catalog must be skipped entirely, not merely raced.
			expect(vitest.mocked(getModels)).not.toHaveBeenCalled()
			expect(mockCreate).not.toHaveBeenCalled()
		})

		it("sends the per-instance session ID on non-streaming completions", async () => {
			mockCreate.mockResolvedValue({ choices: [{ message: { content: "ok" } }] })
			const handler = new OpencodeGoHandler(mockOptions)

			await handler.completePrompt("ping")
			const sessionId = mockCreate.mock.calls[0][1]?.headers["x-opencode-session"]
			expect(sessionId).toEqual(expect.any(String))

			// completePrompt has no taskId metadata, so the per-instance ID is
			// reused across calls on the same handler.
			await handler.completePrompt("ping")
			expect(mockCreate.mock.calls[1][1]?.headers["x-opencode-session"]).toBe(sessionId)
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

		it("sends the stable conversation ID to the Anthropic messages endpoint", async () => {
			const handler = new OpencodeGoHandler(anthropicOptions)
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Hi" }]

			await collectStream(handler.createMessage("sys", messages, { taskId: "conversation-123" }))

			expect(mockAnthropicCreate.mock.calls[0][1]?.headers).toMatchObject({
				"x-opencode-session": "conversation-123",
			})
		})

		it("falls back to a stable per-instance session ID when no taskId is provided", async () => {
			const handler = new OpencodeGoHandler(anthropicOptions)
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Hi" }]

			await collectStream(handler.createMessage("sys", messages))

			const sessionId = mockAnthropicCreate.mock.calls[0][1]?.headers["x-opencode-session"]
			expect(sessionId).toEqual(expect.any(String))

			// The same handler instance reuses its session ID across requests.
			await collectStream(handler.createMessage("sys", messages))
			expect(mockAnthropicCreate.mock.calls[1][1]?.headers["x-opencode-session"]).toBe(sessionId)
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

		it("preserves abort identity when the Anthropic request rejects with a name-based AbortError", async () => {
			// No SDK abort class and no aborted signal: only the DOM-standard
			// name === "AbortError" check marks a cancelled pre-stream request.
			const rawAbort = Object.assign(new Error("raw"), { name: "AbortError" })
			mockAnthropicCreate.mockRejectedValueOnce(rawAbort)

			const handler = new OpencodeGoHandler(anthropicOptions)
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "hi" }]

			const error = await collectStream(handler.createMessage("sys", messages)).then(
				() => undefined,
				(e: unknown) => e,
			)
			expect(error).toMatchObject({ name: "AbortError" })
			expect((error as Error).message).toBe("The Opencode Go request was aborted")
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

		it("completePrompt falls back to the model max_tokens when includeMaxTokens is on but modelMaxTokens is unset", async () => {
			mockAnthropicCreate.mockResolvedValue({
				content: [{ type: "text", text: "ok" }],
			})

			const handler = new OpencodeGoHandler({ ...anthropicOptions, includeMaxTokens: true })
			await handler.completePrompt("ping")
			const callArgs = mockAnthropicCreate.mock.calls[0][0] as Record<string, unknown>
			// qwen3.7-max maxTokens (65_536) clamped to 20% of 1M context => 65_536.
			expect(callArgs.max_tokens).toBe(65_536)
		})

		it("completePrompt sends the per-instance session ID via the Anthropic client default headers", async () => {
			mockAnthropicCreate.mockResolvedValue({
				content: [{ type: "text", text: "ok" }],
			})

			const handler = new OpencodeGoHandler(anthropicOptions)
			await handler.completePrompt("ping")

			// completePrompt passes no per-request options; the session header
			// is a default header on the Anthropic client (streaming overrides
			// it with taskId when available).
			expect(mockAnthropicCreate.mock.calls[0][1]).toBeUndefined()
			expect(Anthropic).toHaveBeenCalledWith(
				expect.objectContaining({
					defaultHeaders: expect.objectContaining({ "x-opencode-session": expect.any(String) }),
				}),
			)
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
			// With no timeoutMs, mergeAbortSignalAndTimeout returns the caller's signal unchanged:
			// pin the identity so forwarding a freshly-wrapped signal (or dropping the caller's)
			// cannot pass.
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
				signal: expect.any(AbortSignal),
				timeout: 10000,
			})
		})

		it("completePrompt passes the timeout deadline signal and timeoutMs when no caller signal is provided", async () => {
			mockAnthropicCreate.mockResolvedValue({ content: [{ type: "text", text: "response" }] })
			const handler = new OpencodeGoHandler(anthropicOptions)
			await handler.completePrompt("ping", { timeoutMs: 5000 })
			// The per-request timeout now also bounds model resolution, so the merged deadline
			// signal is forwarded alongside the SDK timeout option.
			expect(mockAnthropicCreate).toHaveBeenCalledWith(expect.objectContaining({ model: expect.any(String) }), {
				signal: expect.any(AbortSignal),
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
		it("completePrompt omits the timeout option when timeoutMs is negative (Anthropic path)", async () => {
			// The disabled-timeout contract covers every non-positive value, not just 0.
			mockAnthropicCreate.mockResolvedValue({ content: [{ type: "text", text: "response" }] })
			const handler = new OpencodeGoHandler(anthropicOptions)
			await handler.completePrompt("ping", { timeoutMs: -1 })
			const call = mockAnthropicCreate.mock.calls[mockAnthropicCreate.mock.calls.length - 1]
			const requestOptions = call[1] as { timeout?: number } | undefined
			expect(Object.keys(requestOptions ?? {})).not.toContain("timeout")
		})

		it("completePrompt preserves abort identity when the caller aborts mid-request (Anthropic path)", async () => {
			// The abort has to land after the request starts. A pre-aborted signal is
			// caught by resolveModelWithAbort during model resolution, so the completion
			// catch in opencode-go.ts (the isRequestAborted branch) never runs and the
			// test would pass without exercising it. The mock rejects with a generic
			// Error rather than an abort-shaped one, exactly the shape the sibling
			// Responses test uses, so normalizing it proves the catch consults the
			// caller signal argument and not just the error name or message.
			mockAnthropicCreate.mockImplementation(
				(_params: unknown, options: { signal?: AbortSignal }) =>
					new Promise<never>((_resolve, reject) => {
						const signal = options?.signal
						if (!signal) {
							reject(new Error("the provider forwarded no request signal"))
							return
						}
						signal.addEventListener("abort", () => reject(new Error("boom")), { once: true })
					}),
			)
			const handler = new OpencodeGoHandler(anthropicOptions)
			const controller = new AbortController()
			const completion = handler.completePrompt("ping", { abortSignal: controller.signal })
			// Attach the rejection handler before polling: if the lookup or the SDK call rejects while this
			// test is still waiting for readiness, the rejection is already observed.
			const settled = completion.then(
				() => undefined,
				(e: unknown) => e,
			)

			await vitest.waitFor(() => expect(mockAnthropicCreate).toHaveBeenCalled())
			controller.abort()

			const error = await settled
			expect(error).toMatchObject({ name: "AbortError" })
			expect((error as Error).message).toBe("The Opencode Go request was aborted")
		})

		it("completePrompt surfaces request timeouts as an AbortError (Anthropic path)", async () => {
			// Emulate the Anthropic SDK: when the request timeout fires, the SDK
			// surfaces APIConnectionTimeoutError ("Request timed out.") once retries
			// are exhausted — verified against @anthropic-ai/sdk against a hung server.
			mockAnthropicCreate.mockImplementation(async (_params: unknown, options: { signal?: AbortSignal }) => {
				const requestSignal = options?.signal
				if (!requestSignal) {
					throw new Error("the provider forwarded no request signal")
				}
				// Observable condition: the deadline signal the provider shares with this request has
				// fired. The 50 ms sleep stood in for that same instant — the SDK's own timeout
				// budget and this deadline are the same number by design, so the signal is the only
				// witness that either leg of the race actually ran.
				await vitest.waitFor(() => expect(requestSignal.aborted).toBe(true), { timeout: 1000, interval: 5 })
				throw new AnthropicTimeoutError()
			})
			const handler = new OpencodeGoHandler(anthropicOptions)

			const error = await handler.completePrompt("ping", { timeoutMs: 50 }).then(
				() => undefined,
				(e: unknown) => e,
			)
			expect(error).toMatchObject({ name: "AbortError" })
			expect((error as Error).message).toBe("The Opencode Go request was aborted")
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

		it("completePrompt keeps the model max_tokens when includeMaxTokens is off (Anthropic path)", async () => {
			// includeMaxTokens unset: modelMaxTokens must NOT replace the model
			// default — only the explicit includeMaxTokens flag opts into the
			// user override.
			mockAnthropicCreate.mockResolvedValueOnce({ content: [{ type: "text", text: "ok" }] })
			const handler = new OpencodeGoHandler({ ...anthropicOptions, modelMaxTokens: 2048 })
			await handler.completePrompt("ping")
			expect(mockAnthropicCreate).toHaveBeenCalledWith(
				expect.objectContaining({ model: "qwen3.7-max", max_tokens: 65_536 }),
				undefined,
			)
		})

		it("completePrompt forwards an explicit model temperature (Anthropic path)", async () => {
			mockAnthropicCreate.mockResolvedValueOnce({ content: [{ type: "text", text: "ok" }] })
			const handler = new OpencodeGoHandler({ ...anthropicOptions, modelTemperature: 0.7 })
			await handler.completePrompt("ping")
			expect(mockAnthropicCreate).toHaveBeenCalledWith(
				expect.objectContaining({ model: "qwen3.7-max", temperature: 0.7 }),
				undefined,
			)
		})

		it("completePrompt settles a pre-aborted signal before the Anthropic request starts", async () => {
			// Model resolution runs inside the cancellation scope, so a signal
			// that is already aborted rejects before the Anthropic request is
			// built: the SDK must never be called.
			const controller = new AbortController()
			controller.abort()
			const handler = new OpencodeGoHandler(anthropicOptions)

			const error = await handler.completePrompt("ping", { abortSignal: controller.signal }).then(
				() => undefined,
				(e: unknown) => e,
			)
			expect(error).toMatchObject({ name: "AbortError" })
			expect((error as Error).message).toBe("The Opencode Go request was aborted")
			expect(mockAnthropicCreate).not.toHaveBeenCalled()
		})

		it("completePrompt preserves abort identity for a name-based AbortError rejection (Anthropic path)", async () => {
			// No aborted signal and no SDK abort class: only the DOM-standard
			// name === "AbortError" check marks a cancelled request.
			const rawAbort = Object.assign(new Error("raw"), { name: "AbortError" })
			mockAnthropicCreate.mockRejectedValueOnce(rawAbort)
			const handler = new OpencodeGoHandler(anthropicOptions)

			const error = await handler.completePrompt("ping").then(
				() => undefined,
				(e: unknown) => e,
			)
			expect(error).toMatchObject({ name: "AbortError" })
			expect((error as Error).message).toBe("The Opencode Go request was aborted")
		})

		describe("completePrompt (OpenAI path)", () => {
			const openaiOptions: ApiHandlerOptions = {
				opencodeGoApiKey: "test-key",
				// The handler reads opencodeGoModelId; apiModelId would be ignored silently and the whole
				// describe would run the glm-5.2 default while claiming glm-5.1.
				opencodeGoModelId: "glm-5.1", // OpenAI-format model
			}

			beforeEach(() => {
				clearAllMocks()
			})

			it("completePrompt returns text for OpenAI path", async () => {
				mockCreate.mockResolvedValueOnce({
					choices: [{ message: { content: "response" } }],
				})

				const handler = new OpencodeGoHandler(openaiOptions)
				expect(await handler.completePrompt("ping")).toBe("response")
				expect(mockCreate).toHaveBeenCalledWith(
					expect.objectContaining({ model: "glm-5.1", stream: false }),
					{ headers: { "x-opencode-session": expect.any(String) } }, // session header only: no signal/timeout
				)
			})

			it("completePrompt passes abort signal through to OpenAI client", async () => {
				mockCreate.mockResolvedValueOnce({
					choices: [{ message: { content: "response" } }],
				})
				const controller = new AbortController()
				const handler = new OpencodeGoHandler(openaiOptions)

				await handler.completePrompt("ping", { abortSignal: controller.signal })
				expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ model: "glm-5.1", stream: false }), {
					signal: expect.any(AbortSignal),
					headers: { "x-opencode-session": expect.any(String) },
				})
			})

			it("completePrompt passes both signal and timeoutMs through to OpenAI client", async () => {
				mockCreate.mockResolvedValueOnce({
					choices: [{ message: { content: "response" } }],
				})
				const controller = new AbortController()
				const handler = new OpencodeGoHandler(openaiOptions)

				await handler.completePrompt("ping", { abortSignal: controller.signal, timeoutMs: 10000 })
				expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ model: "glm-5.1", stream: false }), {
					signal: expect.any(AbortSignal),
					timeout: 10000,
					headers: { "x-opencode-session": expect.any(String) },
				})
			})

			it("completePrompt passes only timeoutMs when no signal is provided", async () => {
				mockCreate.mockResolvedValueOnce({
					choices: [{ message: { content: "response" } }],
				})
				const handler = new OpencodeGoHandler(openaiOptions)

				await handler.completePrompt("ping", { timeoutMs: 5000 })
				expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ model: "glm-5.1", stream: false }), {
					signal: expect.any(AbortSignal),
					timeout: 5000,
					headers: { "x-opencode-session": expect.any(String) },
				})
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
			it("completePrompt omits the timeout option when timeoutMs is negative (OpenAI path)", async () => {
				// The disabled-timeout contract covers every non-positive value, not just 0.
				mockCreate.mockResolvedValueOnce({
					choices: [{ message: { content: "response" } }],
				})
				const handler = new OpencodeGoHandler(openaiOptions)
				await handler.completePrompt("ping", { timeoutMs: -1 })
				const call = mockCreate.mock.calls[mockCreate.mock.calls.length - 1]
				const requestOptions = call[1] as { timeout?: number } | undefined
				expect(requestOptions).not.toHaveProperty("timeout")
			})

			it("completePrompt normalizes the OpenAI SDK's own abort rejection", async () => {
				// Delivered from the SDK mock with no caller signal: the pre-flight guard cannot fire,
				// so the mock really runs and its APIUserAbortError ("Request was aborted." — the
				// trailing period would fail task-level abort detection) is what the catch must normalize.
				mockCreate.mockImplementationOnce(async () => {
					throw await sdkAbortError()
				})
				const handler = new OpencodeGoHandler(openaiOptions)

				const error = await handler.completePrompt("ping").then(
					() => undefined,
					(e: unknown) => e,
				)
				expect(mockCreate).toHaveBeenCalledTimes(1) // the SDK call ran, not the fast-fail guard
				expect(error).toMatchObject({ name: "AbortError" })
				expect((error as Error).message).toBe("The Opencode Go request was aborted")
			})

			it("completePrompt surfaces request timeouts as an AbortError (OpenAI path)", async () => {
				// Emulate the OpenAI SDK: when the request timeout fires, the SDK
				// surfaces APIConnectionTimeoutError ("Request timed out.") once retries
				// are exhausted — verified against openai v5.23.2 against a hung server.
				mockCreate.mockImplementation(async (_params: unknown, options: { signal?: AbortSignal }) => {
					const requestSignal = options?.signal
					if (!requestSignal) {
						throw new Error("the provider forwarded no request signal")
					}
					// Observable condition: the deadline signal the provider shares with this request
					// has fired, the same instant the 50 ms sleep was standing in for.
					await vitest.waitFor(() => expect(requestSignal.aborted).toBe(true), { timeout: 1000, interval: 5 })
					throw new APIConnectionTimeoutError()
				})
				const handler = new OpencodeGoHandler(openaiOptions)

				const error = await handler.completePrompt("ping", { timeoutMs: 50 }).then(
					() => undefined,
					(e: unknown) => e,
				)
				expect(error).toMatchObject({ name: "AbortError" })
				expect((error as Error).message).toBe("The Opencode Go request was aborted")
			})

			it("completePrompt works without options (backward compatible, OpenAI path)", async () => {
				mockCreate.mockResolvedValueOnce({
					choices: [{ message: { content: "response" } }],
				})
				const handler = new OpencodeGoHandler(openaiOptions)

				const result = await handler.completePrompt("ping")
				expect(result).toBe("response")
				expect(mockCreate).toHaveBeenCalledWith(
					expect.objectContaining({ model: "glm-5.1", stream: false }),
					{ headers: { "x-opencode-session": expect.any(String) } }, // session header only: no signal/timeout
				)
			})

			it("completePrompt settles a pre-aborted signal before the OpenAI request starts", async () => {
				// Model resolution runs inside the cancellation scope, so a signal
				// that is already aborted rejects before the chat completion is
				// issued: the SDK must never be called.
				const controller = new AbortController()
				controller.abort()
				const handler = new OpencodeGoHandler(openaiOptions)

				const error = await handler.completePrompt("ping", { abortSignal: controller.signal }).then(
					() => undefined,
					(e: unknown) => e,
				)
				expect(error).toMatchObject({ name: "AbortError" })
				expect((error as Error).message).toBe("The Opencode Go request was aborted")
				expect(mockCreate).not.toHaveBeenCalled()
			})

			it("completePrompt preserves abort identity for a name-based AbortError rejection (OpenAI path)", async () => {
				// No aborted signal and no SDK abort class: only the DOM-standard
				// name === "AbortError" check marks a cancelled request.
				const rawAbort = Object.assign(new Error("raw"), { name: "AbortError" })
				mockCreate.mockRejectedValueOnce(rawAbort)
				const handler = new OpencodeGoHandler(openaiOptions)

				const error = await handler.completePrompt("ping").then(
					() => undefined,
					(e: unknown) => e,
				)
				expect(error).toMatchObject({ name: "AbortError" })
				expect((error as Error).message).toBe("The Opencode Go request was aborted")
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

		it("adopts the cumulative output token count in the final Anthropic cost", async () => {
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
			// qwen3.7-max: input $2.5/M, output $7.5/M. Each message_delta reports the running total,
			// so the final cost reflects the reported 6 output tokens rather than the sum of the
			// two deltas (4 + 6 = 10) - adopting the reported total is what anthropic.ts and
			// minimax.ts do. The per-event usage chunks above still carry each delta's own value.
			expect(costChunk.totalCost).toBeCloseTo((10 * 2.5 + 6 * 7.5) / 1_000_000, 10)
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

		it("re-checks the signal between the separator and the body of an indexed thinking block", async () => {
			// The thinking branch carries its own separator guard: an indexed thinking block yields the newline
			// and then the block body, and only the check in between can stop the body after a cancel.
			mockAnthropicCreate.mockImplementationOnce(async () =>
				asyncStreamFrom([
					{
						type: "content_block_start",
						index: 1,
						content_block: { type: "thinking", thinking: "pondering" },
					},
				]),
			)
			const controller = new AbortController()
			const handler = new OpencodeGoHandler(anthropicOptions)
			const iterator = handler
				.createMessage(
					"sys",
					[{ role: "user", content: "Hi" }],
					makeCreateMessageMetadata({ abortSignal: controller.signal }),
				)
				[Symbol.asyncIterator]()

			const first = await iterator.next()
			expect(first.value).toMatchObject({ type: "reasoning", text: "\n" })
			// Observable condition: the separator reached the consumer, so the cancel lands before the body.
			controller.abort()

			const settled = await iterator.next().then(
				(result) => result.value,
				(error: unknown) => error,
			)
			expect(settled).toMatchObject({ name: "AbortError" })
			expect((settled as Error).message).toBe("The Opencode Go request was aborted")
		})

		it("completes an Anthropic stream when the caller passes no abort signal at all", async () => {
			// Every guard in this helper is written as abortSignal?.aborted. With no caller signal there is
			// nothing to consult, so they must fall through: dropping the optional chain would turn each guard
			// into a property access on undefined and fail a stream that nobody cancelled.
			const events = [
				{ type: "content_block_start", index: 0, content_block: { type: "text", text: "one" } },
				{ type: "content_block_start", index: 1, content_block: { type: "text", text: "two" } },
				{ type: "content_block_start", index: 2, content_block: { type: "thinking", thinking: "pondering" } },
				{ type: "message_start", message: { usage: { input_tokens: 3, output_tokens: 4 } } },
			]
			mockAnthropicCreate.mockImplementationOnce(async () => asyncStreamFrom(events))
			const handler = new OpencodeGoHandler(anthropicOptions)
			const chunks = await collectStream(
				handler.createMessage(
					"sys",
					[{ role: "user", content: "Hi" }],
					// No caller signal at all: the uncancelled default path through every guard.
					makeCreateMessageMetadata({ abortSignal: undefined }),
				),
			)
			expect(chunks.filter((chunk) => chunk.type === "text").map((chunk) => chunk.text)).toEqual([
				"one",
				"\n",
				"two",
			])
			expect(chunks.filter((chunk) => chunk.type === "reasoning").map((chunk) => chunk.text)).toEqual([
				"\n",
				"pondering",
			])
			expect(chunks.some((chunk) => chunk.type === "usage" && chunk.totalCost !== undefined)).toBe(true)
		})

		it("rejects an Anthropic stream that closes quietly after a cancel and still succeeds on a live signal", async () => {
			// The Anthropic SDK swallows the body-read AbortError and returns from the iterator, so the
			// helper can reach its terminal cost yield on a cancelled request. A cancelled turn must not
			// report terminal usage as if it finished, and a live signal must still complete normally.
			const events = [
				{ type: "content_block_start", index: 0, content_block: { type: "text", text: "answer" } },
				{ type: "message_start", message: { usage: { input_tokens: 3, output_tokens: 4 } } },
			]
			const handler = new OpencodeGoHandler(anthropicOptions)
			const cancelled = new AbortController()
			mockAnthropicCreate.mockImplementationOnce(async () => asyncStreamFrom(events))
			const iterator = handler
				.createMessage(
					"sys",
					[{ role: "user", content: "Hi" }],
					makeCreateMessageMetadata({ abortSignal: cancelled.signal }),
				)
				[Symbol.asyncIterator]()

			const first = await iterator.next()
			expect(first.value).toMatchObject({ type: "text", text: "answer" })
			// Observable condition: the consumer holds the partial text and cancels; the mock iterator then
			// reports done instead of throwing, which is what the pinned SDK does.
			cancelled.abort()

			const settled = await iterator.next().then(
				(result) => result.value,
				(error: unknown) => error,
			)
			expect(settled).toMatchObject({ name: "AbortError" })
			expect((settled as Error).message).toBe("The Opencode Go request was aborted")

			// The same fixture with the caller signal live is an ordinary completion, terminal cost included.
			mockAnthropicCreate.mockImplementationOnce(async () => asyncStreamFrom(events))
			const live = new AbortController()
			const chunks = await collectStream(
				handler.createMessage(
					"sys",
					[{ role: "user", content: "Hi" }],
					makeCreateMessageMetadata({ abortSignal: live.signal }),
				),
			)
			expect(chunks.some((chunk) => chunk.type === "usage" && chunk.totalCost !== undefined)).toBe(true)
			expect(live.signal.aborted).toBe(false)
		})

		it("rejects instead of reporting terminal cost when the cancel lands after the last Anthropic event", async () => {
			// Every event was dispatched and delivered, so neither the per-event check nor the separator check
			// can run again; only a check after the loop can stop the helper from yielding its terminal cost
			// chunk for a turn the caller already cancelled.
			mockAnthropicCreate.mockImplementationOnce(async () =>
				asyncStreamFrom([
					{ type: "message_start", message: { usage: { input_tokens: 3, output_tokens: 4 } } },
					{ type: "content_block_start", index: 0, content_block: { type: "text", text: "answer" } },
					{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " more" } },
				]),
			)
			const controller = new AbortController()
			const handler = new OpencodeGoHandler(anthropicOptions)
			const iterator = handler
				.createMessage(
					"sys",
					[{ role: "user", content: "Hi" }],
					makeCreateMessageMetadata({ abortSignal: controller.signal }),
				)
				[Symbol.asyncIterator]()

			const delivered = []
			for (let i = 0; i < 3; i++) {
				const result = await iterator.next()
				if (result.done) throw new Error("expected three delivered items")
				delivered.push(result.value)
			}
			expect(delivered.map((item) => item.type)).toEqual(["usage", "text", "text"])
			// Observable condition: the caller cancels after the last event was handed over, and the mock
			// iterator then reports done the way the pinned SDK does after swallowing the abort.
			controller.abort()

			const settled = await iterator.next().then(
				(result) => result.value,
				(error: unknown) => error,
			)
			expect(settled).toMatchObject({ name: "AbortError" })
			expect((settled as Error).message).toBe("The Opencode Go request was aborted")
		})

		it("re-checks the signal between the two yields of one Anthropic event", async () => {
			// An indexed content_block_start emits a separator item and then the block text. A consumer that
			// takes the separator and cancels must not be handed the text: only a guard inside the event
			// dispatch can stop it, because the post-stream guard runs after both yields.
			mockAnthropicCreate.mockImplementationOnce(async () =>
				asyncStreamFrom([
					{ type: "content_block_start", index: 1, content_block: { type: "text", text: "answer" } },
				]),
			)
			const controller = new AbortController()
			const handler = new OpencodeGoHandler(anthropicOptions)
			const iterator = handler
				.createMessage(
					"sys",
					[{ role: "user", content: "Hi" }],
					makeCreateMessageMetadata({ abortSignal: controller.signal }),
				)
				[Symbol.asyncIterator]()

			const first = await iterator.next()
			expect(first.value).toMatchObject({ type: "text", text: "\n" })
			controller.abort()

			const settled = await iterator.next().then(
				(result) => result.value,
				(error: unknown) => error,
			)
			expect(settled).toMatchObject({ name: "AbortError" })
			expect((settled as Error).message).toBe("The Opencode Go request was aborted")
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

		it("normalizes a mid-stream abort on the Anthropic path to the standardized AbortError", async () => {
			// A cancellation that surfaces after the /v1/messages stream has
			// started must normalize to the standardized AbortError like the
			// other wire formats, not leak the raw SDK rejection.
			let capturedSignal: AbortSignal | undefined
			let firstChunkDelivered = false
			mockAnthropicCreate.mockImplementation(async (_params: unknown, options: { signal?: AbortSignal }) => {
				capturedSignal = options?.signal
				return (async function* () {
					yield {
						type: "content_block_delta",
						index: 0,
						delta: { type: "text_delta", text: "partial" },
					}
					// Runs only once the consumer has taken the first chunk and asked for the next
					// one, which is the state the 25 ms sleep was approximating.
					firstChunkDelivered = true
					// Observable condition: the bridge aborted the internal controller.
					await vitest.waitFor(() => expect(capturedSignal?.aborted).toBe(true), {
						timeout: 1000,
						interval: 5,
					})
					throw new AnthropicAbortError()
				})()
			})
			const controller = new AbortController()
			const handler = new OpencodeGoHandler(anthropicOptions)
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Hi" }]

			const consumed = collectStream(
				handler.createMessage("sys", messages, { taskId: "test-task", abortSignal: controller.signal }),
			)

			// Observable condition: the first chunk has been consumed and the stream is asking for
			// the next one; abort mid-stream from there rather than after a fixed 25 ms.
			await vitest.waitFor(() => expect(firstChunkDelivered).toBe(true), { timeout: 1000, interval: 5 })
			controller.abort()

			const error = await consumed.then(
				() => undefined,
				(e: unknown) => e,
			)
			expect(capturedSignal?.aborted).toBe(true)
			expect(error).toMatchObject({ name: "AbortError" })
			expect((error as Error).message).toBe("The Opencode Go request was aborted")
		})
	})

	describe("Responses-format models (gpt-5.6-luna, gpt-6-luna)", () => {
		// gpt-5.6-luna is Responses-only on the Go gateway: its chat-completions
		// adapter fails with an opaque HTTP 500 (Zoo-Code-Org/Zoo-Code#1431),
		// so the handler must route it through /v1/responses and never fall
		// back to chat completions.
		const lunaOptions: ApiHandlerOptions = {
			opencodeGoApiKey: "test-key",
			opencodeGoModelId: "gpt-5.6-luna",
		}
		const gpt6LunaOptions: ApiHandlerOptions = {
			opencodeGoApiKey: "test-key",
			opencodeGoModelId: "gpt-6-luna",
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

		it("forwards the per-request abort signal to the streaming Responses request", async () => {
			// The /v1/responses request is wired to the per-request internal
			// controller (the bridge target), not the caller's signal: the
			// caller's signal is bridged into the internal controller, and the
			// SDK watches only the internal one.
			const handler = new OpencodeGoHandler(lunaOptions)
			const controller = new AbortController()
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Hi" }]

			await collectStream(
				handler.createMessage("sys", messages, { taskId: "test-task", abortSignal: controller.signal }),
			)

			const callOptions = mockResponsesCreate.mock.calls[0][1] as { signal?: AbortSignal; headers?: unknown }
			expect(callOptions.headers).toEqual({ "x-opencode-session": "test-task" })
			expect(callOptions.signal).toBeInstanceOf(AbortSignal)
			expect(callOptions.signal).not.toBe(controller.signal)
			expect(callOptions.signal?.aborted).toBe(false)
		})

		it("normalizes an aborted Responses request to the standardized AbortError", async () => {
			// Emulate the OpenAI SDK against the per-request internal signal:
			// the caller's signal aborts just as the request starts, the bridge
			// flips the internal controller, and the SDK rejects with
			// APIUserAbortError. The Responses-path guard must normalize it to
			// the DOM-standard AbortError instead of wrapping it.
			const controller = new AbortController()
			let sdkSignal: AbortSignal | undefined
			mockResponsesCreate.mockImplementation(async (_body: unknown, options: { signal?: AbortSignal }) => {
				sdkSignal = options?.signal
				controller.abort()
				// A plain failure rather than an abort-shaped one: the conversion into the contract
				// AbortError can then only come from the provider consulting the aborted signal, so the
				// assertions below have to be carried by the captured signal, not by that conversion.
				throw new Error("gateway rejected the request")
			})
			const handler = new OpencodeGoHandler(lunaOptions)
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Hi" }]

			const error = await collectStream(
				handler.createMessage("sys", messages, { taskId: "test-task", abortSignal: controller.signal }),
			).then(
				() => undefined,
				(e: unknown) => e,
			)
			// A cancelled /v1/responses request surfaces as a DOM-standard
			// AbortError, not the wrapped "completion error" reserved for other
			// failures.
			expect(error).toMatchObject({ name: "AbortError" })
			expect((error as Error).message).toBe("The Opencode Go request was aborted")
			// Observed outside the provider's conversion: the signal the SDK actually received had already
			// flipped, so the bridge - not the catch's signal arm alone - carried the cancel into the request.
			expect(sdkSignal).toBeInstanceOf(AbortSignal)
			expect(sdkSignal?.aborted).toBe(true)
		})

		it("normalizes an SDK abort rejection on the Responses stream path while the signal is live", async () => {
			// No caller signal here, so nothing aborts: the only thing that can normalize this rejection
			// is the error-name arm of the pre-stream catch. Without that arm the failure falls through
			// as "Opencode Go completion error: Request was aborted.", which the outer catch cannot
			// recognize either — its message check is exact and the signal never aborted.
			mockResponsesCreate.mockImplementationOnce(async () => {
				throw await sdkAbortError()
			})
			const handler = new OpencodeGoHandler(lunaOptions)
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Hi" }]

			const error = await collectStream(handler.createMessage("sys", messages)).then(
				() => undefined,
				(e: unknown) => e,
			)
			expect(mockResponsesCreate).toHaveBeenCalledTimes(1) // the SDK call really ran
			expect(error).toMatchObject({ name: "AbortError" })
			expect((error as Error).message).toBe("The Opencode Go request was aborted")
		})
		it("normalizes a mid-stream abort on the Responses path to the standardized AbortError", async () => {
			// A cancellation that surfaces after the /v1/responses stream has
			// started must normalize to the standardized AbortError like the
			// other wire formats, not leak the raw SDK rejection.
			let capturedSignal: AbortSignal | undefined
			let firstChunkDelivered = false
			mockResponsesCreate.mockImplementation(async (_body: unknown, options: { signal?: AbortSignal }) => {
				capturedSignal = options?.signal
				return (async function* () {
					yield { type: "response.output_text.delta", delta: "partial" }
					// Runs only once the consumer has taken the first chunk and asked for the next
					// one, which is the state the 25 ms sleep was approximating.
					firstChunkDelivered = true
					// Observable condition: the bridge aborted the internal controller.
					await vitest.waitFor(() => expect(capturedSignal?.aborted).toBe(true), {
						timeout: 1000,
						interval: 5,
					})
					throw new APIUserAbortError()
				})()
			})
			const controller = new AbortController()
			const handler = new OpencodeGoHandler(lunaOptions)
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Hi" }]

			const consumed = collectStream(
				handler.createMessage("sys", messages, { taskId: "test-task", abortSignal: controller.signal }),
			)

			// Observable condition: the first chunk has been consumed and the stream is asking for
			// the next one; abort mid-stream from there rather than after a fixed 25 ms.
			await vitest.waitFor(() => expect(firstChunkDelivered).toBe(true), { timeout: 1000, interval: 5 })
			controller.abort()

			const error = await consumed.then(
				() => undefined,
				(e: unknown) => e,
			)
			expect(capturedSignal?.aborted).toBe(true)
			expect(error).toMatchObject({ name: "AbortError" })
			expect((error as Error).message).toBe("The Opencode Go request was aborted")
		})

		it("completes a Responses stream when the caller passes no abort signal at all", async () => {
			// The after-stream guard runs on every normal end of a Responses stream, including one where the
			// caller never supplied a signal, so an absent signal must read as not-cancelled.
			mockResponsesCreate.mockImplementationOnce(async () =>
				asyncStreamFrom([{ type: "response.output_text.delta", delta: "partial" }]),
			)
			const handler = new OpencodeGoHandler(lunaOptions)
			const chunks = await collectStream(
				handler.createMessage(
					"sys",
					[{ role: "user", content: "Hi" }],
					makeCreateMessageMetadata({ abortSignal: undefined }),
				),
			)
			expect(chunks.filter((chunk) => chunk.type === "text").map((chunk) => chunk.text)).toEqual(["partial"])
		})

		it("rejects a Responses stream that closes quietly after a cancel and still succeeds on a live signal", async () => {
			// The pinned OpenAI SDK detaches the bridge and returns from SSE iteration when a pending read
			// raises AbortError, so the Responses processor sees an ordinary end of stream. A cancelled turn
			// must reject with the contract AbortError instead of resolving as a completed turn, while the
			// same quiet end with a live caller signal is still a normal completion.
			const events = [{ type: "response.output_text.delta", delta: "partial" }]
			const handler = new OpencodeGoHandler(lunaOptions)
			const cancelled = new AbortController()
			mockResponsesCreate.mockImplementationOnce(async () => asyncStreamFrom(events))
			const iterator = handler
				.createMessage(
					"sys",
					[{ role: "user", content: "Hi" }],
					makeCreateMessageMetadata({ abortSignal: cancelled.signal }),
				)
				[Symbol.asyncIterator]()

			const first = await iterator.next()
			expect(first.value).toMatchObject({ type: "text", text: "partial" })
			// Observable condition: the consumer holds the partial text, cancels, and the mock iterator then
			// reports done instead of throwing - the quiet close the SDK actually performs.
			cancelled.abort()

			const settled = await iterator.next().then(
				(result) => result.value,
				(error: unknown) => error,
			)
			expect(settled).toMatchObject({ name: "AbortError" })
			expect((settled as Error).message).toBe("The Opencode Go request was aborted")

			// Same fixture, live signal: the quiet end is an ordinary completion.
			mockResponsesCreate.mockImplementationOnce(async () => asyncStreamFrom(events))
			const live = new AbortController()
			const chunks = await collectStream(
				handler.createMessage(
					"sys",
					[{ role: "user", content: "Hi" }],
					makeCreateMessageMetadata({ abortSignal: live.signal }),
				),
			)
			expect(chunks.filter((chunk) => chunk.type === "text").map((chunk) => chunk.text)).toEqual(["partial"])
			expect(live.signal.aborted).toBe(false)
		})

		// One transport read can decode both the text delta and the terminal event. Both cancel
		// checks are exercised against this same buffered payload: the pull-time test below cancels
		// before the second read is requested, the read-gated test after it releases that read only
		// once the cancel has landed, so the pre-pull check has already been evaluated by then.
		// The shape a source iterator's close() resolves with, shared by the two cancel-window tests.
		type CloseOutcome = Promise<{ done: boolean; value: undefined }>

		const bufferedCompletionEvents = [
			{ type: "response.output_text.delta", delta: "partial" },
			{
				type: "response.completed",
				response: { usage: { input_tokens: 10, output_tokens: 5 } },
			},
		]

		it("rejects a Responses turn whose buffered completion event arrives after the caller cancels", async () => {
			// One transport read can decode both the text delta and the terminal event: the
			// consumer takes the delta, cancels, and the processor would otherwise pull the
			// already-buffered response.completed and hand over its usage chunk for a turn
			// nobody is reading any more. The pull-time check must end the stream there, so the
			// cancelled turn rejects with the contract error and reports no terminal cost.
			const events = bufferedCompletionEvents
			const handler = new OpencodeGoHandler(lunaOptions)
			const cancelled = new AbortController()
			mockResponsesCreate.mockImplementationOnce(async () => asyncStreamFrom(events))
			const iterator = handler
				.createMessage(
					"sys",
					[{ role: "user", content: "Hi" }],
					makeCreateMessageMetadata({ abortSignal: cancelled.signal }),
				)
				[Symbol.asyncIterator]()

			const first = await iterator.next()
			expect(first.value).toMatchObject({ type: "text", text: "partial" })
			// Observable consequence: the next pull must not deliver the buffered terminal event.
			cancelled.abort()

			const next = await iterator.next().then(
				(result) => ({
					done: result.done,
					value: result.value as unknown,
					rejected: undefined as unknown,
				}),
				(error: unknown) => ({ done: false, value: undefined, rejected: error }),
			)
			expect(next.rejected).toMatchObject({ name: "AbortError" })
			expect((next.rejected as Error).message).toBe("The Opencode Go request was aborted")
			expect(next.value).toBeUndefined()

			// Same buffered fixture, live caller signal: an ordinary completion, cost included.
			mockResponsesCreate.mockImplementationOnce(async () => asyncStreamFrom(events))
			const live = new AbortController()
			const chunks = await collectStream(
				handler.createMessage(
					"sys",
					[{ role: "user", content: "Hi" }],
					makeCreateMessageMetadata({ abortSignal: live.signal }),
				),
			)
			expect(chunks.filter((chunk) => chunk.type === "text").map((chunk) => chunk.text)).toEqual(["partial"])
			expect(chunks.some((chunk) => chunk.type === "usage" && chunk.totalCost !== undefined)).toBe(true)
			expect(live.signal.aborted).toBe(false)
		})

		it("rejects a Responses turn whose buffered completion event resolves after the pull already started", async () => {
			// Same buffered payload as the test above, with the transport read held open past the cancel:
			// for this pull the pre-pull check has already been evaluated, so only a check in front of
			// forwarding the processed chunk can keep the terminal usage chunk from a consumer that has
			// given up on the turn.
			type ReadGatedResponsesIterator = {
				next: () => Promise<{ done: boolean; value: unknown }>
				return: (value?: unknown) => CloseOutcome
				[Symbol.asyncIterator]: () => ReadGatedResponsesIterator
			}
			const events = bufferedCompletionEvents
			let releaseRead!: (event: unknown) => void
			const readGate = new Promise<unknown>((resolve) => {
				releaseRead = resolve
			})
			let index = 0
			const read = vitest.fn((): Promise<{ done: boolean; value: unknown }> => {
				const event = events[index]
				if (event === undefined) {
					return Promise.resolve({ done: true, value: undefined })
				}
				index += 1
				// The terminal event is the read the cancel outlives.
				return index === events.length
					? readGate.then((value) => ({ done: false, value }))
					: Promise.resolve({ done: false, value: event })
			})
			const closeSpy = vitest.fn((): CloseOutcome => Promise.resolve({ done: true, value: undefined }))
			const source: ReadGatedResponsesIterator = {
				next: read,
				return: closeSpy,
				[Symbol.asyncIterator]: () => source,
			}
			const handler = new OpencodeGoHandler(lunaOptions)
			const cancelled = new AbortController()
			mockResponsesCreate.mockImplementationOnce(async () => source)
			const iterator = handler
				.createMessage(
					"sys",
					[{ role: "user", content: "Hi" }],
					makeCreateMessageMetadata({ abortSignal: cancelled.signal }),
				)
				[Symbol.asyncIterator]()

			const first = await iterator.next()
			expect(first.value).toMatchObject({ type: "text", text: "partial" })
			const pending = iterator.next().then(
				(result) => ({
					done: result.done,
					value: result.value as unknown,
					rejected: undefined as unknown,
				}),
				(error: unknown) => ({ done: false, value: undefined, rejected: error }),
			)
			// Observable condition: the second read has been requested and has not settled, so the
			// pre-pull check has already run for it when the cancel lands.
			await vitest.waitFor(() => expect(read).toHaveBeenCalledTimes(2), { timeout: 1000, interval: 5 })
			cancelled.abort()
			releaseRead(events[events.length - 1])
			const outcome = await pending
			expect(outcome.rejected).toMatchObject({ name: "AbortError" })
			expect((outcome.rejected as Error).message).toBe("The Opencode Go request was aborted")
			expect(outcome.value).toBeUndefined() // no terminal cost for a turn the caller gave up on
			// The SDK iterator is still closed: once by the transform unwinding the delegated loop and
			// once by the provider's own cleanup, which is the count the early-exit test pins as well.
			expect(closeSpy).toHaveBeenCalledTimes(2)
		})

		it("rejects a cancelled Responses turn when the cancel lands while the iterator is closing", async () => {
			// The provider's finally block awaits the SDK iterator's return(), which makes the cleanup a
			// suspension point of its own. A cancel that lands there used to settle the waiting pull as an
			// ordinary end of stream, because the quiet-close check ran before the cleanup instead of after
			// it. The check still runs outside the finally, so a stream error already in flight keeps its
			// own failure instead of being replaced by the abort.
			type PendingCloseResponsesIterator = {
				next: () => Promise<{ done: boolean; value: unknown }>
				return: (value?: unknown) => CloseOutcome
				[Symbol.asyncIterator]: () => PendingCloseResponsesIterator
			}
			let releaseCleanup!: () => void
			const cleanupGate = new Promise<void>((resolve) => {
				releaseCleanup = resolve
			})
			const events = [{ type: "response.output_text.delta", delta: "partial" }]
			let index = 0
			const closeSpy = vitest.fn((): CloseOutcome => cleanupGate.then(() => ({ done: true, value: undefined })))
			const source: PendingCloseResponsesIterator = {
				next: () => {
					const event = events[index]
					if (event === undefined) {
						return Promise.resolve({ done: true, value: undefined })
					}
					index += 1
					return Promise.resolve({ done: false, value: event })
				},
				return: closeSpy,
				[Symbol.asyncIterator]: () => source,
			}
			const handler = new OpencodeGoHandler(lunaOptions)
			const cancelled = new AbortController()
			mockResponsesCreate.mockImplementationOnce(async () => source)
			const iterator = handler
				.createMessage(
					"sys",
					[{ role: "user", content: "Hi" }],
					makeCreateMessageMetadata({ abortSignal: cancelled.signal }),
				)
				[Symbol.asyncIterator]()

			const first = await iterator.next()
			expect(first.value).toMatchObject({ type: "text", text: "partial" })
			const settled = iterator.next().then(
				(result) => ({
					done: result.done,
					value: result.value as unknown,
					rejected: undefined as unknown,
				}),
				(error: unknown) => ({ done: false, value: undefined, rejected: error }),
			)
			// Observable condition: the provider has reached its cleanup await - the close has been
			// requested and the waiting pull has not settled, which is the window this test is about.
			await vitest.waitFor(() => expect(closeSpy).toHaveBeenCalledTimes(1), { timeout: 1000, interval: 5 })
			cancelled.abort()
			releaseCleanup()
			const outcome = await settled
			expect(outcome.rejected).toMatchObject({ name: "AbortError" })
			expect((outcome.rejected as Error).message).toBe("The Opencode Go request was aborted")
			expect(outcome.done).toBe(false) // a cancel during cleanup is not a normal end of stream
			expect(outcome.value).toBeUndefined()
		})

		it("wraps non-abort Responses pre-stream failures with the Opencode Go prefix", async () => {
			// A non-abort rejection from responses.create (e.g. an upstream 500)
			// must be wrapped like the other wire formats, not normalized.
			mockResponsesCreate.mockRejectedValue(new Error("boom"))
			const handler = new OpencodeGoHandler(lunaOptions)
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Hi" }]

			await expect(collectStream(handler.createMessage("sys", messages))).rejects.toThrow(
				"Opencode Go completion error: boom",
			)
		})

		it("detaches the bridged abort listener from the Responses-format path", async () => {
			// The Responses branch must detach the bridged listener on the way
			// out like the other formats: a task-scoped signal must not
			// accumulate one listener per request.
			const handler = new OpencodeGoHandler(lunaOptions)
			const controller = new AbortController()
			const removeListenerSpy = vi.spyOn(controller.signal, "removeEventListener")
			const addEventListenerSpy = vi.spyOn(controller.signal, "addEventListener")
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Hi" }]

			const chunks = await collectStream(
				handler.createMessage("sys", messages, { taskId: "test-task", abortSignal: controller.signal }),
			)
			expect(chunks).toContainEqual({ type: "text", text: "Hello" })
			// The model-resolution race registers its own "abort" listener on the same signal and detaches
			// it before the request starts, so there are exactly two registrations here and the bridge's is
			// the second one. Naming it by position — and requiring it to differ from the race's callback —
			// means a bridge that stopped registering its own listener cannot satisfy the assertions below
			// by falling back on the race's.
			const abortAddCalls = addEventListenerSpy.mock.calls.filter(([event]) => event === "abort")
			const abortRemoveCalls = removeListenerSpy.mock.calls
				.filter(([event]) => event === "abort")
				.map(([, listener]) => listener)
			expect(abortAddCalls.length).toBe(2)
			const [raceCall, bridgeCall] = abortAddCalls
			const addedListener = bridgeCall?.[1]
			expect(typeof addedListener).toBe("function")
			expect(addedListener).not.toBe(raceCall?.[1])
			expect(addEventListenerSpy).toHaveBeenCalledWith("abort", addedListener, { once: true })
			// Both listeners are gone by reference: the lookup race's first (its cleanup ran before the
			// request), the bridge's last.
			expect(abortRemoveCalls).toEqual([raceCall?.[1], addedListener])
			expect(controller.signal.aborted).toBe(false)
		})

		it("falls back to a stable per-instance session ID when no taskId is provided", async () => {
			const handler = new OpencodeGoHandler(lunaOptions)
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Hi" }]

			await collectStream(handler.createMessage("sys", messages))

			const requestOptions = mockResponsesCreate.mock.calls[0][1] as { headers: Record<string, string> }
			const sessionId = requestOptions.headers["x-opencode-session"]
			expect(sessionId).toEqual(expect.any(String))

			// The same handler instance reuses its session ID across requests.
			await collectStream(handler.createMessage("sys", messages))
			const secondOptions = mockResponsesCreate.mock.calls[1][1] as { headers: Record<string, string> }
			expect(secondOptions.headers["x-opencode-session"]).toBe(sessionId)
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

		type NextOnlyResponsesIterator = {
			next: () => Promise<{ done: boolean; value: unknown }>
			[Symbol.asyncIterator]: () => NextOnlyResponsesIterator
		}
		it("keeps the Responses stream callable when the source iterator has no return method", async () => {
			// The shared transform accepts any AsyncIterable, so the provider must not assume
			// the captured iterator implements return: a plain next-only iterator has to stream,
			// honour a cancel with the contract AbortError, and still clean up without throwing.
			const events = [
				{ type: "response.output_text.delta", delta: "partial" },
				{
					type: "response.completed",
					response: { usage: { input_tokens: 10, output_tokens: 5 } },
				},
			]
			let index = 0
			const sourceIterator: NextOnlyResponsesIterator = {
				next: () =>
					index < events.length
						? Promise.resolve({ done: false, value: events[index++] })
						: Promise.resolve({ done: true, value: undefined }),
				[Symbol.asyncIterator]() {
					return this
				},
			}
			mockResponsesCreate.mockResolvedValue(sourceIterator)
			const handler = new OpencodeGoHandler(lunaOptions)
			const cancelled = new AbortController()
			const iterator = handler
				.createMessage(
					"sys",
					[{ role: "user", content: "Hi" }],
					makeCreateMessageMetadata({ abortSignal: cancelled.signal }),
				)
				[Symbol.asyncIterator]()

			const first = await iterator.next()
			expect(first.value).toMatchObject({ type: "text", text: "partial" })
			cancelled.abort()

			const settled = await iterator.next().then(
				(result) => result.value,
				(error: unknown) => error,
			)
			expect(settled).toMatchObject({ name: "AbortError" })
			expect((settled as Error).message).toBe("The Opencode Go request was aborted")
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
			// The iterator's own listener and the request-level listener race to reject the same
			// promise, so the double is one object and the assertion below pins which rejection
			// propagated. opencode-go hands the caller's signal straight to the SDK and never
			// normalises it into a provider AbortError, so there is no provider message to assert
			// on this path: identity is the strongest statement that is true here.
			const abortDouble = new Error("request aborted")
			let rejectNext: ((reason?: unknown) => void) | undefined
			const iterator = {
				next: vitest.fn().mockImplementation(
					() =>
						new Promise((_resolve, reject) => {
							rejectNext = reject
							controller.signal.addEventListener("abort", () => reject(abortDouble), {
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
				options.signal?.addEventListener("abort", () => rejectNext?.(abortDouble), {
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

			// The read rejection lands on an aborted request signal, so the
			// Responses branch normalizes it to the standardized AbortError
			// (series standard) while still closing the in-flight iterator.
			await expect(nextPromise).rejects.toMatchObject({
				name: "AbortError",
				message: "The Opencode Go request was aborted",
			})
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

		it("routes gpt-6-luna streaming through responses.create only", async () => {
			const handler = new OpencodeGoHandler(gpt6LunaOptions)
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Hi" }]

			const chunks = await collectStream(handler.createMessage("sys", messages))

			expect(chunks).toContainEqual({ type: "text", text: "Hello" })
			expect(mockResponsesCreate).toHaveBeenCalledWith(
				expect.objectContaining({ model: "gpt-6-luna", stream: true }),
				expect.anything(),
			)
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
			// No custom temperature is set, so the provider default is not sent.
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

		it("normalizes an aborted non-streaming Responses completion to the standardized AbortError", async () => {
			// A caller-initiated cancellation of a /v1/responses completion must
			// surface as a DOM-standard AbortError (series standard), not the raw
			// rejection or a wrapped completion error.
			const controller = new AbortController()
			// One double object here too. The Responses completion path wraps every failure
			// (`opencode-go.ts:439` throws `Opencode Go completion error: <message>`), so the
			// abort surfaces as a new Error carrying the double's text behind the provider prefix,
			// not as the double and not as an AbortError. The assertion below pins that whole
			// message; a bare "abort" substring would also match a raw SDK error.
			const abortDouble = new Error("request aborted")
			const request = new Promise<never>((_resolve, reject) => {
				controller.signal.addEventListener("abort", () => reject(abortDouble), { once: true })
			})
			mockResponsesCreate.mockReturnValue(request)
			const handler = new OpencodeGoHandler(lunaOptions)
			const completion = handler.completePrompt("ping", { abortSignal: controller.signal })

			await vitest.waitFor(() => expect(mockResponsesCreate).toHaveBeenCalled())
			controller.abort()

			await expect(completion).rejects.toMatchObject({
				name: "AbortError",
				message: "The Opencode Go request was aborted",
			})
		})

		it.each([
			["anthropic", { opencodeGoApiKey: "test-key", opencodeGoModelId: "qwen3.7-max" }, mockAnthropicCreate],
			["responses", { opencodeGoApiKey: "test-key", opencodeGoModelId: "gpt-5.6-luna" }, mockResponsesCreate],
			["openai", { opencodeGoApiKey: "test-key", opencodeGoModelId: "glm-5.1" }, mockCreate],
		] as const)(
			"completePrompt pins the caller signal and rejects with AbortError for the %s format",
			async (_format, options, requestMock) => {
				clearAllMocks()
				const controller = new AbortController()
				const pending = new Promise<never>((_resolve, reject) => {
					controller.signal.addEventListener(
						"abort",
						() => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
						{ once: true },
					)
				})
				requestMock.mockReturnValue(pending)
				const handler = new OpencodeGoHandler(options)
				const completion = handler.completePrompt("ping", { abortSignal: controller.signal })

				await vitest.waitFor(() => expect(requestMock).toHaveBeenCalled())
				const requestOptions = requestMock.mock.calls[0][1] as { signal?: AbortSignal } | undefined
				// With no timeoutMs the merged signal is the caller signal itself.
				expect(requestOptions?.signal).toBe(controller.signal)

				controller.abort()
				expect(requestOptions?.signal?.aborted).toBe(true)
				await expect(completion).rejects.toMatchObject({
					name: "AbortError",
					message: "The Opencode Go request was aborted",
				})
			},
		)

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

		it("completePrompt routes gpt-6-luna through responses.create only", async () => {
			mockResponsesCreate.mockResolvedValue({ output_text: "Luna 6 response" })
			const handler = new OpencodeGoHandler(gpt6LunaOptions)

			expect(await handler.completePrompt("ping")).toBe("Luna 6 response")

			expect(mockResponsesCreate).toHaveBeenCalledWith(
				expect.objectContaining({ model: "gpt-6-luna", store: false }),
				expect.anything(),
			)
			expect(mockCreate).not.toHaveBeenCalled()
			expect(mockAnthropicCreate).not.toHaveBeenCalled()
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

			expect(mockResponsesCreate.mock.calls[0][1]).toEqual({
				signal: expect.any(AbortSignal),
				headers: { "x-opencode-session": expect.any(String) },
			})
			expect(mockCreate).not.toHaveBeenCalled()
		})

		it("forwards a positive timeoutMs to the non-streaming Responses request", async () => {
			mockResponsesCreate.mockResolvedValue({ output_text: "Hello!" })
			const handler = new OpencodeGoHandler(lunaOptions)

			await handler.completePrompt("ping", { timeoutMs: 5_000 })

			expect(mockResponsesCreate.mock.calls[0][1]).toEqual({
				signal: expect.any(AbortSignal),
				timeout: 5_000,
				headers: { "x-opencode-session": expect.any(String) },
			})
			expect(mockCreate).not.toHaveBeenCalled()
		})

		it("omits the timeout option from the Responses request when timeoutMs is 0", async () => {
			// The OpenAI SDK treats timeout: 0 as an immediate abort, so the
			// "disabled" value must never be forwarded — assert the absence of
			// the option (a forwarded timeout: 0 would fail this assertion).
			mockResponsesCreate.mockResolvedValue({ output_text: "Hello!" })
			const handler = new OpencodeGoHandler(lunaOptions)

			await handler.completePrompt("ping", { timeoutMs: 0 })

			const callOptions = mockResponsesCreate.mock.calls[0][1] as Record<string, unknown>
			expect(callOptions).not.toHaveProperty("timeout")
			expect(callOptions).not.toHaveProperty("signal")
			expect(mockCreate).not.toHaveBeenCalled()
		})
		it("omits the timeout option from the Responses request when timeoutMs is negative", async () => {
			// The disabled-timeout contract covers every non-positive value, not just 0.
			mockResponsesCreate.mockResolvedValue({ output_text: "Hello!" })
			const handler = new OpencodeGoHandler(lunaOptions)

			await handler.completePrompt("ping", { timeoutMs: -1 })

			const callOptions = mockResponsesCreate.mock.calls[0][1] as Record<string, unknown>
			expect(callOptions).not.toHaveProperty("timeout")
			expect(callOptions).not.toHaveProperty("signal")
			expect(mockCreate).not.toHaveBeenCalled()
		})

		it("preserves abort identity on the Responses completion path", async () => {
			// Delivered from the SDK mock with no caller signal: the pre-flight guard cannot fire, so
			// the mock really runs and its APIUserAbortError is what this path must normalize into the
			// DOM-standard AbortError, not a wrapped completion error.
			mockResponsesCreate.mockImplementationOnce(async () => {
				throw await sdkAbortError()
			})
			const handler = new OpencodeGoHandler(lunaOptions)

			const error = await handler.completePrompt("ping").then(
				() => undefined,
				(e: unknown) => e,
			)
			expect(mockResponsesCreate).toHaveBeenCalledTimes(1) // the SDK call ran, not the guard
			expect(error).toMatchObject({ name: "AbortError" })
			expect((error as Error).message).toBe("The Opencode Go request was aborted")
		})

		it("surfaces Responses request timeouts as an AbortError in completePrompt", async () => {
			// Emulate the OpenAI SDK: when the request timeout fires, the SDK
			// surfaces APIConnectionTimeoutError ("Request timed out.") — the
			// series standard maps it to the same AbortError identity as caller
			// cancellations.
			mockResponsesCreate.mockRejectedValue(new APIConnectionTimeoutError())
			const handler = new OpencodeGoHandler(lunaOptions)

			const error = await handler.completePrompt("ping").then(
				() => undefined,
				(e: unknown) => e,
			)
			expect(error).toMatchObject({ name: "AbortError" })
			expect((error as Error).message).toBe("The Opencode Go request was aborted")
		})

		it("completePrompt sends the per-instance session ID to the Responses endpoint", async () => {
			mockResponsesCreate.mockResolvedValue({ output_text: "Hello!" })
			const handler = new OpencodeGoHandler(lunaOptions)

			await handler.completePrompt("ping")

			expect(mockResponsesCreate.mock.calls[0][1]?.headers).toMatchObject({
				"x-opencode-session": expect.any(String),
			})
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

		describe("temperature (Zoo-Code-Org/Zoo-Code#2055)", () => {
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Hi" }]

			const streamRequest = async (options: ApiHandlerOptions) => {
				await collectStream(new OpencodeGoHandler(options).createMessage("sys", messages))
				return mockResponsesCreate.mock.calls[0][0] as Record<string, unknown>
			}

			const completeRequest = async (options: ApiHandlerOptions) => {
				mockResponsesCreate.mockResolvedValue({ output_text: "Hello!" })
				await new OpencodeGoHandler(options).completePrompt("ping")
				return mockResponsesCreate.mock.calls[0][0] as Record<string, unknown>
			}

			const paths = [
				["streaming", streamRequest],
				["non-streaming", completeRequest],
			] as const

			describe.each(paths)("%s request", (_path, sendRequest) => {
				it.each([
					["grok-4.6", undefined],
					["muse-spark-1.3-contributor", undefined],
					["muse-spark-1.2-contributor", undefined],
					["gpt-5.6-luna", "none"],
					["gpt-6-luna", "none"],
				] as const)("forwards a custom temperature for %s (effort %s)", async (modelId, reasoningEffort) => {
					const callArgs = await sendRequest({
						opencodeGoApiKey: "test-key",
						opencodeGoModelId: modelId,
						modelTemperature: 0.37,
						...(reasoningEffort && { reasoningEffort }),
					})

					// The value keeps the UI's 0.01 resolution.
					expect(callArgs.temperature).toBe(0.37)
				})

				it.each([
					["grok-4.6", "low"],
					["grok-4.6", "high"],
					["muse-spark-1.3-contributor", "minimal"],
					["muse-spark-1.2-contributor", "high"],
				] as const)(
					"forwards a custom temperature for %s with explicit effort %s",
					async (modelId, reasoningEffort) => {
						const callArgs = await sendRequest({
							opencodeGoApiKey: "test-key",
							opencodeGoModelId: modelId,
							modelTemperature: 0.37,
							reasoningEffort,
						})

						// Grok and Muse support does not depend on reasoning effort.
						expect(callArgs.reasoning).toEqual({ effort: reasoningEffort })
						expect(callArgs.temperature).toBe(0.37)
					},
				)

				it("omits temperature for a stale none effort when reasoning effort is switched off", async () => {
					// A saved "none" does not reach the wire while the toggle is off,
					// so the configuration is unverified and temperature is omitted.
					const callArgs = await sendRequest({
						...lunaOptions,
						modelTemperature: 0.5,
						reasoningEffort: "none",
						enableReasoningEffort: false,
					})

					expect(callArgs).not.toHaveProperty("reasoning")
					expect(callArgs).not.toHaveProperty("temperature")
				})

				it.each([
					["gpt-5.6-luna", "low"],
					["gpt-5.6-luna", "max"],
					["gpt-6-luna", "medium"],
					["gpt-6-luna", "xhigh"],
					["gpt-6-luna", "disable"],
				] as const)("omits a saved temperature for %s with effort %s", async (modelId, reasoningEffort) => {
					const callArgs = await sendRequest({
						opencodeGoApiKey: "test-key",
						opencodeGoModelId: modelId,
						modelTemperature: 0.5,
						reasoningEffort,
					})

					expect(callArgs).not.toHaveProperty("temperature")
				})

				it("omits temperature 1 for a GPT Luna model with a non-none effort", async () => {
					// Temperature 1 is the only value the gateway accepted with
					// reasoning, but it is the model default, so it is omitted.
					const callArgs = await sendRequest({
						opencodeGoApiKey: "test-key",
						opencodeGoModelId: "gpt-5.6-luna",
						modelTemperature: 1,
						reasoningEffort: "high",
					})

					expect(callArgs).not.toHaveProperty("temperature")
				})

				it("omits a saved temperature for a GPT Luna model on its default effort", async () => {
					const callArgs = await sendRequest({ ...gpt6LunaOptions, modelTemperature: 0.5 })

					expect(callArgs.reasoning).toEqual({ effort: "medium" })
					expect(callArgs).not.toHaveProperty("temperature")
				})

				it.each([undefined, null])(
					"omits temperature when no custom value is set (%s)",
					async (modelTemperature) => {
						const callArgs = await sendRequest({
							opencodeGoApiKey: "test-key",
							opencodeGoModelId: "grok-4.6",
							modelTemperature,
						})

						expect(callArgs).not.toHaveProperty("temperature")
					},
				)

				it("forwards temperature 0 as an explicit custom value", async () => {
					const callArgs = await sendRequest({
						opencodeGoApiKey: "test-key",
						opencodeGoModelId: "grok-4.6",
						modelTemperature: 0,
					})

					expect(callArgs.temperature).toBe(0)
				})
			})
		})

		it("classifies documented Responses models as Responses-format and other models as not", () => {
			expect(isOpencodeGoResponsesFormatModel("gpt-5.6-luna")).toBe(true)
			expect(isOpencodeGoResponsesFormatModel("gpt-6-luna")).toBe(true)
			expect(isOpencodeGoResponsesFormatModel("grok-4.5")).toBe(false)
			expect(isOpencodeGoResponsesFormatModel("grok-4.6")).toBe(true)
			expect(isOpencodeGoResponsesFormatModel("muse-spark-1.3-contributor")).toBe(true)
			expect(isOpencodeGoResponsesFormatModel("muse-spark-1.2-contributor")).toBe(true)
			expect(isOpencodeGoResponsesFormatModel("glm-5.3")).toBe(false)
			expect(isOpencodeGoResponsesFormatModel("qwen3.7-max")).toBe(false)
			expect(isOpencodeGoResponsesFormatModel("some-unknown-model")).toBe(false)
		})
	})

	describe("isOpencodeGoAnthropicFormatModel", () => {
		it("classifies Qwen and MiniMax Go models as Anthropic-format", () => {
			expect(isOpencodeGoAnthropicFormatModel("qwen3.8-flash")).toBe(true)
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
			expect(isOpencodeGoAnthropicFormatModel("qwen3.5-plus")).toBe(false)
		})

		it("defaults unknown model IDs to the OpenAI-compatible format", () => {
			expect(isOpencodeGoAnthropicFormatModel("some-unknown-model")).toBe(false)
		})
	})

	describe("completePrompt catch classification", () => {
		it.each([
			{
				label: "Anthropic",
				options: { ...mockOptions, opencodeGoModelId: "qwen3.7-max" },
				arm: (controller: AbortController) =>
					mockAnthropicCreate.mockImplementationOnce(() => {
						controller.abort()
						throw new Error("boom")
					}),
				sdkCall: mockAnthropicCreate,
			},
			{
				label: "Responses",
				options: { ...mockOptions, opencodeGoModelId: "gpt-5.6-luna" },
				arm: (controller: AbortController) =>
					mockResponsesCreate.mockImplementationOnce(() => {
						controller.abort()
						throw new Error("boom")
					}),
				sdkCall: mockResponsesCreate,
			},
			{
				label: "Chat Completions",
				options: mockOptions,
				arm: (controller: AbortController) =>
					mockCreate.mockImplementationOnce(() => {
						controller.abort()
						throw new Error("boom")
					}),
				sdkCall: mockCreate,
			},
		])(
			"classifies a caller cancel that lands inside the $label SDK call as an AbortError",
			async ({ options, arm, sdkCall }) => {
				// The cancel arrives during the SDK call and the SDK rejects with a generic error that
				// carries no abort shape, before any abort race is installed: only the caller signal can
				// classify it. The SDK-error tests cannot reach this arm because their mock decides the
				// classification instead of the signal.
				const controller = new AbortController()
				arm(controller)
				const handler = new OpencodeGoHandler(options)

				const error = await handler.completePrompt("ping", { abortSignal: controller.signal }).then(
					() => undefined,
					(e: unknown) => e,
				)
				expect(sdkCall).toHaveBeenCalledTimes(1) // the mock ran and threw the generic "boom"
				expect(error).toMatchObject({ name: "AbortError" })
				expect((error as Error).message).toBe("The Opencode Go request was aborted")
			},
		)

		it.each([
			{
				label: "Anthropic",
				options: { ...mockOptions, opencodeGoModelId: "qwen3.7-max" },
				arm: () =>
					mockAnthropicCreate.mockImplementationOnce(() => {
						throw new AnthropicTimeoutError()
					}),
				sdkCall: mockAnthropicCreate,
			},
			{
				label: "Responses",
				options: { ...mockOptions, opencodeGoModelId: "gpt-5.6-luna" },
				arm: () =>
					mockResponsesCreate.mockImplementationOnce(() => {
						throw new APIConnectionTimeoutError()
					}),
				sdkCall: mockResponsesCreate,
			},
			{
				label: "Chat Completions",
				options: mockOptions,
				arm: () =>
					mockCreate.mockImplementationOnce(() => {
						throw new APIConnectionTimeoutError()
					}),
				sdkCall: mockCreate,
			},
		])(
			"classifies the $label SDK's own timeout error without a provider deadline",
			async ({ options, arm, sdkCall }) => {
				// No timeoutMs and nothing aborted: the provider deadline is not what classifies this
				// failure, the SDK timeout class is. The deadline tests cannot isolate that arm because
				// their signal is already aborted by the time the SDK rejects, so the signal arm of the
				// condition would answer first.
				arm()
				const handler = new OpencodeGoHandler(options)

				const error = await handler.completePrompt("ping").then(
					() => undefined,
					(e: unknown) => e,
				)
				expect(sdkCall).toHaveBeenCalledTimes(1)
				expect(error).toMatchObject({ name: "AbortError" })
				expect((error as Error).message).toBe("The Opencode Go request was aborted")
			},
		)
	})
	describe("completePrompt shared timeout deadline", () => {
		// Stands in for a slow catalog lookup: the typed fetcher stays pending until the test releases
		// it, so "the deadline fired first" is an observable state the test can assert, not a race
		// against a fixed delay the test cannot see. The record it eventually resolves with is one
		// the provider can actually use, so the lookup could have continued had the deadline lost.
		const gateModelLookup = () => {
			let release!: () => void
			let pending = true
			const lookup = new Promise<Awaited<ReturnType<typeof getModels>>>((resolve) => {
				release = () => {
					pending = false
					resolve({
						"glm-5.1": { ...opencodeGoModels["glm-5.1"] },
						"qwen3.7-max": { ...opencodeGoModels["qwen3.7-max"] },
						"gpt-5.6-luna": { ...opencodeGoModels["gpt-5.6-luna"] },
					})
				}
			})
			vitest.mocked(getModels).mockImplementationOnce(() => lookup)
			return { isPending: () => pending, release }
		}

		it.each([
			[
				"Anthropic",
				() => new OpencodeGoHandler({ ...mockOptions, opencodeGoModelId: "qwen3.7-max" }),
				mockAnthropicCreate,
			],
			[
				"Responses",
				() => new OpencodeGoHandler({ ...mockOptions, opencodeGoModelId: "gpt-5.6-luna" }),
				mockResponsesCreate,
			],
			["OpenAI", () => new OpencodeGoHandler(mockOptions), mockCreate],
		])("bounds %s model resolution by the request timeout", async (_label, makeHandler, createMock) => {
			const handler = makeHandler() as OpencodeGoHandler
			const { isPending, release } = gateModelLookup()

			try {
				const error = await handler.completePrompt("ping", { timeoutMs: 20 }).catch((caught: unknown) => caught)

				expect(error).toMatchObject({ name: "AbortError" })
				expect((error as Error).message).toBe("The Opencode Go request was aborted")
				// The gate is the typed catalog fetcher, so this asserts the lookup really started.
				expect(vitest.mocked(getModels)).toHaveBeenCalledTimes(1)
				// The lookup was still parked when the deadline fired, which is the condition the old
				// 80 ms delay was approximating; it must still be pending here, and no completion
				// request may have started.
				expect(isPending()).toBe(true)
				expect(createMock).not.toHaveBeenCalled()
			} finally {
				// Release the parked lookup so the test leaves no pending promise behind.
				release()
			}
		})

		it("hands the dispatched request the cancellation scope that bounded model resolution", async () => {
			// No timeoutMs: mergeAbortSignalAndTimeout returns the caller's own signal, so the object
			// the SDK receives is observable. The catalog fetcher is parked first, so dispatch can only
			// happen after the lookup ran under that scope; a provider that built a fresh cancellation
			// scope at SDK dispatch would hand over a different object and a later deadline.
			const { isPending, release } = gateModelLookup()
			let sdkSignal: AbortSignal | undefined
			let sdkSettled = false
			mockCreate.mockImplementation((_params: unknown, options?: { signal?: AbortSignal }) => {
				sdkSignal = options?.signal
				const pending = new Promise<never>(() => {})
				void pending.then(() => {
					sdkSettled = true
				})
				return pending
			})
			const handler = new OpencodeGoHandler(mockOptions) as OpencodeGoHandler
			const controller = new AbortController()
			const settled = handler.completePrompt("ping", { abortSignal: controller.signal }).then(
				() => undefined,
				(caught: unknown) => caught,
			)

			try {
				await vitest.waitFor(() => expect(vitest.mocked(getModels)).toHaveBeenCalledTimes(1), {
					timeout: 1000,
					interval: 5,
				})
				// The lookup is still parked: nothing has been dispatched yet.
				expect(isPending()).toBe(true)
				release()
				await vitest.waitFor(() => expect(sdkSignal).toBeInstanceOf(AbortSignal), {
					timeout: 1000,
					interval: 5,
				})
			} finally {
				release()
			}

			// Same scope, not a re-armed one: reference identity is the only assertion a fresh
			// dispatch-phase controller can fail, and it needs no timing.
			expect(sdkSignal).toBe(controller.signal)
			expect(sdkSignal?.aborted).toBe(false)
			controller.abort()
			// No await between these two reads: the cancel has to reach the SDK-facing signal
			// when it happens, not by the time the completion settles.
			expect(sdkSignal?.aborted).toBe(true)

			const error = await settled
			expect(error).toMatchObject({ name: "AbortError" })
			expect((error as Error).message).toBe("The Opencode Go request was aborted")
			// The SDK promise never settled, so this rejection can only come from the provider's
			// race against the scope the lookup already used.
			expect(sdkSettled).toBe(false)
			expect(isPending()).toBe(false)
		})

		it.each([
			[
				"Anthropic",
				() => new OpencodeGoHandler({ ...mockOptions, opencodeGoModelId: "qwen3.7-max" }),
				mockAnthropicCreate,
			],
			["Chat Completions", () => new OpencodeGoHandler(mockOptions), mockCreate],
			[
				"Responses",
				() => new OpencodeGoHandler({ ...mockOptions, opencodeGoModelId: "gpt-5.6-luna" }),
				mockResponsesCreate,
			],
		])(
			"rejects at the deadline even while the SDK retry delay keeps the %s request pending",
			async (_label, makeHandler, createMock) => {
				// The SDK's internal retry backoff is not covered by the request signal; without the
				// rejectOnAbort race this promise would never settle and the test would time out.
				let requestSignal: AbortSignal | undefined
				let sdkSettled = false
				createMock.mockImplementation((_params: unknown, options?: { signal?: AbortSignal }) => {
					requestSignal = options?.signal
					const pending = new Promise<never>(() => {})
					void pending.then(() => {
						sdkSettled = true
					})
					return pending
				})
				const handler = makeHandler() as OpencodeGoHandler

				const error = await handler.completePrompt("ping", { timeoutMs: 30 }).catch((caught: unknown) => caught)

				expect(error).toMatchObject({ name: "AbortError" })
				expect((error as Error).message).toBe("The Opencode Go request was aborted")
				// The deadline's own effect plus the identity the race has to carry, not elapsed time: neither
				// reading changes when a worker stalls, which is what the removed 1 s bound hinged on.
				expect(requestSignal).toBeInstanceOf(AbortSignal)
				expect(requestSignal?.aborted).toBe(true)
				expect(sdkSettled).toBe(false)
			},
		)
	})

	// Regression evidence that every completePrompt wire format actually applies the shared
	// hasUsableTimeout/toSdkTimeoutMs contract: a disabled budget (NaN, Infinity, negative) must
	// never reach the SDK, and a usable one must arrive rounded up (the SDKs reject fractional
	// timeouts) and capped at the largest delay a Node timer accepts. Every row also carries the
	// caller's signal, so dropping the budget can never drop the cancellation scope.
	describe("completePrompt timeout option per wire format", () => {
		const timeoutRows: { label: string; timeoutMs: number; expected: number | undefined }[] = [
			{ label: "NaN", timeoutMs: Number.NaN, expected: undefined },
			{ label: "Infinity", timeoutMs: Number.POSITIVE_INFINITY, expected: undefined },
			{ label: "negative", timeoutMs: -5, expected: undefined },
			{ label: "fractional", timeoutMs: 12.5, expected: 13 },
			{ label: "above the Node timer cap", timeoutMs: MAX_TIMEOUT_MS + 1, expected: MAX_TIMEOUT_MS },
		]

		function assertTimeoutOption(
			requestOptions: { timeout?: number; signal?: AbortSignal } | undefined,
			expected: number | undefined,
			callerSignal: AbortSignal,
		): void {
			if (expected === undefined) {
				expect(Object.keys(requestOptions ?? {})).not.toContain("timeout")
				// With no usable timer the merged signal must be the caller's own signal: reference identity is
				// the only assertion a deadline-only signal cannot satisfy.
				expect(requestOptions?.signal).toBe(callerSignal)
			} else {
				expect(requestOptions?.timeout).toBe(expected)
				// With a usable timer the request runs under a merged deadline rather than the caller's own
				// signal, and the caller's cancel still has to reach it (pinned by the cancel test below).
				expect(requestOptions?.signal).toBeInstanceOf(AbortSignal)
				expect(requestOptions?.signal).not.toBe(callerSignal)
			}
		}

		it.each(timeoutRows)(
			"applies the $label timeoutMs to the Anthropic messages request options",
			async ({ timeoutMs, expected }) => {
				mockAnthropicCreate.mockResolvedValue({ content: [{ type: "text", text: "response" }] })
				const controller = new AbortController()
				const handler = new OpencodeGoHandler({ ...mockOptions, opencodeGoModelId: "qwen3.7-max" })
				await handler.completePrompt("ping", { abortSignal: controller.signal, timeoutMs })
				const call = mockAnthropicCreate.mock.calls[mockAnthropicCreate.mock.calls.length - 1]
				assertTimeoutOption(
					call[1] as { timeout?: number; signal?: AbortSignal } | undefined,
					expected,
					controller.signal,
				)
			},
		)

		it.each(timeoutRows)(
			"applies the $label timeoutMs to the Responses request options",
			async ({ timeoutMs, expected }) => {
				mockResponsesCreate.mockResolvedValue({ output_text: "response" })
				const controller = new AbortController()
				const handler = new OpencodeGoHandler({ ...mockOptions, opencodeGoModelId: "gpt-5.6-luna" })
				await handler.completePrompt("ping", { abortSignal: controller.signal, timeoutMs })
				const call = mockResponsesCreate.mock.calls[mockResponsesCreate.mock.calls.length - 1]
				assertTimeoutOption(
					call[1] as { timeout?: number; signal?: AbortSignal } | undefined,
					expected,
					controller.signal,
				)
			},
		)

		it.each(timeoutRows)(
			"applies the $label timeoutMs to the chat completions request options",
			async ({ timeoutMs, expected }) => {
				mockCreate.mockResolvedValue({ choices: [{ message: { content: "response" } }] })
				const controller = new AbortController()
				const handler = new OpencodeGoHandler(mockOptions)
				await handler.completePrompt("ping", { abortSignal: controller.signal, timeoutMs })
				const call = mockCreate.mock.calls[mockCreate.mock.calls.length - 1]
				assertTimeoutOption(
					call[1] as { timeout?: number; signal?: AbortSignal } | undefined,
					expected,
					controller.signal,
				)
			},
		)

		it.each([
			[
				"Anthropic",
				() => new OpencodeGoHandler({ ...mockOptions, opencodeGoModelId: "qwen3.7-max" }),
				mockAnthropicCreate,
			],
			[
				"Responses",
				() => new OpencodeGoHandler({ ...mockOptions, opencodeGoModelId: "gpt-5.6-luna" }),
				mockResponsesCreate,
			],
			["Chat Completions", () => new OpencodeGoHandler(mockOptions), mockCreate],
		])(
			"settles on a caller cancel while a usable timeout is armed for the %s request",
			async (_label, makeHandler, createMock) => {
				// A usable budget must not disable caller cancellation and a live-but-unusable signal must not
				// stand in for the budget: park the request under the merged deadline signal, cancel the caller
				// well before the deadline, and require the cancel to reach that signal.
				let sdkSignal: AbortSignal | undefined
				createMock.mockImplementationOnce((_params: unknown, options?: { signal?: AbortSignal }) => {
					sdkSignal = options?.signal
					return new Promise<never>(() => {})
				})
				const handler = makeHandler() as OpencodeGoHandler
				const controller = new AbortController()
				const settled = handler
					.completePrompt("ping", { abortSignal: controller.signal, timeoutMs: 5000 })
					.then(
						() => undefined,
						(e: unknown) => e,
					)

				await vitest.waitFor(() => expect(sdkSignal).toBeInstanceOf(AbortSignal), {
					timeout: 1000,
					interval: 5,
				})
				// Observable condition: the request runs under a merged deadline signal, not the caller's own.
				expect(sdkSignal).not.toBe(controller.signal)
				expect(sdkSignal?.aborted).toBe(false)
				controller.abort()
				// Asserted with no await in between: caller cancellation has to reach the signal the SDK
				// received at the moment of the cancel, not by the time the completion settles.
				expect(sdkSignal?.aborted).toBe(true)

				const error = await settled
				expect(error).toMatchObject({ name: "AbortError" })
				expect((error as Error).message).toBe("The Opencode Go request was aborted")
			},
		)
	})
})
