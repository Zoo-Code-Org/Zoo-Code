import { render, screen, fireEvent, act } from "@testing-library/react"

import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

import type { ProviderSettings, OrganizationAllowList } from "@roo-code/types"
import {
	openRouterDefaultModelId,
	allRouterModelsProvider,
	providerIdentifiers,
	RouterModelsMessageType,
} from "@roo-code/types"

import { OpenRouter } from "../OpenRouter"

// Explicit toolkit stub (vitest validates factory keys, so no Proxy tricks).
// Uses React.createElement because this factory runs while the spec's own
// imports are still initializing (hoisted vi.mock).
vi.mock("@vscode/webview-ui-toolkit/react", async () => {
	const React = await import("react")
	const VSCodeTextField = ({ children, value, onInput, type }: any) =>
		React.createElement(
			"div",
			null,
			children,
			React.createElement("input", {
				type,
				value,
				onChange: (e: any) => onInput(e),
				"data-testid": type === "url" ? "base-url-input" : "api-key-input",
			}),
		)
	const VSCodeLink = ({ children, href }: any) =>
		React.createElement("a", { href, "data-vscode-stub": "VSCodeLink" }, children)
	return { VSCodeTextField, VSCodeLink }
})

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock("@src/oauth/urls", () => ({
	getOpenRouterAuthUrl: () => "https://openrouter.ai/auth",
}))

// Alias-path mock (reliable across environments): prevents the real balance
// display from issuing network requests during tests.
vi.mock("@src/components/settings/providers/OpenRouterBalanceDisplay", () => ({
	OpenRouterBalanceDisplay: () => null,
}))

vi.mock("@src/components/common/VSCodeButtonLink", () => ({
	VSCodeButtonLink: ({ children, href }: any) => (
		<a href={href} data-testid="get-api-key-link">
			{children}
		</a>
	),
}))

const { postMessageMock } = vi.hoisted(() => ({
	postMessageMock: vi.fn(),
}))

vi.mock("@src/utils/vscode", () => ({
	vscode: {
		postMessage: postMessageMock,
	},
}))

// Keep every real export (Popover, Select, ...) so leaked child renders work,
// and only stub Button to assert onClick/disabled without styling deps.
vi.mock("@src/components/ui", async (importOriginal) => ({
	...(await importOriginal<typeof import("@src/components/ui")>()),
	Button: ({ children, onClick, disabled, className }: any) => (
		<button onClick={onClick} disabled={disabled} className={className} data-testid="refresh-button">
			{children}
		</button>
	),
}))

vi.mock("vscrui", async (importOriginal) => ({
	...(await importOriginal<typeof import("vscrui")>()),
	Checkbox: ({ checked, onChange, children }: any) => (
		<label data-testid="base-url-checkbox" onClick={() => onChange(!checked)}>
			{children}
		</label>
	),
}))

// The shared Button stub is also used by the real ModelPicker rendered
// underneath, so identify OUR refresh button via its unique i18n label.
const getRefreshButton = () =>
	screen.getByText("settings:providers.refreshModels.label").closest("button") as HTMLElement

