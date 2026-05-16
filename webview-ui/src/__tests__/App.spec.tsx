// npx vitest run src/__tests__/App.spec.tsx

import React from "react"
import { render, screen, act, cleanup } from "@/utils/test-utils"

import AppWithProviders from "../App"

vi.mock("@src/utils/vscode", () => ({
	vscode: {
		postMessage: vi.fn(),
	},
}))

// Mock the ErrorBoundary component
vi.mock("@src/components/ErrorBoundary", () => ({
	__esModule: true,
	default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

// Mock the telemetry client
vi.mock("@src/utils/TelemetryClient", () => ({
	telemetryClient: {
		capture: vi.fn(),
		updateTelemetryState: vi.fn(),
	},
}))

vi.mock("@src/components/chat/ChatView", () => ({
	__esModule: true,
	default: function ChatView({ isHidden }: { isHidden: boolean }) {
		return (
			<div data-testid="chat-view" data-hidden={isHidden}>
				Chat View
			</div>
		)
	},
}))

vi.mock("@src/components/settings/SettingsView", () => ({
	__esModule: true,
	default: function SettingsView({ onDone }: { onDone: () => void }) {
		return (
			<div data-testid="settings-view" onClick={onDone}>
				Settings View
			</div>
		)
	},
}))

vi.mock("@src/components/welcome/WelcomeViewProvider", () => ({
	__esModule: true,
	default: function WelcomeView() {
		return <div data-testid="welcome-view">Welcome View</div>
	},
}))

vi.mock("@src/components/history/HistoryView", () => ({
	__esModule: true,
	default: function HistoryView({ onDone }: { onDone: () => void }) {
		return (
			<div data-testid="history-view" onClick={onDone}>
				History View
			</div>
		)
	},
}))

vi.mock("@src/components/mcp/McpView", () => ({
	__esModule: true,
	default: function McpView() {
		return <div data-testid="mcp-view">MCP View</div>
	},
}))

vi.mock("@src/components/modes/ModesView", () => ({
	__esModule: true,
	default: function ModesView() {
		return <div data-testid="prompts-view">Modes View</div>
	},
}))

vi.mock("@src/components/marketplace/MarketplaceView", () => ({
	MarketplaceView: function MarketplaceView({ onDone }: { onDone: () => void }) {
		return (
			<div data-testid="marketplace-view" onClick={onDone}>
				Marketplace View
			</div>
		)
	},
}))

const mockUseExtensionState = vi.fn()

// Mock i18next and react-i18next
vi.mock("i18next", () => {
	const tFunction = (key: string) => key
	const i18n = {
		t: tFunction,
		use: () => i18n,
		init: () => Promise.resolve(tFunction),
		changeLanguage: vi.fn(() => Promise.resolve()),
	}
	return { default: i18n }
})

vi.mock("react-i18next", () => {
	const tFunction = (key: string) => key
	return {
		withTranslation: () => (Component: any) => {
			const MockedComponent = (props: any) => {
				return <Component t={tFunction} i18n={{ t: tFunction }} tReady {...props} />
			}
			MockedComponent.displayName = `withTranslation(${Component.displayName || Component.name || "Component"})`
			return MockedComponent
		},
		Trans: ({ children }: { children: React.ReactNode }) => <>{children}</>,
		useTranslation: () => {
			return {
				t: tFunction,
				i18n: {
					t: tFunction,
					changeLanguage: vi.fn(() => Promise.resolve()),
				},
			}
		},
		initReactI18next: {
			type: "3rdParty",
			init: vi.fn(),
		},
	}
})

// Mock TranslationProvider to pass through children
vi.mock("@src/i18n/TranslationContext", () => {
	const tFunction = (key: string) => key
	return {
		__esModule: true,
		default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
		useAppTranslation: () => ({
			t: tFunction,
			i18n: {
				t: tFunction,
				changeLanguage: vi.fn(() => Promise.resolve()),
			},
		}),
	}
})

vi.mock("@src/context/ExtensionStateContext", () => ({
	useExtensionState: () => mockUseExtensionState(),
	ExtensionStateContextProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

// Mock environment variables
vi.mock("process.env", () => ({
	NODE_ENV: "test",
	PKG_VERSION: "1.0.0-test",
}))

describe("App", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		window.removeEventListener("message", () => {})

		// Set up default mock return value
		mockUseExtensionState.mockReturnValue({
			didHydrateState: true,
			showWelcome: false,
			shouldShowAnnouncement: false,
			experiments: {},
			language: "en",
			telemetrySetting: "enabled",
		})
	})

	afterEach(() => {
		cleanup()
		window.removeEventListener("message", () => {})
	})

	const triggerMessage = (action: string) => {
		const messageEvent = new MessageEvent("message", {
			data: {
				type: "action",
				action,
			},
		})
		window.dispatchEvent(messageEvent)
	}

	const createSetupIncompleteState = () => ({
		didHydrateState: true,
		showWelcome: true,
		shouldShowAnnouncement: false,
		experiments: {},
		language: "en",
		telemetrySetting: "enabled",
	})

	it("shows chat view by default", () => {
		render(<AppWithProviders />)

		const chatView = screen.getByTestId("chat-view")
		expect(chatView).toBeInTheDocument()
		expect(chatView.getAttribute("data-hidden")).toBe("false")
	}, 10000)

	it("shows welcome view when setup is incomplete", () => {
		mockUseExtensionState.mockReturnValue({
			didHydrateState: true,
			showWelcome: true,
			shouldShowAnnouncement: false,
			experiments: {},
			language: "en",
			telemetrySetting: "enabled",
		})

		render(<AppWithProviders />)

		expect(screen.getByTestId("welcome-view")).toBeInTheDocument()
		expect(screen.queryByTestId("settings-view")).not.toBeInTheDocument()
	})

	it("switches to settings view when receiving settingsButtonClicked action", async () => {
		render(<AppWithProviders />)

		act(() => {
			triggerMessage("settingsButtonClicked")
		})

		const settingsView = await screen.findByTestId("settings-view")
		expect(settingsView).toBeInTheDocument()

		const chatView = screen.getByTestId("chat-view")
		expect(chatView.getAttribute("data-hidden")).toBe("true")
	})

	it.each([
		["settings", "settings-view"],
		["marketplace", "marketplace-view"],
	])("still switches to %s while welcome gating is active", async (action, testId) => {
		mockUseExtensionState.mockReturnValue({
			didHydrateState: true,
			showWelcome: true,
			shouldShowAnnouncement: false,
			experiments: {},
			language: "en",
			telemetrySetting: "enabled",
		})

		render(<AppWithProviders />)

		act(() => {
			triggerMessage(`${action}ButtonClicked`)
		})

		expect(await screen.findByTestId(testId)).toBeInTheDocument()
		expect(screen.queryByTestId("welcome-view")).not.toBeInTheDocument()
	})

	it("keeps history behind the welcome gate while setup is incomplete", () => {
		mockUseExtensionState.mockReturnValue({
			didHydrateState: true,
			showWelcome: true,
			shouldShowAnnouncement: false,
			experiments: {},
			language: "en",
			telemetrySetting: "enabled",
		})

		render(<AppWithProviders />)

		act(() => {
			triggerMessage("historyButtonClicked")
		})

		expect(screen.getByTestId("welcome-view")).toBeInTheDocument()
		expect(screen.queryByTestId("history-view")).not.toBeInTheDocument()
	})

	it.each([
		{ label: "chat", action: undefined },
		{ label: "history", action: "historyButtonClicked" },
	])("redirects to providers settings when an import fires from the $label tab", async ({ action }) => {
		const state = {
			...createSetupIncompleteState(),
			settingsImportedAt: undefined as number | undefined,
		}

		mockUseExtensionState.mockImplementation(() => state)

		const { rerender } = render(<AppWithProviders />)

		if (action) {
			act(() => {
				triggerMessage(action)
			})
		}

		if (action === "historyButtonClicked") {
			expect(screen.getByTestId("welcome-view")).toBeInTheDocument()
		}

		state.settingsImportedAt = Date.now()
		rerender(<AppWithProviders />)

		expect(await screen.findByTestId("settings-view")).toBeInTheDocument()
		expect(screen.queryByTestId("welcome-view")).not.toBeInTheDocument()
	})

	it.each([
		{
			label: "settings before returning to chat",
			action: "settingsButtonClicked",
			viewId: "settings-view",
			nextAction: undefined,
		},
		{
			label: "settings before switching to history",
			action: "settingsButtonClicked",
			viewId: "settings-view",
			nextAction: "historyButtonClicked",
		},
		{
			label: "marketplace before returning to chat",
			action: "marketplaceButtonClicked",
			viewId: "marketplace-view",
			nextAction: undefined,
		},
		{
			label: "marketplace before switching to history",
			action: "marketplaceButtonClicked",
			viewId: "marketplace-view",
			nextAction: "historyButtonClicked",
		},
	])(
		"consumes imported settings without a later redirect when already on $label",
		async ({ action, viewId, nextAction }) => {
			const state = {
				...createSetupIncompleteState(),
				settingsImportedAt: undefined as number | undefined,
			}

			mockUseExtensionState.mockImplementation(() => state)

			const { rerender } = render(<AppWithProviders />)

			act(() => {
				triggerMessage(action)
			})

			expect(await screen.findByTestId(viewId)).toBeInTheDocument()
			expect(screen.queryByTestId("welcome-view")).not.toBeInTheDocument()

			state.settingsImportedAt = Date.now()
			rerender(<AppWithProviders />)

			const currentView = await screen.findByTestId(viewId)
			expect(currentView).toBeInTheDocument()

			if (nextAction) {
				act(() => {
					triggerMessage(nextAction)
				})
			} else {
				act(() => {
					currentView.click()
				})
			}

			expect(screen.getByTestId("welcome-view")).toBeInTheDocument()
			expect(screen.queryByTestId("settings-view")).not.toBeInTheDocument()
			expect(screen.queryByTestId("marketplace-view")).not.toBeInTheDocument()
		},
	)

	it("does not bounce back to settings after the import redirect has already fired", async () => {
		const importedAt = Date.now()

		mockUseExtensionState.mockReturnValue({
			...createSetupIncompleteState(),
			settingsImportedAt: importedAt,
		})

		render(<AppWithProviders />)

		const settingsView = await screen.findByTestId("settings-view")
		expect(settingsView).toBeInTheDocument()

		act(() => {
			settingsView.click()
		})

		expect(screen.getByTestId("welcome-view")).toBeInTheDocument()
		expect(screen.queryByTestId("settings-view")).not.toBeInTheDocument()
	})

	it("switches to history view when receiving historyButtonClicked action", async () => {
		render(<AppWithProviders />)

		act(() => {
			triggerMessage("historyButtonClicked")
		})

		const historyView = await screen.findByTestId("history-view")
		expect(historyView).toBeInTheDocument()

		const chatView = screen.getByTestId("chat-view")
		expect(chatView.getAttribute("data-hidden")).toBe("true")
	})

	it("returns to chat view when clicking done in settings view", async () => {
		render(<AppWithProviders />)

		act(() => {
			triggerMessage("settingsButtonClicked")
		})

		const settingsView = await screen.findByTestId("settings-view")

		act(() => {
			settingsView.click()
		})

		const chatView = screen.getByTestId("chat-view")
		expect(chatView.getAttribute("data-hidden")).toBe("false")
		expect(screen.queryByTestId("settings-view")).not.toBeInTheDocument()
	})

	it.each(["history"])("returns to chat view when clicking done in %s view", async (view) => {
		render(<AppWithProviders />)

		act(() => {
			triggerMessage(`${view}ButtonClicked`)
		})

		const viewElement = await screen.findByTestId(`${view}-view`)

		act(() => {
			viewElement.click()
		})

		const chatView = screen.getByTestId("chat-view")
		expect(chatView.getAttribute("data-hidden")).toBe("false")
		expect(screen.queryByTestId(`${view}-view`)).not.toBeInTheDocument()
	})

	it("switches to marketplace view when receiving marketplaceButtonClicked action", async () => {
		render(<AppWithProviders />)

		act(() => {
			triggerMessage("marketplaceButtonClicked")
		})

		const marketplaceView = await screen.findByTestId("marketplace-view")
		expect(marketplaceView).toBeInTheDocument()

		const chatView = screen.getByTestId("chat-view")
		expect(chatView.getAttribute("data-hidden")).toBe("true")
	})

	it("returns to chat view when clicking done in marketplace view", async () => {
		render(<AppWithProviders />)

		act(() => {
			triggerMessage("marketplaceButtonClicked")
		})

		const marketplaceView = await screen.findByTestId("marketplace-view")

		act(() => {
			marketplaceView.click()
		})

		const chatView = screen.getByTestId("chat-view")
		expect(chatView.getAttribute("data-hidden")).toBe("false")
		expect(screen.queryByTestId("marketplace-view")).not.toBeInTheDocument()
	})
})
