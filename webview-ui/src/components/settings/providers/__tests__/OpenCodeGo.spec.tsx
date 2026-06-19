import { render, screen, fireEvent, act } from "@testing-library/react"

import type { ProviderSettings, OrganizationAllowList } from "@roo-code/types"
import { opencodeGoDefaultModelId } from "@roo-code/types"

import { OpenCodeGo } from "../OpenCodeGo"

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeTextField: ({ children, value, onInput, type }: any) => (
		<div>
			{children}
			<input type={type} value={value} onChange={(e) => onInput(e)} data-testid="api-key-input" />
		</div>
	),
}))

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock("@src/components/common/VSCodeButtonLink", () => ({
	VSCodeButtonLink: ({ children, href }: any) => (
		<a href={href} data-testid="get-api-key-link">
			{children}
		</a>
	),
}))

// Stub ModelPicker so we can assert the props it receives without pulling in its hooks.
vi.mock("../../ModelPicker", () => ({
	ModelPicker: ({ defaultModelId, modelIdKey, serviceName }: any) => (
		<div
			data-testid="model-picker"
			data-default-model-id={defaultModelId}
			data-model-id-key={modelIdKey}
			data-service-name={serviceName}
		/>
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

// Stub the shared Button so we can assert onClick/disabled without its styling deps.
vi.mock("@src/components/ui", () => ({
	Button: ({ children, onClick, disabled, className }: any) => (
		<button onClick={onClick} disabled={disabled} className={className} data-testid="refresh-button">
			{children}
		</button>
	),
}))

describe("OpenCodeGo", () => {
	const organizationAllowList: OrganizationAllowList = { allowAll: true, providers: {} }
	const mockSetApiConfigurationField = vi.fn()

	const renderComponent = (apiConfiguration: ProviderSettings) =>
		render(
			<OpenCodeGo
				apiConfiguration={apiConfiguration}
				setApiConfigurationField={mockSetApiConfigurationField}
				organizationAllowList={organizationAllowList}
			/>,
		)

	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("updates the API key via setApiConfigurationField on input", () => {
		renderComponent({ opencodeGoApiKey: "" })

		fireEvent.change(screen.getByTestId("api-key-input"), { target: { value: "secret-key" } })

		expect(mockSetApiConfigurationField).toHaveBeenCalledWith("opencodeGoApiKey", "secret-key")
	})

	it("shows the get-API-key CTA only when no API key is set", () => {
		const { rerender } = renderComponent({ opencodeGoApiKey: "" })
		const link = screen.getByTestId("get-api-key-link")
		expect(link).toBeInTheDocument()
		expect(link).toHaveAttribute("href", "https://opencode.ai/docs/go/")

		rerender(
			<OpenCodeGo
				apiConfiguration={{ opencodeGoApiKey: "already-set" }}
				setApiConfigurationField={mockSetApiConfigurationField}
				organizationAllowList={organizationAllowList}
			/>,
		)
		expect(screen.queryByTestId("get-api-key-link")).not.toBeInTheDocument()
	})

	it("wires the ModelPicker with the Opencode Go defaults", () => {
		renderComponent({ opencodeGoApiKey: "key" })

		const picker = screen.getByTestId("model-picker")
		expect(picker).toHaveAttribute("data-default-model-id", opencodeGoDefaultModelId)
		expect(picker).toHaveAttribute("data-model-id-key", "opencodeGoModelId")
		expect(picker).toHaveAttribute("data-service-name", "Opencode Go")
	})

	describe("refresh models", () => {
		const dispatchMessage = (data: any) =>
			act(() => {
				window.dispatchEvent(new MessageEvent("message", { data }))
			})

		it("renders the refresh button in idle state", () => {
			renderComponent({ opencodeGoApiKey: "key" })

			const button = screen.getByTestId("refresh-button")
			expect(button).not.toBeDisabled()
			expect(button.querySelector(".codicon-refresh")).not.toBeNull()
			expect(screen.getByText("settings:providers.refreshModels.label")).toBeInTheDocument()
		})

		it("sends requestRouterModels with the current api key when clicked", () => {
			renderComponent({ opencodeGoApiKey: "my-key" })

			fireEvent.click(screen.getByTestId("refresh-button"))

			expect(postMessageMock).toHaveBeenCalledWith({
				type: "requestRouterModels",
				values: { provider: "opencode-go", refresh: true, opencodeGoApiKey: "my-key" },
			})
		})

		it("enters loading state and disables the button while refreshing", () => {
			renderComponent({ opencodeGoApiKey: "key" })

			fireEvent.click(screen.getByTestId("refresh-button"))

			const button = screen.getByTestId("refresh-button")
			expect(button).toBeDisabled()
			expect(button.querySelector(".codicon-loading")).not.toBeNull()
			expect(screen.getByText("settings:providers.refreshModels.loading")).toBeInTheDocument()
		})

		it("shows success state when routerModels arrives while loading", () => {
			renderComponent({ opencodeGoApiKey: "key" })

			fireEvent.click(screen.getByTestId("refresh-button"))
			dispatchMessage({ type: "routerModels" })

			expect(screen.getByText("settings:providers.refreshModels.success")).toBeInTheDocument()
		})

		it("shows error state with the received error message on fetch failure", () => {
			renderComponent({ opencodeGoApiKey: "key" })

			fireEvent.click(screen.getByTestId("refresh-button"))
			dispatchMessage({
				type: "singleRouterModelFetchResponse",
				success: false,
				values: { provider: "opencode-go" },
				error: "Invalid API key",
			})

			expect(screen.getByText("Invalid API key")).toBeInTheDocument()
		})

		it("falls back to the default error translation when no error is provided", () => {
			renderComponent({ opencodeGoApiKey: "key" })

			fireEvent.click(screen.getByTestId("refresh-button"))
			dispatchMessage({
				type: "singleRouterModelFetchResponse",
				success: false,
				values: { provider: "opencode-go" },
			})

			expect(screen.getByText("settings:providers.refreshModels.error")).toBeInTheDocument()
		})

		it("ignores fetch failures for other providers", () => {
			renderComponent({ opencodeGoApiKey: "key" })

			fireEvent.click(screen.getByTestId("refresh-button"))
			dispatchMessage({
				type: "singleRouterModelFetchResponse",
				success: false,
				values: { provider: "openrouter" },
				error: "should not show",
			})

			expect(screen.queryByText("should not show")).not.toBeInTheDocument()
			expect(screen.getByText("settings:providers.refreshModels.loading")).toBeInTheDocument()
		})

		it("does not override an error with success when routerModels arrives after a failure", () => {
			renderComponent({ opencodeGoApiKey: "key" })

			fireEvent.click(screen.getByTestId("refresh-button"))

			// Dispatch both within the same act batch so the handler still sees
			// refreshStatus === "loading" and the errorJustReceived guard is exercised.
			act(() => {
				window.dispatchEvent(
					new MessageEvent("message", {
						data: {
							type: "singleRouterModelFetchResponse",
							success: false,
							values: { provider: "opencode-go" },
							error: "boom",
						},
					}),
				)
				window.dispatchEvent(new MessageEvent("message", { data: { type: "routerModels" } }))
			})

			expect(screen.getByText("boom")).toBeInTheDocument()
			expect(screen.queryByText("settings:providers.refreshModels.success")).not.toBeInTheDocument()
		})

		it("ignores routerModels messages when not in loading state", () => {
			renderComponent({ opencodeGoApiKey: "key" })

			// No refresh initiated; an unsolicited routerModels message should be a no-op.
			dispatchMessage({ type: "routerModels" })

			expect(screen.queryByText("settings:providers.refreshModels.success")).not.toBeInTheDocument()
			expect(screen.queryByText("settings:providers.refreshModels.loading")).not.toBeInTheDocument()
		})
	})
})
