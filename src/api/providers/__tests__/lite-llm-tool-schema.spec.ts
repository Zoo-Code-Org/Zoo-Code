import { Anthropic } from "@anthropic-ai/sdk"
import type OpenAI from "openai"

import { litellmDefaultModelId, litellmDefaultModelInfo, type ModelInfo } from "@roo-code/types"

import { LiteLLMHandler } from "../lite-llm"
import { BaseProvider } from "../base-provider"
import type { ApiStream } from "../../transform/stream"
import type { ApiHandlerOptions } from "../../../shared/api"
import { makeCreateMessageMetadata } from "../../../test-utils/api"
import { asyncStreamFrom, collectStream } from "../../../test-utils/stream"
import { clearAllMocks } from "../../../test-utils/reset"

// Mock vscode first to avoid import errors
vi.mock("vscode", () => ({
	workspace: {
		getConfiguration: () => ({
			get: (_key: string, defaultValue?: unknown) => defaultValue,
		}),
	},
}))

// Mock OpenAI
const mockCreate = vi.fn()

vi.mock("openai", () => {
	return {
		default: vi.fn().mockImplementation(function () {
			return {
				chat: {
					completions: {
						create: mockCreate,
					},
				},
			}
		}),
	}
})

// Mock model fetching
vi.mock("../fetchers/modelCache", () => ({
	getModels: vi.fn().mockImplementation(function () {
		return Promise.resolve({
			[litellmDefaultModelId]: litellmDefaultModelInfo,
			// The issue's repro: Claude Sonnet 5 behind a LiteLLM proxy backed by AWS Bedrock.
			"claude-sonnet-5": { ...litellmDefaultModelInfo, maxTokens: 8192 },
		})
	}),
	refreshModels: vi.fn(async (options, handler) => {
		const { getModels } = await import("../fetchers/modelCache")
		return getModels(options, handler)
	}),
	getModelsFromCache: vi.fn().mockReturnValue(undefined),
}))

/**
 * Expose the shared tool-conversion helper so the strict-mode contract of every
 * route shape (default, strict-disabled, strict-unaware) can be pinned from one
 * subclass.
 */
class StrictModeProbe extends BaseProvider {
	createMessage(_systemPrompt: string, _messages: Anthropic.Messages.MessageParam[]): ApiStream {
		throw new Error("Not implemented")
	}

	getModel(): { id: string; info: ModelInfo } {
		return {
			id: "test-model",
			info: {
				maxTokens: 4096,
				contextWindow: 128000,
				supportsPromptCache: false,
			},
		}
	}

	exposeTools(tools: OpenAI.Chat.ChatCompletionFunctionTool[]): OpenAI.Chat.ChatCompletionFunctionTool[] | undefined {
		return this.convertToolsForOpenAI(tools)
	}

	exposeToolsWithStrict(
		tools: OpenAI.Chat.ChatCompletionFunctionTool[],
		strict: boolean,
	): OpenAI.Chat.ChatCompletionFunctionTool[] | undefined {
		return this.convertToolsForOpenAI(tools, strict)
	}

	exposeToolsStrictUnaware(
		tools: OpenAI.Chat.ChatCompletionFunctionTool[],
	): OpenAI.Chat.ChatCompletionFunctionTool[] | undefined {
		return this.convertToolsForOpenAI(tools, null)
	}
}

// A nullable declared type: strict-mode rewriting would flatten it and inject
// additionalProperties, so it doubles as the schema-preservation probe.
const nullableParameters = {
	type: "object",
	properties: {
		path: { type: ["string", "null"] },
	},
	required: ["path"],
}

function buildTools(): OpenAI.Chat.ChatCompletionFunctionTool[] {
	return [
		{
			type: "function",
			function: {
				name: "read_file",
				description: "Read a file",
				parameters: nullableParameters,
			},
		},
		{
			type: "function",
			function: {
				name: "mcp--github--get_me",
				description: "Get current user",
				parameters: { type: "object", properties: { token: { type: "string" } }, required: ["token"] },
			},
		},
		// A caller that supplies its own strict flag: the emitted payload must not
		// inherit it (it would reintroduce the Bedrock 400).
		{
			type: "function",
			function: {
				name: "carry_strict",
				description: "Caller supplied strict",
				strict: true,
				parameters: { type: "object", properties: {}, required: [] },
			},
		},
	]
}

