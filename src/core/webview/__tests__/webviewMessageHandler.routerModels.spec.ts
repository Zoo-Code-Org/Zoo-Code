import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

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

// Real handlers eagerly fetch models in their constructors, so use lightweight doubles.
// One double per provider lets tests assert each call receives its own provider's handler.
//
// The MiMo double enforces MimoHandler's real constructor contract: it throws unless the
// base URL it is handed passes the same allowlist the real handler applies. A non-throwing
// double would mask the mixed-state bug where the guard validated the resolved base URL but
// the handler was built from the raw stored config.
const { handlersByProvider, MIMO_HANDLER_REJECTION } = vi.hoisted(() => ({
	handlersByProvider: new Map<string | undefined, { providerName: string | undefined }>(),
	MIMO_HANDLER_REJECTION:
		"MIMO/MimoHandler/001: MiMo chat completion rejected: base URL is not an allowed Xiaomi MiMo endpoint.",
}))

vi.mock("../../../api", async () => {
	const { ALLOWED_BASE_URLS, MIMO_DEFAULT_BASE_URL, stripTrailingSlashes } =
		await import("../../../api/providers/fetchers/mimo")

	return {
		buildApiHandler: vi.fn((configuration: { apiProvider?: string; mimoBaseUrl?: string }) => {
			const providerName = configuration.apiProvider

			if (providerName === providerIdentifiers.mimo) {
				const mimoBaseUrl = configuration.mimoBaseUrl || MIMO_DEFAULT_BASE_URL
				if (!ALLOWED_BASE_URLS.has(stripTrailingSlashes(mimoBaseUrl))) {
					throw new Error(MIMO_HANDLER_REJECTION)
				}
			}

			let handler = handlersByProvider.get(providerName)
			if (!handler) {
				handler = {
					providerName,
					getModel: vi.fn().mockReturnValue({ id: "claude-3-sonnet" }),
				} as { providerName: string | undefined }
				handlersByProvider.set(providerName, handler)
			}
			return handler
		}),
	}
})

const handlerForProvider = (providerName: string) => {
	const handler = handlersByProvider.get(providerName)
	if (!handler) {
		throw new Error(`buildApiHandler was never called for provider "${providerName}"`)
	}
	return handler
}