describe("OpenRouter", () => {
	const organizationAllowList: OrganizationAllowList = { allowAll: true, providers: {} }
	const mockSetApiConfigurationField = vi.fn()

	let queryClient: QueryClient
	let invalidateQueriesSpy: ReturnType<typeof vi.spyOn>

	const renderComponent = ({
		apiConfiguration = { openRouterApiKey: "key" } as ProviderSettings,
		simplifySettings = true,
	}: {
		apiConfiguration?: ProviderSettings
		simplifySettings?: boolean
	} = {}) =>
		render(
			<QueryClientProvider client={queryClient}>
				<OpenRouter
					apiConfiguration={apiConfiguration}
					setApiConfigurationField={mockSetApiConfigurationField}
					selectedModelId={openRouterDefaultModelId}
					uriScheme="vscode"
					simplifySettings={simplifySettings}
					organizationAllowList={organizationAllowList}
				/>
			</QueryClientProvider>,
		)

	beforeEach(() => {
		vi.clearAllMocks()
		queryClient = new QueryClient({
			defaultOptions: {
				queries: { retry: false },
				mutations: { retry: false },
			},
		})
		invalidateQueriesSpy = vi.spyOn(queryClient, "invalidateQueries")
	})

	it("updates the API key via setApiConfigurationField on input", () => {
		renderComponent()

		fireEvent.change(screen.getByTestId("api-key-input"), { target: { value: "secret-key" } })

		expect(mockSetApiConfigurationField).toHaveBeenCalledWith("openRouterApiKey", "secret-key")
	})

	it("shows the get-API-key CTA only when no API key is set", () => {
		const { rerender } = renderComponent({ apiConfiguration: { openRouterApiKey: "" } })

		expect(screen.getByTestId("get-api-key-link")).toBeInTheDocument()
		expect(screen.getByTestId("get-api-key-link")).toHaveAttribute("href", "https://openrouter.ai/auth")

		rerender(
			<QueryClientProvider client={queryClient}>
				<OpenRouter
					apiConfiguration={{ openRouterApiKey: "already-set" }}
					setApiConfigurationField={mockSetApiConfigurationField}
					selectedModelId={openRouterDefaultModelId}
					uriScheme="vscode"
					organizationAllowList={organizationAllowList}
				/>
			</QueryClientProvider>,
		)
		expect(screen.queryByTestId("get-api-key-link")).not.toBeInTheDocument()
	})

	it("clears the base URL when the custom base URL checkbox is unchecked", () => {
		renderComponent({
			apiConfiguration: { openRouterApiKey: "key", openRouterBaseUrl: "https://proxy.example.com" },
			simplifySettings: false,
		})

		fireEvent.click(screen.getByTestId("base-url-checkbox"))

		expect(mockSetApiConfigurationField).toHaveBeenCalledWith("openRouterBaseUrl", "")
	})

	describe("refresh models", () => {
		const dispatchMessage = (data: any) =>
			act(() => {
				window.dispatchEvent(new MessageEvent("message", { data }))
			})

		it("renders the refresh button in idle state", () => {
			renderComponent()

			const button = getRefreshButton()
			expect(button).not.toBeDisabled()
			expect(button.querySelector(".codicon-refresh")).not.toBeNull()
			expect(screen.getByText("settings:providers.refreshModels.label")).toBeInTheDocument()
		})

		it("sends requestRouterModels for the openrouter provider when clicked", () => {
			renderComponent()

			fireEvent.click(getRefreshButton())

			expect(postMessageMock).toHaveBeenCalledWith({
				type: RouterModelsMessageType.requestRouterModels,
				values: { provider: providerIdentifiers.openrouter, refresh: true },
			})
		})

		it("enters loading state and disables the button while refreshing", () => {
			renderComponent()

			fireEvent.click(getRefreshButton())

			const button = getRefreshButton()
			expect(button).toBeDisabled()
			expect(button.querySelector(".codicon-loading")).not.toBeNull()
			expect(screen.getByText("settings:providers.refreshModels.loading")).toBeInTheDocument()
		})

		it("shows success and invalidates caches when a scoped routerModels response arrives", () => {
			renderComponent()

			fireEvent.click(getRefreshButton())
			dispatchMessage({
				type: RouterModelsMessageType.routerModels,
				values: { provider: providerIdentifiers.openrouter },
			})

			expect(screen.getByText("settings:providers.refreshModels.success")).toBeInTheDocument()
			expect(invalidateQueriesSpy).toHaveBeenCalledTimes(2)
			expect(invalidateQueriesSpy).toHaveBeenNthCalledWith(1, {
				queryKey: [RouterModelsMessageType.routerModels, providerIdentifiers.openrouter],
			})
			expect(invalidateQueriesSpy).toHaveBeenNthCalledWith(2, {
				queryKey: [RouterModelsMessageType.routerModels, allRouterModelsProvider],
			})
		})

		it("still resolves on unscoped (legacy/global) routerModels broadcasts", () => {
			renderComponent()

			fireEvent.click(getRefreshButton())
			dispatchMessage({ type: RouterModelsMessageType.routerModels })

			expect(screen.getByText("settings:providers.refreshModels.success")).toBeInTheDocument()
		})

		it("ignores scoped routerModels responses belonging to other providers", () => {
			renderComponent()

			fireEvent.click(getRefreshButton())
			dispatchMessage({
				type: RouterModelsMessageType.routerModels,
				values: { provider: providerIdentifiers.moonshot },
			})

			expect(screen.queryByText("settings:providers.refreshModels.success")).not.toBeInTheDocument()
			expect(screen.getByText("settings:providers.refreshModels.loading")).toBeInTheDocument()
			expect(invalidateQueriesSpy).not.toHaveBeenCalled()
		})

		it("shows error state with the received error message on fetch failure", () => {
			renderComponent()

			fireEvent.click(getRefreshButton())
			dispatchMessage({
				type: RouterModelsMessageType.singleRouterModelFetchResponse,
				success: false,
				values: { provider: providerIdentifiers.openrouter },
				error: "Invalid API key",
			})

			expect(screen.getByText("Invalid API key")).toBeInTheDocument()
		})

		it("falls back to the default error translation when no error is provided", () => {
			renderComponent()

			fireEvent.click(getRefreshButton())
			dispatchMessage({
				type: RouterModelsMessageType.singleRouterModelFetchResponse,
				success: false,
				values: { provider: providerIdentifiers.openrouter },
			})

			expect(screen.getByText("settings:providers.refreshModels.error")).toBeInTheDocument()
		})

		it("ignores fetch failures for other providers", () => {
			renderComponent()

			fireEvent.click(getRefreshButton())
			dispatchMessage({
				type: RouterModelsMessageType.singleRouterModelFetchResponse,
				success: false,
				values: { provider: providerIdentifiers.moonshot },
				error: "should not show",
			})

			expect(screen.queryByText("should not show")).not.toBeInTheDocument()
			expect(screen.getByText("settings:providers.refreshModels.loading")).toBeInTheDocument()
		})

		it("does not override an error with success when routerModels arrives after a failure", () => {
			renderComponent()

			fireEvent.click(getRefreshButton())

			// Dispatch both within the same act batch so the handler still sees
			// refreshStatus === "loading" and the errorJustReceived guard is exercised.
			act(() => {
				window.dispatchEvent(
					new MessageEvent("message", {
						data: {
							type: RouterModelsMessageType.singleRouterModelFetchResponse,
							success: false,
							values: { provider: providerIdentifiers.openrouter },
							error: "boom",
						},
					}),
				)
				window.dispatchEvent(
					new MessageEvent("message", { data: { type: RouterModelsMessageType.routerModels } }),
				)
			})

			expect(screen.getByText("boom")).toBeInTheDocument()
			expect(screen.queryByText("settings:providers.refreshModels.success")).not.toBeInTheDocument()
		})

		it("ignores routerModels messages when not in loading state", () => {
			renderComponent()

			// No refresh initiated; an unsolicited routerModels message should be a no-op.
			dispatchMessage({ type: RouterModelsMessageType.routerModels })

			expect(screen.queryByText("settings:providers.refreshModels.success")).not.toBeInTheDocument()
			expect(screen.queryByText("settings:providers.refreshModels.loading")).not.toBeInTheDocument()
		})

		it("stops listening for messages after unmount", () => {
			const { unmount } = renderComponent()

			unmount()

			expect(() =>
				act(() => {
					window.dispatchEvent(
						new MessageEvent("message", { data: { type: RouterModelsMessageType.routerModels } }),
					)
				}),
			).not.toThrow()
			expect(screen.queryByText("settings:providers.refreshModels.label")).not.toBeInTheDocument()
		})
	})
})
