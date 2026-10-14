// npx vitest src/components/chat/hooks/__tests__/useChatModelSelector.spec.tsx

import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { renderHook } from "@testing-library/react"
import React, { type ReactNode } from "react"
import { type Mock } from "vitest"

import { type ProviderSettings, providerIdentifiers, retiredProviderIdentifiers } from "@roo-code/types"

import { useRouterModels } from "@/components/ui/hooks/useRouterModels"
import { useOllamaModels } from "@/components/ui/hooks/useOllamaModels"
import { useLmStudioModels } from "@/components/ui/hooks/useLmStudioModels"
import { useVsCodeLmModels } from "@/components/ui/hooks/useVsCodeLmModels"
import { useExtensionState } from "@src/context/ExtensionStateContext"

import { useChatModelSelector } from "../useChatModelSelector"

vi.mock("@src/context/ExtensionStateContext", () => ({
	ExtensionStateContextProvider: ({ children }: { children: ReactNode }) => children,
	useExtensionState: vi.fn(),
}))

vi.mock("@/components/ui/hooks/useRouterModels")
vi.mock("@/components/ui/hooks/useOllamaModels")
vi.mock("@/components/ui/hooks/useLmStudioModels")
vi.mock("@/components/ui/hooks/useVsCodeLmModels")

const mockUseRouterModels = useRouterModels as Mock<typeof useRouterModels>
const mockUseOllamaModels = useOllamaModels as Mock<typeof useOllamaModels>
const mockUseLmStudioModels = useLmStudioModels as Mock<typeof useLmStudioModels>
const mockUseVsCodeLmModels = useVsCodeLmModels as Mock<typeof useVsCodeLmModels>
const mockUseExtensionState = useExtensionState as Mock<typeof useExtensionState>

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
const wrapper = ({ children }: { children: ReactNode }) => (
	<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
)

