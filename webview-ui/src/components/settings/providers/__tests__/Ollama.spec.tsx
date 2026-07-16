// npx vitest src/components/settings/providers/__tests__/Ollama.spec.tsx

import React from "react"
import { render, screen, fireEvent } from "@/utils/test-utils"
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
	ModelPicker: () => <div data-testid="model-picker">Model Picker</div>,
}))

// Mock the ThinkingBudget
vi.mock("../../ThinkingBudget", () => ({
	ThinkingBudget: ({ modelInfo }: any) => (
		<div data-testid="thinking-budget" data-supports={modelInfo?.supportsReasoningEffort}>
			Thinking Budget
		</div>
	),
}))

// Mock react-use
vi.mock("react-use", () => ({
	useEvent: vi.fn(),
}))

// Mock useRouterModels
vi.mock("@src/components/ui/hooks/useRouterModels", () => ({
	useRouterModels: () => ({ data: {}, isLoading: false, error: null }),
}))

// Mock vscode
vi.mock("@src/utils/vscode", () => ({
	vscode: { postMessage: vi.fn() },
}))

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
