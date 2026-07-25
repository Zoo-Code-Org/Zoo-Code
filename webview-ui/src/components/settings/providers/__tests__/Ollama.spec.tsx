// npx vitest src/components/settings/providers/__tests__/Ollama.spec.tsx

import React from "react"
import { render, screen, fireEvent, act } from "@/utils/test-utils"
import { Ollama } from "../Ollama"
import { ProviderSettings } from "@roo-code/types"

// Mock the vscrui Checkbox component
vi.mock("vscrui", () => ({
	Checkbox: ({ children, checked, onChange }: any) => (
		<label data-testid={`checkbox-${children?.toString().replace(/\s+/g, "-").toLowerCase()}`}>
			<input
				type="checkbox"
				checked={checked}
				onChange={() => onChange(!checked)}
				data-testid={`checkbox-input-${children?.toString().replace(/\s+/g, "-").toLowerCase()}`}
			/>
			{children}
		</label>
	),
}))

// Mock the VSCodeTextField component
vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeTextField: ({ children, value, onInput, placeholder, className, ...rest }: any) => (
		<div data-testid="vscode-text-field" className={className}>
			{children}
			<input
				type="text"
				value={value}
				onChange={(e) => onInput && onInput(e)}
				placeholder={placeholder}
				{...rest}
			/>
		</div>
	),
}))

// Mock the translation hook
vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string) => key,
	}),
}))

// Mock the ModelPicker
vi.mock("../../ModelPicker", () => ({
	ModelPicker: ({ models }: any) => <div data-testid="model-picker">{Object.keys(models ?? {}).join(",")}</div>,
}))

// Mock the ThinkingBudget
vi.mock("../../ThinkingBudget", () => ({
	ThinkingBudget: ({ modelInfo }: any) => (
		<div data-testid="thinking-budget" data-supports={modelInfo?.supportsReasoningEffort}>
			Thinking Budget
		</div>
	),
}))

// Mock useRouterModels
vi.mock("@src/components/ui/hooks/useRouterModels", () => ({
	useRouterModels: () => ({ data: {}, isLoading: false, error: null }),
}))

const { postMessageMock } = vi.hoisted(() => ({
	postMessageMock: vi.fn(),
}))

// Mock vscode
vi.mock("@src/utils/vscode", () => ({
	vscode: { postMessage: postMessageMock },
}))

// Stub the shared Button so we can assert onClick/disabled without its styling deps.
vi.mock("@src/components/ui", async () => {
	const actual = await vi.importActual<typeof import("@src/components/ui")>("@src/components/ui")
	return {
		...actual,
		Button: ({ children, onClick, disabled, className }: any) => (
			<button onClick={onClick} disabled={disabled} className={className} data-testid="refresh-button">
				{children}
			</button>
		),
	}
})

