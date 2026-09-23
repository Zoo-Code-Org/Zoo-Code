import { act, fireEvent, render, screen } from "@testing-library/react"

import {
	type OrganizationAllowList,
	type ProviderSettings,
	type RouterModels,
	ioIntelligenceDefaultModelId,
	providerIdentifiers,
	RouterModelsMessageType,
} from "@roo-code/types"

import { IOIntelligence } from "../IOIntelligence"

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
			<input type={type} value={value} onInput={onInput} data-testid="ionet-api-key" />
		</div>
	),
}))

vi.mock("@src/components/common/VSCodeButtonLink", () => ({
	VSCodeButtonLink: ({ children, href }: React.ComponentProps<"a">) => (
		<a href={href} data-testid="ionet-get-key">
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

describe("IOIntelligence", () => {
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
		nanogpt: {},
		"io-intelligence": {
			"meta-llama/Llama-3.3-70B-Instruct": { contextWindow: 128000, maxTokens: 8192, supportsPromptCache: false },
		},
		"kimi-code": {},
		ollama: {},
		lmstudio: {},
	}

	const renderComponent = (apiConfiguration: ProviderSettings = {}) =>
		render(
			<IOIntelligence
				apiConfiguration={apiConfiguration}
				setApiConfigurationField={setApiConfigurationField}
				routerModels={routerModels}
				organizationAllowList={organizationAllowList}
			/>,
		)

	beforeEach(() => vi.clearAllMocks())

	afterEach(() => vi.useRealTimers())

	it("renders the secret key input, CTA, and dynamic model picker", () => {
		renderComponent({ ioIntelligenceApiKey: "stored" })

		expect(screen.getByTestId("ionet-api-key")).toHaveAttribute("type", "password")
		expect(screen.getByText("settings:providers.ioIntelligence.apiKey")).toBeInTheDocument()
		expect(screen.queryByTestId("ionet-get-key")).not.toBeInTheDocument()
		expect(screen.getByTestId("model-picker")).toHaveAttribute(
			"data-default-model-id",
			ioIntelligenceDefaultModelId,
		)
		expect(screen.getByTestId("model-picker")).toHaveAttribute("data-model-id-key", "ioIntelligenceModelId")
		expect(screen.getByTestId("model-picker")).toHaveAttribute("data-model-count", "1")
		expect(screen.getByText("settings:providers.apiKeyStorageNotice")).toBeInTheDocument()
	})

	it("shows the get-key CTA only when no key is configured", () => {
		renderComponent({})

		expect(screen.getByTestId("ionet-get-key")).toHaveAttribute("href", "https://ai.io.net/ai/api-keys")
		expect(screen.getByText("settings:providers.ioIntelligence.getApiKey")).toBeInTheDocument()
	})

	it("updates the cached key with exact values", () => {
		renderComponent({ ioIntelligenceApiKey: "" })

		fireEvent.input(screen.getByTestId("ionet-api-key"), { target: { value: "new-secret" } })

		expect(setApiConfigurationField).toHaveBeenCalledWith("ioIntelligenceApiKey", "new-secret")
	})

	it("refreshes models with the unsaved cached key 250ms after it stops changing", () => {
		vi.useFakeTimers()
		const rerenderWithKey = (rerender: ReturnType<typeof render>["rerender"], ioIntelligenceApiKey: string) =>
			rerender(
				<IOIntelligence
					apiConfiguration={{ ioIntelligenceApiKey }}
					setApiConfigurationField={setApiConfigurationField}
					routerModels={{ ...routerModels, "io-intelligence": {} }}
					organizationAllowList={organizationAllowList}
				/>,
			)

		const { rerender } = renderComponent({ ioIntelligenceApiKey: "first-key" })

		act(() => vi.advanceTimersByTime(249))
		expect(postMessageMock).not.toHaveBeenCalled()
		act(() => vi.advanceTimersByTime(1))
		expect(postMessageMock).toHaveBeenCalledTimes(1)
		expect(postMessageMock).toHaveBeenLastCalledWith({
			type: RouterModelsMessageType.requestRouterModels,
			values: { provider: providerIdentifiers.ioIntelligence, ioIntelligenceApiKey: "first-key" },
		})

		// Each edit restarts the timer, so intermediate values never reach the host.
		rerenderWithKey(rerender, "unsaved-")
		act(() => vi.advanceTimersByTime(200))
		rerenderWithKey(rerender, "unsaved-key")
		act(() => vi.advanceTimersByTime(249))
		expect(postMessageMock).toHaveBeenCalledTimes(1)

		act(() => vi.advanceTimersByTime(1))
		expect(postMessageMock).toHaveBeenCalledTimes(2)
		expect(postMessageMock).toHaveBeenLastCalledWith({
			type: RouterModelsMessageType.requestRouterModels,
			values: { provider: providerIdentifiers.ioIntelligence, ioIntelligenceApiKey: "unsaved-key" },
		})
	})

	it("drops a pending model refresh when it unmounts", () => {
		vi.useFakeTimers()
		const { unmount } = renderComponent({ ioIntelligenceApiKey: "first-key" })

		unmount()
		act(() => vi.advanceTimersByTime(250))

		expect(postMessageMock).not.toHaveBeenCalled()
	})
})
