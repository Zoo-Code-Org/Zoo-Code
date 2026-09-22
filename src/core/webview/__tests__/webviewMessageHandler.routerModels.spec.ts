import { describe, it, expect, vi, beforeEach } from "vitest"

import {
	kimiCodeAuthMethodSchema,
	providerIdentifiers,
	retiredProviderIdentifiers,
	RouterModelsMessageType,
} from "@roo-code/types"

import { webviewMessageHandler } from "../webviewMessageHandler"
import type { ClineProvider } from "../ClineProvider"

const [kimiCodeOAuthAuthMethod, kimiCodeApiKeyAuthMethod] = kimiCodeAuthMethodSchema.options

const { getKimiCodeAccessTokenMock } = vi.hoisted(() => ({
	getKimiCodeAccessTokenMock: vi.fn(),
}))

vi.mock("../../../integrations/kimi-code/oauth", () => ({
	kimiCodeOAuthManager: {
		getAccessToken: getKimiCodeAccessTokenMock,
	},
}))

// Mock vscode (minimal)
vi.mock("vscode", () => ({
	window: {
		showErrorMessage: vi.fn(),
		showWarningMessage: vi.fn(),
		showInformationMessage: vi.fn(),
	},
	workspace: {
		workspaceFolders: undefined,
		getConfiguration: vi.fn(() => ({
			get: vi.fn(),
			update: vi.fn(),
		})),
	},
	env: {
		clipboard: { writeText: vi.fn() },
		openExternal: vi.fn(),
	},
	commands: {
		executeCommand: vi.fn(),
	},
	Uri: {
		parse: vi.fn((s: string) => ({ toString: () => s })),
		file: vi.fn((p: string) => ({ fsPath: p })),
	},
	ConfigurationTarget: {
		Global: 1,
		Workspace: 2,
		WorkspaceFolder: 3,
	},
}))

// Mock modelCache getModels/flushModels used by the handler
const getModelsMock = vi.fn()
const flushModelsMock = vi.fn()
vi.mock("../../../api/providers/fetchers/modelCache", () => ({
	getModels: (...args: any[]) => getModelsMock(...args),
	flushModels: (...args: any[]) => flushModelsMock(...args),
}))

type MockRouterModelsProvider = ClineProvider & {
	postMessageToWebview: ReturnType<typeof vi.fn>
	getState: ReturnType<typeof vi.fn>
	contextProxy: unknown
	log: ReturnType<typeof vi.fn>
}

// The handler only touches these members; cast the literal once so every describe below
// shares the same double.
const makeMockProvider = (): MockRouterModelsProvider =>
	({
		postMessageToWebview: vi.fn(),
		getState: vi.fn().mockResolvedValue({ apiConfiguration: {} }),
		contextProxy: {
			getValue: vi.fn(),
			setValue: vi.fn(),
			globalStorageUri: { fsPath: "/mock/storage" },
		},
		log: vi.fn(),
	}) as any