describe("Ollama Component - thinking setting", () => {
	const mockSetApiConfigurationField = vi.fn()

	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("should render the thinking checkbox unchecked by default", () => {
		const apiConfiguration: Partial<ProviderSettings> = {}

		render(
			<Ollama
				apiConfiguration={apiConfiguration as ProviderSettings}
				setApiConfigurationField={mockSetApiConfigurationField}
			/>,
		)

		const checkbox = screen.getByTestId("checkbox-settings:providers.ollama.thinking")
		expect(checkbox).toBeInTheDocument()

		const input = screen.getByTestId("checkbox-input-settings:providers.ollama.thinking") as HTMLInputElement
		expect(input.checked).toBe(false)
	})

	it("should render the thinking checkbox checked when enableReasoningEffort is true", () => {
		const apiConfiguration: Partial<ProviderSettings> = {
			enableReasoningEffort: true,
		}

		render(
			<Ollama
				apiConfiguration={apiConfiguration as ProviderSettings}
				setApiConfigurationField={mockSetApiConfigurationField}
			/>,
		)

		const input = screen.getByTestId("checkbox-input-settings:providers.ollama.thinking") as HTMLInputElement
		expect(input.checked).toBe(true)
	})

	it("should render the thinking help text", () => {
		render(
			<Ollama
				apiConfiguration={{} as ProviderSettings}
				setApiConfigurationField={mockSetApiConfigurationField}
			/>,
		)

		expect(screen.getByText("settings:providers.ollama.thinkingHelp")).toBeInTheDocument()
	})

	it("should enable reasoning effort and default reasoningEffort to medium when the checkbox is toggled on with no prior value", () => {
		render(
			<Ollama
				apiConfiguration={{} as ProviderSettings}
				setApiConfigurationField={mockSetApiConfigurationField}
			/>,
		)

		const input = screen.getByTestId("checkbox-input-settings:providers.ollama.thinking")
		fireEvent.click(input)

		expect(mockSetApiConfigurationField).toHaveBeenCalledWith("enableReasoningEffort", true)
		// Defaulting to "medium" ensures getOllamaThinkParam() actually sends a
		// think parameter instead of leaving reasoningEffort undefined.
		expect(mockSetApiConfigurationField).toHaveBeenCalledWith("reasoningEffort", "medium")
	})

	it("should restore the prior reasoningEffort value when re-enabled after being toggled off", () => {
		// The user previously selected "high", toggled the checkbox off (which
		// preserves reasoningEffort), and is now toggling it back on. The
		// prior effort level should be restored rather than reset to "medium".
		const apiConfiguration: Partial<ProviderSettings> = {
			enableReasoningEffort: false,
			reasoningEffort: "high",
		}

		render(
			<Ollama
				apiConfiguration={apiConfiguration as ProviderSettings}
				setApiConfigurationField={mockSetApiConfigurationField}
			/>,
		)

		const input = screen.getByTestId("checkbox-input-settings:providers.ollama.thinking")
		fireEvent.click(input)

		expect(mockSetApiConfigurationField).toHaveBeenCalledWith("enableReasoningEffort", true)
		expect(mockSetApiConfigurationField).toHaveBeenCalledWith("reasoningEffort", "high")
	})

	it("should disable reasoning effort and preserve reasoningEffort when toggled off", () => {
		// Toggling the checkbox off no longer wipes the user's prior effort
		// choice. The handler gates on enableReasoningEffort === true, so a
		// stale reasoningEffort value will not emit a think param while the
		// checkbox is off, and the value is preserved for re-enabling.
		const apiConfiguration: Partial<ProviderSettings> = {
			enableReasoningEffort: true,
			reasoningEffort: "high",
		}

		render(
			<Ollama
				apiConfiguration={apiConfiguration as ProviderSettings}
				setApiConfigurationField={mockSetApiConfigurationField}
			/>,
		)

		const input = screen.getByTestId("checkbox-input-settings:providers.ollama.thinking")
		fireEvent.click(input)

		expect(mockSetApiConfigurationField).toHaveBeenCalledWith("enableReasoningEffort", false)
		// reasoningEffort is intentionally left untouched so the user's prior
		// selection survives across toggles.
		expect(mockSetApiConfigurationField).not.toHaveBeenCalledWith("reasoningEffort", expect.anything())
	})

	it("should render ThinkingBudget with supportsReasoningEffort when thinking is enabled", () => {
		const apiConfiguration: Partial<ProviderSettings> = {
			enableReasoningEffort: true,
		}

		render(
			<Ollama
				apiConfiguration={apiConfiguration as ProviderSettings}
				setApiConfigurationField={mockSetApiConfigurationField}
			/>,
		)

		const thinkingBudget = screen.getByTestId("thinking-budget")
		expect(thinkingBudget).toBeInTheDocument()
		expect(thinkingBudget.getAttribute("data-supports")).toBe("true")
	})

	it("should not render ThinkingBudget when thinking is disabled", () => {
		const apiConfiguration: Partial<ProviderSettings> = {
			enableReasoningEffort: false,
		}

		render(
			<Ollama
				apiConfiguration={apiConfiguration as ProviderSettings}
				setApiConfigurationField={mockSetApiConfigurationField}
			/>,
		)

		expect(screen.queryByTestId("thinking-budget")).toBeNull()
	})
})

