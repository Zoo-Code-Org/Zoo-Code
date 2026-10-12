// npx vitest src/components/settings/providers/__tests__/Mimo.spec.tsx

import { render, screen, fireEvent, waitFor, act } from "@/utils/test-utils"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { allRouterModelsProvider, providerIdentifiers, type ProviderSettings } from "@roo-code/types"

import { Mimo } from "../Mimo"

// Mock the translation hook
vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string) => key,
	}),
}))

// Mock VSCode webview toolkit components using importOriginal
vi.mock("@vscode/webview-ui-toolkit/react", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@vscode/webview-ui-toolkit/react")>()
	return {
		...actual,
		VSCodeTextField: ({ children, value, onInput, type, placeholder }: any) => (
			<div data-testid="vscode-text-field">
				{children}
				<input
					type={type}
					value={value}
					onInput={(e) => onInput?.(e)}
					placeholder={placeholder}
					data-testid="mimo-api-key-input"
				/>
			</div>
		),
		VSCodeDropdown: ({ children, value, onChange }: any) => (
			<div data-testid="vscode-dropdown" data-value={value}>
				{children}
				<button data-testid="dropdown-trigger" onClick={() => onChange?.({ target: { value: "changed" } })}>
					Change
				</button>
			</div>
		),
		VSCodeOption: ({ children, value }: any) => (
			<div data-testid={`option-${value}`} data-value={value}>
				{children}
			</div>
		),
	}
})

// Mock vscode - factory must not reference outer scope variables
vi.mock("@src/utils/vscode", () => {
	const mockPostMessage = vi.fn()
	return {
		vscode: { postMessage: mockPostMessage },
	}
})

// Mock @src/components/ui using importOriginal to get all real exports
vi.mock("@src/components/ui", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@src/components/ui")>()
	return {
		...actual,
		Button: ({ children, onClick, disabled, variant }: any) => (
			<button data-testid="button" disabled={disabled} onClick={onClick} data-variant={variant}>
				{children}
			</button>
		),
	}
})

// Mock VSCodeButtonLink
vi.mock("@src/components/common/VSCodeButtonLink", () => ({
	VSCodeButtonLink: ({ href, children }: any) => (
		<a data-testid="vscode-button-link" href={href}>
			{children}
		</a>
	),
}))

import { vscode } from "@src/utils/vscode"

const findRefreshButton = () =>
	screen.getAllByTestId("button").find((b) => b.getAttribute("data-variant") === "outline")