describe("webviewMessageHandler - requestRouterModels provider filter", () => {
	let mockProvider: MockRouterModelsProvider

	beforeEach(() => {
		vi.clearAllMocks()

		mockProvider = makeMockProvider()

		// Default mock: return distinct model maps per provider so we can verify keys
		getModelsMock.mockImplementation(async (options: any) => {
			switch (options?.provider) {
				case providerIdentifiers.openrouter:
					return { "openrouter/qwen2.5": { contextWindow: 32768, supportsPromptCache: false } }
				case providerIdentifiers.requesty:
					return { "requesty/model": { contextWindow: 8192, supportsPromptCache: false } }
				case providerIdentifiers.vercelAiGateway:
					return { "vercel/model": { contextWindow: 8192, supportsPromptCache: false } }
				case providerIdentifiers.litellm:
					return { "litellm/model": { contextWindow: 8192, supportsPromptCache: false } }
				default:
					return {}
			}
		})
	})

	it("returns explicit removal error for requestRooModels", async () => {
		await webviewMessageHandler(mockProvider as any, { type: "requestRooModels" } as any)

		expect(mockProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: RouterModelsMessageType.singleRouterModelFetchResponse,
			success: false,
			error: "Roo Code Router has been removed. Please select and configure a different provider.",
			values: { provider: retiredProviderIdentifiers.roo },
		})
	})

	it("defaults to aggregate fetching when no provider filter is sent", async () => {
		await webviewMessageHandler(
			mockProvider as any,
			{
				type: RouterModelsMessageType.requestRouterModels,
			} as any,
		)

		const call = (mockProvider.postMessageToWebview as any).mock.calls.find(
			(c: any[]) => c[0]?.type === RouterModelsMessageType.routerModels,
		)
		expect(call).toBeTruthy()
		const routerModels = call[0].routerModels as Record<string, Record<string, any>>

		// Aggregate handler initializes many known routers - ensure a few expected keys exist
		expect(routerModels).toHaveProperty(providerIdentifiers.openrouter)
		expect(routerModels).toHaveProperty(providerIdentifiers.requesty)
		expect(routerModels).toHaveProperty(providerIdentifiers.deepseek)
		expect(routerModels).toHaveProperty(providerIdentifiers.moonshot)
		expect(routerModels.deepseek).toEqual({})
		expect(routerModels.moonshot).toEqual({})
		expect(getModelsMock).not.toHaveBeenCalledWith(
			expect.objectContaining({ provider: providerIdentifiers.deepseek }),
		)
		expect(getModelsMock).not.toHaveBeenCalledWith(
			expect.objectContaining({ provider: providerIdentifiers.moonshot }),
		)
	})

	it("fetches DeepSeek models when stored DeepSeek credentials exist", async () => {
		mockProvider.getState.mockResolvedValue({
			apiConfiguration: {
				deepSeekApiKey: "stored-deepseek-key",
				deepSeekBaseUrl: "https://deepseek.example.com",
			},
		})

		getModelsMock.mockImplementation(async (options: any) => {
			if (options?.provider === providerIdentifiers.deepseek) {
				return { "deepseek-v4-flash": { contextWindow: 1_000_000, supportsPromptCache: true } }
			}

			switch (options?.provider) {
				case providerIdentifiers.openrouter:
					return { "openrouter/qwen2.5": { contextWindow: 32768, supportsPromptCache: false } }
				case providerIdentifiers.requesty:
					return { "requesty/model": { contextWindow: 8192, supportsPromptCache: false } }
				case providerIdentifiers.vercelAiGateway:
					return { "vercel/model": { contextWindow: 8192, supportsPromptCache: false } }
				case providerIdentifiers.litellm:
					return { "litellm/model": { contextWindow: 8192, supportsPromptCache: false } }
				default:
					return {}
			}
		})

		await webviewMessageHandler(
			mockProvider as any,
			{
				type: RouterModelsMessageType.requestRouterModels,
			} as any,
		)

		expect(getModelsMock).toHaveBeenCalledWith({
			provider: providerIdentifiers.deepseek,
			apiKey: "stored-deepseek-key",
			baseUrl: "https://deepseek.example.com",
		})

		const call = (mockProvider.postMessageToWebview as any).mock.calls.find(
			(c: any[]) => c[0]?.type === RouterModelsMessageType.routerModels,
		)
		expect(call).toBeTruthy()
		expect(call[0].routerModels.deepseek).toEqual({
			"deepseek-v4-flash": { contextWindow: 1_000_000, supportsPromptCache: true },
		})
	})

	it("posts a DeepSeek provider error and keeps an empty aggregate entry when DeepSeek fetch fails", async () => {
		mockProvider.getState.mockResolvedValue({
			apiConfiguration: {
				deepSeekApiKey: "stored-deepseek-key",
			},
		})

		getModelsMock.mockImplementation(async (options: any) => {
			if (options?.provider === providerIdentifiers.deepseek) {
				throw new Error("DeepSeek API error")
			}

			switch (options?.provider) {
				case providerIdentifiers.openrouter:
					return { "openrouter/qwen2.5": { contextWindow: 32768, supportsPromptCache: false } }
				case providerIdentifiers.requesty:
					return { "requesty/model": { contextWindow: 8192, supportsPromptCache: false } }
				case providerIdentifiers.vercelAiGateway:
					return { "vercel/model": { contextWindow: 8192, supportsPromptCache: false } }
				case providerIdentifiers.litellm:
					return { "litellm/model": { contextWindow: 8192, supportsPromptCache: false } }
				default:
					return {}
			}
		})

		await webviewMessageHandler(
			mockProvider as any,
			{
				type: RouterModelsMessageType.requestRouterModels,
			} as any,
		)

		expect(mockProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: RouterModelsMessageType.singleRouterModelFetchResponse,
			success: false,
			error: "DeepSeek API error",
			values: { provider: providerIdentifiers.deepseek },
		})

		const call = (mockProvider.postMessageToWebview as any).mock.calls.find(
			(c: any[]) => c[0]?.type === RouterModelsMessageType.routerModels,
		)
		expect(call).toBeTruthy()
		expect(call[0].routerModels.deepseek).toEqual({})
	})

	it("supports filtering another single provider ('openrouter')", async () => {
		await webviewMessageHandler(
			mockProvider as any,
			{
				type: RouterModelsMessageType.requestRouterModels,
				values: { provider: providerIdentifiers.openrouter },
			} as any,
		)

		const call = (mockProvider.postMessageToWebview as any).mock.calls.find(
			(c: any[]) => c[0]?.type === RouterModelsMessageType.routerModels,
		)
		expect(call).toBeTruthy()
		const routerModels = call[0].routerModels as Record<string, Record<string, any>>
		const keys = Object.keys(routerModels)

		expect(keys).toEqual([providerIdentifiers.openrouter])
		expect(Object.keys(routerModels.openrouter || {})).toContain("openrouter/qwen2.5")

		const providersCalled = getModelsMock.mock.calls.map((c: any[]) => c[0]?.provider)
		expect(providersCalled).toEqual([providerIdentifiers.openrouter])
	})

	it("filters to Kimi Code and dispatches an explicit API key without reading the OAuth token", async () => {
		const kimiModels = { "kimi-for-coding": { contextWindow: 262_144, supportsPromptCache: true } }
		getModelsMock.mockResolvedValue(kimiModels)

		await webviewMessageHandler(mockProvider, {
			type: RouterModelsMessageType.requestRouterModels,
			values: {
				provider: providerIdentifiers.kimiCode,
				kimiCodeAuthMethod: kimiCodeApiKeyAuthMethod,
				kimiCodeApiKey: "preview-kimi-api-key",
			},
		})

		expect(getKimiCodeAccessTokenMock).not.toHaveBeenCalled()
		expect(getModelsMock).toHaveBeenCalledTimes(1)
		expect(getModelsMock).toHaveBeenCalledWith({
			provider: providerIdentifiers.kimiCode,
			apiKey: "preview-kimi-api-key",
		})

		const response = mockProvider.postMessageToWebview.mock.calls.find(
			(call) => call[0]?.type === RouterModelsMessageType.routerModels,
		)
		expect(response).toBeDefined()
		if (!response) throw new Error("Expected routerModels response")
		expect(response[0].routerModels).toEqual({ [providerIdentifiers.kimiCode]: kimiModels })
	})

	it("filters to Kimi Code and dispatches the OAuth access token", async () => {
		getKimiCodeAccessTokenMock.mockResolvedValue("kimi-oauth-token")

		await webviewMessageHandler(mockProvider, {
			type: RouterModelsMessageType.requestRouterModels,
			values: {
				provider: providerIdentifiers.kimiCode,
				kimiCodeAuthMethod: kimiCodeOAuthAuthMethod,
			},
		})

		expect(getKimiCodeAccessTokenMock).toHaveBeenCalledTimes(1)
		expect(getModelsMock).toHaveBeenCalledTimes(1)
		expect(getModelsMock).toHaveBeenCalledWith({
			provider: providerIdentifiers.kimiCode,
			apiKey: "kimi-oauth-token",
		})
	})

	it("excludes Kimi Code from model fetching when OAuth has no access token", async () => {
		getKimiCodeAccessTokenMock.mockResolvedValue(null)

		await webviewMessageHandler(mockProvider, {
			type: RouterModelsMessageType.requestRouterModels,
			values: {
				provider: providerIdentifiers.kimiCode,
				kimiCodeAuthMethod: kimiCodeOAuthAuthMethod,
			},
		})

		expect(getKimiCodeAccessTokenMock).toHaveBeenCalledTimes(1)
		expect(getModelsMock).not.toHaveBeenCalled()

		const response = mockProvider.postMessageToWebview.mock.calls.find(
			(call) => call[0]?.type === RouterModelsMessageType.routerModels,
		)
		expect(response).toBeDefined()
		if (!response) throw new Error("Expected routerModels response")
		expect(response[0].routerModels).toEqual({})
	})

	it("flushes cache when LiteLLM credentials are provided in message values", async () => {
		// Provide LiteLLM credentials via message.values (simulating Refresh Models button)
		await webviewMessageHandler(
			mockProvider as any,
			{
				type: RouterModelsMessageType.requestRouterModels,
				values: {
					litellmApiKey: "test-api-key",
					litellmBaseUrl: "http://localhost:4000",
				},
			} as any,
		)

		// flushModels should have been called for litellm with refresh=true and credentials
		expect(flushModelsMock).toHaveBeenCalledWith(
			{ provider: providerIdentifiers.litellm, apiKey: "test-api-key", baseUrl: "http://localhost:4000" },
			true,
		)

		// getModels should have been called with the provided credentials
		const litellmCalls = getModelsMock.mock.calls.filter(
			(c: any[]) => c[0]?.provider === providerIdentifiers.litellm,
		)
		expect(litellmCalls.length).toBe(1)
		expect(litellmCalls[0][0]).toEqual({
			provider: providerIdentifiers.litellm,
			apiKey: "test-api-key",
			baseUrl: "http://localhost:4000",
		})
	})

	it("does not flush cache when using stored LiteLLM credentials", async () => {
		// Provide stored credentials via apiConfiguration
		mockProvider.getState.mockResolvedValue({
			apiConfiguration: {
				litellmApiKey: "stored-api-key",
				litellmBaseUrl: "http://stored:4000",
			},
		})

		await webviewMessageHandler(
			mockProvider as any,
			{
				type: RouterModelsMessageType.requestRouterModels,
			} as any,
		)

		// flushModels should NOT have been called for litellm
		const litellmFlushCalls = flushModelsMock.mock.calls.filter(
			(c: any[]) => c[0]?.provider === providerIdentifiers.litellm,
		)
		expect(litellmFlushCalls.length).toBe(0)

		// getModels should still have been called with stored credentials
		const litellmCalls = getModelsMock.mock.calls.filter(
			(c: any[]) => c[0]?.provider === providerIdentifiers.litellm,
		)
		expect(litellmCalls.length).toBe(1)
		expect(litellmCalls[0][0]).toEqual({
			provider: providerIdentifiers.litellm,
			apiKey: "stored-api-key",
			baseUrl: "http://stored:4000",
		})
	})

	it("flushes and fetches Poe models with explicit unsaved credentials", async () => {
		const poeModels = { "claude-sonnet": { contextWindow: 200_000, supportsPromptCache: false } }
		getModelsMock.mockImplementation(async (options: { provider?: string }) =>
			options.provider === providerIdentifiers.poe ? poeModels : {},
		)

		await webviewMessageHandler(mockProvider, {
			type: RouterModelsMessageType.requestRouterModels,
			values: {
				poeApiKey: "new-poe-key",
				poeBaseUrl: "https://poe.example.com/v1",
			},
		})

		const poeOptions = {
			provider: providerIdentifiers.poe,
			apiKey: "new-poe-key",
			baseUrl: "https://poe.example.com/v1",
		}
		expect(flushModelsMock).toHaveBeenCalledWith(poeOptions, true)
		expect(getModelsMock).toHaveBeenCalledWith(poeOptions)

		const response = mockProvider.postMessageToWebview.mock.calls.find(
			(call) => call[0]?.type === RouterModelsMessageType.routerModels,
		)
		expect(response).toBeDefined()
		if (!response) throw new Error("Expected routerModels response")
		expect(response[0].routerModels.poe).toEqual(poeModels)
	})

	it("flushes DeepSeek models when an unsaved base URL is paired with the stored API key", async () => {
		mockProvider.getState.mockResolvedValue({
			apiConfiguration: {
				deepSeekApiKey: "stored-deepseek-key",
				deepSeekBaseUrl: "https://stored.deepseek.example.com",
			},
		})

		await webviewMessageHandler(mockProvider, {
			type: RouterModelsMessageType.requestRouterModels,
			values: { deepSeekBaseUrl: "https://preview.deepseek.example.com" },
		})

		const deepSeekOptions = {
			provider: providerIdentifiers.deepseek,
			apiKey: "stored-deepseek-key",
			baseUrl: "https://preview.deepseek.example.com",
		}
		expect(flushModelsMock).toHaveBeenCalledWith(deepSeekOptions, true)
		expect(getModelsMock).toHaveBeenCalledWith(deepSeekOptions)
	})

	it("fetches Moonshot models when stored Moonshot credentials exist", async () => {
		mockProvider.getState.mockResolvedValue({
			apiConfiguration: {
				moonshotApiKey: "stored-moonshot-key",
				moonshotBaseUrl: "https://api.moonshot.ai/v1",
			},
		})

		getModelsMock.mockImplementation(async (options: any) => {
			if (options?.provider === providerIdentifiers.moonshot) {
				return { "kimi-k2-0905-preview": { contextWindow: 262144, supportsPromptCache: true } }
			}

			switch (options?.provider) {
				case providerIdentifiers.openrouter:
					return { "openrouter/qwen2.5": { contextWindow: 32768, supportsPromptCache: false } }
				case providerIdentifiers.requesty:
					return { "requesty/model": { contextWindow: 8192, supportsPromptCache: false } }
				case providerIdentifiers.vercelAiGateway:
					return { "vercel/model": { contextWindow: 8192, supportsPromptCache: false } }
				case providerIdentifiers.litellm:
					return { "litellm/model": { contextWindow: 8192, supportsPromptCache: false } }
				default:
					return {}
			}
		})

		await webviewMessageHandler(
			mockProvider as any,
			{
				type: RouterModelsMessageType.requestRouterModels,
			} as any,
		)

		expect(getModelsMock).toHaveBeenCalledWith({
			provider: providerIdentifiers.moonshot,
			apiKey: "stored-moonshot-key",
			baseUrl: "https://api.moonshot.ai/v1",
		})

		const call = (mockProvider.postMessageToWebview as any).mock.calls.find(
			(c: any[]) => c[0]?.type === RouterModelsMessageType.routerModels,
		)
		expect(call).toBeTruthy()
		expect(call[0].routerModels.moonshot).toEqual({
			"kimi-k2-0905-preview": { contextWindow: 262144, supportsPromptCache: true },
		})
	})

	it("flushes Moonshot cache when explicit apiKey provided via message values", async () => {
		getModelsMock.mockResolvedValue({
			"kimi-k2-0905-preview": { contextWindow: 262144, supportsPromptCache: true },
		})

		await webviewMessageHandler(
			mockProvider as any,
			{
				type: RouterModelsMessageType.requestRouterModels,
				values: {
					moonshotApiKey: "new-moonshot-key",
					moonshotBaseUrl: "https://api.moonshot.cn/v1",
				},
			} as any,
		)

		// flushModels should have been called for moonshot
		const moonshotFlushCalls = flushModelsMock.mock.calls.filter(
			(c: any[]) => c[0]?.provider === providerIdentifiers.moonshot,
		)
		expect(moonshotFlushCalls.length).toBe(1)
		expect(moonshotFlushCalls[0][0]).toEqual({
			provider: providerIdentifiers.moonshot,
			apiKey: "new-moonshot-key",
			baseUrl: "https://api.moonshot.cn/v1",
		})

		// getModels should use the provided credentials
		const moonshotCalls = getModelsMock.mock.calls.filter(
			(c: any[]) => c[0]?.provider === providerIdentifiers.moonshot,
		)
		expect(moonshotCalls.length).toBe(1)
		expect(moonshotCalls[0][0]).toEqual({
			provider: providerIdentifiers.moonshot,
			apiKey: "new-moonshot-key",
			baseUrl: "https://api.moonshot.cn/v1",
		})
	})

	it("does not flush Moonshot cache when using stored credentials", async () => {
		mockProvider.getState.mockResolvedValue({
			apiConfiguration: {
				moonshotApiKey: "stored-moonshot-key",
			},
		})

		getModelsMock.mockImplementation(async (options: any) => {
			if (options?.provider === providerIdentifiers.moonshot) {
				return { "kimi-k2-0905-preview": { contextWindow: 262144, supportsPromptCache: true } }
			}

			switch (options?.provider) {
				case providerIdentifiers.openrouter:
					return { "openrouter/qwen2.5": { contextWindow: 32768, supportsPromptCache: false } }
				case providerIdentifiers.requesty:
					return { "requesty/model": { contextWindow: 8192, supportsPromptCache: false } }
				case providerIdentifiers.vercelAiGateway:
					return { "vercel/model": { contextWindow: 8192, supportsPromptCache: false } }
				case providerIdentifiers.litellm:
					return { "litellm/model": { contextWindow: 8192, supportsPromptCache: false } }
				default:
					return {}
			}
		})

		await webviewMessageHandler(
			mockProvider as any,
			{
				type: RouterModelsMessageType.requestRouterModels,
			} as any,
		)

		// flushModels should NOT have been called for moonshot
		const moonshotFlushCalls = flushModelsMock.mock.calls.filter(
			(c: any[]) => c[0]?.provider === providerIdentifiers.moonshot,
		)
		expect(moonshotFlushCalls.length).toBe(0)

		// getModels should still have been called with stored credentials
		const moonshotCalls = getModelsMock.mock.calls.filter(
			(c: any[]) => c[0]?.provider === providerIdentifiers.moonshot,
		)
		expect(moonshotCalls.length).toBe(1)
		expect(moonshotCalls[0][0]).toEqual({
			provider: providerIdentifiers.moonshot,
			apiKey: "stored-moonshot-key",
			baseUrl: undefined,
		})
	})

	it("posts a Moonshot provider error and keeps an empty aggregate entry when fetch fails", async () => {
		mockProvider.getState.mockResolvedValue({
			apiConfiguration: {
				moonshotApiKey: "stored-moonshot-key",
			},
		})

		getModelsMock.mockImplementation(async (options: any) => {
			if (options?.provider === providerIdentifiers.moonshot) {
				throw new Error("Moonshot API error")
			}

			switch (options?.provider) {
				case providerIdentifiers.openrouter:
					return { "openrouter/qwen2.5": { contextWindow: 32768, supportsPromptCache: false } }
				case providerIdentifiers.requesty:
					return { "requesty/model": { contextWindow: 8192, supportsPromptCache: false } }
				case providerIdentifiers.vercelAiGateway:
					return { "vercel/model": { contextWindow: 8192, supportsPromptCache: false } }
				case providerIdentifiers.litellm:
					return { "litellm/model": { contextWindow: 8192, supportsPromptCache: false } }
				default:
					return {}
			}
		})

		await webviewMessageHandler(
			mockProvider as any,
			{
				type: RouterModelsMessageType.requestRouterModels,
			} as any,
		)

		// Should have posted an error for moonshot
		const errorCall = (mockProvider.postMessageToWebview as any).mock.calls.find(
			(c: any[]) =>
				c[0]?.type === RouterModelsMessageType.singleRouterModelFetchResponse &&
				c[0]?.values?.provider === providerIdentifiers.moonshot,
		)
		expect(errorCall).toBeTruthy()
		expect(errorCall[0].success).toBe(false)

		// Aggregate entry should still be empty
		const call = (mockProvider.postMessageToWebview as any).mock.calls.find(
			(c: any[]) => c[0]?.type === RouterModelsMessageType.routerModels,
		)
		expect(call).toBeTruthy()
		expect(call[0].routerModels.moonshot).toEqual({})
	})

	it("fetches Gemini models when stored Gemini credentials exist", async () => {
		mockProvider.getState.mockResolvedValue({
			apiConfiguration: {
				geminiApiKey: "stored-gemini-key",
				googleGeminiBaseUrl: "https://generativelanguage.example.com",
			},
		})

		getModelsMock.mockImplementation(async (options: { provider?: string }) => {
			if (options?.provider === providerIdentifiers.gemini) {
				return { "gemini-3-pro": { contextWindow: 1_048_576, supportsPromptCache: true } }
			}

			switch (options?.provider) {
				case providerIdentifiers.openrouter:
					return { "openrouter/qwen2.5": { contextWindow: 32768, supportsPromptCache: false } }
				case providerIdentifiers.requesty:
					return { "requesty/model": { contextWindow: 8192, supportsPromptCache: false } }
				case providerIdentifiers.vercelAiGateway:
					return { "vercel/model": { contextWindow: 8192, supportsPromptCache: false } }
				case providerIdentifiers.litellm:
					return { "litellm/model": { contextWindow: 8192, supportsPromptCache: false } }
				default:
					return {}
			}
		})

		await webviewMessageHandler(mockProvider, {
			type: RouterModelsMessageType.requestRouterModels,
		})

		expect(getModelsMock).toHaveBeenCalledWith({
			provider: providerIdentifiers.gemini,
			apiKey: "stored-gemini-key",
			baseUrl: "https://generativelanguage.example.com",
		})

		const response = mockProvider.postMessageToWebview.mock.calls.find(
			(call) => call[0]?.type === RouterModelsMessageType.routerModels,
		)
		expect(response).toBeDefined()
		if (!response) throw new Error("Expected routerModels response")
		expect(response[0].routerModels.gemini).toEqual({
			"gemini-3-pro": { contextWindow: 1_048_576, supportsPromptCache: true },
		})
	})

	it("does not fetch Gemini models when no apiKey is configured", async () => {
		await webviewMessageHandler(mockProvider, {
			type: RouterModelsMessageType.requestRouterModels,
		})

		expect(getModelsMock).not.toHaveBeenCalledWith(
			expect.objectContaining({ provider: providerIdentifiers.gemini }),
		)

		const response = mockProvider.postMessageToWebview.mock.calls.find(
			(call) => call[0]?.type === RouterModelsMessageType.routerModels,
		)
		expect(response).toBeDefined()
		if (!response) throw new Error("Expected routerModels response")
		expect(response[0].routerModels.gemini).toEqual({})
	})

	it("flushes and fetches Gemini models when unsaved values override stored config", async () => {
		mockProvider.getState.mockResolvedValue({
			apiConfiguration: {
				geminiApiKey: "stored-gemini-key",
				googleGeminiBaseUrl: "https://stored.generativelanguage.example.com",
			},
		})

		getModelsMock.mockResolvedValue({
			"gemini-3-pro": { contextWindow: 1_048_576, supportsPromptCache: true },
		})

		await webviewMessageHandler(mockProvider, {
			type: RouterModelsMessageType.requestRouterModels,
			values: {
				geminiApiKey: "preview-gemini-key",
				googleGeminiBaseUrl: "https://preview.generativelanguage.example.com",
			},
		})

		const geminiOptions = {
			provider: providerIdentifiers.gemini,
			apiKey: "preview-gemini-key",
			baseUrl: "https://preview.generativelanguage.example.com",
		}
		expect(flushModelsMock).toHaveBeenCalledWith(geminiOptions, true)
		expect(getModelsMock).toHaveBeenCalledWith(geminiOptions)
	})

	it("fetches Vertex models when stored Vertex credentials exist", async () => {
		mockProvider.getState.mockResolvedValue({
			apiConfiguration: {
				vertexProjectId: "stored-project",
				vertexRegion: "us-central1",
			},
		})

		getModelsMock.mockImplementation(async (options: { provider?: string }) => {
			if (options?.provider === providerIdentifiers.vertex) {
				return { "gemini-3-pro-vertex": { contextWindow: 1_048_576, supportsPromptCache: true } }
			}

			return {}
		})

		await webviewMessageHandler(mockProvider, {
			type: RouterModelsMessageType.requestRouterModels,
		})

		expect(getModelsMock).toHaveBeenCalledWith({
			provider: providerIdentifiers.vertex,
			projectId: "stored-project",
			region: "us-central1",
			keyFile: undefined,
			jsonCredentials: undefined,
		})

		const response = mockProvider.postMessageToWebview.mock.calls.find(
			(call) => call[0]?.type === RouterModelsMessageType.routerModels,
		)
		expect(response).toBeDefined()
		if (!response) throw new Error("Expected routerModels response")
		expect(response[0].routerModels.vertex).toEqual({
			"gemini-3-pro-vertex": { contextWindow: 1_048_576, supportsPromptCache: true },
		})
	})

	it("does not fetch Vertex models when only a keyFile is provided (no project ID)", async () => {
		getModelsMock.mockResolvedValue({})

		await webviewMessageHandler(mockProvider, {
			type: RouterModelsMessageType.requestRouterModels,
			values: { vertexKeyFile: "/secrets/vertex-key.json" },
		})

		// Listing requires a project: a key file alone would fail at fetch time and leave the
		// picker silently empty, so no vertex fetch or refresh is dispatched.
		expect(getModelsMock).not.toHaveBeenCalledWith(
			expect.objectContaining({ provider: providerIdentifiers.vertex }),
		)
		expect(flushModelsMock).not.toHaveBeenCalledWith(
			expect.objectContaining({ provider: providerIdentifiers.vertex }),
			expect.anything(),
		)

		const response = mockProvider.postMessageToWebview.mock.calls.find(
			(call) => call[0]?.type === RouterModelsMessageType.routerModels,
		)
		expect(response).toBeDefined()
		if (!response) throw new Error("Expected routerModels response")
		expect(response[0].routerModels.vertex).toEqual({})
	})

	it("does not fetch Vertex models when only JSON credentials are provided (no project ID)", async () => {
		getModelsMock.mockResolvedValue({})

		await webviewMessageHandler(mockProvider, {
			type: RouterModelsMessageType.requestRouterModels,
			values: { vertexJsonCredentials: '{"type":"service_account"}' },
		})

		expect(getModelsMock).not.toHaveBeenCalledWith(
			expect.objectContaining({ provider: providerIdentifiers.vertex }),
		)
		expect(flushModelsMock).not.toHaveBeenCalledWith(
			expect.objectContaining({ provider: providerIdentifiers.vertex }),
			expect.anything(),
		)
	})

	it("prefers unsaved Vertex values over stored config", async () => {
		mockProvider.getState.mockResolvedValue({
			apiConfiguration: {
				vertexProjectId: "stored-project",
				vertexRegion: "us-central1",
			},
		})

		getModelsMock.mockResolvedValue({})

		await webviewMessageHandler(mockProvider, {
			type: RouterModelsMessageType.requestRouterModels,
			values: { vertexRegion: "europe-west1" },
		})

		expect(getModelsMock).toHaveBeenCalledWith({
			provider: providerIdentifiers.vertex,
			projectId: "stored-project",
			region: "europe-west1",
			keyFile: undefined,
			jsonCredentials: undefined,
		})
	})

	it("does not fetch Vertex models when only a region is set", async () => {
		mockProvider.getState.mockResolvedValue({
			apiConfiguration: {
				vertexRegion: "us-central1",
			},
		})

		await webviewMessageHandler(mockProvider, {
			type: RouterModelsMessageType.requestRouterModels,
		})

		expect(getModelsMock).not.toHaveBeenCalledWith(
			expect.objectContaining({ provider: providerIdentifiers.vertex }),
		)

		const response = mockProvider.postMessageToWebview.mock.calls.find(
			(call) => call[0]?.type === RouterModelsMessageType.routerModels,
		)
		expect(response).toBeDefined()
		if (!response) throw new Error("Expected routerModels response")
		expect(response[0].routerModels.vertex).toEqual({})
	})
})

