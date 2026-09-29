import React from "react"
import { act, renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

import {
	providerIdentifiers,
	retiredProviderIdentifiers,
	anthropicDefaultModelId,
	bedrockDefaultModelId,
	deepSeekDefaultModelId,
	moonshotDefaultModelId,
	geminiDefaultModelId,
	mistralDefaultModelId,
	openAiNativeDefaultModelId,
	qwenCodeDefaultModelId,
	vertexDefaultModelId,
	xaiDefaultModelId,
	sambaNovaDefaultModelId,
	internationalZAiDefaultModelId,
	internationalZAiModels,
	mainlandZAiDefaultModelId,
	mainlandZAiModels,
	fireworksDefaultModelId,
	friendliDefaultModelId,
	minimaxDefaultModelId,
	mimoDefaultModelId,
	basetenDefaultModelId,
	openRouterDefaultModelId,
	requestyDefaultModelId,
	unboundDefaultModelId,
	litellmDefaultModelId,
	vercelAiGatewayDefaultModelId,
	zooGatewayDefaultModelId,
	opencodeGoDefaultModelId,
	kenariDefaultModelId,
	nanoGptDefaultModelId,
	kimiCodeDefaultModelId,
	poeDefaultModelId,
} from "@roo-code/types"

import { useChatModelSelector } from "../useChatModelSelector"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { useRouterModels } from "@/components/ui/hooks/useRouterModels"
import { vscode } from "@/utils/vscode"

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: vi.fn(),
}))

vi.mock("@/components/ui/hooks/useRouterModels", () => ({
	useRouterModels: vi.fn(),
}))

vi.mock("@/utils/vscode", () => ({
	vscode: {
		postMessage: vi.fn(),
	},
}))

const mockUseExtensionState = useExtensionState as ReturnType<typeof vi.fn>
const mockUseRouterModels = useRouterModels as ReturnType<typeof vi.fn>
const mockPostMessage = vscode.postMessage as ReturnType<typeof vi.fn>

const wrapper = ({ children }: { children: React.ReactNode }) => {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
	return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
}

const emitMessage = (message: unknown) => {
	window.dispatchEvent(new MessageEvent("message", { data: message }))
}