describe("Ollama Component - refresh models", () => {
	const mockSetApiConfigurationField = vi.fn()

	const dispatchMessage = (data: any) =>
		act(() => {
			window.dispatchEvent(new MessageEvent("message", { data }))
		})

	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("renders the refresh button in idle state", () => {
		render(
			<Ollama
				apiConfiguration={{} as ProviderSettings}
				setApiConfigurationField={mockSetApiConfigurationField}
			/>,
		)

		const button = screen.getByTestId("refresh-button")
		expect(button).not.toBeDisabled()
		expect(button.querySelector(".codicon-refresh")).not.toBeNull()
		expect(screen.getByText("settings:providers.refreshModels.label")).toBeInTheDocument()
	})

	it("sends requestOllamaModels with baseUrl and apiKey when the refresh button is clicked", () => {
		render(
			<Ollama
				apiConfiguration={
					{
						ollamaBaseUrl: "https://ollama.example.com",
						ollamaApiKey: "secret-key",
					} as ProviderSettings
				}
				setApiConfigurationField={mockSetApiConfigurationField}
			/>,
		)

		fireEvent.click(screen.getByTestId("refresh-button"))

		expect(postMessageMock).toHaveBeenCalledWith({
			type: "requestOllamaModels",
			values: {
				baseUrl: "https://ollama.example.com",
				apiKey: "secret-key",
			},
		})
	})

	it("enters loading state and disables the button while refreshing", () => {
		render(
			<Ollama
				apiConfiguration={{} as ProviderSettings}
				setApiConfigurationField={mockSetApiConfigurationField}
			/>,
		)

		fireEvent.click(screen.getByTestId("refresh-button"))

		const button = screen.getByTestId("refresh-button")
		expect(button).toBeDisabled()
		expect(button.querySelector(".codicon-loading")).not.toBeNull()
		expect(screen.getByText("settings:providers.refreshModels.loading")).toBeInTheDocument()
	})

	it("handles a response dispatched synchronously while posting the refresh request", () => {
		render(
			<Ollama
				apiConfiguration={{} as ProviderSettings}
				setApiConfigurationField={mockSetApiConfigurationField}
			/>,
		)

		// Ignore the mount request and respond synchronously to the explicit refresh.
		postMessageMock.mockClear()
		postMessageMock.mockImplementationOnce(() => {
			window.dispatchEvent(
				new MessageEvent("message", { data: { type: "ollamaModels", ollamaModels: { "llama3:latest": {} } } }),
			)
		})
		fireEvent.click(screen.getByTestId("refresh-button"))

		expect(screen.getByText("settings:providers.refreshModels.success")).toBeInTheDocument()
		expect(screen.getByTestId("model-picker")).toHaveTextContent("llama3:latest")
	})

	it("shows success state when ollamaModels arrives with models while loading", () => {
		render(
			<Ollama
				apiConfiguration={{} as ProviderSettings}
				setApiConfigurationField={mockSetApiConfigurationField}
			/>,
		)

		fireEvent.click(screen.getByTestId("refresh-button"))
		dispatchMessage({ type: "ollamaModels", ollamaModels: { "llama3:latest": {} } })

		expect(screen.getByText("settings:providers.refreshModels.success")).toBeInTheDocument()
	})

	it("shows success state when Ollama is reachable but has no installed models", () => {
		render(
			<Ollama
				apiConfiguration={{} as ProviderSettings}
				setApiConfigurationField={mockSetApiConfigurationField}
			/>,
		)

		fireEvent.click(screen.getByTestId("refresh-button"))
		dispatchMessage({ type: "ollamaModels", ollamaModels: {} })

		expect(screen.getByText("settings:providers.refreshModels.success")).toBeInTheDocument()
	})

	it("displays the backend error message when ollamaModels arrives with an error", () => {
		render(
			<Ollama
				apiConfiguration={{} as ProviderSettings}
				setApiConfigurationField={mockSetApiConfigurationField}
			/>,
		)

		fireEvent.click(screen.getByTestId("refresh-button"))
		dispatchMessage({ type: "ollamaModels", ollamaModels: {}, error: "Connection refused" })

		expect(screen.getByText("Connection refused")).toBeInTheDocument()
	})

	it("preserves previously loaded models when a later refresh fails", () => {
		render(
			<Ollama
				apiConfiguration={{} as ProviderSettings}
				setApiConfigurationField={mockSetApiConfigurationField}
			/>,
		)

		fireEvent.click(screen.getByTestId("refresh-button"))
		dispatchMessage({ type: "ollamaModels", ollamaModels: { "llama3:latest": {} } })
		expect(screen.getByTestId("model-picker")).toHaveTextContent("llama3:latest")

		fireEvent.click(screen.getByTestId("refresh-button"))
		dispatchMessage({ type: "ollamaModels", ollamaModels: {}, error: "Connection refused" })

		expect(screen.getByText("Connection refused")).toBeInTheDocument()
		expect(screen.getByTestId("model-picker")).toHaveTextContent("llama3:latest")
	})

	it("ignores ollamaModels messages when not in loading state", () => {
		render(
			<Ollama
				apiConfiguration={{} as ProviderSettings}
				setApiConfigurationField={mockSetApiConfigurationField}
			/>,
		)

		// No refresh initiated; an unsolicited ollamaModels message should be a no-op.
		dispatchMessage({ type: "ollamaModels", ollamaModels: { "llama3:latest": {} } })

		expect(screen.queryByText("settings:providers.refreshModels.success")).not.toBeInTheDocument()
		expect(screen.queryByText("settings:providers.refreshModels.loading")).not.toBeInTheDocument()
	})
})
