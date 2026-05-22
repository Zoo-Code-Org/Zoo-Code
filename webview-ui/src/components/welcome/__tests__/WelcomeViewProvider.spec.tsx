// npx vitest src/components/welcome/__tests__/WelcomeViewProvider.spec.tsx

import React from "react"
import { render, screen, fireEvent } from "@/utils/test-utils"
import { openRouterDefaultModelId } from "@roo-code/types"

import * as ExtensionStateContext from "@src/context/ExtensionStateContext"
const { ExtensionStateContextProvider } = ExtensionStateContext

import WelcomeViewProvider from "../WelcomeViewProvider"
import { vscode } from "@src/utils/vscode"

// Mock VSCode components
vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeLink: ({ children, onClick }: any) => (
		<button onClick={onClick} data-testid="vscode-link">
			{children}
		</button>
	),
}))

vi.mock("@src/components/ui", () => ({
	Button: ({ children, onClick, variant }: any) => (
		<button onClick={onClick} data-testid={`button-${variant}`}>
			{children}
		</button>
	),
}))

vi.mock("../../settings/ApiOptions", () => ({
	default: ({ apiConfiguration }: any) => (
		<div
			data-testid="api-options"
			data-provider={apiConfiguration.apiProvider}
			data-model={apiConfiguration.openRouterModelId}>
			API Options Component
		</div>
	),
}))

vi.mock("../../common/Tab", () => ({
	Tab: ({ children }: any) => <div data-testid="tab">{children}</div>,
	TabContent: ({ children, className }: any) => (
		<div data-testid="tab-content" className={className}>
			{children}
		</div>
	),
}))

vi.mock("../RooHero", () => ({
	default: () => <div data-testid="roo-hero">Roo Hero</div>,
}))

vi.mock("lucide-react", () => ({
	ArrowLeft: () => <span data-testid="arrow-left-icon">left</span>,
	Brain: () => <span data-testid="brain-icon">brain</span>,
}))

vi.mock("@src/utils/vscode", () => ({
	vscode: {
		postMessage: vi.fn(),
	},
}))

vi.mock("react-i18next", () => ({
	Trans: ({ i18nKey, children }: any) => <span data-testid={`trans-${i18nKey}`}>{children || i18nKey}</span>,
	initReactI18next: {
		type: "3rdParty",
		init: () => {},
	},
}))

vi.mock("i18next", () => ({
	default: {
		t: (key: string) => key,
	},
}))

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string) => key,
	}),
}))

// Mock buildDocLink
vi.mock("@/utils/docLinks", () => ({
	buildDocLink: (path: string, source: string) => `https://docs.zoocode.dev/${path}?utm_source=${source}`,
}))

const renderWelcomeViewProvider = (extensionState = {}) => {
	const useExtensionStateMock = vi.spyOn(ExtensionStateContext, "useExtensionState")
	const setApiConfiguration = vi.fn()
	useExtensionStateMock.mockReturnValue({
		apiConfiguration: {},
		currentApiConfigName: "default",
		setApiConfiguration,
		uriScheme: "vscode",
		...extensionState,
	} as any)

	render(
		<ExtensionStateContextProvider>
			<WelcomeViewProvider />
		</ExtensionStateContextProvider>,
	)

	return { useExtensionStateMock, setApiConfiguration }
}

