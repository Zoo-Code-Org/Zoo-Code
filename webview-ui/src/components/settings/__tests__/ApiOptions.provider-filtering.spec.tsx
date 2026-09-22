import { screen } from "@testing-library/react"

import { renderWithExtensionState } from "@/utils/test-utils"

import {
	providerIdentifiers,
	mimoDefaultModelId,
	type ModelInfo,
	type ProviderSettings,
	type OrganizationAllowList,
} from "@roo-code/types"

import { useExtensionState } from "@src/context/ExtensionStateContext"
import { useRouterModels } from "@src/components/ui/hooks/useRouterModels"
import { useSelectedModel } from "@src/components/ui/hooks/useSelectedModel"

import ApiOptions from "../ApiOptions"
import { MODELS_BY_PROVIDER, PROVIDERS } from "../constants"

// Mock the extension state context. The hoisted state holder lets the MiMo suite
// reset the allow list to the unfiltered default without re-typing the full
// ExtensionStateContextType (previous suites pin mockReturnValue via `as any`,
// and vi.clearAllMocks() does not undo that).
const { useExtensionStateMock, setOrganizationAllowList } = vi.hoisted(() => {
	const mock = vi.fn(() => ({
		organizationAllowList: undefined as OrganizationAllowList | undefined,
		cloudIsAuthenticated: false,
	}))
	return {
		useExtensionStateMock: mock,
		setOrganizationAllowList: (list: OrganizationAllowList | undefined) => {
			mock.mockReturnValue({ organizationAllowList: list, cloudIsAuthenticated: false })
		},
	}
})

vi.mock("@src/context/ExtensionStateContext", () => ({
	ExtensionStateContextProvider: ({ children }: any) => children,
	useExtensionState: useExtensionStateMock,
}))

// Mock the translation hook
vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string) => key,
	}),
}))

// Mock vscode
vi.mock("@src/utils/vscode", () => ({
	vscode: {
		postMessage: vi.fn(),
	},
}))

// Mock the router models hook. The hoisted state holder lets tests drive `data`
// without re-typing the full react-query UseQueryResult at each call site.
const { useRouterModelsMock, setRouterModelsData } = vi.hoisted(() => {
	const state = { data: undefined as Record<string, Record<string, unknown>> | undefined }
	return {
		useRouterModelsMock: vi.fn(() => ({ data: state.data, refetch: vi.fn() })),
		setRouterModelsData: (data: typeof state.data) => {
			state.data = data
		},
	}
})

vi.mock("@src/components/ui/hooks/useRouterModels", () => ({
	useRouterModels: useRouterModelsMock,
}))

// Mock the selected model hook
vi.mock("@src/components/ui/hooks/useSelectedModel", () => ({
	useSelectedModel: vi.fn(() => ({
		provider: providerIdentifiers.anthropic,
		id: "claude-3-5-sonnet-20241022",
		info: null,
	})),
}))

// Mock the OpenRouter model providers hook
vi.mock("@src/components/ui/hooks/useOpenRouterModelProviders", () => ({
	useOpenRouterModelProviders: () => ({
		data: null,
	}),
	OPENROUTER_DEFAULT_PROVIDER_NAME: "Auto",
}))

