import { fireEvent, render, screen } from "@testing-library/react"

import {
	type OrganizationAllowList,
	type ProviderSettings,
	type RouterModels,
	nanoGptDefaultModelId,
	nanoGptRoutingPreferences,
	providerIdentifiers,
	RouterModelsMessageType,
} from "@roo-code/types"

import { NanoGPT } from "../NanoGPT"

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
			<input type={type} value={value} onInput={onInput} data-testid="nanogpt-api-key" />
		</div>
	),
	VSCodeLink: ({ children, href }: React.ComponentProps<"a">) => <a href={href}>{children}</a>,
}))

vi.mock("@src/components/common/VSCodeButtonLink", () => ({
	VSCodeButtonLink: ({ children, href }: React.ComponentProps<"a">) => (
		<a href={href} data-testid="nanogpt-get-key">
			{children}
		</a>
	),
}))

vi.mock("@src/components/ui", () => ({
	Select: ({
		children,
		value,
		onValueChange,
	}: {
		children: React.ReactNode
		value: string
		onValueChange: (value: string) => void
	}) => (
		<select data-testid="routing-select" value={value} onChange={(event) => onValueChange(event.target.value)}>
			{children}
		</select>
	),
	SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
	SelectItem: ({ children, value }: { children: React.ReactNode; value: string }) => (
		<option value={value}>{children}</option>
	),
	SelectTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
	SelectValue: () => null,
}))

vi.mock("../../ModelPicker", () => ({
	ModelPicker: ({
		defaultModelId,
		models,
		modelIdKey,
		serviceName,
	}: {
		defaultModelId: string
		models: object
		modelIdKey: string
		serviceName: string
	}) => (
		<div
			data-testid="model-picker"
			data-default-model-id={defaultModelId}
			data-model-count={Object.keys(models).length}
			data-model-id-key={modelIdKey}
			data-service-name={serviceName}
		/>
	),
}))

describe("NanoGPT", () => {
	const organizationAllowList: OrganizationAllowList = { allowAll: true, providers: {} }
	const setApiConfigurationField = vi.fn()
	const routerModels: RouterModels = {
		openrouter: {},
		"vercel-ai-gateway": {},
		"zoo-gateway": {},
		litellm: {},
		requesty: {},
		unbound: {},
		poe: {},
		deepseek: {},
		moonshot: {},
		"opencode-go": {},
		kenari: {},
		nanogpt: { "openai/test": { contextWindow: 1, maxTokens: 1, supportsPromptCache: false } },
		"kimi-code": {},
		ollama: {},
		lmstudio: {},
		friendli: {},
	}

	const renderComponent = (apiConfiguration: ProviderSettings = {}) =>
		render(
			<NanoGPT
				apiConfiguration={apiConfiguration}
				setApiConfigurationField={setApiConfigurationField}
				routerModels={routerModels}
				organizationAllowList={organizationAllowList}
			/>,
		)

	beforeEach(() => vi.clearAllMocks())

	it("renders the secret key input, CTA, dynamic model picker, routing copy, and links", () => {
		renderComponent({ nanoGptRoutingPreference: "fast" })

		expect(screen.getByTestId("nanogpt-api-key")).toHaveAttribute("type", "password")
		expect(screen.getByText("settings:providers.nanoGpt.apiKey")).toBeInTheDocument()
		expect(screen.getByTestId("nanogpt-get-key")).toHaveAttribute("href", "https://nano-gpt.com/api")
		expect(screen.getByText("settings:providers.nanoGpt.getApiKey")).toBeInTheDocument()
		expect(screen.getByTestId("model-picker")).toHaveAttribute("data-default-model-id", nanoGptDefaultModelId)
		expect(screen.getByTestId("model-picker")).toHaveAttribute("data-model-id-key", "nanoGptModelId")
		expect(screen.getByTestId("model-picker")).toHaveAttribute("data-model-count", "1")
		expect(screen.getByText("settings:providers.nanoGpt.automaticExplanation")).toBeInTheDocument()
		expect(screen.getByText("settings:providers.nanoGpt.billingWarning")).toBeInTheDocument()
		expect(screen.getByText("settings:providers.nanoGpt.routingDocs")).toHaveAttribute(
			"href",
			"https://docs.nano-gpt.com/api-reference/miscellaneous/provider-selection",
		)
	})

	it("defaults routing to automatic and renders every routing option", () => {
		renderComponent()

		expect(screen.getByTestId("routing-select")).toHaveValue("auto")
		expect(screen.getAllByRole("option").map((option) => option.getAttribute("value"))).toEqual([
			...nanoGptRoutingPreferences,
		])
		expect(screen.queryByText("settings:providers.nanoGpt.billingWarning")).not.toBeInTheDocument()
		expect(screen.queryByText("settings:providers.nanoGpt.routingDocs")).not.toBeInTheDocument()
	})

	it("updates the cached key and routing preference with exact values", () => {
		renderComponent({ nanoGptApiKey: "", nanoGptRoutingPreference: "fast" })

		fireEvent.input(screen.getByTestId("nanogpt-api-key"), { target: { value: "new-secret" } })
		fireEvent.change(screen.getByTestId("routing-select"), { target: { value: "tools" } })

		expect(setApiConfigurationField).toHaveBeenCalledWith("nanoGptApiKey", "new-secret")
		expect(setApiConfigurationField).toHaveBeenCalledWith("nanoGptRoutingPreference", "tools")
	})

	it("refreshes models with the unsaved cached key whenever it changes", () => {
		const { rerender } = renderComponent({ nanoGptApiKey: "first-key" })
		expect(postMessageMock).toHaveBeenLastCalledWith({
			type: RouterModelsMessageType.requestRouterModels,
			values: { provider: providerIdentifiers.nanogpt, nanoGptApiKey: "first-key" },
		})

		rerender(
			<NanoGPT
				apiConfiguration={{ nanoGptApiKey: "unsaved-key" }}
				setApiConfigurationField={setApiConfigurationField}
				routerModels={{ ...routerModels, nanogpt: {} }}
				organizationAllowList={organizationAllowList}
			/>,
		)

		expect(postMessageMock).toHaveBeenLastCalledWith({
			type: RouterModelsMessageType.requestRouterModels,
			values: { provider: providerIdentifiers.nanogpt, nanoGptApiKey: "unsaved-key" },
		})
	})
})
