import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"

import {
	allRouterModelsProvider,
	providerIdentifiers,
	type OrganizationAllowList,
	type ProviderSettings,
} from "@roo-code/types"

import { Poe } from "../Poe"

const { mockUseExtensionState, postMessageMock } = vi.hoisted(() => ({
	mockUseExtensionState: vi.fn(),
	postMessageMock: vi.fn(),
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
}))

vi.mock("@src/components/common/VSCodeButtonLink", () => ({
	VSCodeButtonLink: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

vi.mock("@src/components/ui", () => ({
	Button: ({ children, onClick, disabled }: React.ComponentProps<"button">) => (
		<button data-testid="refresh-button" onClick={onClick} disabled={disabled}>
			{children}
		</button>
	),
}))

vi.mock("../../ModelPicker", () => ({
	ModelPicker: ({ onModelChange }: { onModelChange?: (modelId: string) => void }) => (
		<button data-testid="model-picker" onClick={() => onModelChange?.("claude-sonnet-4.5")}>
			Select model
		</button>
	),
}))

describe("Poe", () => {
	const organizationAllowList: OrganizationAllowList = { allowAll: true, providers: {} }
	const setApiConfigurationField = vi.fn()

	const renderComponent = (apiConfiguration: ProviderSettings = { apiProvider: providerIdentifiers.poe }) => {
		const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

		return render(
			<QueryClientProvider client={queryClient}>
				<Poe
					apiConfiguration={apiConfiguration}
					setApiConfigurationField={setApiConfigurationField}
					organizationAllowList={organizationAllowList}
				/>
			</QueryClientProvider>,
		)
	}

	beforeEach(() => {
		vi.clearAllMocks()
		mockUseExtensionState.mockReturnValue({ routerModels: { [providerIdentifiers.poe]: {} } })
	})

	it("shows the Poe refresh error returned by the extension", () => {
		renderComponent({ apiProvider: providerIdentifiers.poe, poeApiKey: "test-key" })

		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "singleRouterModelFetchResponse",
						success: false,
						values: { provider: providerIdentifiers.poe },
						error: "Poe authentication failed",
					},
				}),
			)
		})

		expect(screen.getByText("Poe authentication failed")).toBeInTheDocument()
	})

	it("ignores failed refresh responses for another provider", () => {
		renderComponent({ apiProvider: providerIdentifiers.poe, poeApiKey: "test-key" })

		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "singleRouterModelFetchResponse",
						success: false,
						values: { provider: providerIdentifiers.openrouter },
						error: "OpenRouter authentication failed",
					},
				}),
			)
		})

		expect(screen.queryByText("OpenRouter authentication failed")).not.toBeInTheDocument()
		expect(screen.queryByText("settings:providers.refreshModels.error")).not.toBeInTheDocument()
	})

	it("invalidates only the Poe and shared router-model caches after a successful refresh", async () => {
		const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
		const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries")

		render(
			<QueryClientProvider client={queryClient}>
				<Poe
					apiConfiguration={{ apiProvider: providerIdentifiers.poe, poeApiKey: "test-key" }}
					setApiConfigurationField={setApiConfigurationField}
					organizationAllowList={organizationAllowList}
				/>
			</QueryClientProvider>,
		)

		fireEvent.click(screen.getByTestId("refresh-button"))
		expect(postMessageMock).toHaveBeenCalledWith({
			type: "requestRouterModels",
			values: {
				provider: providerIdentifiers.poe,
				poeApiKey: "test-key",
				poeBaseUrl: undefined,
			},
		})
		act(() => {
			window.dispatchEvent(new MessageEvent("message", { data: { type: "routerModels" } }))
		})

		await waitFor(() => {
			expect(invalidateQueries).toHaveBeenCalledWith({
				queryKey: ["routerModels", providerIdentifiers.poe],
			})
			expect(invalidateQueries).toHaveBeenCalledWith({
				queryKey: ["routerModels", allRouterModelsProvider],
			})
			expect(invalidateQueries).not.toHaveBeenCalledWith({ queryKey: ["routerModels"] })
		})
	})

	it("clears model-specific reasoning settings when the Poe model changes", () => {
		renderComponent()

		fireEvent.click(screen.getByTestId("model-picker"))

		expect(setApiConfigurationField).toHaveBeenCalledWith("reasoningEffort", undefined)
		expect(setApiConfigurationField).toHaveBeenCalledWith("modelMaxTokens", undefined)
		expect(setApiConfigurationField).toHaveBeenCalledWith("modelMaxThinkingTokens", undefined)
	})
})
