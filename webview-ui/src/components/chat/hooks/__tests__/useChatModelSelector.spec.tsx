import React from "react"
import { act, renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

import {
	anthropicDefaultModelId,
	mainlandZAiDefaultModelId,
	providerIdentifiers,
	retiredProviderIdentifiers,
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

	describe("request cleanup", () => {
		it.each([
			providerIdentifiers.ollama,
			providerIdentifiers.lmstudio,
			providerIdentifiers.openai,
			providerIdentifiers.vscodeLm,
		])("cancels %s on provider switch and rapid remount", (apiProvider) => {
			const config = { apiProvider, openAiBaseUrl: "https://example.test/v1", openAiApiKey: "test-key" }
			mockUseExtensionState.mockReturnValue({ apiConfiguration: config })
			const first = renderHook(() => useChatModelSelector(), { wrapper })
			const request = mockPostMessage.mock.calls.at(-1)![0]
			mockUseExtensionState.mockReturnValue({ apiConfiguration: { apiProvider: providerIdentifiers.anthropic } })
			first.rerender()
			expect(mockPostMessage).toHaveBeenLastCalledWith({
				type: "cancelModelRequest",
				requestId: request.requestId,
			})
			mockUseExtensionState.mockReturnValue({ apiConfiguration: config })
			first.rerender()
			const restarted = mockPostMessage.mock.calls.at(-1)![0]
			expect(restarted.requestId).not.toBe(request.requestId)
			first.unmount()
			expect(mockPostMessage).toHaveBeenLastCalledWith({
				type: "cancelModelRequest",
				requestId: restarted.requestId,
			})
			const second = renderHook(() => useChatModelSelector(), { wrapper })
			const remounted = mockPostMessage.mock.calls.at(-1)![0]
			expect(remounted.requestId).not.toBe(restarted.requestId)
			second.unmount()
			expect(mockPostMessage).toHaveBeenLastCalledWith({
				type: "cancelModelRequest",
				requestId: remounted.requestId,
			})
		})

		it("cancels the replayed StrictMode effect and the final request on unmount", () => {
			mockUseExtensionState.mockReturnValue({ apiConfiguration: { apiProvider: providerIdentifiers.ollama } })
			const { unmount } = renderHook(() => useChatModelSelector(), {
				wrapper: ({ children }) => <React.StrictMode>{children}</React.StrictMode>,
			})
			const messages = mockPostMessage.mock.calls.map(([message]) => message)
			expect(messages.map((message) => message.type)).toEqual([
				"requestOllamaModels",
				"cancelModelRequest",
				"requestOllamaModels",
			])
			expect(messages[1].requestId).toBe(messages[0].requestId)
			expect(messages[2].requestId).not.toBe(messages[0].requestId)
			unmount()
			expect(mockPostMessage).toHaveBeenLastCalledWith({
				type: "cancelModelRequest",
				requestId: messages[2].requestId,
			})
		})
	})

	describe("static providers", () => {
		it("returns static models for anthropic with apiModelId key", () => {
			const { result } = renderHook(() => useChatModelSelector(), { wrapper })

			expect(result.current.provider).toBe(providerIdentifiers.anthropic)
			expect(result.current.modelIdKey).toBe("apiModelId")
			expect(result.current.models).not.toBeNull()
			expect(Object.keys(result.current.models!)).toContain("claude-opus-4-20250514")
			expect(result.current.defaultModelId).toBe(anthropicDefaultModelId)
		})

		it("returns the mainland coding models and default for Z.AI china_coding", () => {
			mockUseExtensionState.mockReturnValue({
				apiConfiguration: { apiProvider: providerIdentifiers.zai, zaiApiLine: "china_coding" },
			})
			const { result } = renderHook(() => useChatModelSelector(), { wrapper })
			expect(result.current.defaultModelId).toBe(mainlandZAiDefaultModelId)
			expect(Object.keys(result.current.models!).sort()).toEqual([
				"glm-4.5",
				"glm-4.5-air",
				"glm-4.5-airx",
				"glm-4.5-flash",
				"glm-4.5-x",
				"glm-4.5v",
				"glm-4.6",
				"glm-4.6v",
				"glm-4.6v-flash",
				"glm-4.6v-flashx",
				"glm-4.7",
				"glm-4.7-flash",
				"glm-4.7-flashx",
				"glm-5",
				"glm-5-turbo",
				"glm-5.1",
				"glm-5.2",
				"glm-5.3",
				"glm-5.3-flash",
			])
		})

		it("does not request message-based models for static providers", () => {
			renderHook(() => useChatModelSelector(), { wrapper })

			expect(mockPostMessage).not.toHaveBeenCalled()
		})
	})

	describe("dynamic router providers", () => {
		it.each([
			[providerIdentifiers.zooGateway, "zooGatewayModelId", "anthropic/claude-sonnet-4"],
			[providerIdentifiers.opencodeGo, "opencodeGoModelId", "glm-5.2"],
			[providerIdentifiers.kenari, "kenariModelId", "glm-5-2"],
			[providerIdentifiers.nanogpt, "nanoGptModelId", "openai/gpt-5.6-sol"],
			[providerIdentifiers.requesty, "requestyModelId", "openai/gpt-5.1"],
			[providerIdentifiers.unbound, "unboundModelId", "openai/gpt-4o"],
			[providerIdentifiers.vercelAiGateway, "vercelAiGatewayModelId", "openai/gpt-4o-mini"],
			[providerIdentifiers.kimiCode, "apiModelId", "kimi-k2"],
		] as const)("reads %s models from the react-query routerModels", (provider, modelIdKey, modelId) => {
			mockUseRouterModels.mockReturnValue({
				data: { [provider]: { [modelId]: { maxTokens: 1, contextWindow: 1 } } },
				isLoading: false,
				isError: false,
			})
			mockUseExtensionState.mockReturnValue({
				apiConfiguration: { apiProvider: provider, [modelIdKey]: modelId },
				routerModels: undefined,
			})

			const { result } = renderHook(() => useChatModelSelector(), { wrapper })

			expect(result.current.modelIdKey).toBe(modelIdKey)
			expect(result.current.defaultModelId).toBeTruthy()
			expect(Object.keys(result.current.models!)).toEqual([modelId])
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

			expect(mockPostMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "requestOpenAiModels",
					values: {
						baseUrl: "https://api.example.com/v1",
						apiKey: "test-key",
						customHeaders: {},
						openAiHeaders: {},
					},
				}),
			)
		})

		it("only requests again when serialized header values change", () => {
			const configure = (headers?: Record<string, string>) =>
				mockUseExtensionState.mockReturnValue({
					apiConfiguration: {
						apiProvider: providerIdentifiers.openai,
						openAiBaseUrl: "https://api.example.com/v1",
						openAiApiKey: "test-key",
						openAiHeaders: headers,
					},
				})
			configure()
			const { rerender } = renderHook(() => useChatModelSelector(), { wrapper })
			configure({})
			rerender()
			expect(mockPostMessage).toHaveBeenCalledTimes(1)
			configure({ "X-Test": "first" })
			rerender()
			expect(mockPostMessage).toHaveBeenCalledTimes(3)
			configure({ "X-Test": "first" })
			rerender()
			expect(mockPostMessage).toHaveBeenCalledTimes(3)
			configure({ "X-Test": "second" })
			rerender()
			expect(mockPostMessage).toHaveBeenCalledTimes(5)
			expect(mockPostMessage).toHaveBeenLastCalledWith(
				expect.objectContaining({
					values: expect.objectContaining({ openAiHeaders: { "X-Test": "second" } }),
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

		it("stops loading when the OpenAI models response is empty", async () => {
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

			const requestId = mockPostMessage.mock.calls[0][0].requestId as string
			act(() => {
				emitMessage({ type: "openAiModels", openAiModels: [], requestId })
			})

			// An empty (but successful) response must end the spinner; otherwise the
			// trigger shows "…" forever for an endpoint with no models.
			await waitFor(() => {
				expect(result.current.isLoading).toBe(false)
			})
			expect(result.current.models).toBeNull()
		})

		it("ignores model responses whose requestId does not match the latest request", async () => {
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

			const requestId = mockPostMessage.mock.calls[0][0].requestId as string
			expect(typeof requestId).toBe("string")

			// A response for a different request is stale and must be discarded.
			act(() => {
				emitMessage({ type: "openAiModels", openAiModels: ["stale-model"], requestId: "different-request" })
			})
			expect(result.current.models).toBeNull()

			// The matching response is applied.
			act(() => {
				emitMessage({ type: "openAiModels", openAiModels: ["fresh-model"], requestId })
			})
			await waitFor(() => {
				expect(result.current.models).not.toBeNull()
			})
			expect(Object.keys(result.current.models!)).toEqual(["fresh-model"])
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

			expect(mockPostMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "requestOllamaModels" }))
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

			expect(mockPostMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "requestLmStudioModels" }))
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

			expect(mockPostMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "requestVsCodeLmModels" }))

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

	it.each([
		[providerIdentifiers.openai, { type: "openAiModels", openAiModels: ["old-model"] }],
		[providerIdentifiers.ollama, { type: "ollamaModels", ollamaModels: { "old-model": { contextWindow: 1 } } }],
		[
			providerIdentifiers.lmstudio,
			{ type: "lmStudioModels", lmStudioModels: { "old-model": { contextWindow: 1 } } },
		],
		[
			providerIdentifiers.vscodeLm,
			{ type: "vsCodeLmModels", vsCodeLmModels: [{ vendor: "old", family: "model" }] },
		],
	])("discards cached %s models when switching providers", (provider, message) => {
		mockUseExtensionState.mockReturnValue({ apiConfiguration: { apiProvider: provider } })
		const { result, rerender } = renderHook(() => useChatModelSelector(), { wrapper })
		act(() => emitMessage(message))
		expect(Object.keys(result.current.models!)).toHaveLength(1)
		mockUseExtensionState.mockReturnValue({ apiConfiguration: { apiProvider: providerIdentifiers.anthropic } })
		rerender()
		mockUseExtensionState.mockReturnValue({ apiConfiguration: { apiProvider: provider } })
		rerender()
		expect(Object.keys(result.current.models ?? {})).toHaveLength(0)
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
