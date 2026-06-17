import { render, screen, fireEvent } from "@testing-library/react"

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
})
