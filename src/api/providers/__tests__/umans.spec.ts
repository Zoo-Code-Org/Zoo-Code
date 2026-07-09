// npx vitest run api/providers/__tests__/umans.spec.ts

vitest.mock("../utils/timeout-config", () => ({
	getApiRequestTimeout: vitest.fn().mockReturnValue(300_000),
}))

const MOCK_TIMEOUT_MS = 300_000

import { Anthropic } from "@anthropic-ai/sdk"
import OpenAI from "openai"

import { UmansHandler } from "../umans"
import type { ApiHandlerOptions } from "../../../shared/api"
import { Package } from "../../../shared/package"

const mockCreate = vitest.fn()

vitest.mock("openai", () => ({
	default: vitest.fn().mockImplementation(function () {
		return {
			chat: {
				completions: {
					create: mockCreate,
				},
			},
		}
	}),
}))

vitest.mock("../fetchers/modelCache", () => ({
	getModels: vitest.fn().mockResolvedValue({
		"umans-coder": {
			maxTokens: 32768,
			contextWindow: 262144,
			supportsImages: true,
			supportsPromptCache: false,
			supportsMaxTokens: true,
			inputPrice: 0.95,
			outputPrice: 4,
			description: "Umans Coder",
		},
		"umans-glm-5.2": {
			maxTokens: 131071,
			contextWindow: 405504,
			supportsImages: true,
			supportsPromptCache: false,
			supportsMaxTokens: true,
			supportsReasoningEffort: ["none", "high", "max"],
			reasoningEffort: "high",
			inputPrice: 1.4,
			outputPrice: 4.4,
			description: "Umans GLM 5.2",
		},
	}),
}))

describe("UmansHandler", () => {
	const mockOptions: ApiHandlerOptions = {
		umansApiKey: "test-key",
		umansModelId: "umans-coder",
	}

	beforeEach(() => vitest.clearAllMocks())

	it("initializes with the Umans base URL and API key", () => {
		new UmansHandler(mockOptions)

		expect(OpenAI).toHaveBeenCalledWith({
			baseURL: "https://api.code.umans.ai/v1",
			apiKey: "test-key",
			defaultHeaders: {
				"HTTP-Referer": "https://github.com/Zoo-Code-Org/Zoo-Code",
				"X-Title": "Zoo Code",
				"User-Agent": `ZooCode/${Package.version}`,
			},
			timeout: MOCK_TIMEOUT_MS,
		})
	})

	it("returns the default model when no options are provided", async () => {
		const handler = new UmansHandler({})
		const result = await handler.fetchModel()

		expect(result.id).toBe("umans-coder")
		expect(result.info.description).toBe("Umans Coder")
	})

	it("uses the provider's default OpenAI reasoning payload for Umans GLM models", async () => {
		const handler = new UmansHandler({
			umansApiKey: "test-key",
			umansModelId: "umans-glm-5.2",
			reasoningEffort: "max",
		})

		const mockStream = {
			async *[Symbol.asyncIterator]() {
				yield {
					choices: [{ delta: { content: "done" } }],
				}
			},
		}

		mockCreate.mockResolvedValue(mockStream)

		const generator = handler.createMessage("system prompt", [{ role: "user" as const, content: "test" }])
		await generator.next()

		expect(mockCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				model: "umans-glm-5.2",
				reasoning_effort: "max",
				stream: true,
			}),
		)
	})
})
