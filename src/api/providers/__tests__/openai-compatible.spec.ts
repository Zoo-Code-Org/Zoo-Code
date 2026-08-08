// npx vitest run api/providers/__tests__/openai-compatible.spec.ts

import OpenAI from "openai"

import type { ModelInfo } from "@roo-code/types"

import { OpenAICompatibleHandler, type OpenAICompatibleConfig } from "../openai-compatible"

const mockStreamText = vi.fn()

// Mock the AI SDK streamText to capture request options without network calls.
vi.mock("ai", async (importOriginal) => {
	const actual = await importOriginal<typeof import("ai")>()
	return {
		...actual,
		streamText: (...args: unknown[]) => mockStreamText(...args),
		generateText: vi.fn(),
	}
})

// Mock @ai-sdk/openai-compatible so no real provider is constructed.
vi.mock("@ai-sdk/openai-compatible", () => ({
	createOpenAICompatible: vi.fn(() => {
		return (modelId: string) => ({ modelId })
	}),
}))

const testModelInfo: ModelInfo = {
	maxTokens: 4096,
	contextWindow: 128000,
	supportsImages: false,
	supportsPromptCache: false,
	inputPrice: 0,
	outputPrice: 0,
}

const toolDef: OpenAI.Chat.ChatCompletionTool[] = [
	{
		type: "function",
		function: {
			name: "read_file",
			description: "Read a file",
			parameters: { type: "object", properties: {} },
		},
	},
]

class TestHandler extends OpenAICompatibleHandler {
	/** Records the (tools, strict) args of every internal convertToolsForOpenAI call. */
	public convertCalls: Array<{ tools: OpenAI.Chat.ChatCompletionTool[] | undefined; strict: boolean }> = []

	constructor(strict: boolean | undefined) {
		const config: OpenAICompatibleConfig = {
			providerName: "test",
			baseURL: "https://test.example.com/v1",
			apiKey: "test-key",
			modelId: "test-model",
			modelInfo: testModelInfo,
		}
		super({ openAiToolStrictMode: strict }, config)
	}

	override getModel(): { id: string; info: ModelInfo } {
		return { id: "test-model", info: testModelInfo }
	}

	protected override convertToolsForOpenAI(
		tools: OpenAI.Chat.ChatCompletionTool[] | undefined,
		strict = false,
	) {
		this.convertCalls.push({ tools, strict })
		return super.convertToolsForOpenAI(tools, strict)
	}
}

describe("OpenAICompatibleHandler", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockStreamText.mockReturnValue({
			fullStream: (async function* () {
				yield { type: "text-delta", textDelta: "ok" }
			})(),
			usage: Promise.resolve({ inputTokens: 1, outputTokens: 1 }),
		})
	})

	it("should pass strict: false to convertToolsForOpenAI when openAiToolStrictMode is unset", async () => {
		const handler = new TestHandler(undefined)

		const stream = handler.createMessage("system", [])
		for await (const _ of stream) {
			// drain
		}

		expect(handler.convertCalls).toEqual([{ tools: undefined, strict: false }])
	})

	it("should pass strict: true to convertToolsForOpenAI when openAiToolStrictMode is enabled", async () => {
		const handler = new TestHandler(true)

		const stream = handler.createMessage("system", [], { taskId: "t1", tools: toolDef })
		for await (const _ of stream) {
			// drain
		}

		expect(handler.convertCalls).toEqual([{ tools: toolDef, strict: true }])
	})
})
