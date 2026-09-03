import { render, screen, fireEvent, act } from "@testing-library/react"

import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

import type { ReactNode, ChangeEvent } from "react"
import type { ProviderSettings, OrganizationAllowList, ExtensionMessage } from "@roo-code/types"
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
	type VSCodeTextFieldProps = {
		children?: ReactNode
		value?: string
		onInput?: (event: ChangeEvent<HTMLInputElement>) => void
		type?: string
	}
	const VSCodeTextField = ({ children, value, onInput, type }: VSCodeTextFieldProps) =>
		React.createElement(
			"div",
			null,
			children,
			React.createElement("input", {
				type,
				value,
				onChange: (e: ChangeEvent<HTMLInputElement>) => onInput?.(e),
				"data-testid": type === "url" ? "base-url-input" : "api-key-input",
			}),
		)
	type VSCodeLinkProps = { children?: ReactNode; href?: string }
	const VSCodeLink = ({ children, href }: VSCodeLinkProps) =>
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
	VSCodeButtonLink: ({ children, href }: { children?: ReactNode; href?: string }) => (
		<a href={href} data-testid="get-api-key-link">
			{children}
		</a>
	),
}))

// Stub the whole hook module: the real fetchRouterModels registers a
// transient window "message" listener that only cleans up when a matching
// response arrives or the 10s timeout fires. Stubbing removes that noise so
// the unmount test below can assert listener balance for OpenRouter's own
// effect pair in isolation.
vi.mock("@src/components/ui/hooks/useRouterModels", () => ({
	useRouterModels: ({ provider }: { provider?: string }) => ({
		data: provider ? { [provider]: {} } : {},
		isLoading: false,
		isError: false,
		refetch: vi.fn(),
	}),
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
	Button: ({
		children,
		onClick,
		disabled,
		className,
	}: {
		children?: ReactNode
		onClick?: React.MouseEventHandler<HTMLButtonElement>
		disabled?: boolean
		className?: string
	}) => (
		<button onClick={onClick} disabled={disabled} className={className} data-testid="refresh-button">
			{children}
		</button>
	),
}))

vi.mock("vscrui", async (importOriginal) => ({
	...(await importOriginal<typeof import("vscrui")>()),
	Checkbox: ({
		checked,
		onChange,
		children,
	}: {
		checked?: boolean
		onChange?: (checked: boolean) => void
		children?: ReactNode
	}) => (
		<label data-testid="base-url-checkbox" onClick={() => onChange?.(!checked)}>
			{children}
		</label>
	),
}))

// The shared Button stub is also used by the real ModelPicker rendered
// underneath, so identify OUR refresh button via its unique i18n label.
const getRefreshButton = (): HTMLButtonElement => {
	const button = screen.getByText("settings:providers.refreshModels.label").closest("button")
	if (!(button instanceof HTMLButtonElement)) {
		throw new Error("Refresh button element not found or not a <button>")
	}
	return button
}

describe("OpenRouter", () => {
	const organizationAllowList: OrganizationAllowList = { allowAll: true, providers: {} }
	const mockSetApiConfigurationField = vi.fn()

	let queryClient: QueryClient
	let invalidateQueriesSpy: ReturnType<typeof vi.spyOn>

	const minimalApiConfiguration: ProviderSettings = {
		apiProvider: providerIdentifiers.openrouter,
		openRouterApiKey: "key",
	}

	const renderComponent = ({
		apiConfiguration = minimalApiConfiguration,
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
		// Narrow fixture type matching the message shapes OpenRouter actually
		// consumes (ExtensionMessage fields for routerModels refresh flows).
		const dispatchMessage = (data: ExtensionMessage) =>
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

		it("ignores fetch failures carrying no values", () => {
			renderComponent()

			fireEvent.click(getRefreshButton())
			// No `values` at all: `message.values?.provider` must short-circuit to
			// undefined so the provider match fails and the error branch is skipped.
			// fireEvent rethrows listener exceptions, so an OptionalChaining mutant
			// (`?.` replaced by `.`) crashes here and is killed by this assertion.
			expect(() =>
				fireEvent(
					window,
					new MessageEvent("message", {
						data: {
							type: RouterModelsMessageType.singleRouterModelFetchResponse,
							success: false,
							error: "should not show",
						} satisfies ExtensionMessage,
					}),
				),
			).not.toThrow()

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
			// Spy but delegate to the original methods (captured before spying,
			// since jsdom rejects EventTarget.prototype.addEventListener.call(window))
			// so the component still registers/unregisters listeners during the test.
			type Listener = Parameters<typeof window.addEventListener>[1] & {}
			const added: Array<[string, Listener]> = []
			const removed: Array<[string, Listener]> = []

			const originalAdd = window.addEventListener
			const originalRemove = window.removeEventListener

			const addSpy = vi
				.spyOn(window, "addEventListener")
				.mockImplementation((type: string, listener: Listener, options?: AddEventListenerOptions | boolean) => {
					added.push([type, listener])
					originalAdd.call(window, type, listener, options)
				})

			const removeSpy = vi
				.spyOn(window, "removeEventListener")
				.mockImplementation((type: string, listener: Listener, options?: EventListenerOptions | boolean) => {
					removed.push([type, listener])
					originalRemove.call(window, type, listener, options)
				})

			try {
				const { unmount } = renderComponent()

				unmount()

				// Every "message" listener added must be removed (multiset compare).
				const addedMessages = added.filter(([type]) => type === "message").map(([, listener]) => listener)
				const removedMessages = removed.filter(([type]) => type === "message").map(([, listener]) => listener)
				expect(addedMessages.length).toBeGreaterThan(0)

				const remaining = [...addedMessages]
				for (const listener of removedMessages) {
					const index = remaining.indexOf(listener)
					expect(index).toBeGreaterThanOrEqual(0)
					if (index >= 0) {
						remaining.splice(index, 1)
					}
				}
				expect(remaining).toEqual([])

				expect(() =>
					act(() => {
						window.dispatchEvent(
							new MessageEvent("message", { data: { type: RouterModelsMessageType.routerModels } }),
						)
					}),
				).not.toThrow()
				expect(screen.queryByText("settings:providers.refreshModels.label")).not.toBeInTheDocument()
			} finally {
				addSpy.mockRestore()
				removeSpy.mockRestore()
			}
		})
	})
})