describe("useChatModelSelector", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockUseRouterModels.mockReturnValue({
			data: undefined,
			isLoading: false,
			isError: false,
		})
		mockUseExtensionState.mockReturnValue({
			apiConfiguration: { apiProvider: providerIdentifiers.anthropic, apiModelId: "claude-opus-4-20250514" },
			routerModels: undefined,
		})
	})

	describe("static providers", () => {
		it("returns static models for anthropic with apiModelId key", () => {
			const { result } = renderHook(() => useChatModelSelector(), { wrapper })

			expect(result.current.provider).toBe(providerIdentifiers.anthropic)
			expect(result.current.modelIdKey).toBe("apiModelId")
			expect(result.current.models).not.toBeNull()
			expect(Object.keys(result.current.models!)).toContain("claude-opus-4-20250514")
			// Assert the exact default id, not just "some non-empty value", so a
			// wrong/empty default is caught.
			expect(result.current.defaultModelId).toBe(anthropicDefaultModelId)
		})

		it("does not request message-based models for static providers", () => {
			renderHook(() => useChatModelSelector(), { wrapper })

			expect(mockPostMessage).not.toHaveBeenCalled()
		})
	})

	describe("zai (static provider, API line aware)", () => {
		it("uses international defaults and international model keys by default", () => {
			mockUseExtensionState.mockReturnValue({
				apiConfiguration: { apiProvider: providerIdentifiers.zai },
				routerModels: undefined,
			})

			const { result } = renderHook(() => useChatModelSelector(), { wrapper })

			expect(result.current.provider).toBe(providerIdentifiers.zai)
			expect(result.current.defaultModelId).toBe(internationalZAiDefaultModelId)
			expect(Object.keys(result.current.models!)).toEqual(
				expect.arrayContaining(Object.keys(internationalZAiModels)),
			)
			// International pricing proves the international registry was read
			// (the mainland registry uses different prices for the same model id).
			expect(result.current.models!["glm-4.5"]?.inputPrice).toBe(internationalZAiModels["glm-4.5"].inputPrice)
			expect(result.current.models!["glm-4.5"]?.inputPrice).not.toBe(mainlandZAiModels["glm-4.5"].inputPrice)
		})

		it("uses mainland defaults and mainland model keys when zaiApiLine is china_coding", () => {
			mockUseExtensionState.mockReturnValue({
				apiConfiguration: { apiProvider: providerIdentifiers.zai, zaiApiLine: "china_coding" },
				routerModels: undefined,
			})

			const { result } = renderHook(() => useChatModelSelector(), { wrapper })

			expect(result.current.defaultModelId).toBe(mainlandZAiDefaultModelId)
			expect(Object.keys(result.current.models!)).toEqual(expect.arrayContaining(Object.keys(mainlandZAiModels)))
			// The China Coding plan additionally exposes coding-plan-only models.
			expect(Object.keys(result.current.models!)).toEqual(expect.arrayContaining(["glm-5.3", "glm-5.3-flash"]))
			expect(result.current.models!["glm-4.5"]?.inputPrice).toBe(mainlandZAiModels["glm-4.5"].inputPrice)
			expect(result.current.models!["glm-4.5"]?.inputPrice).not.toBe(internationalZAiModels["glm-4.5"].inputPrice)
		})
	})

	describe("zoo-gateway (dynamic router provider)", () => {
		it("reads zoo-gateway models from the react-query routerModels", () => {
			mockUseRouterModels.mockReturnValue({
				data: {
					[providerIdentifiers.zooGateway]: {
						"anthropic/claude-sonnet-4": { maxTokens: 1, contextWindow: 1 },
					},
				},
				isLoading: false,
				isError: false,
			})
			mockUseExtensionState.mockReturnValue({
				apiConfiguration: {
					apiProvider: providerIdentifiers.zooGateway,
					zooGatewayModelId: "anthropic/claude-sonnet-4",
				},
				routerModels: undefined,
			})

			const { result } = renderHook(() => useChatModelSelector(), { wrapper })

			expect(result.current.modelIdKey).toBe("zooGatewayModelId")
			expect(result.current.defaultModelId).toBe(zooGatewayDefaultModelId)
			expect(Object.keys(result.current.models!)).toEqual(["anthropic/claude-sonnet-4"])
		})

		it("reports loading while the router models request is in flight", () => {
			mockUseRouterModels.mockReturnValue({ data: undefined, isLoading: true, isError: false })
			mockUseExtensionState.mockReturnValue({
				apiConfiguration: {
					apiProvider: providerIdentifiers.zooGateway,
					zooGatewayModelId: "anthropic/claude-sonnet-4",
				},
				routerModels: undefined,
			})

			const { result } = renderHook(() => useChatModelSelector(), { wrapper })

			expect(result.current.isLoading).toBe(true)
		})
	})

	describe("opencode-go (dynamic router provider)", () => {
		it("reads opencode-go models from the react-query routerModels", () => {
			mockUseRouterModels.mockReturnValue({
				data: { [providerIdentifiers.opencodeGo]: { "glm-5.2": { maxTokens: 1, contextWindow: 1 } } },
				isLoading: false,
				isError: false,
			})
			mockUseExtensionState.mockReturnValue({
				apiConfiguration: { apiProvider: providerIdentifiers.opencodeGo, opencodeGoModelId: "glm-5.2" },
				routerModels: undefined,
			})

			const { result } = renderHook(() => useChatModelSelector(), { wrapper })

			expect(result.current.modelIdKey).toBe("opencodeGoModelId")
			expect(result.current.defaultModelId).toBe(opencodeGoDefaultModelId)
			expect(Object.keys(result.current.models!)).toEqual(["glm-5.2"])
		})
	})

	describe("kenari (dynamic router provider)", () => {
		it("reads kenari models from the react-query routerModels", () => {
			mockUseRouterModels.mockReturnValue({
				data: { [providerIdentifiers.kenari]: { "glm-5-2": { maxTokens: 1, contextWindow: 1 } } },
				isLoading: false,
				isError: false,
			})
			mockUseExtensionState.mockReturnValue({
				apiConfiguration: { apiProvider: providerIdentifiers.kenari, kenariModelId: "glm-5-2" },
				routerModels: undefined,
			})

			const { result } = renderHook(() => useChatModelSelector(), { wrapper })

			expect(result.current.modelIdKey).toBe("kenariModelId")
			expect(result.current.defaultModelId).toBe(kenariDefaultModelId)
			expect(Object.keys(result.current.models!)).toEqual(["glm-5-2"])
		})
	})

	describe("nanogpt (dynamic router provider)", () => {
		it("reads nanogpt models from the react-query routerModels", () => {
			mockUseRouterModels.mockReturnValue({
				data: { [providerIdentifiers.nanogpt]: { "openai/gpt-5.6-sol": { maxTokens: 1, contextWindow: 1 } } },
				isLoading: false,
				isError: false,
			})
			mockUseExtensionState.mockReturnValue({
				apiConfiguration: { apiProvider: providerIdentifiers.nanogpt, nanoGptModelId: "openai/gpt-5.6-sol" },
				routerModels: undefined,
			})

			const { result } = renderHook(() => useChatModelSelector(), { wrapper })

			expect(result.current.modelIdKey).toBe("nanoGptModelId")
			expect(result.current.defaultModelId).toBe(nanoGptDefaultModelId)
			expect(Object.keys(result.current.models!)).toEqual(["openai/gpt-5.6-sol"])
		})
	})

	describe("requesty (dynamic router provider)", () => {
		it("reads requesty models from the react-query routerModels", () => {
			mockUseRouterModels.mockReturnValue({
				data: { [providerIdentifiers.requesty]: { "openai/gpt-5.1": { maxTokens: 1, contextWindow: 1 } } },
				isLoading: false,
				isError: false,
			})
			mockUseExtensionState.mockReturnValue({
				apiConfiguration: { apiProvider: providerIdentifiers.requesty, requestyModelId: "openai/gpt-5.1" },
				routerModels: undefined,
			})

			const { result } = renderHook(() => useChatModelSelector(), { wrapper })

			expect(result.current.modelIdKey).toBe("requestyModelId")
			expect(result.current.defaultModelId).toBe(requestyDefaultModelId)
			expect(Object.keys(result.current.models!)).toEqual(["openai/gpt-5.1"])
		})
	})

	describe("unbound (dynamic router provider)", () => {
		it("reads unbound models from the react-query routerModels", () => {
			mockUseRouterModels.mockReturnValue({
				data: { [providerIdentifiers.unbound]: { "openai/gpt-4o": { maxTokens: 1, contextWindow: 1 } } },
				isLoading: false,
				isError: false,
			})
			mockUseExtensionState.mockReturnValue({
				apiConfiguration: { apiProvider: providerIdentifiers.unbound, unboundModelId: "openai/gpt-4o" },
				routerModels: undefined,
			})

			const { result } = renderHook(() => useChatModelSelector(), { wrapper })

			expect(result.current.modelIdKey).toBe("unboundModelId")
			expect(result.current.defaultModelId).toBe(unboundDefaultModelId)
			expect(Object.keys(result.current.models!)).toEqual(["openai/gpt-4o"])
		})
	})

	describe("vercel-ai-gateway (dynamic router provider)", () => {
		it("reads vercel-ai-gateway models from the react-query routerModels", () => {
			mockUseRouterModels.mockReturnValue({
				data: {
					[providerIdentifiers.vercelAiGateway]: { "openai/gpt-4o-mini": { maxTokens: 1, contextWindow: 1 } },
				},
				isLoading: false,
				isError: false,
			})
			mockUseExtensionState.mockReturnValue({
				apiConfiguration: {
					apiProvider: providerIdentifiers.vercelAiGateway,
					vercelAiGatewayModelId: "openai/gpt-4o-mini",
				},
				routerModels: undefined,
			})

			const { result } = renderHook(() => useChatModelSelector(), { wrapper })

			expect(result.current.modelIdKey).toBe("vercelAiGatewayModelId")
			expect(result.current.defaultModelId).toBe(vercelAiGatewayDefaultModelId)
			expect(Object.keys(result.current.models!)).toEqual(["openai/gpt-4o-mini"])
		})
	})

	describe("kimi-code (dynamic router provider)", () => {
		it("reads kimi-code models from the react-query routerModels using apiModelId", () => {
			mockUseRouterModels.mockReturnValue({
				data: { [providerIdentifiers.kimiCode]: { "kimi-k2": { maxTokens: 1, contextWindow: 1 } } },
				isLoading: false,
				isError: false,
			})
			mockUseExtensionState.mockReturnValue({
				apiConfiguration: { apiProvider: providerIdentifiers.kimiCode, apiModelId: "kimi-k2" },
				routerModels: undefined,
			})

			const { result } = renderHook(() => useChatModelSelector(), { wrapper })

			expect(result.current.modelIdKey).toBe("apiModelId")
			expect(result.current.defaultModelId).toBe(kimiCodeDefaultModelId)
			expect(Object.keys(result.current.models!)).toEqual(["kimi-k2"])
		})
	})

	describe("openai (OpenAI compatible)", () => {
		it("requests openAi models on mount when baseUrl and apiKey are set", () => {
			mockUseExtensionState.mockReturnValue({
				apiConfiguration: {
					apiProvider: providerIdentifiers.openai,
					openAiBaseUrl: "https://api.example.com/v1",
					openAiApiKey: "test-key",
					openAiHeaders: {},
				},
				routerModels: undefined,
			})

			renderHook(() => useChatModelSelector(), { wrapper })

			// The request now carries an identity token so the matching response
			// can be correlated and stale replies discarded.
			expect(mockPostMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "requestOpenAiModels",
					requestId: expect.any(String),
					values: {
						baseUrl: "https://api.example.com/v1",
						apiKey: "test-key",
						customHeaders: {},
						openAiHeaders: {},
					},
				}),
			)
		})

		it("uses models delivered through the openAiModels message", async () => {
			mockUseExtensionState.mockReturnValue({
				apiConfiguration: {
					apiProvider: providerIdentifiers.openai,
					openAiBaseUrl: "https://api.example.com/v1",
					openAiApiKey: "test-key",
					openAiHeaders: {},
				},
				routerModels: undefined,
			})

			const { result } = renderHook(() => useChatModelSelector(), { wrapper })

			act(() => {
				emitMessage({ type: "openAiModels", openAiModels: ["gpt-4o", "gpt-4o-mini"] })
			})

			await waitFor(() => {
				expect(result.current.models).not.toBeNull()
			})

			expect(Object.keys(result.current.models!)).toEqual(expect.arrayContaining(["gpt-4o", "gpt-4o-mini"]))
			expect(result.current.modelIdKey).toBe("openAiModelId")
		})

		it("reports loading while the openAi request is in flight", () => {
			mockUseExtensionState.mockReturnValue({
				apiConfiguration: {
					apiProvider: providerIdentifiers.openai,
					openAiBaseUrl: "https://api.example.com/v1",
					openAiApiKey: "test-key",
					openAiHeaders: {},
				},
				routerModels: undefined,
			})

			const { result } = renderHook(() => useChatModelSelector(), { wrapper })

			expect(result.current.isLoading).toBe(true)
		})

		it("does not request openAi models when the base URL is missing", () => {
			mockUseExtensionState.mockReturnValue({
				apiConfiguration: {
					apiProvider: providerIdentifiers.openai,
					openAiApiKey: "test-key",
					openAiHeaders: {},
				},
				routerModels: undefined,
			})

			const { result } = renderHook(() => useChatModelSelector(), { wrapper })

			expect(mockPostMessage).not.toHaveBeenCalled()
			expect(result.current.isLoading).toBe(false)
		})

		it("does not request openAi models when the API key is missing", () => {
			mockUseExtensionState.mockReturnValue({
				apiConfiguration: {
					apiProvider: providerIdentifiers.openai,
					openAiBaseUrl: "https://api.example.com/v1",
					openAiHeaders: {},
				},
				routerModels: undefined,
			})

			const { result } = renderHook(() => useChatModelSelector(), { wrapper })

			expect(mockPostMessage).not.toHaveBeenCalled()
			expect(result.current.isLoading).toBe(false)
		})
	})

	describe("router providers", () => {
		it("reads openrouter models from the react-query routerModels", () => {
			mockUseRouterModels.mockReturnValue({
				data: { [providerIdentifiers.openrouter]: { "openai/gpt-4o": { maxTokens: 1, contextWindow: 1 } } },
				isLoading: false,
				isError: false,
			})
			mockUseExtensionState.mockReturnValue({
				apiConfiguration: { apiProvider: providerIdentifiers.openrouter, openRouterModelId: "openai/gpt-4o" },
				routerModels: undefined,
			})

			const { result } = renderHook(() => useChatModelSelector(), { wrapper })

			expect(result.current.modelIdKey).toBe("openRouterModelId")
			expect(Object.keys(result.current.models!)).toEqual(["openai/gpt-4o"])
		})

		it("reads poe models from the backend-broadcast state routerModels", () => {
			mockUseExtensionState.mockReturnValue({
				apiConfiguration: { apiProvider: providerIdentifiers.poe, poeApiKey: "test" },
				routerModels: { [providerIdentifiers.poe]: { "claude-sonnet": { maxTokens: 1, contextWindow: 1 } } },
			})

			const { result } = renderHook(() => useChatModelSelector(), { wrapper })

			expect(result.current.modelIdKey).toBe("apiModelId")
			expect(Object.keys(result.current.models!)).toEqual(["claude-sonnet"])
		})

		it("reads litellm models from the backend-broadcast state routerModels", () => {
			mockUseExtensionState.mockReturnValue({
				apiConfiguration: {
					apiProvider: providerIdentifiers.litellm,
					litellmApiKey: "test",
					litellmBaseUrl: "http://x",
				},
				routerModels: { [providerIdentifiers.litellm]: { "gpt-4o": { maxTokens: 1, contextWindow: 1 } } },
			})

			const { result } = renderHook(() => useChatModelSelector(), { wrapper })

			expect(result.current.modelIdKey).toBe("litellmModelId")
			expect(Object.keys(result.current.models!)).toEqual(["gpt-4o"])
		})
	})

	describe("ollama / lmstudio / vscode-lm", () => {
		it("requests ollama models on mount", () => {
			mockUseExtensionState.mockReturnValue({
				apiConfiguration: { apiProvider: providerIdentifiers.ollama, ollamaModelId: "llama3" },
				routerModels: undefined,
			})

			renderHook(() => useChatModelSelector(), { wrapper })

			expect(mockPostMessage).toHaveBeenCalledWith({ type: "requestOllamaModels" })
		})

		it("uses models delivered through the ollamaModels message", async () => {
			mockUseExtensionState.mockReturnValue({
				apiConfiguration: { apiProvider: providerIdentifiers.ollama, ollamaModelId: "llama3" },
				routerModels: undefined,
			})

			const { result } = renderHook(() => useChatModelSelector(), { wrapper })

			act(() => {
				emitMessage({ type: "ollamaModels", ollamaModels: { llama3: { maxTokens: 1, contextWindow: 1 } } })
			})

			await waitFor(() => {
				expect(result.current.models).not.toBeNull()
			})
			expect(result.current.modelIdKey).toBe("ollamaModelId")
			expect(Object.keys(result.current.models!)).toEqual(["llama3"])
		})

		it("requests lmstudio models on mount", () => {
			mockUseExtensionState.mockReturnValue({
				apiConfiguration: { apiProvider: providerIdentifiers.lmstudio, lmStudioModelId: "local-model" },
				routerModels: undefined,
			})

			renderHook(() => useChatModelSelector(), { wrapper })

			expect(mockPostMessage).toHaveBeenCalledWith({ type: "requestLmStudioModels" })
		})

		it("uses models delivered through the lmStudioModels message", async () => {
			mockUseExtensionState.mockReturnValue({
				apiConfiguration: { apiProvider: providerIdentifiers.lmstudio, lmStudioModelId: "local-model" },
				routerModels: undefined,
			})

			const { result } = renderHook(() => useChatModelSelector(), { wrapper })

			act(() => {
				emitMessage({
					type: "lmStudioModels",
					lmStudioModels: { "local-model": { maxTokens: 1, contextWindow: 1 } },
				})
			})

			await waitFor(() => {
				expect(result.current.models).not.toBeNull()
			})
			expect(result.current.modelIdKey).toBe("lmStudioModelId")
			expect(Object.keys(result.current.models!)).toEqual(["local-model"])
		})

		it("requests vsCodeLm models on mount and builds model records", async () => {
			mockUseExtensionState.mockReturnValue({
				apiConfiguration: { apiProvider: providerIdentifiers.vscodeLm },
				routerModels: undefined,
			})

			const { result } = renderHook(() => useChatModelSelector(), { wrapper })

			expect(mockPostMessage).toHaveBeenCalledWith({ type: "requestVsCodeLmModels" })

			act(() => {
				emitMessage({
					type: "vsCodeLmModels",
					vsCodeLmModels: [{ vendor: "copilot", family: "gpt-4o" }],
				})
			})

			await waitFor(() => {
				expect(result.current.models).not.toBeNull()
			})
			expect(Object.keys(result.current.models!)).toEqual(["copilot/gpt-4o"])
			expect(result.current.modelIdKey).toBe("vsCodeLmModelSelector")
		})

		it("transforms vsCodeLm model ids to vendor/family and formats display values", async () => {
			mockUseExtensionState.mockReturnValue({
				apiConfiguration: {
					apiProvider: providerIdentifiers.vscodeLm,
					vsCodeLmModelSelector: { vendor: "copilot", family: "gpt-4o" },
				},
				routerModels: undefined,
			})

			const { result } = renderHook(() => useChatModelSelector(), { wrapper })

			act(() => {
				emitMessage({
					type: "vsCodeLmModels",
					vsCodeLmModels: [{ vendor: "copilot", family: "gpt-4o" }],
				})
			})

			await waitFor(() => {
				expect(result.current.models).not.toBeNull()
			})

			// valueTransform: "copilot/gpt-4o" -> { vendor: "copilot", family: "gpt-4o" }
			expect(result.current.valueTransform!("copilot/gpt-4o")).toEqual({ vendor: "copilot", family: "gpt-4o" })
			// displayTransform: { vendor, family } -> "copilot/gpt-4o"
			expect(result.current.displayTransform!({ vendor: "copilot", family: "gpt-4o" })).toBe("copilot/gpt-4o")
			// displayTransform returns "" for missing values
			expect(result.current.displayTransform!(undefined)).toBe("")
			expect(result.current.displayTransform!({ vendor: "copilot" })).toBe("")
		})
	})

	describe("default model ids", () => {
		// Asserting the exact default id for every mapped provider kills mutants
		// that drop or change an entry in STATIC_DEFAULT_MODEL_IDS /
		// ROUTER_DEFAULT_MODEL_IDS (a weak toBeTruthy() only proves non-empty).
		const staticProviderDefaults: Array<[string, string]> = [
			[providerIdentifiers.anthropic, anthropicDefaultModelId],
			[providerIdentifiers.bedrock, bedrockDefaultModelId],
			[providerIdentifiers.deepseek, deepSeekDefaultModelId],
			[providerIdentifiers.moonshot, moonshotDefaultModelId],
			[providerIdentifiers.gemini, geminiDefaultModelId],
			[providerIdentifiers.mistral, mistralDefaultModelId],
			[providerIdentifiers.openaiNative, openAiNativeDefaultModelId],
			[providerIdentifiers.qwenCode, qwenCodeDefaultModelId],
			[providerIdentifiers.vertex, vertexDefaultModelId],
			[providerIdentifiers.xai, xaiDefaultModelId],
			[providerIdentifiers.sambanova, sambaNovaDefaultModelId],
			[providerIdentifiers.fireworks, fireworksDefaultModelId],
			[providerIdentifiers.friendli, friendliDefaultModelId],
			[providerIdentifiers.minimax, minimaxDefaultModelId],
			[providerIdentifiers.mimo, mimoDefaultModelId],
			[providerIdentifiers.baseten, basetenDefaultModelId],
		]

		it.each(staticProviderDefaults)("resolves the exact default id for %s", (provider, expected) => {
			mockUseExtensionState.mockReturnValue({
				apiConfiguration: { apiProvider: provider },
				routerModels: undefined,
			})

			const { result } = renderHook(() => useChatModelSelector(), { wrapper })

			expect(result.current.defaultModelId).toBe(expected)
		})

		const routerProviderDefaults: Array<[string, string]> = [
			[providerIdentifiers.openrouter, openRouterDefaultModelId],
			[providerIdentifiers.requesty, requestyDefaultModelId],
			[providerIdentifiers.unbound, unboundDefaultModelId],
			[providerIdentifiers.litellm, litellmDefaultModelId],
			[providerIdentifiers.vercelAiGateway, vercelAiGatewayDefaultModelId],
			[providerIdentifiers.zooGateway, zooGatewayDefaultModelId],
			[providerIdentifiers.opencodeGo, opencodeGoDefaultModelId],
			[providerIdentifiers.kenari, kenariDefaultModelId],
			[providerIdentifiers.nanogpt, nanoGptDefaultModelId],
			[providerIdentifiers.kimiCode, kimiCodeDefaultModelId],
			[providerIdentifiers.poe, poeDefaultModelId],
		]

		it.each(routerProviderDefaults)("resolves the exact router default id for %s", (provider, expected) => {
			mockUseExtensionState.mockReturnValue({
				apiConfiguration: { apiProvider: provider },
				routerModels: undefined,
			})

			const { result } = renderHook(() => useChatModelSelector(), { wrapper })

			expect(result.current.defaultModelId).toBe(expected)
		})
	})

	describe("retired providers", () => {
		it("returns empty data for retired providers", () => {
			mockUseExtensionState.mockReturnValue({
				apiConfiguration: { apiProvider: retiredProviderIdentifiers.groq as unknown as "openrouter" },
				routerModels: undefined,
			})

			const { result } = renderHook(() => useChatModelSelector(), { wrapper })

			expect(result.current.provider).toBeUndefined()
			expect(result.current.models).toBeNull()
			expect(result.current.modelIdKey).toBeUndefined()
		})
	})
})
