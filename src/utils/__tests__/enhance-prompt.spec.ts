// npx vitest run src/utils/__tests__/enhance-prompt.spec.ts

import type { ProviderSettings } from "@roo-code/types"

import { singleCompletionHandler } from "../single-completion-handler"
import { buildApiHandler, type ApiHandler, type SingleCompletionHandler } from "../../api"
import { supportPrompt } from "../../shared/support-prompt"
import { providerIdentifiers } from "@roo-code/types/provider-identifiers"

// Mock the API handler
vi.mock("../../api", () => ({
	buildApiHandler: vi.fn(),
	disposeApiHandler: vi.fn((handler?: { dispose?: () => void }) => handler?.dispose?.()),
}))

type ApiHandlerDouble = ApiHandler & { dispose?: () => void }
type CompletionHandlerDouble = ApiHandlerDouble & SingleCompletionHandler

const testModel = {
	id: "test-model",
	info: {
		maxTokens: 4096,
		contextWindow: 8192,
		supportsPromptCache: false,
	},
} satisfies ReturnType<ApiHandler["getModel"]>

const testModelCacheScope = {
	urlScoped: false,
	keyScoped: false,
	authScoped: false,
} satisfies ReturnType<ApiHandler["getModelCacheScope"]>

function createApiHandlerDouble(options: { dispose?: () => void } = {}): ApiHandlerDouble {
	const handler: ApiHandlerDouble = {
		createMessage: vi.fn(),
		getModel: vi.fn().mockReturnValue(testModel),
		countTokens: vi.fn().mockResolvedValue(0),
		getModelCacheScope: vi.fn().mockReturnValue(testModelCacheScope),
	}

	if (options.dispose) {
		handler.dispose = options.dispose
	}

	return handler
}

function createCompletionHandlerDouble(
	options: {
		completePrompt?: SingleCompletionHandler["completePrompt"]
		dispose?: () => void
	} = {},
): CompletionHandlerDouble {
	return {
		...createApiHandlerDouble(options),
		completePrompt: options.completePrompt ?? vi.fn().mockResolvedValue("Enhanced prompt"),
	}
}

function isCompletionHandler(handler: unknown): handler is SingleCompletionHandler {
	return (
		typeof handler === "object" &&
		handler !== null &&
		"completePrompt" in handler &&
		typeof handler.completePrompt === "function"
	)
}

function requireCompletionHandler(handler: unknown): SingleCompletionHandler {
	if (!isCompletionHandler(handler)) {
		throw new Error("Expected a completion-capable API handler")
	}

	return handler
}

describe("enhancePrompt", () => {
	const mockApiConfig: ProviderSettings = {
		apiProvider: providerIdentifiers.openai,
		openAiApiKey: "test-key",
		openAiBaseUrl: "https://api.openai.com/v1",
		enableReasoningEffort: false,
	}

	beforeEach(() => {
		vi.clearAllMocks()

		// Mock the API handler with a completePrompt method
		vi.mocked(buildApiHandler).mockReturnValue(createCompletionHandlerDouble())
	})

	it("enhances prompt using default enhancement prompt when no custom prompt provided", async () => {
		const result = await singleCompletionHandler(mockApiConfig, "Test prompt")

		expect(result).toBe("Enhanced prompt")
		const handler = buildApiHandler(mockApiConfig)
		expect(requireCompletionHandler(handler).completePrompt).toHaveBeenCalledWith(`Test prompt`, undefined)
	})

	it("disposes each handler it builds, after success and after failure", async () => {
		const succeeding = createCompletionHandlerDouble({
			completePrompt: vi.fn().mockResolvedValue("ok"),
			dispose: vi.fn(),
		})
		const failing = createCompletionHandlerDouble({
			completePrompt: vi.fn().mockRejectedValue(new Error("boom")),
			dispose: vi.fn(),
		})
		vi.mocked(buildApiHandler).mockReturnValueOnce(succeeding).mockReturnValueOnce(failing)

		await expect(singleCompletionHandler(mockApiConfig, "a")).resolves.toBe("ok")
		expect(succeeding.dispose).toHaveBeenCalledOnce()
		expect(failing.dispose).not.toHaveBeenCalled()

		await expect(singleCompletionHandler(mockApiConfig, "b")).rejects.toThrow("boom")
		expect(failing.dispose).toHaveBeenCalledOnce()
		expect(succeeding.dispose).toHaveBeenCalledOnce()
	})

	it("disposes the handler when the provider does not support prompt enhancement", async () => {
		const unsupported = createApiHandlerDouble({ dispose: vi.fn() })
		vi.mocked(buildApiHandler).mockReturnValueOnce(unsupported)

		await expect(singleCompletionHandler(mockApiConfig, "a")).rejects.toThrow(
			"The selected API provider does not support prompt enhancement",
		)
		expect(unsupported.dispose).toHaveBeenCalledOnce()
	})

	it("enhances prompt using custom enhancement prompt when provided", async () => {
		const customEnhancePrompt = "You are a custom prompt enhancer"
		const customEnhancePromptWithTemplate = customEnhancePrompt + "\n\n${userInput}"

		const result = await singleCompletionHandler(
			mockApiConfig,
			supportPrompt.create(
				"ENHANCE",
				{
					userInput: "Test prompt",
				},
				{
					ENHANCE: customEnhancePromptWithTemplate,
				},
			),
		)

		expect(result).toBe("Enhanced prompt")
		const handler = buildApiHandler(mockApiConfig)
		expect(requireCompletionHandler(handler).completePrompt).toHaveBeenCalledWith(
			`${customEnhancePrompt}\n\nTest prompt`,
			undefined,
		)
	})

	it("throws error for empty prompt input", async () => {
		await expect(singleCompletionHandler(mockApiConfig, "")).rejects.toThrow("No prompt text provided")
	})

	it("throws error for missing API configuration", async () => {
		await expect(singleCompletionHandler({} as ProviderSettings, "Test prompt")).rejects.toThrow(
			"No valid API configuration provided",
		)
	})

	it("throws error for API provider that does not support prompt enhancement", async () => {
		vi.mocked(buildApiHandler).mockReturnValue(createApiHandlerDouble())

		await expect(singleCompletionHandler(mockApiConfig, "Test prompt")).rejects.toThrow(
			"The selected API provider does not support prompt enhancement",
		)
	})

	it("uses appropriate model based on provider", async () => {
		const openRouterConfig: ProviderSettings = {
			apiProvider: providerIdentifiers.openrouter,
			openRouterApiKey: "test-key",
			openRouterModelId: "test-model",
			enableReasoningEffort: false,
		}

		// Mock successful enhancement
		vi.mocked(buildApiHandler).mockReturnValue(createCompletionHandlerDouble())

		const result = await singleCompletionHandler(openRouterConfig, "Test prompt")

		expect(buildApiHandler).toHaveBeenCalledWith(openRouterConfig)
		expect(result).toBe("Enhanced prompt")
	})

	it("propagates API errors", async () => {
		vi.mocked(buildApiHandler).mockReturnValue(
			createCompletionHandlerDouble({
				completePrompt: vi.fn().mockRejectedValue(new Error("API Error")),
			}),
		)

		await expect(singleCompletionHandler(mockApiConfig, "Test prompt")).rejects.toThrow("API Error")
	})
})
