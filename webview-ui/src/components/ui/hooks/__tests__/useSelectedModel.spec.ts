// npx vitest src/components/ui/hooks/__tests__/useSelectedModel.spec.ts

import React from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { renderHook } from "@testing-library/react"
import type { Mock } from "vitest"

import {
	ProviderSettings,
	ModelInfo,
	type ModelRecord,
	type RouterModels,
	anthropicModels,
	BEDROCK_1M_CONTEXT_MODEL_IDS,
	litellmDefaultModelInfo,
	kenariDefaultModelId,
	kenariDefaultModelInfo,
	nanoGptDefaultModelId,
	nanoGptDefaultModelInfo,
	openAiModelInfoSaneDefaults,
	minimaxDefaultModelId,
	minimaxModels,
	friendliDefaultModelId,
	friendliModels,
	deepSeekDefaultModelId,
	deepSeekModels,
	openRouterDefaultModelId,
	vscodeLlmModels,
	vscodeLlmDefaultModelId,
	moonshotDefaultModelId,
	moonshotModels,
	kimiCodeDefaultModelInfo,
	lMStudioDefaultModelInfo,
	opencodeGoDefaultModelInfo,
	getZAiModels,
	mainlandZAiDefaultModelId,
	providerIdentifiers,
	retiredProviderIdentifiers,
} from "@roo-code/types"

import { useSelectedModel } from "../useSelectedModel"
import { useRouterModels } from "../useRouterModels"
import { useOpenRouterModelProviders } from "../useOpenRouterModelProviders"
import { useLmStudioModels } from "../useLmStudioModels"
import { useOllamaModels } from "../useOllamaModels"

vi.mock("../useRouterModels")
vi.mock("../useOpenRouterModelProviders")
vi.mock("../useLmStudioModels")
vi.mock("../useOllamaModels")

const mockUseRouterModels = useRouterModels as Mock<typeof useRouterModels>
const mockUseOpenRouterModelProviders = useOpenRouterModelProviders as Mock<typeof useOpenRouterModelProviders>
const mockUseLmStudioModels = useLmStudioModels as Mock<typeof useLmStudioModels>
const mockUseOllamaModels = useOllamaModels as Mock<typeof useOllamaModels>

type TestRouterModels = Partial<Record<keyof RouterModels, ModelRecord | null>>
type QueryResultOptions = { isLoading?: boolean; isError?: boolean }

const createQueryResult = <TData>(data: TData, options: QueryResultOptions = {}) => ({
	data,
	isLoading: options.isLoading ?? false,
	isError: options.isError ?? false,
})

// React Query exposes a discriminated union with additional runtime fields; these tests only need the stable query state fields.
const createRouterModelsResult = (
	data: TestRouterModels | undefined,
	options?: QueryResultOptions,
): ReturnType<typeof useRouterModels> => createQueryResult(data, options) as ReturnType<typeof useRouterModels>

const createOpenRouterModelProvidersResult = (
	data: Record<string, ModelInfo> | undefined,
	options?: QueryResultOptions,
): ReturnType<typeof useOpenRouterModelProviders> =>
	createQueryResult(data, options) as ReturnType<typeof useOpenRouterModelProviders>

const createLocalModelsResult = (
	data: ModelRecord | undefined,
	options?: QueryResultOptions,
): ReturnType<typeof useLmStudioModels> => createQueryResult(data, options) as ReturnType<typeof useLmStudioModels>

const createWrapper = () => {
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: {
				retry: false,
			},
		},
	})
	return ({ children }: { children: React.ReactNode }) =>
		React.createElement(QueryClientProvider, { client: queryClient }, children)
}