describe("LiteLLM tool schema (issue #1137)", () => {
	let handler: LiteLLMHandler
	let mockOptions: ApiHandlerOptions

	beforeEach(() => {
		clearAllMocks()
		mockOptions = {
			litellmApiKey: "test-litellm-key",
			litellmBaseUrl: "http://localhost:4000",
			litellmModelId: "claude-sonnet-5",
		}
		handler = new LiteLLMHandler(mockOptions)
	})

	function mockStream() {
		mockCreate.mockReturnValue({
			withResponse: vi.fn().mockResolvedValue({
				data: asyncStreamFrom([
					{
						choices: [{ delta: { content: "ok" } }],
						usage: { prompt_tokens: 1, completion_tokens: 1 },
					},
				]),
			}),
		})
	}

	it("sends no strict field on any tool to claude-sonnet-5 (Bedrock rejects tools.0.custom.strict)", async () => {
		// Bedrock answers LiteLLM's forwarded request with
		// "tools.0.custom.strict: Extra inputs are not permitted" before inference
		// starts: the OpenAI-specific strict key must never reach this route.
		vi.spyOn(handler, "fetchModel").mockResolvedValue({
			id: "claude-sonnet-5",
			info: { ...litellmDefaultModelInfo, maxTokens: 8192 },
		})
		mockStream()

		const metadata = makeCreateMessageMetadata({ tools: buildTools() })
		await collectStream(handler.createMessage("system", [{ role: "user", content: "Hello" }], metadata))

		const request = mockCreate.mock.calls[0][0] as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming
		expect(request.model).toBe("claude-sonnet-5")
		expect(request.tools).toHaveLength(3)

		const [plain, mcp, carrier] = (request.tools ?? []) as OpenAI.Chat.ChatCompletionFunctionTool[]

		// Strict absence contracts: toStrictEqual fails on the extra strict key.
		expect(plain).toStrictEqual({
			type: "function",
			function: {
				name: "read_file",
				description: "Read a file",
				parameters: nullableParameters,
			},
		})
		expect(mcp).toStrictEqual({
			type: "function",
			function: {
				name: "mcp--github--get_me",
				description: "Get current user",
				parameters: { type: "object", properties: { token: { type: "string" } }, required: ["token"] },
			},
		})
		// An inherited strict flag from the caller is dropped, not re-emitted.
		expect(carrier).toStrictEqual({
			type: "function",
			function: {
				name: "carry_strict",
				description: "Caller supplied strict",
				parameters: { type: "object", properties: {}, required: [] },
			},
		})
	})

	it("preserves the declared schema without strict-mode rewriting", async () => {
		// The declared nullable type must reach the proxy untouched: rewriting it
		// (flattened type, injected additionalProperties) changes what the backend
		// model sees for no benefit on a pass-through route.
		vi.spyOn(handler, "fetchModel").mockResolvedValue({
			id: "claude-sonnet-5",
			info: { ...litellmDefaultModelInfo, maxTokens: 8192 },
		})
		mockStream()

		const metadata = makeCreateMessageMetadata({ tools: buildTools() })
		await collectStream(handler.createMessage("system", [{ role: "user", content: "Hello" }], metadata))

		const request = mockCreate.mock.calls[0][0] as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming
		const [sentTool] = (request.tools ?? []) as OpenAI.Chat.ChatCompletionFunctionTool[]
		expect(sentTool?.function.parameters).toStrictEqual(nullableParameters)
	})
})

describe("convertToolsForOpenAI strict-mode routes", () => {
	let provider: StrictModeProbe

	beforeEach(() => {
		provider = new StrictModeProbe()
	})

	it("keeps the default strict-aware contract for OpenAI-shaped routes", () => {
		const [fnTool, mcpTool, carrierTool] = provider.exposeTools(buildTools()) ?? []

		// OpenAI-strict routes keep strict: true on non-MCP tools, strict: false
		// on MCP tools, and the schema rewritten for strict adherence.
		expect(fnTool?.function.strict).toBe(true)
		expect(mcpTool?.function.strict).toBe(false)
		expect(carrierTool?.function.strict).toBe(true)
		const strictParameters = fnTool?.function.parameters
		expect(strictParameters?.additionalProperties).toBe(false)
		expect(strictParameters?.required).toEqual(["path"])
		expect((strictParameters?.properties as { path?: { type?: unknown } } | undefined)?.path).toEqual({
			type: "string",
		})
	})

	it("still sends strict false with a preserved schema on strict-disabled routes", () => {
		const result = provider.exposeToolsWithStrict(buildTools(), false)

		expect(result?.[0].function.strict).toBe(false)
		expect(result?.[0].function.parameters).toStrictEqual(nullableParameters)
	})

	it("omits the strict key entirely on the strict-unaware mode", () => {
		const result = provider.exposeToolsStrictUnaware(buildTools())

		// No strict key on any function tool - emitted, MCP-disabled, or inherited
		// from the caller - and declared schemas preserved as-is.
		expect(result?.[0].function).toStrictEqual({
			name: "read_file",
			description: "Read a file",
			parameters: nullableParameters,
		})
		expect(result?.[1].function).toStrictEqual({
			name: "mcp--github--get_me",
			description: "Get current user",
			parameters: { type: "object", properties: { token: { type: "string" } }, required: ["token"] },
		})
		expect(result?.[2].function).toStrictEqual({
			name: "carry_strict",
			description: "Caller supplied strict",
			parameters: { type: "object", properties: {}, required: [] },
		})
	})
})