// Mock the SearchableSelect component to capture the options passed to it
vi.mock("@src/components/ui", () => ({
	SearchableSelect: ({ options, ...props }: any) => {
		// Store the options in a data attribute for testing
		return (
			<div data-testid="searchable-select" data-options={JSON.stringify(options)} {...props}>
				{options.map((opt: any) => (
					<div key={opt.value} data-testid={`option-${opt.value}`}>
						{opt.label}
					</div>
				))}
			</div>
		)
	},
	Select: ({ children }: any) => <div>{children}</div>,
	SelectTrigger: ({ children }: any) => <div>{children}</div>,
	SelectValue: ({ placeholder }: any) => <div>{placeholder}</div>,
	SelectContent: ({ children }: any) => <div>{children}</div>,
	SelectItem: ({ children, value }: any) => <div data-value={value}>{children}</div>,
	Collapsible: ({ children }: any) => <div>{children}</div>,
	CollapsibleTrigger: ({ children }: any) => <div>{children}</div>,
	CollapsibleContent: ({ children }: any) => <div>{children}</div>,
	Slider: ({ children, ...props }: any) => <div {...props}>{children}</div>,
	Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
	// Add Popover components for ModelPicker
	Popover: ({ children }: any) => <div>{children}</div>,
	PopoverTrigger: ({ children }: any) => <div>{children}</div>,
	PopoverContent: ({ children }: any) => <div>{children}</div>,
	// Add Command components for ModelPicker
	Command: ({ children }: any) => <div>{children}</div>,
	CommandInput: ({ ...props }: any) => <input {...props} />,
	CommandList: ({ children }: any) => <div>{children}</div>,
	CommandEmpty: ({ children }: any) => <div>{children}</div>,
	CommandGroup: ({ children }: any) => <div>{children}</div>,
	CommandItem: ({ children, ...props }: any) => <div {...props}>{children}</div>,
}))

