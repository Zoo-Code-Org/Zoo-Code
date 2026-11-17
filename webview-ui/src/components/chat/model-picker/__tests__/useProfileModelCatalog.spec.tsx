import { act, renderHook } from "@testing-library/react"

import {
	providerIdentifiers,
	friendliModels,
	type ModelInfo,
	type ProviderSettings,
	type RouterModels,
} from "@roo-code/types"

import { filterModels } from "@/components/settings/utils/organizationFilters"
import { vscode } from "@/utils/vscode"

import { MODEL_CATALOG_SETTINGS_FALLBACK, useProfileModelCatalog } from "../useProfileModelCatalog"

vi.mock("@/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))
const router = vi.hoisted(() => ({
	data: undefined as Partial<RouterModels> | undefined,
	isLoading: false,
	isError: false,
	refetch: vi.fn(),
}))
const routerCalls = vi.hoisted(() => vi.fn())
vi.mock("@/components/ui/hooks/useRouterModels", () => ({
	useRouterModels: (options: unknown) => {
		routerCalls(options)
		return router
	},
}))

const info: ModelInfo = { contextWindow: 1000, supportsPromptCache: false }

describe("useProfileModelCatalog", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		router.data = undefined
		router.isLoading = false
		router.isError = false
	})

	it("returns typed static models without discovery", () => {
		const { result } = renderHook(() => useProfileModelCatalog({ apiProvider: providerIdentifiers.anthropic }))
		expect(result.current).toMatchObject({
			provider: providerIdentifiers.anthropic,
			field: "apiModelId",
			isUnsupported: false,
			isLoading: false,
			isError: false,
		})
		expect(Object.keys(result.current.models ?? {}).length).toBeGreaterThan(0)
		expect(routerCalls).toHaveBeenLastCalledWith({ provider: providerIdentifiers.anthropic, enabled: false })
		expect(vscode.postMessage).not.toHaveBeenCalled()
	})

	it("defaults to OpenRouter and refetches the router catalog", () => {
		router.data = { openrouter: { custom: info } }
		const { result } = renderHook(() => useProfileModelCatalog({}))
		expect(result.current.provider).toBe(providerIdentifiers.openrouter)
		expect(result.current.models).toEqual({ custom: info })
		act(() => result.current.refetch())
		expect(router.refetch).toHaveBeenCalledTimes(1)
	})

	it("reports router loading, errors and missing provider catalogs", () => {
		router.isLoading = true
		const { result, rerender } = renderHook(() =>
			useProfileModelCatalog({ apiProvider: providerIdentifiers.requesty }),
		)
		expect(result.current).toMatchObject({ models: null, isLoading: true, isError: false })
		router.isLoading = false
		router.isError = true
		rerender()
		expect(result.current).toMatchObject({
			models: null,
			isLoading: false,
			isError: true,
			fallbackMessage: MODEL_CATALOG_SETTINGS_FALLBACK,
		})
	})

	it("passes router models as the fourth static argument for Friendli override and fallback", () => {
		const { result, rerender } = renderHook(() =>
			useProfileModelCatalog({ apiProvider: providerIdentifiers.friendli }),
		)
		expect(result.current.models).toEqual(friendliModels)
		expect(routerCalls).toHaveBeenLastCalledWith({ provider: providerIdentifiers.friendli, enabled: true })
		router.data = { friendli: { fetched: info } }
		rerender()
		expect(result.current.models).toEqual({ fetched: info })
		router.data = { friendli: {} }
		rerender()
		expect(result.current.models).toEqual(friendliModels)
	})

	it("uses the configured Z.ai API line", () => {
		const { result } = renderHook(() =>
			useProfileModelCatalog({ apiProvider: providerIdentifiers.zai, zaiApiLine: "china_api" }),
		)
		expect(result.current.models).not.toBeNull()
		expect(result.current.field).toBe("apiModelId")
	})

	it.each([
		providerIdentifiers.ollama,
		providerIdentifiers.lmstudio,
		providerIdentifiers.vscodeLm,
		providerIdentifiers.githubCopilot,
	])("explicitly falls back to Settings for %s", (apiProvider) => {
		const { result } = renderHook(() => useProfileModelCatalog({ apiProvider: apiProvider }))
		expect(result.current).toMatchObject({
			field: undefined,
			models: null,
			isLoading: false,
			isError: false,
			isUnsupported: true,
			fallbackMessage: MODEL_CATALOG_SETTINGS_FALLBACK,
		})
		act(() => result.current.refetch())
		expect(router.refetch).not.toHaveBeenCalled()
	})

	it("leaves organization filtering to the consumer", () => {
		router.data = { openrouter: { allowed: info, denied: info } }
		const { result } = renderHook(() => useProfileModelCatalog({}))
		expect(Object.keys(result.current.models ?? {})).toEqual(["allowed", "denied"])
		expect(
			filterModels(result.current.models, result.current.provider, {
				allowAll: false,
				providers: { openrouter: { allowAll: false, models: ["allowed"] } },
			}),
		).toEqual({ allowed: info })
	})

	it("does not issue requests the legacy host silently ignores", () => {
		const settings: ProviderSettings = {
			apiProvider: providerIdentifiers.openai,
			openAiBaseUrl: "https://example.test",
		}
		const { result } = renderHook(() => useProfileModelCatalog(settings))
		expect(result.current).toMatchObject({
			field: "openAiModelId",
			isUnsupported: false,
			isLoading: false,
			isError: true,
			fallbackMessage: MODEL_CATALOG_SETTINGS_FALLBACK,
		})
		expect(vscode.postMessage).not.toHaveBeenCalled()
	})
})
