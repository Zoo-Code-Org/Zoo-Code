// npx vitest src/components/welcome/__tests__/WelcomeViewProvider.spec.tsx

import React from "react"
import { render, screen, fireEvent } from "@/utils/test-utils"

import * as ExtensionStateContext from "@src/context/ExtensionStateContext"
const { ExtensionStateContextProvider } = ExtensionStateContext

import WelcomeViewProvider from "../WelcomeViewProvider"

// Mock VSCode components
vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeLink: ({ children, onClick }: any) => (
		<button onClick={onClick} data-testid="vscode-link">
			{children}
		</button>
	),
}))

// Mock Button component
vi.mock("@src/components/ui", () => ({
	Button: ({ children, onClick, variant }: any) => (
		<button onClick={onClick} data-testid={`button-${variant}`}>
			{children}
		</button>
	),
}))

// Mock ApiOptions
vi.mock("../../settings/ApiOptions", () => ({
	default: () => <div data-testid="api-options">API Options Component</div>,
}))

// Mock Tab components
vi.mock("../../common/Tab", () => ({
	Tab: ({ children }: any) => <div data-testid="tab">{children}</div>,
	TabContent: ({ children, className }: any) => (
		<div data-testid="tab-content" className={className}>
			{children}
		</div>
	),
}))

// Mock RooHero
vi.mock("../RooHero", () => ({
	default: () => <div data-testid="roo-hero">Roo Hero</div>,
}))

// Mock lucide-react icons
vi.mock("lucide-react", () => ({
	ArrowLeft: () => <span data-testid="arrow-left-icon">←</span>,
	ArrowRight: () => <span data-testid="arrow-right-icon">→</span>,
	BadgeInfo: () => <span data-testid="badge-info-icon">ℹ</span>,
	Brain: () => <span data-testid="brain-icon">🧠</span>,
	TriangleAlert: () => <span data-testid="triangle-alert-icon">⚠</span>,
}))

// Mock vscode utility
vi.mock("@src/utils/vscode", () => ({
	vscode: {
		postMessage: vi.fn(),
	},
}))

// Mock react-i18next
vi.mock("react-i18next", () => ({
	Trans: ({ i18nKey, children }: any) => <span data-testid={`trans-${i18nKey}`}>{children || i18nKey}</span>,
	initReactI18next: {
		type: "3rdParty",
		init: () => {},
	},
}))

// Mock the translation hook
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
	useExtensionStateMock.mockReturnValue({
		apiConfiguration: {},
		currentApiConfigName: "default",
		setApiConfiguration: vi.fn(),
		uriScheme: "vscode",
		cloudIsAuthenticated: false,
		...extensionState,
	} as any)

	render(
		<ExtensionStateContextProvider>
			<WelcomeViewProvider />
		</ExtensionStateContextProvider>,
	)

	return useExtensionStateMock
}

describe("WelcomeViewProvider", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	describe("Landing Screen", () => {
		it("renders landing screen by default", () => {
			renderWelcomeViewProvider()

			// Should show the landing greeting
			expect(screen.getByText(/welcome:landing.greeting/)).toBeInTheDocument()

			// Should show introduction
			expect(screen.getByTestId("trans-welcome:landing.introduction")).toBeInTheDocument()

			// Router account marketing copy should be removed
			expect(screen.queryByTestId("trans-welcome:landing.accountMention")).not.toBeInTheDocument()

			// Should show "Get Started" button
			expect(screen.getByTestId("button-primary")).toBeInTheDocument()

			expect(screen.queryByText(/welcome:landing.noAccount/)).not.toBeInTheDocument()
		})

		it("moves to provider selection when 'Get Started' is clicked on landing", () => {
			renderWelcomeViewProvider()

			const getStartedButton = screen.getByTestId("button-primary")
			fireEvent.click(getStartedButton)

			expect(screen.getByTestId("api-options")).toBeInTheDocument()
			expect(screen.getByTestId("trans-welcome:providerSignup.chooseProvider")).toBeInTheDocument()
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

		it("does not render the retired Roo onboarding option", () => {
			renderWelcomeViewProvider()
			fireEvent.click(screen.getByTestId("button-primary"))

			expect(screen.queryByTestId("radio-roo")).not.toBeInTheDocument()
			expect(screen.queryByText(/welcome:providerSignup.rooCloudProvider/)).not.toBeInTheDocument()
		})
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
})