describe("useChatModelSelector", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockUseRouterModels.mockReturnValue({
			data: {},
			isLoading: false,
			isError: false,
		} as unknown as ReturnType<typeof useRouterModels>)
		mockUseOllamaModels.mockReturnValue({
			data: undefined,
			isLoading: false,
		} as unknown as ReturnType<typeof useOllamaModels>)
		mockUseLmStudioModels.mockReturnValue({
			data: undefined,
			isLoading: false,
		} as unknown as ReturnType<typeof useLmStudioModels>)
		mockUseVsCodeLmModels.mockReturnValue({
			data: [],
			isLoading: false,
		} as unknown as ReturnType<typeof useVsCodeLmModels>)
	})

	const setApiConfig = (apiConfiguration: Partial<ProviderSettings> | undefined) => {
		mockUseExtensionState.mockReturnValue({
			apiConfiguration: apiConfiguration as ProviderSettings,
			routerModels: {},
		} as unknown as ReturnType<typeof useExtensionState>)
	}

	it("resolves router models for openrouter provider", () => {
		mockUseRouterModels.mockReturnValue({
			data: {
				[providerIdentifiers.openrouter]: {
					"model-a": { name: "Model A", maxTokens: 8192, contextWindow: 200000, supportsPromptCache: true },
				},
			},
			isLoading: false,
		} as unknown as ReturnType<typeof useRouterModels>)

		setApiConfig({ apiProvider: providerIdentifiers.openrouter })
		const { result } = renderHook(() => useChatModelSelector(), { wrapper })

		expect(result.current.provider).toBe(providerIdentifiers.openrouter)
		expect(result.current.modelIdKey).toBe("openRouterModelId")
		expect(result.current.models).toHaveProperty("model-a")
		expect(result.current.isLoading).toBe(false)
		expect(mockUseVsCodeLmModels).toHaveBeenCalledWith(false)
	})

	it("resolves ollama models for ollama provider", () => {
		mockUseOllamaModels.mockReturnValue({
			data: {
				"llama3:latest": { name: "Llama 3", maxTokens: 4096, contextWindow: 8192, supportsPromptCache: false },
			},
			isLoading: false,
		} as unknown as ReturnType<typeof useOllamaModels>)

		setApiConfig({ apiProvider: providerIdentifiers.ollama })
		const { result } = renderHook(() => useChatModelSelector(), { wrapper })

		expect(result.current.provider).toBe(providerIdentifiers.ollama)
		expect(result.current.modelIdKey).toBe("ollamaModelId")
		expect(result.current.models).toHaveProperty("llama3:latest")
		expect(result.current.isLoading).toBe(false)
		expect(mockUseVsCodeLmModels).toHaveBeenCalledWith(false)
	})

	it("resolves lmstudio models for lmstudio provider", () => {
		mockUseLmStudioModels.mockReturnValue({
			data: {
				"qwen2.5-coder": {
					name: "Qwen2.5-Coder",
					maxTokens: 4096,
					contextWindow: 8192,
					supportsPromptCache: false,
				},
			},
			isLoading: true,
		} as unknown as ReturnType<typeof useLmStudioModels>)

		setApiConfig({ apiProvider: providerIdentifiers.lmstudio })
		const { result } = renderHook(() => useChatModelSelector(), { wrapper })

		expect(result.current.provider).toBe(providerIdentifiers.lmstudio)
		expect(result.current.modelIdKey).toBe("lmStudioModelId")
		expect(result.current.models).toHaveProperty("qwen2.5-coder")
		expect(result.current.isLoading).toBe(true)
		expect(mockUseVsCodeLmModels).toHaveBeenCalledWith(false)
	})

	it("composes vsCodeLm models with vendor/family transforms", () => {
		mockUseVsCodeLmModels.mockReturnValue({
			data: [{ vendor: "copilot", family: "gpt-4o" }],
			isLoading: false,
		} as unknown as ReturnType<typeof useVsCodeLmModels>)

		setApiConfig({ apiProvider: providerIdentifiers.vscodeLm })
		const { result } = renderHook(() => useChatModelSelector(), { wrapper })

		expect(result.current.provider).toBe(providerIdentifiers.vscodeLm)
		expect(result.current.modelIdKey).toBe("vsCodeLmModelSelector")
		expect(result.current.models).toHaveProperty("copilot/gpt-4o")
		expect(result.current.valueTransform).toBeDefined()
		expect(result.current.displayTransform).toBeDefined()

		// valueTransform: "copilot/gpt-4o" -> { vendor, family }
		expect(result.current.valueTransform?.("copilot/gpt-4o")).toEqual({ vendor: "copilot", family: "gpt-4o" })
		// displayTransform: { vendor, family } -> "copilot/gpt-4o"
		expect(result.current.displayTransform?.({ vendor: "copilot", family: "gpt-4o" })).toBe("copilot/gpt-4o")
		// displayTransform: empty value -> ""
		expect(result.current.displayTransform?.(null)).toBe("")
		expect(mockUseVsCodeLmModels).toHaveBeenCalledWith(true)
	})

	it("resolves static models for anthropic provider", () => {
		setApiConfig({ apiProvider: providerIdentifiers.anthropic })
		const { result } = renderHook(() => useChatModelSelector(), { wrapper })

		expect(result.current.provider).toBe(providerIdentifiers.anthropic)
		expect(result.current.modelIdKey).toBe("apiModelId")
		expect(result.current.models).not.toBeNull()
		expect(Object.keys(result.current.models as object).length).toBeGreaterThan(0)
		expect(mockUseVsCodeLmModels).toHaveBeenCalledWith(false)
	})

	it("defaults to openrouter when apiConfiguration is empty", () => {
		setApiConfig({})
		const { result } = renderHook(() => useChatModelSelector(), { wrapper })

		expect(result.current.provider).toBe(providerIdentifiers.openrouter)
		expect(result.current.modelIdKey).toBe("openRouterModelId")
		expect(mockUseVsCodeLmModels).toHaveBeenCalledWith(false)
	})

	it("returns undefined for retired providers", () => {
		setApiConfig({ apiProvider: retiredProviderIdentifiers.groq as unknown as ProviderSettings["apiProvider"] })
		const { result } = renderHook(() => useChatModelSelector(), { wrapper })

		expect(result.current.provider).toBeUndefined()
		expect(result.current.models).toBeNull()
		expect(result.current.modelIdKey).toBeUndefined()
		expect(result.current.isLoading).toBe(false)
		expect(mockUseVsCodeLmModels).toHaveBeenCalledWith(false)
	})
})