describe("useSelectedModel", () => {
	beforeEach(() => {
		mockUseLmStudioModels.mockClear()
		mockUseOllamaModels.mockClear()
		mockUseLmStudioModels.mockReturnValue(createLocalModelsResult({}))
		mockUseOllamaModels.mockReturnValue(createLocalModelsResult({}))
	})

	const dynamicProviderCases = [
		[providerIdentifiers.requesty, "requestyModelId"],
		[providerIdentifiers.unbound, "unboundModelId"],
		[providerIdentifiers.vercelAiGateway, "vercelAiGatewayModelId"],
		[providerIdentifiers.opencodeGo, "opencodeGoModelId"],
		[providerIdentifiers.zooGateway, "zooGatewayModelId"],
	] as const
	const configuredModelInfo: ModelInfo = { contextWindow: 1, supportsPromptCache: false }

	it.each(dynamicProviderCases)("uses router data for %s", (provider, modelIdKey) => {
		const modelInfo: ModelInfo = { contextWindow: 42_000, supportsPromptCache: false }
		mockUseRouterModels.mockReturnValue(createRouterModelsResult({ [provider]: { model: modelInfo } }))
		mockUseOpenRouterModelProviders.mockReturnValue(createOpenRouterModelProvidersResult({}))

		const apiConfiguration = {
			apiProvider: provider,
			[modelIdKey]: "model",
		} as ProviderSettings
		const { result } = renderHook(() => useSelectedModel(apiConfiguration), { wrapper: createWrapper() })

		expect(result.current.id).toBe("model")
		expect(result.current.info).toEqual(modelInfo)
	})

	it.each([
		[providerIdentifiers.lmstudio, "lmStudioModelId"],
		[providerIdentifiers.ollama, "ollamaModelId"],
	] as const)("passes the configured model ID to the %s model hook", (provider, modelIdKey) => {
		mockUseRouterModels.mockReturnValue(createRouterModelsResult({}))
		mockUseOpenRouterModelProviders.mockReturnValue(createOpenRouterModelProvidersResult({}))
		mockUseLmStudioModels.mockReturnValue(createLocalModelsResult({ "configured-model": configuredModelInfo }))
		mockUseOllamaModels.mockReturnValue(createLocalModelsResult({ "configured-model": configuredModelInfo }))

		const { result } = renderHook(
			() => useSelectedModel({ apiProvider: provider, [modelIdKey]: "configured-model" }),
			{ wrapper: createWrapper() },
		)

		expect(result.current.id).toBe("configured-model")
		if (provider === providerIdentifiers.lmstudio) {
			expect(mockUseLmStudioModels).toHaveBeenCalledWith("configured-model")
		} else {
			expect(mockUseOllamaModels).toHaveBeenCalledWith("configured-model")
		}
	})

	it.each([
		[providerIdentifiers.lmstudio, "lmStudioModelId", lMStudioDefaultModelInfo],
		[providerIdentifiers.ollama, "ollamaModelId", undefined],
	] as const)("applies local model metadata for %s", (provider, modelIdKey, defaultInfo) => {
		const modelId = "configured-model"
		const modelInfo: ModelInfo = {
			maxTokens: 12_000,
			contextWindow: 100_000,
			supportsImages: false,
			supportsPromptCache: false,
		}
		mockUseRouterModels.mockReturnValue(createRouterModelsResult({}))
		mockUseOpenRouterModelProviders.mockReturnValue(createOpenRouterModelProvidersResult({}))
		if (provider === providerIdentifiers.lmstudio) {
			mockUseLmStudioModels.mockReturnValue(createLocalModelsResult({ [modelId]: modelInfo }))
		} else {
			mockUseOllamaModels.mockReturnValue(createLocalModelsResult({ [modelId]: modelInfo }))
		}

		const apiConfiguration = {
			apiProvider: provider,
			[modelIdKey]: modelId,
			...(provider === providerIdentifiers.ollama ? { ollamaNumCtx: 32_000 } : {}),
		} as ProviderSettings
		const { result } = renderHook(() => useSelectedModel(apiConfiguration), { wrapper: createWrapper() })

		expect(result.current.id).toBe(modelId)
		expect(result.current.info).toEqual(
			provider === providerIdentifiers.lmstudio
				? { ...defaultInfo, ...modelInfo }
				: { ...modelInfo, contextWindow: 32_000 },
		)
	})

	it("falls back to the OpenRouter default for a retired provider", () => {
		mockUseRouterModels.mockReturnValue(createRouterModelsResult({}))
		mockUseOpenRouterModelProviders.mockReturnValue(createOpenRouterModelProvidersResult({}))

		const { result } = renderHook(() => useSelectedModel({ apiProvider: retiredProviderIdentifiers.cerebras }), {
			wrapper: createWrapper(),
		})

		expect(result.current.id).toBe(openRouterDefaultModelId)
		expect(result.current.info).toBeUndefined()
	})

	it("uses OpenCode Go default model information when the router catalog is empty", () => {
		mockUseRouterModels.mockReturnValue(createRouterModelsResult({ [providerIdentifiers.opencodeGo]: {} }))
		mockUseOpenRouterModelProviders.mockReturnValue(createOpenRouterModelProvidersResult({}))

		const { result } = renderHook(() => useSelectedModel({ apiProvider: providerIdentifiers.opencodeGo }), {
			wrapper: createWrapper(),
		})

		expect(result.current.info).toEqual(opencodeGoDefaultModelInfo)
	})

	it.each([providerIdentifiers.deepseek, providerIdentifiers.moonshot])(
		"prefers router data over static data for %s",
		(provider) => {
			const modelInfo: ModelInfo = { contextWindow: 42_000, supportsPromptCache: false }
			const modelId = provider === providerIdentifiers.deepseek ? "deepseek-v4-pro" : moonshotDefaultModelId
			mockUseRouterModels.mockReturnValue(createRouterModelsResult({ [provider]: { [modelId]: modelInfo } }))
			mockUseOpenRouterModelProviders.mockReturnValue(createOpenRouterModelProvidersResult({}))

			const { result } = renderHook(() => useSelectedModel({ apiProvider: provider, apiModelId: modelId }), {
				wrapper: createWrapper(),
			})

			expect(result.current.id).toBe(modelId)
			expect(result.current.info).toEqual(modelInfo)
		},
	)

	it.each([providerIdentifiers.deepseek, providerIdentifiers.moonshot])(
		"falls back to static data when the %s router catalog is null",
		(provider) => {
			const modelId = provider === providerIdentifiers.deepseek ? deepSeekDefaultModelId : moonshotDefaultModelId
			mockUseRouterModels.mockReturnValue(createRouterModelsResult({ [provider]: null }))
			mockUseOpenRouterModelProviders.mockReturnValue(createOpenRouterModelProvidersResult({}))

			const { result } = renderHook(() => useSelectedModel({ apiProvider: provider, apiModelId: modelId }), {
				wrapper: createWrapper(),
			})

			expect(result.current.id).toBe(modelId)
			if (provider === providerIdentifiers.deepseek) {
				expect(result.current.info).toEqual(deepSeekModels[deepSeekDefaultModelId])
			} else {
				expect(result.current.info).toEqual(moonshotModels[modelId as keyof typeof moonshotModels])
			}
		},
	)

	it("uses router data for Poe", () => {
		const modelInfo: ModelInfo = { contextWindow: 42_000, supportsPromptCache: false }
		mockUseRouterModels.mockReturnValue(
			createRouterModelsResult({ [providerIdentifiers.poe]: { model: modelInfo } }),
		)
		mockUseOpenRouterModelProviders.mockReturnValue(createOpenRouterModelProvidersResult({}))

		const { result } = renderHook(
			() => useSelectedModel({ apiProvider: providerIdentifiers.poe, apiModelId: "model" }),
			{ wrapper: createWrapper() },
		)

		expect(result.current.info).toEqual(modelInfo)
	})

	describe("OpenRouter provider merging", () => {
		it("should merge base model info with specific provider info when both exist", () => {
			const baseModelInfo: ModelInfo = {
				maxTokens: 4096,
				contextWindow: 8192,
				supportsImages: false,
				supportsPromptCache: false,
			}

			const specificProviderInfo: ModelInfo = {
				maxTokens: 8192, // Different value that should override
				contextWindow: 16384, // Different value that should override
				supportsImages: true, // Different value that should override
				supportsPromptCache: true, // Different value that should override
				inputPrice: 0.001,
				outputPrice: 0.002,
				description: "Provider-specific description",
			}

			mockUseRouterModels.mockReturnValue({
				data: {
					openrouter: {
						"test-model": baseModelInfo,
					},
					requesty: {},
					litellm: {},
				},
				isLoading: false,
				isError: false,
			} as any)

			mockUseOpenRouterModelProviders.mockReturnValue({
				data: {
					"test-provider": specificProviderInfo,
				},
				isLoading: false,
				isError: false,
			} as any)

			const apiConfiguration: ProviderSettings = {
				apiProvider: providerIdentifiers.openrouter,
				openRouterModelId: "test-model",
				openRouterSpecificProvider: "test-provider",
			}

			const wrapper = createWrapper()
			const { result } = renderHook(() => useSelectedModel(apiConfiguration), { wrapper })

			expect(result.current.id).toBe("test-model")
			expect(result.current.info).toEqual({
				maxTokens: 8192, // From specific provider (overrides base)
				contextWindow: 16384, // From specific provider (overrides base)
				supportsImages: true, // From specific provider (overrides base)
				supportsPromptCache: true, // From specific provider (overrides base)
				inputPrice: 0.001,
				outputPrice: 0.002,
				description: "Provider-specific description",
			})
		})

		it("should fall back to default when configured model doesn't exist in available models", () => {
			const specificProviderInfo: ModelInfo = {
				maxTokens: 8192,
				contextWindow: 16384,
				supportsImages: true,
				supportsPromptCache: true,
				inputPrice: 0.001,
				outputPrice: 0.002,
				description: "Provider-specific description",
			}

			mockUseRouterModels.mockReturnValue({
				data: {
					openrouter: {
						"anthropic/claude-sonnet-4.5": {
							maxTokens: 8192,
							contextWindow: 200_000,
							supportsImages: true,
							supportsPromptCache: true,
							inputPrice: 3.0,
							outputPrice: 15.0,
							cacheWritesPrice: 3.75,
							cacheReadsPrice: 0.3,
						},
					},
					requesty: {},
					litellm: {},
				},
				isLoading: false,
				isError: false,
			} as any)

			mockUseOpenRouterModelProviders.mockReturnValue({
				data: {
					"test-provider": specificProviderInfo,
				},
				isLoading: false,
				isError: false,
			} as any)

			const apiConfiguration: ProviderSettings = {
				apiProvider: providerIdentifiers.openrouter,
				openRouterModelId: "test-model", // This model doesn't exist in available models
				openRouterSpecificProvider: "test-provider",
			}

			const wrapper = createWrapper()
			const { result } = renderHook(() => useSelectedModel(apiConfiguration), { wrapper })

			// Should fall back to provider default since "test-model" doesn't exist
			expect(result.current.id).toBe("anthropic/claude-sonnet-4.5")
			// Should still use specific provider info for the default model if specified
			expect(result.current.info).toEqual({
				...{
					maxTokens: 8192,
					contextWindow: 200_000,
					supportsImages: true,
					supportsPromptCache: true,
					inputPrice: 3.0,
					outputPrice: 15.0,
					cacheWritesPrice: 3.75,
					cacheReadsPrice: 0.3,
				},
				...specificProviderInfo,
			})
		})

		it("should demonstrate the merging behavior validates the comment about missing fields", () => {
			const baseModelInfo: ModelInfo = {
				maxTokens: 4096,
				contextWindow: 8192,
				supportsImages: false,
				supportsPromptCache: false,
				cacheWritesPrice: 0.1,
				cacheReadsPrice: 0.01,
			}

			const specificProviderInfo: Partial<ModelInfo> = {
				inputPrice: 0.001,
				outputPrice: 0.002,
				description: "Provider-specific description",
				maxTokens: 8192, // Override this one
				supportsImages: true, // Override this one
			}

			mockUseRouterModels.mockReturnValue({
				data: {
					openrouter: {
						"test-model": baseModelInfo,
					},
					requesty: {},
					litellm: {},
				},
				isLoading: false,
				isError: false,
			} as any)

			mockUseOpenRouterModelProviders.mockReturnValue({
				data: { "test-provider": specificProviderInfo as ModelInfo },
				isLoading: false,
				isError: false,
			} as any)

			const apiConfiguration: ProviderSettings = {
				apiProvider: providerIdentifiers.openrouter,
				openRouterModelId: "test-model",
				openRouterSpecificProvider: "test-provider",
			}

			const wrapper = createWrapper()
			const { result } = renderHook(() => useSelectedModel(apiConfiguration), { wrapper })

			expect(result.current.id).toBe("test-model")
			expect(result.current.info).toEqual({
				// Fields from base model that provider doesn't have
				contextWindow: 8192, // From base (provider doesn't override)
				supportsPromptCache: false, // From base (provider doesn't override)
				cacheWritesPrice: 0.1, // From base (provider doesn't have)
				cacheReadsPrice: 0.01, // From base (provider doesn't have)

				// Fields overridden by provider
				maxTokens: 8192, // From provider (overrides base)
				supportsImages: true, // From provider (overrides base)

				// Fields only in provider
				inputPrice: 0.001, // From provider (base doesn't have)
				outputPrice: 0.002, // From provider (base doesn't have)
				description: "Provider-specific description", // From provider (base doesn't have)
			})
		})

		it("should use base model info when no specific provider is configured", () => {
			const baseModelInfo: ModelInfo = {
				maxTokens: 4096,
				contextWindow: 8192,
				supportsImages: false,
				supportsPromptCache: false,
			}

			mockUseRouterModels.mockReturnValue({
				data: {
					openrouter: { "test-model": baseModelInfo },
					requesty: {},
					litellm: {},
				},
				isLoading: false,
				isError: false,
			} as any)

			mockUseOpenRouterModelProviders.mockReturnValue({
				data: {},
				isLoading: false,
				isError: false,
			} as any)

			const apiConfiguration: ProviderSettings = {
				apiProvider: providerIdentifiers.openrouter,
				openRouterModelId: "test-model",
			}

			const wrapper = createWrapper()
			const { result } = renderHook(() => useSelectedModel(apiConfiguration), { wrapper })

			expect(result.current.id).toBe("test-model")
			expect(result.current.info).toEqual(baseModelInfo)
		})

		it("should fall back to default when configured model and provider don't exist", () => {
			mockUseRouterModels.mockReturnValue({
				data: {
					openrouter: {
						"anthropic/claude-sonnet-4.5": {
							// Default model - using correct default model name
							maxTokens: 8192,
							contextWindow: 200_000,
							supportsImages: true,
							supportsPromptCache: true,
							inputPrice: 3.0,
							outputPrice: 15.0,
							cacheWritesPrice: 3.75,
							cacheReadsPrice: 0.3,
						},
					},
					requesty: {},
					litellm: {},
				},
				isLoading: false,
				isError: false,
			} as any)

			mockUseOpenRouterModelProviders.mockReturnValue({
				data: {},
				isLoading: false,
				isError: false,
			} as any)

			const apiConfiguration: ProviderSettings = {
				apiProvider: providerIdentifiers.openrouter,
				openRouterModelId: "non-existent-model",
				openRouterSpecificProvider: "non-existent-provider",
			}

			const wrapper = createWrapper()
			const { result } = renderHook(() => useSelectedModel(apiConfiguration), { wrapper })

			// Should fall back to provider default since "non-existent-model" doesn't exist
			expect(result.current.id).toBe("anthropic/claude-sonnet-4.5")
			// Should use base model info since provider doesn't exist
			expect(result.current.info).toEqual({
				maxTokens: 8192,
				contextWindow: 200_000,
				supportsImages: true,
				supportsPromptCache: true,
				inputPrice: 3.0,
				outputPrice: 15.0,
				cacheWritesPrice: 3.75,
				cacheReadsPrice: 0.3,
			})
		})
	})

	describe("loading and error states", () => {
		it("should set loading when router models are loading for the default OpenRouter provider", () => {
			mockUseRouterModels.mockReturnValue({
				data: undefined,
				isLoading: true,
				isError: false,
			} as any)

			mockUseOpenRouterModelProviders.mockReturnValue({
				data: undefined,
				isLoading: false,
				isError: false,
			} as any)

			const wrapper = createWrapper()
			const { result } = renderHook(() => useSelectedModel(), { wrapper })

			expect(result.current.isLoading).toBe(true)
		})

		it("should set loading when OpenRouter provider metadata is loading for the default provider", () => {
			mockUseRouterModels.mockReturnValue({
				data: { openrouter: {}, requesty: {}, litellm: {} },
				isLoading: false,
				isError: false,
			} as any)

			mockUseOpenRouterModelProviders.mockReturnValue({
				data: undefined,
				isLoading: true,
				isError: false,
			} as any)

			const wrapper = createWrapper()
			const { result } = renderHook(() => useSelectedModel(), { wrapper })

			expect(result.current.isLoading).toBe(true)
		})

		it("should set error when router models error for the default OpenRouter provider", () => {
			mockUseRouterModels.mockReturnValue({
				data: undefined,
				isLoading: false,
				isError: true,
			} as any)

			mockUseOpenRouterModelProviders.mockReturnValue({
				data: {},
				isLoading: false,
				isError: false,
			} as any)

			const wrapper = createWrapper()
			const { result } = renderHook(() => useSelectedModel(), { wrapper })

			expect(result.current.isError).toBe(true)
		})
	})

	describe("default behavior", () => {
		it("should return OpenRouter default when no configuration is provided", () => {
			mockUseRouterModels.mockReturnValue({
				data: undefined,
				isLoading: false,
				isError: false,
			} as any)

			mockUseOpenRouterModelProviders.mockReturnValue({
				data: undefined,
				isLoading: false,
				isError: false,
			} as any)

			const wrapper = createWrapper()
			const { result } = renderHook(() => useSelectedModel(), { wrapper })

			expect(result.current.provider).toBe(providerIdentifiers.openrouter)
			expect(result.current.id).toBe(openRouterDefaultModelId)
			expect(result.current.info).toBeUndefined()
		})
	})

	describe("anthropic provider with 1M context", () => {
		beforeEach(() => {
			mockUseRouterModels.mockReturnValue({
				data: undefined,
				isLoading: false,
				isError: false,
			} as any)

			mockUseOpenRouterModelProviders.mockReturnValue({
				data: undefined,
				isLoading: false,
				isError: false,
			} as any)
		})

		it("should apply 1M pricing tier for Claude Sonnet 4.6 when enabled", () => {
			const apiConfiguration: ProviderSettings = {
				apiProvider: providerIdentifiers.anthropic,
				apiModelId: "claude-sonnet-4-6",
				anthropicBeta1MContext: true,
			}

			const wrapper = createWrapper()
			const { result } = renderHook(() => useSelectedModel(apiConfiguration), { wrapper })

			expect(result.current.id).toBe("claude-sonnet-4-6")
			expect(result.current.info?.contextWindow).toBe(1_000_000)
			expect(result.current.info?.inputPrice).toBe(6.0)
			expect(result.current.info?.outputPrice).toBe(22.5)
		})

		it("should apply 1M pricing tier for Claude Opus 4.6 when enabled", () => {
			const apiConfiguration: ProviderSettings = {
				apiProvider: providerIdentifiers.anthropic,
				apiModelId: "claude-opus-4-6",
				anthropicBeta1MContext: true,
			}

			const wrapper = createWrapper()
			const { result } = renderHook(() => useSelectedModel(apiConfiguration), { wrapper })

			expect(result.current.id).toBe("claude-opus-4-6")
			expect(result.current.info?.contextWindow).toBe(1_000_000)
			expect(result.current.info?.inputPrice).toBe(10.0)
			expect(result.current.info?.outputPrice).toBe(37.5)
		})

		it.each([providerIdentifiers.anthropic, providerIdentifiers.geminiCli, providerIdentifiers.fakeAi] as const)(
			"should explicitly resolve configured models for %s",
			(apiProvider) => {
				const apiConfiguration: ProviderSettings = {
					apiProvider,
					apiModelId: "claude-sonnet-4-6",
				}

				const wrapper = createWrapper()
				const { result } = renderHook(() => useSelectedModel(apiConfiguration), { wrapper })

				expect(result.current.provider).toBe(apiProvider)
				expect(result.current.id).toBe("claude-sonnet-4-6")
				expect(result.current.info).toEqual(anthropicModels["claude-sonnet-4-6"])
			},
		)
	})

	describe("bedrock provider with 1M context", () => {
		beforeEach(() => {
			mockUseRouterModels.mockReturnValue({
				data: {
					openrouter: {},
					requesty: {},
					litellm: {},
				},
				isLoading: false,
				isError: false,
			} as any)

			mockUseOpenRouterModelProviders.mockReturnValue({
				data: {},
				isLoading: false,
				isError: false,
			} as any)
		})

		it("should enable 1M context window for Bedrock Claude Sonnet 4 when awsBedrock1MContext is true", () => {
			const apiConfiguration: ProviderSettings = {
				apiProvider: providerIdentifiers.bedrock,
				apiModelId: BEDROCK_1M_CONTEXT_MODEL_IDS[0],
				awsBedrock1MContext: true,
			}

			const wrapper = createWrapper()
			const { result } = renderHook(() => useSelectedModel(apiConfiguration), { wrapper })

			expect(result.current.id).toBe(BEDROCK_1M_CONTEXT_MODEL_IDS[0])
			expect(result.current.info?.contextWindow).toBe(1_000_000)
		})

		it("should use default context window for Bedrock Claude Sonnet 4 when awsBedrock1MContext is false", () => {
			const apiConfiguration: ProviderSettings = {
				apiProvider: providerIdentifiers.bedrock,
				apiModelId: BEDROCK_1M_CONTEXT_MODEL_IDS[0],
				awsBedrock1MContext: false,
			}

			const wrapper = createWrapper()
			const { result } = renderHook(() => useSelectedModel(apiConfiguration), { wrapper })

			expect(result.current.id).toBe(BEDROCK_1M_CONTEXT_MODEL_IDS[0])
			expect(result.current.info?.contextWindow).toBe(200_000)
		})

		it("should not affect context window for non-Claude Sonnet 4 Bedrock models", () => {
			const apiConfiguration: ProviderSettings = {
				apiProvider: providerIdentifiers.bedrock,
				apiModelId: "anthropic.claude-3-5-sonnet-20241022-v2:0",
				awsBedrock1MContext: true,
			}

			const wrapper = createWrapper()
			const { result } = renderHook(() => useSelectedModel(apiConfiguration), { wrapper })

			expect(result.current.id).toBe("anthropic.claude-3-5-sonnet-20241022-v2:0")
			expect(result.current.info?.contextWindow).toBe(200_000)
		})
	})

	describe("bedrock provider with custom ARN", () => {
		beforeEach(() => {
			mockUseRouterModels.mockReturnValue({
				data: {
					openrouter: {},
					requesty: {},
					litellm: {},
				},
				isLoading: false,
				isError: false,
			} as any)

			mockUseOpenRouterModelProviders.mockReturnValue({
				data: {},
				isLoading: false,
				isError: false,
			} as any)
		})

		it("should enable supportsPromptCache for custom-arn model", () => {
			const apiConfiguration: ProviderSettings = {
				apiProvider: providerIdentifiers.bedrock,
				apiModelId: "custom-arn",
			}

			const wrapper = createWrapper()
			const { result } = renderHook(() => useSelectedModel(apiConfiguration), { wrapper })

			expect(result.current.id).toBe("custom-arn")
			expect(result.current.info?.supportsPromptCache).toBe(true)
		})

		it("should enable supportsImages for custom-arn model", () => {
			const apiConfiguration: ProviderSettings = {
				apiProvider: providerIdentifiers.bedrock,
				apiModelId: "custom-arn",
			}

			const wrapper = createWrapper()
			const { result } = renderHook(() => useSelectedModel(apiConfiguration), { wrapper })

			expect(result.current.id).toBe("custom-arn")
			expect(result.current.info?.supportsImages).toBe(true)
		})
	})

	describe("litellm provider", () => {
		beforeEach(() => {
			mockUseOpenRouterModelProviders.mockReturnValue({
				data: {},
				isLoading: false,
				isError: false,
			} as any)
		})

		it("should use litellmDefaultModelInfo as fallback when routerModels.litellm is empty", () => {
			mockUseRouterModels.mockReturnValue({
				data: {
					openrouter: {},
					requesty: {},
					litellm: {},
				},
				isLoading: false,
				isError: false,
			} as any)

			const apiConfiguration: ProviderSettings = {
				apiProvider: providerIdentifiers.litellm,
				litellmModelId: "some-model",
			}

			const wrapper = createWrapper()
			const { result } = renderHook(() => useSelectedModel(apiConfiguration), { wrapper })

			expect(result.current.provider).toBe(providerIdentifiers.litellm)
			// Should preserve configured model ID since "some-model" doesn't exist in empty litellm models
			expect(result.current.id).toBe("some-model")
			// Should use litellmDefaultModelInfo as fallback
			expect(result.current.info).toEqual(litellmDefaultModelInfo)
		})

		it("should return an empty model ID when the list is empty and no model is configured", () => {
			mockUseRouterModels.mockReturnValue({
				data: {
					openrouter: {},
					requesty: {},
					litellm: {},
				},
				isLoading: false,
				isError: false,
			} as any)

			const apiConfiguration: ProviderSettings = {
				apiProvider: providerIdentifiers.litellm,
				// litellmModelId intentionally omitted
			}

			const wrapper = createWrapper()
			const { result } = renderHook(() => useSelectedModel(apiConfiguration), { wrapper })

			expect(result.current.provider).toBe(providerIdentifiers.litellm)
			// LiteLLM has no inherent default; with nothing configured the ID is empty rather than a phantom model
			expect(result.current.id).toBe("")
			expect(result.current.info).toEqual(litellmDefaultModelInfo)
		})

		it("preserves the selected model when the list transitions from populated to empty", () => {
			// Primary user-visible scenario: a "Sync Models" click momentarily empties the
			// router-models list before the refreshed list arrives. The selection must be held
			// across that transition rather than reset.
			mockUseRouterModels.mockReturnValue({
				data: {
					openrouter: {},
					requesty: {},
					litellm: {
						"my-custom-model": {
							maxTokens: 4096,
							contextWindow: 8192,
							supportsImages: false,
							supportsPromptCache: false,
						},
					},
				},
				isLoading: false,
				isError: false,
			} as any)

			const apiConfiguration: ProviderSettings = {
				apiProvider: providerIdentifiers.litellm,
				litellmModelId: "my-custom-model",
			}

			const wrapper = createWrapper()
			const { result, rerender } = renderHook(() => useSelectedModel(apiConfiguration), { wrapper })

			// Initially the configured model resolves from the populated list.
			expect(result.current.id).toBe("my-custom-model")

			// Simulate the list emptying mid-sync.
			mockUseRouterModels.mockReturnValue({
				data: {
					openrouter: {},
					requesty: {},
					litellm: {},
				},
				isLoading: false,
				isError: false,
			} as any)
			rerender()

			// Selection is preserved through the empty window.
			expect(result.current.id).toBe("my-custom-model")
		})

		it("should use litellmDefaultModelInfo when selected model not found in routerModels", () => {
			mockUseRouterModels.mockReturnValue({
				data: {
					openrouter: {},
					requesty: {},
					litellm: {
						"existing-model": {
							maxTokens: 4096,
							contextWindow: 8192,
							supportsImages: false,
							supportsPromptCache: false,
						},
					},
				},
				isLoading: false,
				isError: false,
			} as any)

			const apiConfiguration: ProviderSettings = {
				apiProvider: providerIdentifiers.litellm,
				litellmModelId: "non-existing-model",
			}

			const wrapper = createWrapper()
			const { result } = renderHook(() => useSelectedModel(apiConfiguration), { wrapper })

			expect(result.current.provider).toBe(providerIdentifiers.litellm)
			// Falls back to default model ID
			expect(result.current.id).toBe("claude-3-7-sonnet-20250219")
			// Should use litellmDefaultModelInfo as fallback since default model also not in router models
			expect(result.current.info).toEqual(litellmDefaultModelInfo)
		})

		it("should return routerModels info when model exists", () => {
			const customModelInfo: ModelInfo = {
				maxTokens: 16384,
				contextWindow: 128000,
				supportsImages: true,
				supportsPromptCache: true,
				description: "Custom LiteLLM model",
			}

			mockUseRouterModels.mockReturnValue({
				data: {
					openrouter: {},
					requesty: {},
					litellm: {
						"custom-model": customModelInfo,
					},
				},
				isLoading: false,
				isError: false,
			} as any)

			const apiConfiguration: ProviderSettings = {
				apiProvider: providerIdentifiers.litellm,
				litellmModelId: "custom-model",
			}

			const wrapper = createWrapper()
			const { result } = renderHook(() => useSelectedModel(apiConfiguration), { wrapper })

			expect(result.current.provider).toBe(providerIdentifiers.litellm)
			expect(result.current.id).toBe("custom-model")
			expect(result.current.info).toEqual(customModelInfo)
		})
	})

	describe("kenari provider", () => {
		beforeEach(() => {
			mockUseOpenRouterModelProviders.mockReturnValue({
				data: {},
				isLoading: false,
				isError: false,
			} as any)
		})

		it("should return routerModels info for the configured kenari model", () => {
			const customModelInfo: ModelInfo = {
				maxTokens: 32768,
				contextWindow: 1048576,
				supportsImages: false,
				supportsPromptCache: false,
				description: "GLM 5.2 via Kenari",
			}

			mockUseRouterModels.mockReturnValue({
				data: {
					openrouter: {},
					requesty: {},
					litellm: {},
					kenari: {
						"glm-5-2": customModelInfo,
					},
				},
				isLoading: false,
				isError: false,
			} as any)

			const apiConfiguration: ProviderSettings = {
				apiProvider: providerIdentifiers.kenari,
				kenariModelId: "glm-5-2",
			}

			const wrapper = createWrapper()
			const { result } = renderHook(() => useSelectedModel(apiConfiguration), { wrapper })

			expect(result.current.provider).toBe(providerIdentifiers.kenari)
			expect(result.current.id).toBe("glm-5-2")
			expect(result.current.info).toEqual(customModelInfo)
		})

		it("should use kenariDefaultModelInfo as fallback when routerModels.kenari is empty", () => {
			mockUseRouterModels.mockReturnValue({
				data: {
					openrouter: {},
					requesty: {},
					litellm: {},
					kenari: {},
				},
				isLoading: false,
				isError: false,
			} as any)

			const apiConfiguration: ProviderSettings = {
				apiProvider: providerIdentifiers.kenari,
				kenariModelId: "some-model",
			}

			const wrapper = createWrapper()
			const { result } = renderHook(() => useSelectedModel(apiConfiguration), { wrapper })

			expect(result.current.provider).toBe(providerIdentifiers.kenari)
			// Falls back to the kenari default model ID when the router list is empty
			expect(result.current.id).toBe(kenariDefaultModelId)
			// Should use kenariDefaultModelInfo as fallback
			expect(result.current.info).toEqual(kenariDefaultModelInfo)
		})
	})

	describe("nanogpt provider", () => {
		it("uses dynamic metadata for the configured NanoGPT model", () => {
			const dynamicInfo: ModelInfo = {
				maxTokens: 16_384,
				contextWindow: 256_000,
				supportsPromptCache: false,
				description: "Dynamic NanoGPT model",
			}
			mockUseRouterModels.mockReturnValue(createRouterModelsResult({ nanogpt: { "openai/custom": dynamicInfo } }))
			mockUseOpenRouterModelProviders.mockReturnValue(createOpenRouterModelProvidersResult({}))

			const { result } = renderHook(
				() =>
					useSelectedModel({
						apiProvider: providerIdentifiers.nanogpt,
						nanoGptModelId: "openai/custom",
					}),
				{ wrapper: createWrapper() },
			)

			expect(result.current.id).toBe("openai/custom")
			expect(result.current.info).toEqual(dynamicInfo)
		})

		it("uses NanoGPT's shared fallback when its dynamic catalog is empty", () => {
			mockUseRouterModels.mockReturnValue(createRouterModelsResult({ nanogpt: {} }))
			mockUseOpenRouterModelProviders.mockReturnValue(createOpenRouterModelProvidersResult({}))

			const { result } = renderHook(
				() =>
					useSelectedModel({
						apiProvider: providerIdentifiers.nanogpt,
						nanoGptModelId: "missing-model",
					}),
				{ wrapper: createWrapper() },
			)

			expect(result.current.id).toBe(nanoGptDefaultModelId)
			expect(result.current.info).toEqual(nanoGptDefaultModelInfo)
		})
	})

	describe("openai provider", () => {
		beforeEach(() => {
			mockUseRouterModels.mockReturnValue({
				data: {
					openrouter: {},
					requesty: {},
					litellm: {},
				},
				isLoading: false,
				isError: false,
			} as any)

			mockUseOpenRouterModelProviders.mockReturnValue({
				data: {},
				isLoading: false,
				isError: false,
			} as any)
		})

		it("should use openAiModelInfoSaneDefaults when no custom model info is provided", () => {
			const apiConfiguration: ProviderSettings = {
				apiProvider: providerIdentifiers.openai,
				openAiModelId: "gpt-4o",
			}

			const wrapper = createWrapper()
			const { result } = renderHook(() => useSelectedModel(apiConfiguration), { wrapper })

			expect(result.current.provider).toBe(providerIdentifiers.openai)
			expect(result.current.id).toBe("gpt-4o")
			expect(result.current.info).toEqual(openAiModelInfoSaneDefaults)
		})

		it("should return custom model info when provided", () => {
			const customModelInfo: ModelInfo = {
				maxTokens: 16384,
				contextWindow: 128000,
				supportsImages: true,
				supportsPromptCache: false,
				inputPrice: 0.01,
				outputPrice: 0.03,
				description: "Custom OpenAI-compatible model",
			}

			const apiConfiguration: ProviderSettings = {
				apiProvider: providerIdentifiers.openai,
				openAiModelId: "custom-model",
				openAiCustomModelInfo: customModelInfo,
			}

			const wrapper = createWrapper()
			const { result } = renderHook(() => useSelectedModel(apiConfiguration), { wrapper })

			expect(result.current.provider).toBe(providerIdentifiers.openai)
			expect(result.current.id).toBe("custom-model")
			expect(result.current.info).toEqual(customModelInfo)
		})

		it("should return custom model info as-is", () => {
			const customModelInfo: ModelInfo = {
				maxTokens: 8192,
				contextWindow: 32000,
				supportsImages: false,
				supportsPromptCache: false,
			}

			const apiConfiguration: ProviderSettings = {
				apiProvider: providerIdentifiers.openai,
				openAiModelId: "custom-model-no-tools",
				openAiCustomModelInfo: customModelInfo,
			}

			const wrapper = createWrapper()
			const { result } = renderHook(() => useSelectedModel(apiConfiguration), { wrapper })

			expect(result.current.provider).toBe(providerIdentifiers.openai)
			expect(result.current.id).toBe("custom-model-no-tools")
			expect(result.current.info).toEqual(customModelInfo)
		})
	})

	describe("minimax provider", () => {
		beforeEach(() => {
			mockUseRouterModels.mockReturnValue({
				data: {
					openrouter: {},
					requesty: {},
					litellm: {},
				},
				isLoading: false,
				isError: false,
			} as any)

			mockUseOpenRouterModelProviders.mockReturnValue({
				data: {},
				isLoading: false,
				isError: false,
			} as any)
		})

		it("should return default minimax model when no custom model is specified", () => {
			const apiConfiguration: ProviderSettings = {
				apiProvider: providerIdentifiers.minimax,
			}

			const wrapper = createWrapper()
			const { result } = renderHook(() => useSelectedModel(apiConfiguration), { wrapper })

			expect(result.current.provider).toBe(providerIdentifiers.minimax)
			expect(result.current.id).toBe(minimaxDefaultModelId)
			expect(result.current.info).toEqual(minimaxModels[minimaxDefaultModelId])
		})

		it("should use custom model ID and info when model exists in minimaxModels", () => {
			const apiConfiguration: ProviderSettings = {
				apiProvider: providerIdentifiers.minimax,
				apiModelId: "MiniMax-M2.7",
			}

			const wrapper = createWrapper()
			const { result } = renderHook(() => useSelectedModel(apiConfiguration), { wrapper })

			expect(result.current.provider).toBe(providerIdentifiers.minimax)
			expect(result.current.id).toBe("MiniMax-M2.7")
			expect(result.current.info).toEqual(minimaxModels["MiniMax-M2.7"])
		})
	})

	describe("vscode-lm provider", () => {
		beforeEach(() => {
			mockUseRouterModels.mockReturnValue({
				data: {
					openrouter: {},
					requesty: {},
					litellm: {},
				},
				isLoading: false,
				isError: false,
			} as any)

			mockUseOpenRouterModelProviders.mockReturnValue({
				data: {},
				isLoading: false,
				isError: false,
			} as any)
		})

		it("resolves a listed family's contextWindow to its maxInputTokens", () => {
			const family = vscodeLlmDefaultModelId
			const apiConfiguration: ProviderSettings = {
				apiProvider: providerIdentifiers.vscodeLm,
				vsCodeLmModelSelector: { vendor: "copilot", family },
			}

			const wrapper = createWrapper()
			const { result } = renderHook(() => useSelectedModel(apiConfiguration), { wrapper })

			expect(result.current.provider).toBe(providerIdentifiers.vscodeLm)
			expect(result.current.id).toBe(`copilot/${family}`)
			// The bar and the condense gate share one source of truth: contextWindow === maxInputTokens.
			expect(result.current.info?.contextWindow).toBe(vscodeLlmModels[family].maxInputTokens)
			expect(result.current.info?.supportsImages).toBe(false)
		})

		it("pins a divergent family's contextWindow to maxInputTokens, not its advertised window", () => {
			// claude-opus-4.8 is the row where contextWindow and maxInputTokens differ; a field swap to
			// the advertised window would be caught here.
			const family = "claude-opus-4.8"
			const apiConfiguration: ProviderSettings = {
				apiProvider: providerIdentifiers.vscodeLm,
				vsCodeLmModelSelector: { vendor: "copilot", family },
			}

			const wrapper = createWrapper()
			const { result } = renderHook(() => useSelectedModel(apiConfiguration), { wrapper })

			expect(result.current.provider).toBe(providerIdentifiers.vscodeLm)
			expect(result.current.id).toBe(`copilot/${family}`)
			expect(result.current.info?.contextWindow).toBe(vscodeLlmModels[family].maxInputTokens) // 197897
			expect(result.current.info?.contextWindow).not.toBe(vscodeLlmModels[family].contextWindow) // NOT 679560
			expect(result.current.info?.supportsImages).toBe(false)
		})

		it("falls back to the default model's window for an unlisted family (NOT 128000)", () => {
			const apiConfiguration: ProviderSettings = {
				apiProvider: providerIdentifiers.vscodeLm,
				vsCodeLmModelSelector: { vendor: "copilot", family: "totally-unknown-family" },
			}

			const wrapper = createWrapper()
			const { result } = renderHook(() => useSelectedModel(apiConfiguration), { wrapper })

			// A family miss must not use the 128000 sane-defaults window; use the default model's instead.
			expect(result.current.info?.contextWindow).not.toBe(128000)
			expect(result.current.info?.contextWindow).toBe(vscodeLlmModels[vscodeLlmDefaultModelId].maxInputTokens)
			expect(result.current.info?.supportsImages).toBe(false)
		})
	})

	describe("friendli provider", () => {
		beforeEach(() => {
			mockUseRouterModels.mockReturnValue({
				data: {
					openrouter: {},
					requesty: {},
					litellm: {},
					friendli: {},
				},
				isLoading: false,
				isError: false,
			} as unknown as ReturnType<typeof useRouterModels>)

			mockUseOpenRouterModelProviders.mockReturnValue({
				data: {},
				isLoading: false,
				isError: false,
			} as any)
		})

		it("should return default Friendli model when no custom model is specified", () => {
			const apiConfiguration: ProviderSettings = {
				apiProvider: providerIdentifiers.friendli,
			}

			const wrapper = createWrapper()
			const { result } = renderHook(() => useSelectedModel(apiConfiguration), { wrapper })

			expect(result.current.provider).toBe(providerIdentifiers.friendli)
			expect(result.current.id).toBe(friendliDefaultModelId)
			expect(result.current.info).toEqual(friendliModels[friendliDefaultModelId])
		})

		it("should use custom model ID and info when model exists in routerModels", () => {
			const dynamicModelInfo: ModelInfo = {
				maxTokens: 202752,
				contextWindow: 202752,
				supportsImages: false,
				supportsPromptCache: true,
				supportsMaxTokens: true,
				inputPrice: 1.4,
				outputPrice: 4.4,
				cacheWritesPrice: 0,
				cacheReadsPrice: 0.26,
				description: "Dynamic GLM-5.1 model from /v1/models",
			}
			mockUseRouterModels.mockReturnValue({
				data: {
					openrouter: {},
					requesty: {},
					litellm: {},
					friendli: { "zai-org/GLM-5.1": dynamicModelInfo },
				},
				isLoading: false,
				isError: false,
			} as unknown as ReturnType<typeof useRouterModels>)

			const apiConfiguration: ProviderSettings = {
				apiProvider: providerIdentifiers.friendli,
				apiModelId: "zai-org/GLM-5.1",
			}

			const wrapper = createWrapper()
			const { result } = renderHook(() => useSelectedModel(apiConfiguration), { wrapper })

			expect(result.current.provider).toBe(providerIdentifiers.friendli)
			expect(result.current.id).toBe("zai-org/GLM-5.1")
			expect(result.current.info).toEqual(dynamicModelInfo)
		})
		it("preserves saved static model when router data is empty", () => {
			mockUseRouterModels.mockReturnValue({
				data: {
					openrouter: {},
					requesty: {},
					litellm: {},
					friendli: {},
				},
				isLoading: false,
				isError: false,
			} as unknown as ReturnType<typeof useRouterModels>)

			const apiConfiguration: ProviderSettings = {
				apiProvider: providerIdentifiers.friendli,
				apiModelId: "zai-org/GLM-5.2",
			}

			const wrapper = createWrapper()
			const { result } = renderHook(() => useSelectedModel(apiConfiguration), { wrapper })

			expect(result.current.id).toBe("zai-org/GLM-5.2")
			expect(result.current.info).toEqual(friendliModels["zai-org/GLM-5.2"])
		})

		it("falls back to default model when router is empty and no saved model", () => {
			mockUseRouterModels.mockReturnValue({
				data: {
					openrouter: {},
					requesty: {},
					litellm: {},
					friendli: {},
				},
				isLoading: false,
				isError: false,
			} as unknown as ReturnType<typeof useRouterModels>)

			const apiConfiguration: ProviderSettings = {
				apiProvider: providerIdentifiers.friendli,
			}

			const wrapper = createWrapper()
			const { result } = renderHook(() => useSelectedModel(apiConfiguration), { wrapper })

			expect(result.current.id).toBe(friendliDefaultModelId)
			expect(result.current.info).toEqual(friendliModels[friendliDefaultModelId])
		})

		it("preserves a dynamic-only saved id with undefined info while router is still empty", () => {
			// Mirrors FriendliHandler.getModel() on the extension host: during
			// the loading window a saved id that isn't in the static seed
			// keeps its id instead of silently becoming the default model.
			mockUseRouterModels.mockReturnValue({
				data: {
					openrouter: {},
					requesty: {},
					litellm: {},
					friendli: {},
				},
				isLoading: false,
				isError: false,
			} as unknown as ReturnType<typeof useRouterModels>)

			const apiConfiguration: ProviderSettings = {
				apiProvider: providerIdentifiers.friendli,
				apiModelId: "nonexistent/model",
			}

			const wrapper = createWrapper()
			const { result } = renderHook(() => useSelectedModel(apiConfiguration), { wrapper })

			expect(result.current.id).toBe("nonexistent/model")
			expect(result.current.info).toBeUndefined()
		})

		it("prefers dynamic router info over static info for a model id present in both", () => {
			const staticGlm52 = friendliModels["zai-org/GLM-5.2"]
			const dynamicGlm52: ModelInfo = {
				...staticGlm52,
				description: "Dynamic GLM-5.2 from /v1/models",
				inputPrice: 999,
			}
			mockUseRouterModels.mockReturnValue({
				data: {
					openrouter: {},
					requesty: {},
					litellm: {},
					friendli: { "zai-org/GLM-5.2": dynamicGlm52 },
				},
				isLoading: false,
				isError: false,
			} as unknown as ReturnType<typeof useRouterModels>)

			const apiConfiguration: ProviderSettings = {
				apiProvider: providerIdentifiers.friendli,
				apiModelId: "zai-org/GLM-5.2",
			}

			const wrapper = createWrapper()
			const { result } = renderHook(() => useSelectedModel(apiConfiguration), { wrapper })

			expect(result.current.id).toBe("zai-org/GLM-5.2")
			expect(result.current.info).toEqual(dynamicGlm52)
			expect(result.current.info).not.toEqual(staticGlm52)
		})
	})

	describe("Z AI provider", () => {
		it("uses the International Coding catalog when no API line is configured", () => {
			const apiConfiguration: ProviderSettings = {
				apiProvider: providerIdentifiers.zai,
				apiModelId: "glm-5.3-flash",
			}

			const { result } = renderHook(() => useSelectedModel(apiConfiguration), { wrapper: createWrapper() })

			expect(result.current.id).toBe("glm-5.3-flash")
			expect(result.current.info).toEqual(getZAiModels("international_coding")["glm-5.3-flash"])
			expect(result.current.info?.supportsImages).toBe(true)
		})

		it("uses the China Coding catalog for GLM-5.3", () => {
			const apiConfiguration: ProviderSettings = {
				apiProvider: providerIdentifiers.zai,
				apiModelId: "glm-5.3",
				zaiApiLine: "china_coding",
			}

			const { result } = renderHook(() => useSelectedModel(apiConfiguration), { wrapper: createWrapper() })

			expect(result.current.id).toBe("glm-5.3")
			expect(result.current.info).toEqual(getZAiModels("china_coding")["glm-5.3"])
			expect(result.current.info?.inputPrice).toBe(0.68)
		})

		it("uses the International API catalog for GLM-5.3", () => {
			const apiConfiguration: ProviderSettings = {
				apiProvider: providerIdentifiers.zai,
				apiModelId: "glm-5.3",
				zaiApiLine: "international_api",
			}

			const { result } = renderHook(() => useSelectedModel(apiConfiguration), { wrapper: createWrapper() })

			expect(result.current.id).toBe("glm-5.3")
			expect(result.current.info).toEqual(getZAiModels("international_api")["glm-5.3"])
		})

		it("falls back when GLM-5.3 is unavailable on the China API", () => {
			const apiConfiguration: ProviderSettings = {
				apiProvider: providerIdentifiers.zai,
				apiModelId: "glm-5.3",
				zaiApiLine: "china_api",
			}

			const { result } = renderHook(() => useSelectedModel(apiConfiguration), { wrapper: createWrapper() })

			expect(result.current.id).toBe(mainlandZAiDefaultModelId)
			expect(result.current.info).toEqual(getZAiModels("china_api")[mainlandZAiDefaultModelId])
		})
	})

	describe("Kimi Code provider", () => {
		it("should use the Kimi Code default while router models are loading and no model is configured", () => {
			mockUseRouterModels.mockReturnValue(createRouterModelsResult(undefined, { isLoading: true }))

			const apiConfiguration: ProviderSettings = {
				apiProvider: providerIdentifiers.kimiCode,
			}

			const { result } = renderHook(() => useSelectedModel(apiConfiguration), { wrapper: createWrapper() })

			expect(result.current.provider).toBe(providerIdentifiers.kimiCode)
			expect(result.current.id).toBe("kimi-for-coding")
			expect(result.current.info).toEqual(kimiCodeDefaultModelInfo)
			expect(result.current.isLoading).toBe(true)
		})

		it("should resolve the configured model from router models", () => {
			const modelInfo: ModelInfo = {
				...kimiCodeDefaultModelInfo,
				description: "Configured Kimi Code model",
			}

			mockUseRouterModels.mockReturnValue(
				createRouterModelsResult({ [providerIdentifiers.kimiCode]: { "kimi-for-coding": modelInfo } }),
			)

			const apiConfiguration: ProviderSettings = {
				apiProvider: providerIdentifiers.kimiCode,
				apiModelId: "kimi-for-coding",
			}

			const wrapper = createWrapper()
			const { result } = renderHook(() => useSelectedModel(apiConfiguration), { wrapper })

			expect(result.current.provider).toBe(providerIdentifiers.kimiCode)
			expect(result.current.id).toBe("kimi-for-coding")
			expect(result.current.info).toEqual(modelInfo)
		})
	})

	it("should reject providers unsupported by model selection", () => {
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)
		const preventExpectedError = (event: ErrorEvent) => event.preventDefault()
		window.addEventListener("error", preventExpectedError)
		const apiConfiguration = {
			apiProvider: "unsupported-provider",
		} as unknown as ProviderSettings

		const wrapper = createWrapper()

		expect(() => renderHook(() => useSelectedModel(apiConfiguration), { wrapper })).toThrow(
			"Unsupported provider: unsupported-provider",
		)
		window.removeEventListener("error", preventExpectedError)
		consoleError.mockRestore()
	})

	describe("moonshot provider", () => {
		beforeEach(() => {
			mockUseRouterModels.mockReturnValue({
				data: {
					openrouter: {},
					requesty: {},
					litellm: {},
					moonshot: {},
				},
				isLoading: false,
				isError: false,
			} as any)

			mockUseOpenRouterModelProviders.mockReturnValue({
				data: {},
				isLoading: false,
				isError: false,
			} as any)
		})

		it("should return default moonshot model when no custom model is specified", () => {
			const apiConfiguration: ProviderSettings = {
				apiProvider: providerIdentifiers.moonshot,
			}

			const wrapper = createWrapper()
			const { result } = renderHook(() => useSelectedModel(apiConfiguration), { wrapper })

			expect(result.current.provider).toBe(providerIdentifiers.moonshot)
			expect(result.current.id).toBe(moonshotDefaultModelId)
			expect(result.current.info).toEqual(moonshotModels[moonshotDefaultModelId])
		})

		it("should use router model override when routerModels.moonshot has the model", () => {
			const routerModelInfo: ModelInfo = {
				maxTokens: 32000,
				contextWindow: 262144,
				supportsImages: false,
				supportsPromptCache: true,
				inputPrice: 1.0,
				outputPrice: 5.0,
			}

			mockUseRouterModels.mockReturnValue({
				data: {
					openrouter: {},
					requesty: {},
					litellm: {},
					moonshot: {
						"kimi-k2-0905-preview": routerModelInfo,
					},
				},
				isLoading: false,
				isError: false,
			} as any)

			const apiConfiguration: ProviderSettings = {
				apiProvider: providerIdentifiers.moonshot,
			}

			const wrapper = createWrapper()
			const { result } = renderHook(() => useSelectedModel(apiConfiguration), { wrapper })

			expect(result.current.id).toBe(moonshotDefaultModelId)
			// Router info takes precedence over static info
			expect(result.current.info).toEqual(routerModelInfo)
		})

		it("should fallback to default when model ID is not in static or router models", () => {
			const apiConfiguration: ProviderSettings = {
				apiProvider: providerIdentifiers.moonshot,
				apiModelId: "non-existent-model",
			}

			const wrapper = createWrapper()
			const { result } = renderHook(() => useSelectedModel(apiConfiguration), { wrapper })

			expect(result.current.id).toBe(moonshotDefaultModelId)
			expect(result.current.info).toEqual(moonshotModels[moonshotDefaultModelId])
		})

		it("should use getValidatedModelId to return apiModelId when valid", () => {
			const apiConfiguration: ProviderSettings = {
				apiProvider: providerIdentifiers.moonshot,
				apiModelId: "kimi-k2-turbo-preview",
			}

			const wrapper = createWrapper()
			const { result } = renderHook(() => useSelectedModel(apiConfiguration), { wrapper })

			expect(result.current.id).toBe("kimi-k2-turbo-preview")
			expect(result.current.info).toEqual(moonshotModels["kimi-k2-turbo-preview"])
		})
	})
})