describe("webviewMessageHandler - requestRouterModels cancellation", () => {
	let mockProvider: MockRouterModelsProvider

	beforeEach(() => {
		vi.clearAllMocks()

		mockProvider = makeMockProvider()
	})

	it("threads the per-request abort signal into getModels when a requestId is present", async () => {
		await webviewMessageHandler(mockProvider, {
			type: RouterModelsMessageType.requestRouterModels,
			values: { provider: providerIdentifiers.openrouter, requestId: "req-1" },
		})

		expect(getModelsMock).toHaveBeenCalledWith({
			provider: providerIdentifiers.openrouter,
			signal: expect.any(AbortSignal),
		})

		const response = mockProvider.postMessageToWebview.mock.calls.find(
			(call) => call[0]?.type === RouterModelsMessageType.routerModels,
		)
		expect(response).toBeDefined()
	})

	it("threads the signal into the gemini and vertex candidate fetches", async () => {
		mockProvider.getState.mockResolvedValue({
			apiConfiguration: {
				geminiApiKey: "stored-gemini-key",
				vertexProjectId: "stored-project",
				vertexRegion: "us-central1",
			},
		})

		await webviewMessageHandler(mockProvider, {
			type: RouterModelsMessageType.requestRouterModels,
			values: { requestId: "req-gemini-vertex" },
		})

		expect(getModelsMock).toHaveBeenCalledWith(
			expect.objectContaining({
				provider: providerIdentifiers.gemini,
				signal: expect.any(AbortSignal),
			}),
		)
		expect(getModelsMock).toHaveBeenCalledWith(
			expect.objectContaining({
				provider: providerIdentifiers.vertex,
				signal: expect.any(AbortSignal),
			}),
		)
	})

	it("aborts the matching in-flight request on cancelRouterModelsRequest and no-ops unknown ids", async () => {
		let resolveFetch: ((models: Record<string, unknown>) => void) | undefined
		getModelsMock.mockImplementation(
			() =>
				new Promise<Record<string, unknown>>((resolve) => {
					resolveFetch = resolve
				}),
		)

		const requestPromise = webviewMessageHandler(mockProvider, {
			type: RouterModelsMessageType.requestRouterModels,
			values: { provider: providerIdentifiers.openrouter, requestId: "req-cancel" },
		})

		await vi.waitFor(() => expect(getModelsMock).toHaveBeenCalled())
		const call = getModelsMock.mock.calls.find(
			(c: unknown[]) => (c[0] as { provider?: string }).provider === providerIdentifiers.openrouter,
		)
		if (!call) throw new Error("Expected openrouter getModels call")
		const signal = (call[0] as { signal?: AbortSignal }).signal
		expect(signal).toBeInstanceOf(AbortSignal)
		expect(signal?.aborted).toBe(false)

		// A cancellation for an unknown request id must not disturb the in-flight request.
		await webviewMessageHandler(mockProvider, {
			type: RouterModelsMessageType.cancelRouterModelsRequest,
			values: { requestId: "req-unknown" },
		})
		expect(signal?.aborted).toBe(false)

		// The matching cancellation aborts the threaded signal.
		await webviewMessageHandler(mockProvider, {
			type: RouterModelsMessageType.cancelRouterModelsRequest,
			values: { requestId: "req-cancel" },
		})
		expect(signal?.aborted).toBe(true)

		// The aborted request still settles and posts its aggregate response.
		resolveFetch!({ "openrouter/qwen2.5": { contextWindow: 32768, supportsPromptCache: false } })
		await requestPromise
		const response = mockProvider.postMessageToWebview.mock.calls.find(
			(c: unknown[]) => (c[0] as { type?: string } | undefined)?.type === RouterModelsMessageType.routerModels,
		)
		expect(response).toBeDefined()

		// After the request settled, its registry entry is gone: a duplicate cancellation no-ops.
		await webviewMessageHandler(mockProvider, {
			type: RouterModelsMessageType.cancelRouterModelsRequest,
			values: { requestId: "req-cancel" },
		})
	})

	it("cleans up the cancellation registration when the request finishes on its own", async () => {
		let settledSignal: AbortSignal | undefined
		getModelsMock.mockImplementation((options: { signal?: AbortSignal }) => {
			settledSignal = options.signal
			return Promise.resolve({ "openrouter/qwen2.5": { contextWindow: 32768, supportsPromptCache: false } })
		})

		await webviewMessageHandler(mockProvider, {
			type: RouterModelsMessageType.requestRouterModels,
			values: { provider: providerIdentifiers.openrouter, requestId: "req-settled" },
		})

		// The finally cleanup removed the settled request's controller: a late cancellation for
		// the same id finds no registry entry and must not abort the settled request's signal.
		await webviewMessageHandler(mockProvider, {
			type: RouterModelsMessageType.cancelRouterModelsRequest,
			values: { requestId: "req-settled" },
		})
		expect(settledSignal?.aborted).toBe(false)
	})

	it("honors a cancellation that arrives while getState is still pending", async () => {
		// Deterministic setup race: the request handler registers synchronously at message
		// receipt, then blocks on getState. The cancel lands while getState is unresolved.
		let resolveGetState: ((state: unknown) => void) | undefined
		mockProvider.getState.mockImplementation(
			() =>
				new Promise((resolve) => {
					resolveGetState = resolve
				}),
		)

		const requestPromise = webviewMessageHandler(mockProvider, {
			type: RouterModelsMessageType.requestRouterModels,
			values: { provider: providerIdentifiers.openrouter, requestId: "req-race" },
		})

		await webviewMessageHandler(mockProvider, {
			type: RouterModelsMessageType.cancelRouterModelsRequest,
			values: { requestId: "req-race" },
		})

		resolveGetState!({ apiConfiguration: {} })
		await requestPromise

		// The aborted request never started a candidate fetch...
		expect(getModelsMock).not.toHaveBeenCalled()
		// ...but still answered with the aggregate shape, with the provider entry empty —
		// the same contract as a request whose candidates all came back empty.
		const response = mockProvider.postMessageToWebview.mock.calls.find(
			(c: unknown[]) => (c[0] as { type?: string } | undefined)?.type === RouterModelsMessageType.routerModels,
		)
		if (!response) throw new Error("Expected routerModels response")
		expect((response[0] as { routerModels?: Record<string, unknown> }).routerModels).toEqual({
			[providerIdentifiers.openrouter]: {},
		})

		// No dangling registration: a duplicate cancel for the same id no-ops.
		await webviewMessageHandler(mockProvider, {
			type: RouterModelsMessageType.cancelRouterModelsRequest,
			values: { requestId: "req-race" },
		})
	})

	it("echoes the requestId in the aggregate response and per-candidate failure posts", async () => {
		getModelsMock.mockImplementation(async (options: { provider?: string }) => {
			if (options?.provider === providerIdentifiers.openrouter) {
				throw new Error("openrouter down")
			}
			return {}
		})

		await webviewMessageHandler(mockProvider, {
			type: RouterModelsMessageType.requestRouterModels,
			values: { requestId: "req-echo" },
		})

		const aggregate = mockProvider.postMessageToWebview.mock.calls.find(
			(c: unknown[]) => (c[0] as { type?: string } | undefined)?.type === RouterModelsMessageType.routerModels,
		)
		if (!aggregate) throw new Error("Expected routerModels response")
		expect((aggregate[0] as { values?: Record<string, unknown> }).values).toEqual({ requestId: "req-echo" })

		expect(mockProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: RouterModelsMessageType.singleRouterModelFetchResponse,
			success: false,
			error: "openrouter down",
			values: { provider: providerIdentifiers.openrouter, requestId: "req-echo" },
		})
	})

	it("keeps the legacy values shape when the request carries no requestId", async () => {
		getModelsMock.mockRejectedValue(new Error("openrouter down"))

		await webviewMessageHandler(mockProvider, {
			type: RouterModelsMessageType.requestRouterModels,
			values: { provider: providerIdentifiers.openrouter },
		})

		const aggregate = mockProvider.postMessageToWebview.mock.calls.find(
			(c: unknown[]) => (c[0] as { type?: string } | undefined)?.type === RouterModelsMessageType.routerModels,
		)
		if (!aggregate) throw new Error("Expected routerModels response")
		expect((aggregate[0] as { values?: Record<string, unknown> }).values).toEqual({
			provider: providerIdentifiers.openrouter,
		})

		expect(mockProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: RouterModelsMessageType.singleRouterModelFetchResponse,
			success: false,
			error: "openrouter down",
			values: { provider: providerIdentifiers.openrouter },
		})
	})

	it("threads the abort signal into the credential flush so an abort during refresh detaches it", async () => {
		let flushOptions: { signal?: AbortSignal } | undefined
		let resolveFlush: (() => void) | undefined
		flushModelsMock.mockImplementation((options: { signal?: AbortSignal }) => {
			flushOptions = options
			return new Promise<void>((resolve) => {
				resolveFlush = resolve
			})
		})

		// Explicit gemini credentials take the flush-then-fetch path; the flush stays pending
		// so the cancel lands while the refresh await is in flight.
		const requestPromise = webviewMessageHandler(mockProvider, {
			type: RouterModelsMessageType.requestRouterModels,
			values: { geminiApiKey: "new-gemini-key", requestId: "req-flush" },
		})

		await vi.waitFor(() => expect(flushModelsMock).toHaveBeenCalled())
		const flushSignal = flushOptions?.signal
		expect(flushSignal).toBeInstanceOf(AbortSignal)
		expect(flushSignal?.aborted).toBe(false)

		await webviewMessageHandler(mockProvider, {
			type: RouterModelsMessageType.cancelRouterModelsRequest,
			values: { requestId: "req-flush" },
		})
		expect(flushSignal?.aborted).toBe(true)

		resolveFlush!()
		await requestPromise

		// The refresh completed, but the abort that landed during it won: no candidate fetch
		// was ever started for this request.
		expect(getModelsMock).not.toHaveBeenCalled()
	})
})
