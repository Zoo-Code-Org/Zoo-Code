import { fireEvent, render, screen } from "@testing-library/react"

import {
	type ModelRecord,
	type OrganizationAllowList,
	type ProviderSettings,
	type RouterModels,
	inferDefaultModelId,
	providerIdentifiers,
} from "@roo-code/types"

import { Infer } from "../Infer"

const { postMessageMock } = vi.hoisted(() => ({ postMessageMock: vi.fn() }))

vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: postMessageMock } }))

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeTextField: ({
		children,
		value,
		onInput,
		type,
	}: React.ComponentProps<"input"> & { children: React.ReactNode }) => (
		<div>
			{children}
			<input type={type} value={value} onInput={onInput} data-testid="infer-api-key" />
		</div>
	),
}))

vi.mock("@src/components/common/VSCodeButtonLink", () => ({
	VSCodeButtonLink: ({ children, href }: React.ComponentProps<"a">) => (
		<a href={href} data-testid="infer-get-key">
			{children}
		</a>
	),
}))

vi.mock("../../ModelPicker", () => ({
	ModelPicker: ({
		defaultModelId,
		models,
		modelIdKey,
		serviceName,
		serviceUrl,
	}: {
		defaultModelId: string
		models: object
		modelIdKey: string
		serviceName: string
		serviceUrl: string
	}) => (
		<div
			data-testid="model-picker"
			data-default-model-id={defaultModelId}
			data-model-count={Object.keys(models).length}
			data-model-id-key={modelIdKey}
			data-service-name={serviceName}
			data-service-url={serviceUrl}
		/>
	),
}))

describe("Infer", () => {
	const organizationAllowList: OrganizationAllowList = { allowAll: true, providers: {} }
	const setApiConfigurationField = vi.fn()
	const inferModels: ModelRecord = {
		"infer/test-model:low-cost": { contextWindow: 1_000_000, maxTokens: 128_000, supportsPromptCache: true },
		"infer/test-model:official": { contextWindow: 1_000_000, maxTokens: 128_000, supportsPromptCache: true },
	}
	// The component reads only its own catalog, so the other router entries are left out.
	const routerModels = { [providerIdentifiers.infer]: inferModels } as RouterModels

	const renderComponent = (apiConfiguration: ProviderSettings = {}) =>
		render(
			<Infer
				apiConfiguration={apiConfiguration}
				setApiConfigurationField={setApiConfigurationField}
				routerModels={routerModels}
				organizationAllowList={organizationAllowList}
			/>,
		)

	beforeEach(() => vi.clearAllMocks())

	it("renders the secret key input, the storage notice, and the catalog model picker", () => {
		renderComponent({ inferApiKey: "stored" })

		expect(screen.getByTestId("infer-api-key")).toHaveAttribute("type", "password")
		expect(screen.getByText("settings:providers.infer.apiKey")).toBeInTheDocument()
		expect(screen.getByText("settings:providers.apiKeyStorageNotice")).toBeInTheDocument()
		expect(screen.queryByTestId("infer-get-key")).not.toBeInTheDocument()

		const picker = screen.getByTestId("model-picker")
		expect(picker).toHaveAttribute("data-default-model-id", inferDefaultModelId)
		expect(picker).toHaveAttribute("data-model-id-key", "inferModelId")
		expect(picker).toHaveAttribute("data-model-count", "2")
		expect(picker).toHaveAttribute("data-service-name", "settings:providers.infer.provider")
		expect(picker).toHaveAttribute("data-service-url", "https://infer.flow7.org/models")
	})

	it("shows the get-key link to the API keys page only when no key is configured", () => {
		renderComponent({})

		expect(screen.getByTestId("infer-get-key")).toHaveAttribute("href", "https://infer.flow7.org/app#/keys")
		expect(screen.getByText("settings:providers.infer.getApiKey")).toBeInTheDocument()
	})

	it("updates the cached key with exact values", () => {
		renderComponent({ inferApiKey: "" })

		fireEvent.input(screen.getByTestId("infer-api-key"), { target: { value: "new-secret" } })

		expect(setApiConfigurationField).toHaveBeenCalledWith("inferApiKey", "new-secret")
	})

	it("does not request a new model list when the key changes", () => {
		// The public catalog is the same for every key, so a key edit has nothing to refresh.
		const { rerender } = renderComponent({ inferApiKey: "first-key" })

		rerender(
			<Infer
				apiConfiguration={{ inferApiKey: "second-key" }}
				setApiConfigurationField={setApiConfigurationField}
				routerModels={routerModels}
				organizationAllowList={organizationAllowList}
			/>,
		)

		expect(postMessageMock).not.toHaveBeenCalled()
	})
})
