import React from "react"
import { act, renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

import { providerIdentifiers, retiredProviderIdentifiers } from "@roo-code/types"

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
			expect(result.current.defaultModelId).toBeTruthy()
		})

		it("does not request message-based models for static providers", () => {
			renderHook(() => useChatModelSelector(), { wrapper })

			expect(mockPostMessage).not.toHaveBeenCalled()
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
			expect(result.current.defaultModelId).toBeTruthy()
			expect(Object.keys(result.current.models!)).toEqual(["anthropic/claude-sonnet-4"])
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
			expect(result.current.defaultModelId).toBeTruthy()
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
			expect(result.current.defaultModelId).toBeTruthy()
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
			expect(result.current.defaultModelId).toBeTruthy()
			expect(Object.keys(result.current.models!)).toEqual(["openai/gpt-5.6-sol"])
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

			expect(mockPostMessage).toHaveBeenCalledWith({
				type: "requestOpenAiModels",
				values: {
					baseUrl: "https://api.example.com/v1",
					apiKey: "test-key",
					customHeaders: {},
					openAiHeaders: {},
				},
			})
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
