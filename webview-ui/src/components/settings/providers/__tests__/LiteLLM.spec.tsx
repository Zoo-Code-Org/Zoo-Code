import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"

import {
	allRouterModelsProvider,
	providerIdentifiers,
	type OrganizationAllowList,
	type ProviderSettings,
} from "@roo-code/types"

import { LiteLLM } from "../LiteLLM"

const { postMessageMock, mockUseExtensionState } = vi.hoisted(() => ({
	postMessageMock: vi.fn(),
	mockUseExtensionState: vi.fn(),
}))

vi.mock("@src/utils/vscode", () => ({
	vscode: { postMessage: postMessageMock },
}))

vi.mock("@src/context/ExtensionStateContext", () => ({
	useExtensionState: mockUseExtensionState,
}))

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeTextField: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
	VSCodeCheckbox: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

vi.mock("@src/components/ui", () => ({
	Button: ({ children, onClick, disabled }: React.ComponentProps<"button">) => (
		<button data-testid="refresh-button" onClick={onClick} disabled={disabled}>
			{children}
		</button>
	),
}))

vi.mock("../../ModelPicker", () => ({
	ModelPicker: () => <div data-testid="model-picker" />,
}))

describe("LiteLLM", () => {
	const organizationAllowList: OrganizationAllowList = { allowAll: true, providers: {} }

	beforeEach(() => {
		vi.clearAllMocks()
		mockUseExtensionState.mockReturnValue({ routerModels: { [providerIdentifiers.litellm]: {} } })
	})

	it("invalidates both LiteLLM caches after a successful model refresh", async () => {
		const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
		const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries")
		const apiConfiguration: ProviderSettings = {
			apiProvider: providerIdentifiers.litellm,
			litellmApiKey: "test-key",
			litellmBaseUrl: "http://localhost:4000",
		}

		render(
			<QueryClientProvider client={queryClient}>
				<LiteLLM
					apiConfiguration={apiConfiguration}
					setApiConfigurationField={vi.fn()}
					organizationAllowList={organizationAllowList}
				/>
			</QueryClientProvider>,
		)

		fireEvent.click(screen.getByTestId("refresh-button"))
		expect(postMessageMock).toHaveBeenCalledWith({
			type: "requestRouterModels",
			values: {
				provider: providerIdentifiers.litellm,
				litellmApiKey: "test-key",
				litellmBaseUrl: "http://localhost:4000",
			},
		})
		act(() => {
			window.dispatchEvent(new MessageEvent("message", { data: { type: "routerModels" } }))
		})

		await waitFor(() => {
			expect(invalidateQueries).toHaveBeenCalledWith({
				queryKey: ["routerModels", providerIdentifiers.litellm],
			})
			expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["routerModels", allRouterModelsProvider] })
		})
	})

	it("recognizes failed refresh responses for the canonical LiteLLM provider", () => {
		const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
		render(
			<QueryClientProvider client={queryClient}>
				<LiteLLM
					apiConfiguration={{ apiProvider: providerIdentifiers.litellm }}
					setApiConfigurationField={vi.fn()}
					organizationAllowList={organizationAllowList}
				/>
			</QueryClientProvider>,
		)

		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "singleRouterModelFetchResponse",
						success: false,
						values: { provider: providerIdentifiers.litellm },
						error: "LiteLLM unavailable",
					},
				}),
			)
		})

		expect(screen.getByText("LiteLLM unavailable")).toBeInTheDocument()
	})

	it("does not invalidate caches when a LiteLLM error and router models arrive in the same tick", () => {
		const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
		const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries")

		render(
			<QueryClientProvider client={queryClient}>
				<LiteLLM
					apiConfiguration={{
						apiProvider: providerIdentifiers.litellm,
						litellmApiKey: "test-key",
						litellmBaseUrl: "http://localhost:4000",
					}}
					setApiConfigurationField={vi.fn()}
					organizationAllowList={organizationAllowList}
				/>
			</QueryClientProvider>,
		)

		fireEvent.click(screen.getByTestId("refresh-button"))
		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "singleRouterModelFetchResponse",
						success: false,
						values: { provider: providerIdentifiers.litellm },
						error: "LiteLLM unavailable",
					},
				}),
			)
			window.dispatchEvent(new MessageEvent("message", { data: { type: "routerModels" } }))
		})

		expect(screen.getByText("LiteLLM unavailable")).toBeInTheDocument()
		expect(invalidateQueries).not.toHaveBeenCalled()
	})

	it("ignores failed refresh responses for another provider", () => {
		const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
		render(
			<QueryClientProvider client={queryClient}>
				<LiteLLM
					apiConfiguration={{
						apiProvider: providerIdentifiers.litellm,
						litellmApiKey: "test-key",
						litellmBaseUrl: "http://localhost:4000",
					}}
					setApiConfigurationField={vi.fn()}
					organizationAllowList={organizationAllowList}
				/>
			</QueryClientProvider>,
		)

		fireEvent.click(screen.getByTestId("refresh-button"))
		expect(screen.getByText("settings:providers.refreshModels.loading")).toBeInTheDocument()

		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "singleRouterModelFetchResponse",
						success: false,
						values: { provider: providerIdentifiers.openrouter },
						error: "OpenRouter unavailable",
					},
				}),
			)
		})

		expect(screen.queryByText("OpenRouter unavailable")).not.toBeInTheDocument()
		expect(screen.getByText("settings:providers.refreshModels.loading")).toBeInTheDocument()
	})

	it("hides manual cache controls for Responses-backed models", () => {
		mockUseExtensionState.mockReturnValue({
			routerModels: {
				[providerIdentifiers.litellm]: {
					"gpt-6-astra": {
						contextWindow: 1_050_000,
						supportsPromptCache: true,
						requiresResponsesApi: true,
					},
				},
			},
		})
		const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

		render(
			<QueryClientProvider client={queryClient}>
				<LiteLLM
					apiConfiguration={{ apiProvider: providerIdentifiers.litellm, litellmModelId: "gpt-6-astra" }}
					setApiConfigurationField={vi.fn()}
					organizationAllowList={organizationAllowList}
				/>
			</QueryClientProvider>,
		)

		expect(screen.queryByText("settings:providers.enablePromptCaching")).not.toBeInTheDocument()
	})

	it("shows manual cache controls for cache-capable chat completion models", () => {
		mockUseExtensionState.mockReturnValue({
			routerModels: {
				[providerIdentifiers.litellm]: {
					"cache-capable-model": {
						contextWindow: 128_000,
						supportsPromptCache: true,
					},
				},
			},
		})
		const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

		render(
			<QueryClientProvider client={queryClient}>
				<LiteLLM
					apiConfiguration={{
						apiProvider: providerIdentifiers.litellm,
						litellmModelId: "cache-capable-model",
					}}
					setApiConfigurationField={vi.fn()}
					organizationAllowList={organizationAllowList}
				/>
			</QueryClientProvider>,
		)

		expect(screen.getByText("settings:providers.enablePromptCaching")).toBeInTheDocument()
	})
})