describe("webviewMessageHandler - requestRouterModels provider filter", () => {
	let mockProvider: ClineProvider & {
		postMessageToWebview: ReturnType<typeof vi.fn>
		getState: ReturnType<typeof vi.fn>
		contextProxy: any
		log: ReturnType<typeof vi.fn>
	}

	afterEach(() => {
		// Every model-cache call must receive its own provider's handler.
		for (const [options, handler] of getModelsMock.mock.calls) {
			expect(handler).toBe(handlerForProvider(options.provider))
		}
		for (const [options, handler] of flushModelsMock.mock.calls) {
			expect(handler).toBe(handlerForProvider(options.provider))
		}
	})

	beforeEach(() => {
		vi.clearAllMocks()
		handlersByProvider.clear()

		mockProvider = {
			// Only methods used by this code path
			postMessageToWebview: vi.fn(),
			getState: vi.fn().mockResolvedValue({ apiConfiguration: {} }),
			contextProxy: {
				getValue: vi.fn(),
				setValue: vi.fn(),
				globalStorageUri: { fsPath: "/mock/storage" },
			},
			log: vi.fn(),
		} as any

		// Default mock: return distinct model maps per provider so we can verify keys
		getModelsMock.mockImplementation(async (options: any) => {
			switch (options?.provider) {
				case providerIdentifiers.openrouter:
					return { "openrouter/qwen2.5": { contextWindow: 32768, supportsPromptCache: false } }
				case providerIdentifiers.requesty:
					return { "requesty/model": { contextWindow: 8192, supportsPromptCache: false } }
				case providerIdentifiers.vercelAiGateway:
					return { "vercel/model": { contextWindow: 8192, supportsPromptCache: false } }
				case providerIdentifiers.ioIntelligence:
					return { "io/model": { contextWindow: 8192, supportsPromptCache: false } }
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
		expect(routerModels).toHaveProperty(providerIdentifiers.mimo)
		expect(routerModels.deepseek).toEqual({})
		expect(routerModels.moonshot).toEqual({})
		expect(routerModels.mimo).toEqual({})
		expect(getModelsMock).not.toHaveBeenCalledWith(
			expect.objectContaining({ provider: providerIdentifiers.deepseek }),
			expect.anything(),
		)
		expect(getModelsMock).not.toHaveBeenCalledWith(
			expect.objectContaining({ provider: providerIdentifiers.moonshot }),
			expect.anything(),
		)
		expect(getModelsMock).not.toHaveBeenCalledWith(expect.objectContaining({ provider: providerIdentifiers.mimo }))
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
				case providerIdentifiers.ioIntelligence:
					return { "io/model": { contextWindow: 8192, supportsPromptCache: false } }
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

		expect(getModelsMock).toHaveBeenCalledWith(
			{
				provider: providerIdentifiers.deepseek,
				apiKey: "stored-deepseek-key",
				baseUrl: "https://deepseek.example.com",
			},
			handlerForProvider(providerIdentifiers.deepseek),
		)

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
				case providerIdentifiers.ioIntelligence:
					return { "io/model": { contextWindow: 8192, supportsPromptCache: false } }
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
		expect(getModelsMock.mock.calls[0][1]).toBe(handlerForProvider(providerIdentifiers.openrouter))
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
		expect(getModelsMock).toHaveBeenCalledWith(
			{
				provider: providerIdentifiers.kimiCode,
				apiKey: "preview-kimi-api-key",
			},
			handlerForProvider(providerIdentifiers.kimiCode),
		)

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
		expect(getModelsMock).toHaveBeenCalledWith(
			{
				provider: providerIdentifiers.kimiCode,
				apiKey: "kimi-oauth-token",
			},
			handlerForProvider(providerIdentifiers.kimiCode),
		)
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
			handlerForProvider(providerIdentifiers.litellm),
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
		expect(litellmCalls[0][1]).toBe(handlerForProvider(providerIdentifiers.litellm))
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
		expect(flushModelsMock).toHaveBeenCalledWith(poeOptions, handlerForProvider(providerIdentifiers.poe), true)
		expect(getModelsMock).toHaveBeenCalledWith(poeOptions, handlerForProvider(providerIdentifiers.poe))

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
		expect(flushModelsMock).toHaveBeenCalledWith(
			deepSeekOptions,
			handlerForProvider(providerIdentifiers.deepseek),
			true,
		)
		expect(getModelsMock).toHaveBeenCalledWith(deepSeekOptions, handlerForProvider(providerIdentifiers.deepseek))
	})

	// One catalog per IO Intelligence key, so a fetch made with the wrong key publishes the wrong catalog.
	const ioIntelligenceCatalogs: Record<
		string,
		Record<string, { contextWindow: number; supportsPromptCache: boolean }>
	> = {
		"stored-io-key": { "io/stored-key-model": { contextWindow: 8192, supportsPromptCache: false } },
		"unsaved-io-key": { "io/unsaved-key-model": { contextWindow: 8192, supportsPromptCache: false } },
		"": { "io/public-model": { contextWindow: 8192, supportsPromptCache: false } },
	}

	const mockIoIntelligenceCatalogsByKey = () => {
		const baseGetModels = getModelsMock.getMockImplementation()
		getModelsMock.mockImplementation(async (options) =>
			options?.provider === providerIdentifiers.ioIntelligence
				? ioIntelligenceCatalogs[options.apiKey]
				: baseGetModels?.(options),
		)
	}

	const expectPublishedIoIntelligenceCatalog = (apiKey: string) => {
		expect(mockProvider.postMessageToWebview).toHaveBeenCalledWith(
			expect.objectContaining({
				type: RouterModelsMessageType.routerModels,
				routerModels: expect.objectContaining({
					[providerIdentifiers.ioIntelligence]: ioIntelligenceCatalogs[apiKey],
				}),
			}),
		)
	}

	it("fetches IO Intelligence models with the stored key and does not flush the cache", async () => {
		mockProvider.getState.mockResolvedValue({
			apiConfiguration: { ioIntelligenceApiKey: "stored-io-key" },
		})
		mockIoIntelligenceCatalogsByKey()

		await webviewMessageHandler(mockProvider, {
			type: RouterModelsMessageType.requestRouterModels,
		})

		const ioFlushCalls = flushModelsMock.mock.calls.filter(
			(c) => c[0]?.provider === providerIdentifiers.ioIntelligence,
		)
		expect(ioFlushCalls.length).toBe(0)

		const ioCalls = getModelsMock.mock.calls.filter((c) => c[0]?.provider === providerIdentifiers.ioIntelligence)
		expect(ioCalls.length).toBe(1)
		expect(ioCalls[0][0]).toEqual({ provider: providerIdentifiers.ioIntelligence, apiKey: "stored-io-key" })
		expectPublishedIoIntelligenceCatalog("stored-io-key")
	})

	it("flushes IO Intelligence models with an unsaved key from message values instead of the stored key", async () => {
		mockProvider.getState.mockResolvedValue({
			apiConfiguration: { ioIntelligenceApiKey: "stored-io-key" },
		})
		mockIoIntelligenceCatalogsByKey()

		await webviewMessageHandler(mockProvider, {
			type: RouterModelsMessageType.requestRouterModels,
			values: { ioIntelligenceApiKey: "unsaved-io-key" },
		})

		const ioFlushCalls = flushModelsMock.mock.calls.filter(
			(c) => c[0]?.provider === providerIdentifiers.ioIntelligence,
		)
		expect(ioFlushCalls.length).toBe(1)
		expect(ioFlushCalls[0][0]).toEqual({ provider: providerIdentifiers.ioIntelligence, apiKey: "unsaved-io-key" })

		const ioCalls = getModelsMock.mock.calls.filter((c) => c[0]?.provider === providerIdentifiers.ioIntelligence)
		expect(ioCalls.length).toBe(1)
		expect(ioCalls[0][0]).toEqual({ provider: providerIdentifiers.ioIntelligence, apiKey: "unsaved-io-key" })
		expectPublishedIoIntelligenceCatalog("unsaved-io-key")
	})

	it("treats an explicitly empty unsaved IO Intelligence key as the public catalog, not the stored key", async () => {
		mockProvider.getState.mockResolvedValue({
			apiConfiguration: { ioIntelligenceApiKey: "stored-io-key" },
		})
		mockIoIntelligenceCatalogsByKey()

		await webviewMessageHandler(mockProvider, {
			type: RouterModelsMessageType.requestRouterModels,
			values: { ioIntelligenceApiKey: "" },
		})

		const ioFlushCalls = flushModelsMock.mock.calls.filter(
			(c) => c[0]?.provider === providerIdentifiers.ioIntelligence,
		)
		expect(ioFlushCalls.length).toBe(1)
		expect(ioFlushCalls[0][0]).toEqual({ provider: providerIdentifiers.ioIntelligence, apiKey: "" })

		const ioCalls = getModelsMock.mock.calls.filter((c) => c[0]?.provider === providerIdentifiers.ioIntelligence)
		expect(ioCalls.length).toBe(1)
		expect(ioCalls[0][0]).toEqual({ provider: providerIdentifiers.ioIntelligence, apiKey: "" })
		expectPublishedIoIntelligenceCatalog("")
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
				case providerIdentifiers.ioIntelligence:
					return { "io/model": { contextWindow: 8192, supportsPromptCache: false } }
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

		expect(getModelsMock).toHaveBeenCalledWith(
			{
				provider: providerIdentifiers.moonshot,
				apiKey: "stored-moonshot-key",
				baseUrl: "https://api.moonshot.ai/v1",
			},
			handlerForProvider(providerIdentifiers.moonshot),
		)

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
				case providerIdentifiers.ioIntelligence:
					return { "io/model": { contextWindow: 8192, supportsPromptCache: false } }
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

	it("fetches MiMo models when stored MiMo credentials exist", async () => {
		mockProvider.getState.mockResolvedValue({
			apiConfiguration: {
				mimoApiKey: "stored-mimo-key",
				mimoBaseUrl: "https://token-plan-sgp.xiaomimimo.com/v1",
			},
		})

		getModelsMock.mockImplementation(async (options) => {
			if (options?.provider === providerIdentifiers.mimo) {
				return { "mimo-v2.6-pro": { contextWindow: 1_048_576, supportsPromptCache: false } }
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

		expect(getModelsMock).toHaveBeenCalledWith(
			{
				provider: providerIdentifiers.mimo,
				apiKey: "stored-mimo-key",
				baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1",
			},
			handlerForProvider(providerIdentifiers.mimo),
		)

		const response = mockProvider.postMessageToWebview.mock.calls.find(
			(call) => call[0]?.type === RouterModelsMessageType.routerModels,
		)
		expect(response).toBeDefined()
		if (!response) throw new Error("Expected routerModels response")
		expect(response[0].routerModels.mimo).toEqual({
			"mimo-v2.6-pro": { contextWindow: 1_048_576, supportsPromptCache: false },
		})
	})

	it("fetches only MiMo for a single-provider request with stored credentials", async () => {
		mockProvider.getState.mockResolvedValue({
			apiConfiguration: {
				mimoApiKey: "stored-mimo-key",
				mimoBaseUrl: "https://token-plan-sgp.xiaomimimo.com/v1",
			},
		})

		getModelsMock.mockImplementation(async (options?: { provider?: string }) => {
			if (options?.provider === providerIdentifiers.mimo) {
				return { "mimo-v2.6-pro": { contextWindow: 1_048_576, supportsPromptCache: false } }
			}
			return {}
		})

		await webviewMessageHandler(mockProvider, {
			type: RouterModelsMessageType.requestRouterModels,
			values: { provider: providerIdentifiers.mimo },
		})

		const mimoCalls = getModelsMock.mock.calls.filter((c) => c[0]?.provider === providerIdentifiers.mimo)
		expect(mimoCalls).toHaveLength(1)
		// The single-provider filter must not dispatch fetches for other providers.
		expect(getModelsMock).toHaveBeenCalledTimes(1)
		expect(mimoCalls[0][0]).toEqual({
			provider: providerIdentifiers.mimo,
			apiKey: "stored-mimo-key",
			baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1",
		})

		const response = mockProvider.postMessageToWebview.mock.calls.find(
			(call) => call[0]?.type === RouterModelsMessageType.routerModels,
		)
		expect(response).toBeDefined()
		if (!response) throw new Error("Expected routerModels response")
		// Filtered responses carry only the requested provider's entry.
		expect(Object.keys(response[0].routerModels)).toEqual([providerIdentifiers.mimo])
		expect(response[0].routerModels.mimo).toEqual({
			"mimo-v2.6-pro": { contextWindow: 1_048_576, supportsPromptCache: false },
		})
	})

	it("echoes the request ID in the routerModels response when one was provided", async () => {
		mockProvider.getState.mockResolvedValue({
			apiConfiguration: {
				mimoApiKey: "stored-mimo-key",
			},
		})

		getModelsMock.mockResolvedValue({})

		await webviewMessageHandler(mockProvider, {
			type: RouterModelsMessageType.requestRouterModels,
			values: { provider: providerIdentifiers.mimo, requestId: "req-123" },
		})

		const response = mockProvider.postMessageToWebview.mock.calls.find(
			(call) => call[0]?.type === RouterModelsMessageType.routerModels,
		)
		expect(response).toBeDefined()
		if (!response) throw new Error("Expected routerModels response")
		expect(response[0].values).toEqual({
			requestId: "req-123",
			provider: providerIdentifiers.mimo,
		})
	})

	it("flushes MiMo cache when explicit credentials are provided via message values", async () => {
		getModelsMock.mockResolvedValue({
			"mimo-v2.6-pro": { contextWindow: 1_048_576, supportsPromptCache: false },
		})

		await webviewMessageHandler(mockProvider, {
			type: RouterModelsMessageType.requestRouterModels,
			values: {
				mimoApiKey: "new-mimo-key",
				mimoBaseUrl: "https://token-plan-ams.xiaomimimo.com/v1",
			},
		})

		const mimoOptions = {
			provider: providerIdentifiers.mimo,
			apiKey: "new-mimo-key",
			baseUrl: "https://token-plan-ams.xiaomimimo.com/v1",
		}
		expect(flushModelsMock).toHaveBeenCalledWith(mimoOptions, handlerForProvider(providerIdentifiers.mimo), true)
		expect(getModelsMock).toHaveBeenCalledWith(mimoOptions, handlerForProvider(providerIdentifiers.mimo))

		const response = mockProvider.postMessageToWebview.mock.calls.find(
			(call) => call[0]?.type === RouterModelsMessageType.routerModels,
		)
		expect(response).toBeDefined()
		if (!response) throw new Error("Expected routerModels response")
		expect(response[0].routerModels.mimo).toEqual({
			"mimo-v2.6-pro": { contextWindow: 1_048_576, supportsPromptCache: false },
		})
	})

	it("does not flush MiMo cache when using stored credentials", async () => {
		mockProvider.getState.mockResolvedValue({
			apiConfiguration: {
				mimoApiKey: "stored-mimo-key",
			},
		})

		getModelsMock.mockImplementation(async (options) => {
			if (options?.provider === providerIdentifiers.mimo) {
				return { "mimo-v2.6-pro": { contextWindow: 1_048_576, supportsPromptCache: false } }
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

		const mimoFlushCalls = flushModelsMock.mock.calls.filter((c) => c[0]?.provider === providerIdentifiers.mimo)
		expect(mimoFlushCalls.length).toBe(0)

		const mimoCalls = getModelsMock.mock.calls.filter((c) => c[0]?.provider === providerIdentifiers.mimo)
		expect(mimoCalls.length).toBe(1)
		expect(mimoCalls[0][0]).toEqual({
			provider: providerIdentifiers.mimo,
			apiKey: "stored-mimo-key",
			baseUrl: undefined,
		})
	})

	it("rejects an unsaved MiMo base URL outside the Xiaomi allowlist without dispatching a fetch", async () => {
		mockProvider.getState.mockResolvedValue({
			apiConfiguration: {
				mimoApiKey: "stored-mimo-key",
				mimoBaseUrl: "https://token-plan-sgp.xiaomimimo.com/v1",
			},
		})

		await webviewMessageHandler(mockProvider, {
			type: RouterModelsMessageType.requestRouterModels,
			values: {
				mimoBaseUrl: "https://attacker.example",
			},
		})

		// The off-list unsaved URL must never reach modelCache: no fetch and no
		// cache flush for MiMo is dispatched.
		const mimoCalls = getModelsMock.mock.calls.filter((c) => c[0]?.provider === providerIdentifiers.mimo)
		expect(mimoCalls.length).toBe(0)
		const mimoFlushCalls = flushModelsMock.mock.calls.filter((c) => c[0]?.provider === providerIdentifiers.mimo)
		expect(mimoFlushCalls.length).toBe(0)

		const errorCall = mockProvider.postMessageToWebview.mock.calls.find(
			(call) =>
				call[0]?.type === RouterModelsMessageType.singleRouterModelFetchResponse &&
				call[0]?.values?.provider === providerIdentifiers.mimo,
		)
		expect(errorCall).toBeDefined()
		if (!errorCall) throw new Error("Expected MiMo failure response")
		expect(errorCall[0].success).toBe(false)
		expect(errorCall[0].error).toBe(
			"MIMO/requestRouterModels/001: MiMo model fetch rejected: the provided base URL is not an allowed Xiaomi MiMo endpoint.",
		)

		// Aggregation for the remaining providers still posts, with MiMo empty.
		const response = mockProvider.postMessageToWebview.mock.calls.find(
			(call) => call[0]?.type === RouterModelsMessageType.routerModels,
		)
		expect(response).toBeDefined()
		if (!response) throw new Error("Expected routerModels response")
		expect(response[0].routerModels.openrouter).toEqual({
			"openrouter/qwen2.5": { contextWindow: 32768, supportsPromptCache: false },
		})
		expect(response[0].routerModels.mimo).toEqual({})
	})

	// Regression: flushModels() gained an eagerly-built handler argument, so an
	// off-list STORED mimoBaseUrl made MimoHandler's constructor throw from inside
	// this case. That throw escaped requestRouterModels entirely, so the webview got
	// neither the MiMo failure response nor the aggregate routerModels response, and
	// the Refresh button stuck at Loading indefinitely (Mimo.tsx clears that state
	// only on a routerModels response; the 10s timeout lives in fetchRouterModels,
	// which this button does not use). A stored value can be off-list because
	// ContextProxy.getProviderSettings() fails open on a schema rejection.
	it("rejects an off-list STORED MiMo base URL without letting the handler constructor throw", async () => {
		mockProvider.getState.mockResolvedValue({
			apiConfiguration: {
				mimoApiKey: "stored-mimo-key",
				mimoBaseUrl: "https://attacker.example/v1",
			},
		})

		// Mirrors Mimo.tsx handleRefreshModels: provider + key, no refresh flag.
		await expect(
			webviewMessageHandler(mockProvider, {
				type: RouterModelsMessageType.requestRouterModels,
				values: { provider: providerIdentifiers.mimo, mimoApiKey: "stored-mimo-key" },
			}),
		).resolves.toBeUndefined()

		// The off-list stored URL must never reach modelCache: no flush (which would
		// build the throwing handler) and no fetch.
		const mimoFlushCalls = flushModelsMock.mock.calls.filter((c) => c[0]?.provider === providerIdentifiers.mimo)
		expect(mimoFlushCalls.length).toBe(0)
		const mimoCalls = getModelsMock.mock.calls.filter((c) => c[0]?.provider === providerIdentifiers.mimo)
		expect(mimoCalls.length).toBe(0)

		const errorCall = mockProvider.postMessageToWebview.mock.calls.find(
			(call) =>
				call[0]?.type === RouterModelsMessageType.singleRouterModelFetchResponse &&
				call[0]?.values?.provider === providerIdentifiers.mimo,
		)
		expect(errorCall).toBeDefined()
		if (!errorCall) throw new Error("Expected MiMo failure response")
		expect(errorCall[0].success).toBe(false)
		expect(errorCall[0].error).toBe(
			"MIMO/requestRouterModels/001: MiMo model fetch rejected: the provided base URL is not an allowed Xiaomi MiMo endpoint.",
		)

		// The aggregate response still reaches the webview, so the refresh resolves.
		// A filtered response only carries entries for dispatched candidates, so the
		// skipped provider is absent rather than empty; the webview then falls back
		// to the static catalog instead of hanging.
		const response = mockProvider.postMessageToWebview.mock.calls.find(
			(call) => call[0]?.type === RouterModelsMessageType.routerModels,
		)
		expect(response).toBeDefined()
		if (!response) throw new Error("Expected routerModels response")
		expect(response[0].routerModels.mimo).toBeUndefined()
	})

	// Regression (mixed state): a VALID unsaved base URL alongside an INVALID stored
	// one. The allowlist guard runs on the resolved value, so it accepts the request,
	// but handlerFor() spreads the raw stored config -- so the handler was built from
	// the off-list stored URL and MimoHandler's constructor threw, escaping the case.
	// The mock above enforces the real constructor contract, so this fails if the
	// handler is ever built from anything but the guard-validated resolved value.
	it("builds the MiMo handler from the resolved base URL when the stored one is off-list", async () => {
		mockProvider.getState.mockResolvedValue({
			apiConfiguration: {
				mimoApiKey: "stored-mimo-key",
				mimoBaseUrl: "https://attacker.example/v1",
			},
		})
		getModelsMock.mockImplementation(async (options: { provider?: string }) =>
			options?.provider === providerIdentifiers.mimo
				? { "mimo-v2.6-pro": { contextWindow: 1_048_576, supportsPromptCache: false } }
				: {},
		)

		await expect(
			webviewMessageHandler(mockProvider, {
				type: RouterModelsMessageType.requestRouterModels,
				values: {
					provider: providerIdentifiers.mimo,
					mimoApiKey: "stored-mimo-key",
					mimoBaseUrl: "https://token-plan-ams.xiaomimimo.com/v1",
				},
			}),
		).resolves.toBeUndefined()

		// The accepted unsaved URL is the one that reaches the cache and the fetch.
		const mimoOptions = {
			provider: providerIdentifiers.mimo,
			apiKey: "stored-mimo-key",
			baseUrl: "https://token-plan-ams.xiaomimimo.com/v1",
		}
		expect(flushModelsMock).toHaveBeenCalledWith(mimoOptions, handlerForProvider(providerIdentifiers.mimo), true)
		expect(getModelsMock).toHaveBeenCalledWith(mimoOptions, handlerForProvider(providerIdentifiers.mimo))

		// No failure notification: the guard accepted the request and the handler built.
		const errorCall = mockProvider.postMessageToWebview.mock.calls.find(
			(call) =>
				call[0]?.type === RouterModelsMessageType.singleRouterModelFetchResponse &&
				call[0]?.values?.provider === providerIdentifiers.mimo,
		)
		expect(errorCall).toBeUndefined()

		const response = mockProvider.postMessageToWebview.mock.calls.find(
			(call) => call[0]?.type === RouterModelsMessageType.routerModels,
		)
		expect(response).toBeDefined()
		if (!response) throw new Error("Expected routerModels response")
		expect(response[0].routerModels.mimo).toEqual({
			"mimo-v2.6-pro": { contextWindow: 1_048_576, supportsPromptCache: false },
		})
	})

	// Regression (mixed state + refresh): the same valid-unsaved / off-list-stored
	// pair, but through the filtered-flush path. With `refresh: true` and a provider
	// filter, the handler flushes the cache before the aggregate fetch, and that
	// flush builds its handler eagerly at the call site. The existing mixed-state
	// test above only reaches the fetch path, so it would still pass if the flush
	// site kept spreading the raw stored config.
	it("flushes the MiMo cache from the resolved base URL when refresh is set and the stored one is off-list", async () => {
		mockProvider.getState.mockResolvedValue({
			apiConfiguration: {
				mimoApiKey: "stored-mimo-key",
				mimoBaseUrl: "https://attacker.example/v1",
			},
		})
		getModelsMock.mockImplementation(async (options: { provider?: string }) =>
			options?.provider === providerIdentifiers.mimo
				? { "mimo-v2.6-pro": { contextWindow: 1_048_576, supportsPromptCache: false } }
				: {},
		)

		await expect(
			webviewMessageHandler(mockProvider, {
				type: RouterModelsMessageType.requestRouterModels,
				values: {
					provider: providerIdentifiers.mimo,
					mimoApiKey: "stored-mimo-key",
					mimoBaseUrl: "https://token-plan-ams.xiaomimimo.com/v1",
					refresh: true,
				},
			}),
		).resolves.toBeUndefined()

		// Two flushes: the unsaved-values flush in the MiMo block and the filtered
		// flush at the shared refresh site. Both must receive the guard-validated
		// resolved URL and the MiMo handler built from it; spreading the raw stored
		// config at the shared site throws MIMO_HANDLER_REJECTION out of the whole
		// requestRouterModels case.
		const mimoOptions = {
			provider: providerIdentifiers.mimo,
			apiKey: "stored-mimo-key",
			baseUrl: "https://token-plan-ams.xiaomimimo.com/v1",
		}
		const mimoFlushCalls = flushModelsMock.mock.calls.filter((c) => c[0]?.provider === providerIdentifiers.mimo)
		expect(mimoFlushCalls).toHaveLength(2)
		for (const [options, handler, refresh] of mimoFlushCalls) {
			expect(options).toEqual(mimoOptions)
			expect(handler).toBe(handlerForProvider(providerIdentifiers.mimo))
			expect(refresh).toBe(true)
		}

		// The fetches use the same resolved options and handler.
		const mimoFetchCalls = getModelsMock.mock.calls.filter((c) => c[0]?.provider === providerIdentifiers.mimo)
		expect(mimoFetchCalls).toHaveLength(1)
		expect(mimoFetchCalls[0][0]).toEqual(mimoOptions)
		expect(mimoFetchCalls[0][1]).toBe(handlerForProvider(providerIdentifiers.mimo))

		// The request completed: no failure response, and the aggregate response
		// carries the refreshed catalog instead of hanging the Refresh button.
		const errorCall = mockProvider.postMessageToWebview.mock.calls.find(
			(call) =>
				call[0]?.type === RouterModelsMessageType.singleRouterModelFetchResponse &&
				call[0]?.values?.provider === providerIdentifiers.mimo,
		)
		expect(errorCall).toBeUndefined()

		const response = mockProvider.postMessageToWebview.mock.calls.find(
			(call) => call[0]?.type === RouterModelsMessageType.routerModels,
		)
		expect(response).toBeDefined()
		if (!response) throw new Error("Expected routerModels response")
		expect(response[0].routerModels.mimo).toEqual({
			"mimo-v2.6-pro": { contextWindow: 1_048_576, supportsPromptCache: false },
		})
	})

	it("treats an unsaved empty mimoBaseUrl as unset and keeps using the stored cluster", async () => {
		mockProvider.getState.mockResolvedValue({
			apiConfiguration: {
				mimoApiKey: "stored-mimo-key",
				mimoBaseUrl: "https://token-plan-cn.xiaomimimo.com/v1",
			},
		})

		await webviewMessageHandler(mockProvider, {
			type: RouterModelsMessageType.requestRouterModels,
			values: { mimoBaseUrl: "" },
		})

		// Empty means unset: the stored China cluster must keep applying instead
		// of being silently rerouted to the default Singapore endpoint.
		expect(getModelsMock).toHaveBeenCalledWith(
			{
				provider: providerIdentifiers.mimo,
				apiKey: "stored-mimo-key",
				baseUrl: "https://token-plan-cn.xiaomimimo.com/v1",
			},
			handlerForProvider(providerIdentifiers.mimo),
		)

		// No rejection is posted and no refresh is flushed for the empty value.
		const errorCall = mockProvider.postMessageToWebview.mock.calls.find(
			(call) => call[0]?.type === RouterModelsMessageType.singleRouterModelFetchResponse,
		)
		expect(errorCall).toBeUndefined()
		const mimoFlushCalls = flushModelsMock.mock.calls.filter((c) => c[0]?.provider === providerIdentifiers.mimo)
		expect(mimoFlushCalls.length).toBe(0)
	})

	it("falls back to an undefined base URL when an empty unsaved value has no stored cluster", async () => {
		mockProvider.getState.mockResolvedValue({
			apiConfiguration: {
				mimoApiKey: "stored-mimo-key",
			},
		})

		await webviewMessageHandler(mockProvider, {
			type: RouterModelsMessageType.requestRouterModels,
			values: { mimoBaseUrl: "" },
		})

		expect(getModelsMock).toHaveBeenCalledWith(
			{
				provider: providerIdentifiers.mimo,
				apiKey: "stored-mimo-key",
				baseUrl: undefined,
			},
			handlerForProvider(providerIdentifiers.mimo),
		)
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
				case providerIdentifiers.ioIntelligence:
					return { "io/model": { contextWindow: 8192, supportsPromptCache: false } }
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
})
