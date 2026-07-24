// npx vitest src/components/settings/providers/__tests__/Moonshot.spec.tsx

import React from "react"
import { render, screen, fireEvent, waitFor, act } from "@/utils/test-utils"
import type { ProviderSettings } from "@roo-code/types"

import { Moonshot } from "../Moonshot"

// Mock the translation hook
vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string) => key,
	}),
}))

// Mock VSCode webview toolkit components using importOriginal
vi.mock("@vscode/webview-ui-toolkit/react", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@vscode/webview-ui-toolkit/react")>()
	return {
		...actual,
		VSCodeTextField: ({ children, value, onInput, type, placeholder }: any) => (
			<div data-testid="vscode-text-field">
				{children}
				<input
					type={type}
					value={value}
					onInput={(e) => onInput?.(e)}
					placeholder={placeholder}
					data-testid="moonshot-api-key-input"
				/>
			</div>
		),
		VSCodeDropdown: ({ children, value, onChange }: any) => (
			<div data-testid="vscode-dropdown" data-value={value}>
				{children}
				<button data-testid="dropdown-trigger" onClick={() => onChange?.({ target: { value: "changed" } })}>
					Change
				</button>
			</div>
		),
		VSCodeOption: ({ children, value }: any) => (
			<div data-testid={`option-${value}`} data-value={value}>
				{children}
			</div>
		),
	}
})

// Mock the ModelPicker - must be a simple component that doesn't import anything
vi.mock("../ModelPicker", () => ({
	ModelPicker: function MockModelPicker() {
		return React.createElement(
			"div",
			{ "data-testid": "model-picker" },
			React.createElement("span", { "data-testid": "model-picker-default" }, "mock-default"),
			React.createElement("span", { "data-testid": "model-picker-count" }, "0"),
		)
	},
}))

// Mock vscode - factory must not reference outer scope variables
vi.mock("@src/utils/vscode", () => {
	const mockPostMessage = vi.fn()
	return {
		vscode: { postMessage: mockPostMessage },
	}
})

// Mock useExtensionState
vi.mock("@src/context/ExtensionStateContext", () => ({
	useExtensionState: vi.fn(),
}))

// Mock react-use
vi.mock("react-use", () => ({
	useEvent: vi.fn(),
}))

// Mock useRouterModels
vi.mock("@src/components/ui/hooks/useRouterModels", () => ({
	useRouterModels: () => ({ data: {}, isLoading: false, error: null }),
}))

// Mock @src/components/ui using importOriginal to get all real exports
vi.mock("@src/components/ui", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@src/components/ui")>()
	return {
		...actual,
		Button: ({ children, onClick, disabled, variant }: any) => (
			<button data-testid="button" disabled={disabled} onClick={onClick} data-variant={variant}>
				{children}
			</button>
		),
	}
})

// Mock VSCodeButtonLink
vi.mock("@src/components/common/VSCodeButtonLink", () => ({
	VSCodeButtonLink: ({ href, children }: any) => (
		<a data-testid="vscode-button-link" href={href}>
			{children}
		</a>
	),
}))

// Mock handleModelChangeSideEffects
vi.mock("../utils/providerModelConfig", () => ({
	handleModelChangeSideEffects: vi.fn(),
}))

import { useExtensionState } from "@src/context/ExtensionStateContext"
import { vscode } from "@src/utils/vscode"

const mockUseExtensionState = useExtensionState as ReturnType<typeof vi.fn>