describe("WelcomeViewProvider", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("renders the landing screen by default", () => {
		renderWelcomeViewProvider()

		expect(screen.getByText(/welcome:landing.greeting/)).toBeInTheDocument()
		expect(screen.getByTestId("trans-welcome:landing.introduction")).toBeInTheDocument()
		expect(screen.getByTestId("button-primary")).toBeInTheDocument()
		expect(screen.getByText(/welcome:importSettings/)).toBeInTheDocument()
	})

	it("opens provider setup when Get Started is clicked", () => {
		const { setApiConfiguration } = renderWelcomeViewProvider()

		fireEvent.click(screen.getByTestId("button-primary"))

		// Router account marketing copy should be removed
		expect(screen.queryByTestId("trans-welcome:landing.accountMention")).not.toBeInTheDocument()
		expect(screen.queryByText(/welcome:landing.noAccount/)).not.toBeInTheDocument()

		expect(screen.getByTestId("api-options")).toBeInTheDocument()
		expect(screen.getByTestId("api-options")).toHaveAttribute("data-provider", "openrouter")
		expect(screen.getByTestId("api-options")).toHaveAttribute("data-model", openRouterDefaultModelId)
		expect(setApiConfiguration).toHaveBeenCalledWith({
			apiProvider: "openrouter",
			openRouterModelId: openRouterDefaultModelId,
		})
		expect(screen.getByTestId("trans-welcome:providerSignup.chooseProvider")).toBeInTheDocument()
		expect(vscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "upsertApiConfiguration" }))
	})

	it("moves to provider selection when 'Get Started' is clicked on landing", () => {
		renderWelcomeViewProvider()

		const getStartedButton = screen.getByTestId("button-primary")
		fireEvent.click(getStartedButton)

		expect(screen.getByTestId("api-options")).toBeInTheDocument()
		expect(screen.getByTestId("trans-welcome:providerSignup.chooseProvider")).toBeInTheDocument()
	})

	it("treats the built-in Anthropic default as empty onboarding config", () => {
		const { setApiConfiguration } = renderWelcomeViewProvider({
			apiConfiguration: {
				apiProvider: "anthropic",
				apiModelId: "claude-sonnet-4-5",
			},
		})

		fireEvent.click(screen.getByTestId("button-primary"))

		expect(screen.getByTestId("api-options")).toHaveAttribute("data-provider", "openrouter")
		expect(screen.getByTestId("api-options")).toHaveAttribute("data-model", openRouterDefaultModelId)
		expect(setApiConfiguration).toHaveBeenCalledWith({
			apiProvider: "openrouter",
			openRouterModelId: openRouterDefaultModelId,
		})
	})

	it("keeps the landing screen centered", () => {
		renderWelcomeViewProvider()

		expect(screen.getByTestId("tab-content")).toHaveClass("justify-center")
	})

	it("does not enter auth-in-progress state after clicking 'Get Started' on landing", () => {
		renderWelcomeViewProvider()

		const getStartedButton = screen.getByTestId("button-primary")
		fireEvent.click(getStartedButton)

		expect(screen.queryByTestId("progress-ring")).not.toBeInTheDocument()
		expect(screen.getByTestId("api-options")).toBeInTheDocument()
	})

	describe("Provider Selection Screen", () => {
		const navigateToProviderSelection = () => {
			fireEvent.click(screen.getByTestId("button-primary"))
		}

		it("shows provider configuration without Router selection controls", () => {
			renderWelcomeViewProvider()
			navigateToProviderSelection()

			expect(screen.getByTestId("api-options")).toBeInTheDocument()
			expect(screen.queryByTestId("radio-group")).not.toBeInTheDocument()
		})

		it("shows provider setup copy", () => {
			renderWelcomeViewProvider()
			navigateToProviderSelection()

			expect(screen.getByTestId("trans-welcome:providerSignup.chooseProvider")).toBeInTheDocument()
		})

		it("top-aligns provider setup content so tall forms remain reachable", () => {
			renderWelcomeViewProvider()
			navigateToProviderSelection()

			expect(screen.getByTestId("tab-content")).not.toHaveClass("justify-center")
		})

		it("shows API options immediately", () => {
			renderWelcomeViewProvider()
			navigateToProviderSelection()

			const apiOptions = screen.queryByTestId("api-options")
			expect(apiOptions).toBeInTheDocument()
		})

		it("returns to landing when Back is clicked", () => {
			renderWelcomeViewProvider()
			navigateToProviderSelection()

			fireEvent.click(screen.getByTestId("button-secondary"))

			expect(screen.getByText(/welcome:landing.greeting/)).toBeInTheDocument()
			expect(screen.queryByTestId("api-options")).not.toBeInTheDocument()
		})
	})

	it("saves the configured provider from setup", () => {
		const apiConfiguration = {
			apiProvider: "openrouter" as const,
			openRouterApiKey: "test-key",
			openRouterModelId: openRouterDefaultModelId,
		}
		renderWelcomeViewProvider({ apiConfiguration })

		fireEvent.click(screen.getByTestId("button-primary"))
		fireEvent.click(screen.getByText(/welcome:providerSignup.finish/))

		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "upsertApiConfiguration",
			text: "default",
			apiConfiguration,
		})
	})

	it("returns to landing from provider setup", () => {
		renderWelcomeViewProvider()

		fireEvent.click(screen.getByTestId("button-primary"))
		fireEvent.click(screen.getByTestId("button-secondary"))

		expect(screen.getByText(/welcome:landing.greeting/)).toBeInTheDocument()
		expect(screen.queryByTestId("api-options")).not.toBeInTheDocument()
	})

	it("imports settings from the landing screen", () => {
		renderWelcomeViewProvider()

		fireEvent.click(screen.getByText(/welcome:importSettings/))

		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "importSettings" })
	})
})