describe("ApiOptions Provider Filtering", () => {
	const defaultProps = {
		uriScheme: "vscode",
		apiConfiguration: {
			apiProvider: providerIdentifiers.anthropic,
			apiKey: "test-key",
		} as ProviderSettings,
		setApiConfigurationField: vi.fn(),
		fromWelcomeView: false,
		errorMessage: undefined,
		setErrorMessage: vi.fn(),
	}

	const renderWithProviders = (props = defaultProps) => {
		return renderWithExtensionState(<ApiOptions {...props} />)
	}

	beforeEach(() => {
		vi.clearAllMocks()
		vi.mocked(useSelectedModel).mockReturnValue({
			provider: providerIdentifiers.anthropic,
			id: "claude-3-5-sonnet-20241022",
			info: undefined,
			isLoading: false,
			isError: false,
		})
	})

	it("does not request router models for a static provider", () => {
		renderWithProviders()

		expect(useRouterModels).toHaveBeenCalledWith({ enabled: false, provider: undefined })
	})

	it("requests router models only for the selected dynamic provider", () => {
		vi.mocked(useSelectedModel).mockReturnValue({
			provider: providerIdentifiers.kenari,
			id: "glm-5-2",
			info: undefined,
			isLoading: false,
			isError: false,
		})

		renderWithProviders({
			...defaultProps,
			apiConfiguration: { apiProvider: providerIdentifiers.kenari } as ProviderSettings,
		})

		expect(useRouterModels).toHaveBeenCalledWith({ enabled: true, provider: providerIdentifiers.kenari })
	})

	it.each([providerIdentifiers.ollama, providerIdentifiers.lmstudio])(
		"does not make an aggregate router request for local provider %s",
		(provider) => {
			vi.mocked(useSelectedModel).mockReturnValue({
				provider,
				id: "local-model",
				info: undefined,
				isLoading: false,
				isError: false,
			})

			renderWithProviders({
				...defaultProps,
				apiConfiguration: { apiProvider: provider } as ProviderSettings,
			})

			expect(useRouterModels).toHaveBeenCalledWith({ provider })
			expect(useRouterModels).not.toHaveBeenCalledWith()
		},
	)

	it("should show all providers when no organization allow list is provided", () => {
		renderWithProviders()

		const selectElement = screen.getByTestId("provider-select")
		const options = JSON.parse(selectElement.getAttribute("data-options") || "[]")

		// Should include both static and dynamic providers
		const providerValues = options.map((opt: any) => opt.value)
		expect(providerValues).toContain("anthropic") // static provider
		expect(providerValues).toContain("openrouter") // dynamic provider
		expect(providerValues).toContain("ollama") // dynamic provider
	})

	it("should hide static providers with empty models", () => {
		// Mock MODELS_BY_PROVIDER to have an empty provider
		const _originalModels = { ...MODELS_BY_PROVIDER }
		;(MODELS_BY_PROVIDER as any).emptyProvider = {}

		// Add the empty provider to PROVIDERS
		PROVIDERS.push({ value: "emptyProvider", label: "Empty Provider", proxy: false })

		renderWithProviders()

		const selectElement = screen.getByTestId("provider-select")
		const options = JSON.parse(selectElement.getAttribute("data-options") || "[]")
		const providerValues = options.map((opt: any) => opt.value)

		// Should NOT include the empty static provider
		expect(providerValues).not.toContain("emptyProvider")

		// Cleanup
		delete (MODELS_BY_PROVIDER as any).emptyProvider
		PROVIDERS.pop()
	})

	it("should always show dynamic providers even if they have no models yet", () => {
		renderWithProviders()

		const selectElement = screen.getByTestId("provider-select")
		const options = JSON.parse(selectElement.getAttribute("data-options") || "[]")
		const providerValues = options.map((opt: any) => opt.value)

		// Dynamic providers (not in MODELS_BY_PROVIDER) should always be shown
		expect(providerValues).toContain("openrouter")
		expect(providerValues).toContain("ollama")
		expect(providerValues).toContain("lmstudio")
		expect(providerValues).toContain("litellm")
		expect(providerValues).toContain("requesty")
	})

	it("should filter static providers based on organization allow list", () => {
		// Create a mock organization allow list that only allows certain models
		const allowList: OrganizationAllowList = {
			allowAll: false,
			providers: {
				anthropic: {
					allowAll: false,
					models: ["claude-3-5-sonnet-20241022"], // Only allow one model
				},
				gemini: {
					allowAll: false,
					models: [], // No models allowed
				},
				openrouter: {
					allowAll: true, // Dynamic provider with all models allowed
				},
			},
		}

		// Mock the extension state with the allow list
		vi.mocked(useExtensionState).mockReturnValue({
			organizationAllowList: allowList,
			cloudIsAuthenticated: false,
		} as any)

		renderWithProviders()

		const selectElement = screen.getByTestId("provider-select")
		const options = JSON.parse(selectElement.getAttribute("data-options") || "[]")
		const providerValues = options.map((opt: any) => opt.value)

		// Should include anthropic (has allowed models)
		expect(providerValues).toContain("anthropic")

		// Should NOT include gemini (no allowed models)
		expect(providerValues).not.toContain("gemini")

		// Should include openrouter (dynamic provider)
		expect(providerValues).toContain("openrouter")

		// Should NOT include providers not in the allow list
		expect(providerValues).not.toContain("openai-native")
		expect(providerValues).not.toContain("mistral")
	})

	it("should show static provider when allowAll is true for that provider", () => {
		const allowList: OrganizationAllowList = {
			allowAll: false,
			providers: {
				anthropic: {
					allowAll: true, // Allow all models for this provider
				},
			},
		}

		vi.mocked(useExtensionState).mockReturnValue({
			organizationAllowList: allowList,
			cloudIsAuthenticated: false,
		} as any)

		renderWithProviders()

		const selectElement = screen.getByTestId("provider-select")
		const options = JSON.parse(selectElement.getAttribute("data-options") || "[]")
		const providerValues = options.map((opt: any) => opt.value)

		// Should include anthropic since allowAll is true
		expect(providerValues).toContain("anthropic")
	})

	it("should always show currently selected provider even if it has no models", () => {
		// Add an empty static provider to test
		;(MODELS_BY_PROVIDER as any).testEmptyProvider = {}
		// Add the provider to the PROVIDERS list
		PROVIDERS.push({ value: "testEmptyProvider", label: "Test Empty Provider", proxy: false })

		// Create a mock organization allow list that allows the provider but no models
		const allowList: OrganizationAllowList = {
			allowAll: false,
			providers: {
				testEmptyProvider: {
					allowAll: true, // Allow the provider itself, but it has no models in MODELS_BY_PROVIDER
				},
				anthropic: {
					allowAll: true, // Allow anthropic for comparison
				},
			},
		}

		vi.mocked(useExtensionState).mockReturnValue({
			organizationAllowList: allowList,
			cloudIsAuthenticated: false,
		} as any)

		// Mock the selected model hook to return testEmptyProvider as the selected provider
		;(useSelectedModel as any).mockReturnValue({
			provider: "testEmptyProvider",
			id: undefined,
			info: null,
		})

		// Render with testEmptyProvider as the selected provider
		const props = {
			...defaultProps,
			apiConfiguration: {
				...defaultProps.apiConfiguration,
				apiProvider: "testEmptyProvider" as any,
			} as ProviderSettings,
		}

		renderWithProviders(props)

		const selectElement = screen.getByTestId("provider-select")
		const options = JSON.parse(selectElement.getAttribute("data-options") || "[]")
		const providerValues = options.map((opt: any) => opt.value)

		// Should include testEmptyProvider even though it has no models (empty object in MODELS_BY_PROVIDER), because it's currently selected
		expect(providerValues).toContain("testEmptyProvider")
		// Should also include anthropic since it has allowAll: true
		expect(providerValues).toContain("anthropic")

		// Cleanup
		delete (MODELS_BY_PROVIDER as any).testEmptyProvider
		PROVIDERS.pop()
	})

	describe("MiMo dynamic model catalog (ApiOptions -> ModelPicker wiring)", () => {
		// Regression guard: the generic ModelPicker must receive the host-fetched router
		// catalog for MiMo merged on top of the static MODELS_BY_PROVIDER fallback in
		// ApiOptions. ModelPicker itself performs no router merging, so if the merge in
		// ApiOptions regressed to static-only, router-only models newer than the shipped
		// catalog would silently become unselectable and no other suite would catch it.
		const routerOnlyMimoModelId = "mimo-v2.7-ultra"

		const routerOnlyMimoModelInfo: ModelInfo = {
			maxTokens: 131_072,
			contextWindow: 262_144,
			supportsPromptCache: false,
		}

		const renderWithMimoSelected = (routerData: Record<string, Record<string, ModelInfo>> | undefined) => {
			// Earlier allow-list suites leave a restrictive organizationAllowList on this
			// mock (clearAllMocks keeps mockReturnValue); reset to the unfiltered default
			// so the MiMo catalog reaches the picker in full.
			setOrganizationAllowList(undefined)
			setRouterModelsData(routerData)
			vi.mocked(useSelectedModel).mockReturnValue({
				provider: providerIdentifiers.mimo,
				id: mimoDefaultModelId,
				info: undefined,
				isLoading: false,
				isError: false,
			})

			return renderWithProviders({
				...defaultProps,
				apiConfiguration: {
					apiProvider: providerIdentifiers.mimo,
					apiModelId: mimoDefaultModelId,
				} as ProviderSettings,
			})
		}

		afterEach(() => {
			// Restore the default (no fetched models) for any suites that run later.
			setRouterModelsData(undefined)
		})

		it("passes both static and router-fetched MiMo models to the generic ModelPicker", () => {
			// The router payload contains ONLY a model id that does not exist in the
			// shipped static mimo catalog; it can reach the picker solely via the merge.
			renderWithMimoSelected({ [providerIdentifiers.mimo]: { [routerOnlyMimoModelId]: routerOnlyMimoModelInfo } })

			// Static default from getStaticModelsForProvider(mimo) / MODELS_BY_PROVIDER.
			expect(screen.getByTestId(`model-option-${mimoDefaultModelId}`)).toBeInTheDocument()
			// Router-only model: present in the picker only if ApiOptions merged routerModels[mimo].
			expect(screen.getByTestId(`model-option-${routerOnlyMimoModelId}`)).toBeInTheDocument()
		})

		it("keeps the static MiMo catalog selectable when no router models are available", () => {
			// useRouterModels data is undefined while the fetch is pending/failed; the
			// spread of routerModels?.[mimo] must not crash or drop the static defaults.
			renderWithMimoSelected(undefined)

			expect(screen.getByTestId(`model-option-${mimoDefaultModelId}`)).toBeInTheDocument()
			expect(screen.queryByTestId(`model-option-${routerOnlyMimoModelId}`)).not.toBeInTheDocument()
		})

		it("keeps the static MiMo catalog selectable when the router catalog is empty", () => {
			renderWithMimoSelected({})

			expect(screen.getByTestId(`model-option-${mimoDefaultModelId}`)).toBeInTheDocument()
			expect(screen.queryByTestId(`model-option-${routerOnlyMimoModelId}`)).not.toBeInTheDocument()
		})
	})
})