describe("Moonshot Component", () => {
	const mockSetApiConfigurationField = vi.fn()

	const createDefaultApiConfiguration = (overrides?: Partial<ProviderSettings>): ProviderSettings => ({
		apiProvider: "moonshot",
		moonshotBaseUrl: "https://api.moonshot.ai/v1",
		...overrides,
	})

	beforeEach(() => {
		vi.clearAllMocks()
		mockUseExtensionState.mockReturnValue({
			routerModels: {},
		})
	})

	it("renders API key input, base URL dropdown, and refresh button", () => {
		render(
			<Moonshot
				apiConfiguration={createDefaultApiConfiguration()}
				setApiConfigurationField={mockSetApiConfigurationField}
			/>,
		)

		expect(screen.getByTestId("moonshot-api-key-input")).toBeInTheDocument()
		expect(screen.getByTestId("vscode-dropdown")).toBeInTheDocument()
		// Use getAllByTestId and filter by variant to find the refresh button
		const buttons = screen.getAllByTestId("button")
		const refreshButton = buttons.find((b) => b.getAttribute("data-variant") === "outline")
		expect(refreshButton).toBeInTheDocument()
	})

	it("refresh button is disabled when no API key is provided", () => {
		render(
			<Moonshot
				apiConfiguration={createDefaultApiConfiguration({ moonshotApiKey: undefined })}
				setApiConfigurationField={mockSetApiConfigurationField}
			/>,
		)

		const buttons = screen.getAllByTestId("button")
		const refreshButton = buttons.find((b) => b.getAttribute("data-variant") === "outline")
		expect(refreshButton).toBeDisabled()
	})

	it("refresh button is enabled when API key is provided", () => {
		render(
			<Moonshot
				apiConfiguration={createDefaultApiConfiguration({ moonshotApiKey: "test-key" })}
				setApiConfigurationField={mockSetApiConfigurationField}
			/>,
		)

		const buttons = screen.getAllByTestId("button")
		const refreshButton = buttons.find((b) => b.getAttribute("data-variant") === "outline")
		expect(refreshButton).not.toBeDisabled()
	})

	it("shows loading state when refresh is clicked", () => {
		mockUseExtensionState.mockReturnValue({
			routerModels: {},
		})

		render(
			<Moonshot
				apiConfiguration={createDefaultApiConfiguration({ moonshotApiKey: "test-key" })}
				setApiConfigurationField={mockSetApiConfigurationField}
			/>,
		)

		const buttons = screen.getAllByTestId("button")
		const refreshButton = buttons.find((b) => b.getAttribute("data-variant") === "outline")!
		fireEvent.click(refreshButton)

		// After click, the button should be disabled (loading state)
		expect(refreshButton).toBeDisabled()
		expect(screen.getByText("settings:providers.refreshModels.loading")).toBeInTheDocument()
	})

	it("shows success state after routerModels message received", async () => {
		mockUseExtensionState.mockReturnValue({
			routerModels: {},
		})

		render(
			<Moonshot
				apiConfiguration={createDefaultApiConfiguration({ moonshotApiKey: "test-key" })}
				setApiConfigurationField={mockSetApiConfigurationField}
			/>,
		)

		// Click refresh to enter loading state
		const buttons = screen.getAllByTestId("button")
		const refreshButton = buttons.find((b) => b.getAttribute("data-variant") === "outline")!
		fireEvent.click(refreshButton)

		// Simulate receiving routerModels message (without prior error)
		window.postMessage(
			{
				type: "routerModels",
				values: { moonshot: { "kimi-k2-0905-preview": { maxTokens: 16384 } } },
			},
			"*",
		)

		await waitFor(() => {
			expect(screen.getByText("settings:providers.refreshModels.success")).toBeInTheDocument()
		})
	})

	it("shows error state after singleRouterModelFetchResponse error message", async () => {
		mockUseExtensionState.mockReturnValue({
			routerModels: {},
		})

		render(
			<Moonshot
				apiConfiguration={createDefaultApiConfiguration({ moonshotApiKey: "test-key" })}
				setApiConfigurationField={mockSetApiConfigurationField}
			/>,
		)

		// Click refresh to enter loading state
		await act(async () => {
			const buttons = screen.getAllByTestId("button")
			const refreshButton = buttons.find((b) => b.getAttribute("data-variant") === "outline")
			fireEvent.click(refreshButton!)
		})

		// Wait for loading state to render and effect to re-run with new refreshStatus
		await waitFor(() => {
			expect(screen.getByText("settings:providers.refreshModels.loading")).toBeInTheDocument()
		})

		// Simulate error message — use setTimeout to ensure the useEffect has
		// re-run with the updated refreshStatus === "loading" closure before the
		// message event fires, otherwise the handler closure still captures "idle".
		await act(async () => {
			return new Promise((resolve) => {
				setTimeout(() => {
					window.postMessage(
						{
							type: "singleRouterModelFetchResponse",
							success: false,
							error: "API connection failed",
							values: { provider: "moonshot" },
						},
						"*",
					)
					resolve(undefined)
				}, 0)
			})
		})

		// The component displays refreshError ("API connection failed") when set,
		// falling back to the generic message only when refreshError is undefined.
		await waitFor(() => {
			expect(screen.getByText("API connection failed")).toBeInTheDocument()
		})
	})

	it("race condition: error arrives before routerModels success — stays in error state", async () => {
		mockUseExtensionState.mockReturnValue({
			routerModels: {},
		})

		render(
			<Moonshot
				apiConfiguration={createDefaultApiConfiguration({ moonshotApiKey: "test-key" })}
				setApiConfigurationField={mockSetApiConfigurationField}
			/>,
		)

		// Click refresh to enter loading state
		await act(async () => {
			const buttons = screen.getAllByTestId("button")
			const btn = buttons.find((b) => b.getAttribute("data-variant") === "outline")
			fireEvent.click(btn!)
		})

		// Wait for loading state to render
		await waitFor(() => {
			expect(screen.getByText("settings:providers.refreshModels.loading")).toBeInTheDocument()
		})

		// Error arrives first — delay with setTimeout so the handler closure
		// captures refreshStatus === "loading".
		await act(async () => {
			return new Promise((resolve) => {
				setTimeout(() => {
					window.postMessage(
						{
							type: "singleRouterModelFetchResponse",
							success: false,
							error: "API connection failed",
							values: { provider: "moonshot" },
						},
						"*",
					)
					resolve(undefined)
				}, 0)
			})
		})

		// The component displays refreshError ("API connection failed") when set.
		await waitFor(() => {
			expect(screen.getByText("API connection failed")).toBeInTheDocument()
		})

		// Then routerModels arrives — should NOT flip to success because error was received
		await act(async () => {
			window.postMessage(
				{
					type: "routerModels",
					values: { moonshot: { "kimi-k2-0905-preview": { maxTokens: 16384 } } },
				},
				"*",
			)
		})

		// Error state should still be present (not flipped to success)
		await waitFor(() => {
			expect(screen.getByText("API connection failed")).toBeInTheDocument()
		})
	})

	it("sends correct message when refresh is clicked", () => {
		mockUseExtensionState.mockReturnValue({
			routerModels: {},
		})

		render(
			<Moonshot
				apiConfiguration={createDefaultApiConfiguration({
					moonshotApiKey: "test-key",
					moonshotBaseUrl: "https://api.moonshot.cn/v1",
				})}
				setApiConfigurationField={mockSetApiConfigurationField}
			/>,
		)

		const buttons = screen.getAllByTestId("button")
		const refreshButton = buttons.find((b) => b.getAttribute("data-variant") === "outline")!
		fireEvent.click(refreshButton)

		expect(vscode.postMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "requestRouterModels",
				values: {
					moonshotApiKey: "test-key",
					moonshotBaseUrl: "https://api.moonshot.cn/v1",
				},
			}),
		)
	})

	it("shows 'Get Moonshot API Key' link when no API key is set", () => {
		render(
			<Moonshot
				apiConfiguration={createDefaultApiConfiguration({ moonshotApiKey: undefined })}
				setApiConfigurationField={mockSetApiConfigurationField}
			/>,
		)

		expect(screen.getByTestId("vscode-button-link")).toBeInTheDocument()
		expect(screen.getByTestId("vscode-button-link")).toHaveAttribute(
			"href",
			"https://platform.moonshot.ai/console/api-keys",
		)
	})

	it("hides 'Get Moonshot API Key' link when API key is set", () => {
		render(
			<Moonshot
				apiConfiguration={createDefaultApiConfiguration({ moonshotApiKey: "test-key" })}
				setApiConfigurationField={mockSetApiConfigurationField}
			/>,
		)

		expect(screen.queryByTestId("vscode-button-link")).not.toBeInTheDocument()
	})
})