describe("Mimo Component", () => {
	const mockSetApiConfigurationField = vi.fn()

	const createDefaultApiConfiguration = (overrides?: Partial<ProviderSettings>): ProviderSettings => ({
		apiProvider: providerIdentifiers.mimo,
		mimoBaseUrl: "https://token-plan-sgp.xiaomimimo.com/v1",
		...overrides,
	})

	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("renders API key input, base URL dropdown, and refresh button", () => {
		render(
			<Mimo
				apiConfiguration={createDefaultApiConfiguration()}
				setApiConfigurationField={mockSetApiConfigurationField}
			/>,
		)

		expect(screen.getByTestId("mimo-api-key-input")).toBeInTheDocument()
		expect(screen.getByTestId("vscode-dropdown")).toBeInTheDocument()
		expect(findRefreshButton()).toBeInTheDocument()
	})

	it("refresh button is disabled when no API key is provided", () => {
		render(
			<Mimo
				apiConfiguration={createDefaultApiConfiguration({ mimoApiKey: undefined })}
				setApiConfigurationField={mockSetApiConfigurationField}
			/>,
		)

		expect(findRefreshButton()).toBeDisabled()
	})

	it("refresh button is enabled when API key is provided", () => {
		render(
			<Mimo
				apiConfiguration={createDefaultApiConfiguration({ mimoApiKey: "test-key" })}
				setApiConfigurationField={mockSetApiConfigurationField}
			/>,
		)

		expect(findRefreshButton()).not.toBeDisabled()
	})

	it("shows loading state when refresh is clicked", () => {
		render(
			<Mimo
				apiConfiguration={createDefaultApiConfiguration({ mimoApiKey: "test-key" })}
				setApiConfigurationField={mockSetApiConfigurationField}
			/>,
		)

		const refreshButton = findRefreshButton()!
		fireEvent.click(refreshButton)

		expect(refreshButton).toBeDisabled()
		expect(screen.getByText("settings:providers.refreshModels.loading")).toBeInTheDocument()
	})

	it("shows success state after routerModels message received", async () => {
		render(
			<Mimo
				apiConfiguration={createDefaultApiConfiguration({ mimoApiKey: "test-key" })}
				setApiConfigurationField={mockSetApiConfigurationField}
			/>,
		)

		fireEvent.click(findRefreshButton()!)

		window.postMessage(
			{
				type: "routerModels",
				values: { mimo: { "mimo-v2.6-pro": { maxTokens: 131072 } } },
			},
			"*",
		)

		await waitFor(() => {
			expect(screen.getByText("settings:providers.refreshModels.success")).toBeInTheDocument()
		})
	})

	it("invalidates only the MiMo and shared router-model caches after a successful refresh", async () => {
		const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
		const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries")

		render(
			<QueryClientProvider client={queryClient}>
				<Mimo
					apiConfiguration={createDefaultApiConfiguration({ mimoApiKey: "test-key" })}
					setApiConfigurationField={mockSetApiConfigurationField}
				/>
			</QueryClientProvider>,
		)

		fireEvent.click(findRefreshButton()!)
		act(() => {
			window.dispatchEvent(new MessageEvent("message", { data: { type: "routerModels" } }))
		})

		await waitFor(() => {
			expect(invalidateQueries).toHaveBeenCalledWith({
				queryKey: ["routerModels", providerIdentifiers.mimo],
			})
			expect(invalidateQueries).toHaveBeenCalledWith({
				queryKey: ["routerModels", allRouterModelsProvider],
			})
			expect(invalidateQueries).not.toHaveBeenCalledWith({ queryKey: ["routerModels"] })
		})
	})

	it("shows error state after a MiMo singleRouterModelFetchResponse error message", async () => {
		render(
			<Mimo
				apiConfiguration={createDefaultApiConfiguration({ mimoApiKey: "test-key" })}
				setApiConfigurationField={mockSetApiConfigurationField}
			/>,
		)

		await act(async () => {
			fireEvent.click(findRefreshButton()!)
		})

		await waitFor(() => {
			expect(screen.getByText("settings:providers.refreshModels.loading")).toBeInTheDocument()
		})

		// Delay so the handler closure captures refreshStatus === "loading".
		await act(async () => {
			return new Promise((resolve) => {
				setTimeout(() => {
					window.postMessage(
						{
							type: "singleRouterModelFetchResponse",
							success: false,
							error: "API connection failed",
							values: { provider: providerIdentifiers.mimo },
						},
						"*",
					)
					resolve(undefined)
				}, 0)
			})
		})

		await waitFor(() => {
			expect(screen.getByText("API connection failed")).toBeInTheDocument()
		})
	})

	it("ignores another provider's failed refresh response while loading", async () => {
		render(
			<Mimo
				apiConfiguration={createDefaultApiConfiguration({ mimoApiKey: "test-key" })}
				setApiConfigurationField={mockSetApiConfigurationField}
			/>,
		)

		fireEvent.click(findRefreshButton()!)
		await waitFor(() => expect(screen.getByText("settings:providers.refreshModels.loading")).toBeInTheDocument())

		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "singleRouterModelFetchResponse",
						success: false,
						error: "Moonshot unavailable",
						values: { provider: providerIdentifiers.moonshot },
					},
				}),
			)
		})

		expect(screen.queryByText("Moonshot unavailable")).not.toBeInTheDocument()
		expect(screen.getByText("settings:providers.refreshModels.loading")).toBeInTheDocument()
	})

	it("ignores a MiMo failure response before refresh starts", () => {
		render(
			<Mimo
				apiConfiguration={createDefaultApiConfiguration({ mimoApiKey: "test-key" })}
				setApiConfigurationField={mockSetApiConfigurationField}
			/>,
		)

		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "singleRouterModelFetchResponse",
						success: false,
						error: "MiMo unavailable",
						values: { provider: providerIdentifiers.mimo },
					},
				}),
			)
		})

		expect(screen.queryByText("MiMo unavailable")).not.toBeInTheDocument()
		expect(screen.queryByText("settings:providers.refreshModels.loading")).not.toBeInTheDocument()
	})

	it("sends the provider-correlated MiMo credentials when refresh is clicked", () => {
		render(
			<Mimo
				apiConfiguration={createDefaultApiConfiguration({
					mimoApiKey: "test-key",
					mimoBaseUrl: "https://token-plan-ams.xiaomimimo.com/v1",
				})}
				setApiConfigurationField={mockSetApiConfigurationField}
			/>,
		)

		fireEvent.click(findRefreshButton()!)

		expect(vscode.postMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "requestRouterModels",
				values: {
					provider: providerIdentifiers.mimo,
					mimoApiKey: "test-key",
					mimoBaseUrl: "https://token-plan-ams.xiaomimimo.com/v1",
				},
			}),
		)
	})

	it("shows 'Get MiMo API Key' link when no API key is set", () => {
		render(
			<Mimo
				apiConfiguration={createDefaultApiConfiguration({ mimoApiKey: undefined })}
				setApiConfigurationField={mockSetApiConfigurationField}
			/>,
		)

		expect(screen.getByTestId("vscode-button-link")).toBeInTheDocument()
		expect(screen.getByTestId("vscode-button-link")).toHaveAttribute("href", "https://platform.xiaomimimo.com")
	})

	it("hides 'Get MiMo API Key' link when API key is set", () => {
		render(
			<Mimo
				apiConfiguration={createDefaultApiConfiguration({ mimoApiKey: "test-key" })}
				setApiConfigurationField={mockSetApiConfigurationField}
			/>,
		)

		expect(screen.queryByTestId("vscode-button-link")).not.toBeInTheDocument()
	})
})
