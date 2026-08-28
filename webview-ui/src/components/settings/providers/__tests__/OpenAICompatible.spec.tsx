import React from "react"
import { render, screen, fireEvent } from "@/utils/test-utils"
import { OpenAICompatible } from "../OpenAICompatible"
import { ProviderSettings } from "@roo-code/types"

// Mock the vscrui Checkbox component
vi.mock("vscrui", () => ({
	Checkbox: ({ children, checked, onChange }: any) => (
		<label data-testid={`checkbox-${children?.toString().replace(/\s+/g, "-").toLowerCase()}`}>
			<input
				type="checkbox"
				checked={checked}
				onChange={() => onChange(!checked)} // Toggle the checked state
				data-testid={`checkbox-input-${children?.toString().replace(/\s+/g, "-").toLowerCase()}`}
			/>
			{children}
		</label>
	),
}))

// Mock the VS Code form components
vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeTextField: ({
		children,
		value,
		onInput,
		placeholder,
		className,
		style,
		"data-testid": dataTestId,
		...rest
	}: any) => {
		return (
			<div
				data-testid={dataTestId ? `${dataTestId}-text-field` : "vscode-text-field"}
				className={className}
				style={style}>
				{children}
				<input
					type="text"
					value={value}
					onChange={(e) => onInput && onInput(e)}
					placeholder={placeholder}
					data-testid={dataTestId}
					{...rest}
				/>
			</div>
		)
	},
	VSCodeButton: ({ children, onClick, appearance, title }: any) => (
		<button onClick={onClick} title={title} data-testid={`vscode-button-${appearance}`}>
			{children}
		</button>
	),
	VSCodeTextArea: ({ value, onInput, children, ...rest }: any) => (
		<label>
			{children}
			<textarea value={value} onChange={(event) => onInput?.(event)} {...rest} />
		</label>
	),
}))

// Mock the translation hook
vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string) => key,
	}),
}))

// Mock the UI components
vi.mock("@src/components/ui", () => ({
	Button: ({ children, onClick }: any) => <button onClick={onClick}>{children}</button>,
	StandardTooltip: ({ children, content }: any) => <div title={content}>{children}</div>,
}))

// Mock other components
const { mockModelPicker } = vi.hoisted(() => ({ mockModelPicker: vi.fn() }))

vi.mock("../../ModelPicker", () => ({
	ModelPicker: (props: any) => {
		mockModelPicker(props)
		return <div data-testid="model-picker">Model Picker</div>
	},
}))

vi.mock("../../R1FormatSetting", () => ({
	R1FormatSetting: () => <div data-testid="r1-format-setting">R1 Format Setting</div>,
}))

const { mockThinkingBudget } = vi.hoisted(() => ({ mockThinkingBudget: vi.fn() }))

vi.mock("../../ThinkingBudget", () => ({
	ThinkingBudget: (props: any) => {
		mockThinkingBudget(props)
		return <div data-testid="thinking-budget">Thinking Budget</div>
	},
}))

// Mock react-use
vi.mock("react-use", () => ({
	useEvent: vi.fn(),
}))

describe("OpenAICompatible Component - includeMaxTokens checkbox", () => {
	const mockSetApiConfigurationField = vi.fn()
	const mockOrganizationAllowList = {
		allowAll: true,
		providers: {},
	}

	beforeEach(() => {
		vi.clearAllMocks()
	})

	describe("Checkbox Rendering", () => {
		it("should render the includeMaxTokens checkbox", () => {
			const apiConfiguration: Partial<ProviderSettings> = {
				includeMaxTokens: true,
			}

			render(
				<OpenAICompatible
					apiConfiguration={apiConfiguration as ProviderSettings}
					setApiConfigurationField={mockSetApiConfigurationField}
					organizationAllowList={mockOrganizationAllowList}
				/>,
			)

			// Check that the checkbox is rendered
			const checkbox = screen.getByTestId("checkbox-settings:includemaxoutputtokens")
			expect(checkbox).toBeInTheDocument()

			// Check that the description text is rendered
			expect(screen.getByText("settings:includeMaxOutputTokensDescription")).toBeInTheDocument()
		})

		it("should render the checkbox with correct translation keys", () => {
			const apiConfiguration: Partial<ProviderSettings> = {
				includeMaxTokens: true,
			}

			render(
				<OpenAICompatible
					apiConfiguration={apiConfiguration as ProviderSettings}
					setApiConfigurationField={mockSetApiConfigurationField}
					organizationAllowList={mockOrganizationAllowList}
				/>,
			)

			// Check that the correct translation key is used for the label
			expect(screen.getByText("settings:includeMaxOutputTokens")).toBeInTheDocument()

			// Check that the correct translation key is used for the description
			expect(screen.getByText("settings:includeMaxOutputTokensDescription")).toBeInTheDocument()
		})
	})

	describe("Azure OpenAI guidance", () => {
		it.each([
			{ openAiBaseUrl: "https://resource.openai.azure.com/" },
			{ openAiBaseUrl: "https://models.example.com", openAiUseAzure: true },
		])("shows Azure-specific endpoint and deployment guidance", (apiConfiguration) => {
			render(
				<OpenAICompatible
					apiConfiguration={apiConfiguration as ProviderSettings}
					setApiConfigurationField={mockSetApiConfigurationField}
					organizationAllowList={mockOrganizationAllowList}
				/>,
			)

			expect(screen.getByPlaceholderText("settings:providers.azureOpenAiBaseUrlPlaceholder")).toBeInTheDocument()
			expect(mockModelPicker).toHaveBeenLastCalledWith(
				expect.objectContaining({ label: "settings:providers.azureOpenAiDeploymentName" }),
			)
			expect(screen.getByText("settings:providers.azureOpenAiDeploymentNameDescription")).toBeInTheDocument()
		})

		it("keeps generic OpenAI-compatible guidance for non-Azure endpoints", () => {
			render(
				<OpenAICompatible
					apiConfiguration={{ openAiBaseUrl: "https://models.example.com/v1" } as ProviderSettings}
					setApiConfigurationField={mockSetApiConfigurationField}
					organizationAllowList={mockOrganizationAllowList}
				/>,
			)

			expect(screen.getByPlaceholderText("settings:placeholders.baseUrl")).toBeInTheDocument()
			expect(mockModelPicker).toHaveBeenLastCalledWith(expect.objectContaining({ label: undefined }))
			expect(
				screen.queryByText("settings:providers.azureOpenAiDeploymentNameDescription"),
			).not.toBeInTheDocument()
		})

		it("keeps generic OpenAI-compatible guidance for Azure AI Inference endpoints", () => {
			render(
				<OpenAICompatible
					apiConfiguration={
						{ openAiBaseUrl: "https://my-resource.services.ai.azure.com/models" } as ProviderSettings
					}
					setApiConfigurationField={mockSetApiConfigurationField}
					organizationAllowList={mockOrganizationAllowList}
				/>,
			)

			expect(mockModelPicker).toHaveBeenLastCalledWith(expect.objectContaining({ label: undefined }))
			expect(
				screen.queryByText("settings:providers.azureOpenAiDeploymentNameDescription"),
			).not.toBeInTheDocument()
		})

		it("keeps generic guidance when Azure AI Inference uses the Azure compatibility flag", () => {
			render(
				<OpenAICompatible
					apiConfiguration={
						{
							openAiBaseUrl: "https://my-resource.services.ai.azure.com/models",
							openAiUseAzure: true,
						} as ProviderSettings
					}
					setApiConfigurationField={mockSetApiConfigurationField}
					organizationAllowList={mockOrganizationAllowList}
				/>,
			)

			expect(screen.getByPlaceholderText("settings:placeholders.baseUrl")).toBeInTheDocument()
			expect(mockModelPicker).toHaveBeenLastCalledWith(expect.objectContaining({ label: undefined }))
		})
	})

	describe("Initial State", () => {
		it("should show checkbox as checked when includeMaxTokens is true", () => {
			const apiConfiguration: Partial<ProviderSettings> = {
				includeMaxTokens: true,
			}

			render(
				<OpenAICompatible
					apiConfiguration={apiConfiguration as ProviderSettings}
					setApiConfigurationField={mockSetApiConfigurationField}
					organizationAllowList={mockOrganizationAllowList}
				/>,
			)

			const checkboxInput = screen.getByTestId("checkbox-input-settings:includemaxoutputtokens")
			expect(checkboxInput).toBeChecked()
		})

		it("should show checkbox as unchecked when includeMaxTokens is false", () => {
			const apiConfiguration: Partial<ProviderSettings> = {
				includeMaxTokens: false,
			}

			render(
				<OpenAICompatible
					apiConfiguration={apiConfiguration as ProviderSettings}
					setApiConfigurationField={mockSetApiConfigurationField}
					organizationAllowList={mockOrganizationAllowList}
				/>,
			)

			const checkboxInput = screen.getByTestId("checkbox-input-settings:includemaxoutputtokens")
			expect(checkboxInput).not.toBeChecked()
		})

		it("should default to checked when includeMaxTokens is undefined", () => {
			const apiConfiguration: Partial<ProviderSettings> = {
				// includeMaxTokens is not defined
			}

			render(
				<OpenAICompatible
					apiConfiguration={apiConfiguration as ProviderSettings}
					setApiConfigurationField={mockSetApiConfigurationField}
					organizationAllowList={mockOrganizationAllowList}
				/>,
			)

			const checkboxInput = screen.getByTestId("checkbox-input-settings:includemaxoutputtokens")
			expect(checkboxInput).toBeChecked()
		})

		it("should default to checked when includeMaxTokens is null", () => {
			const apiConfiguration: Partial<ProviderSettings> = {
				includeMaxTokens: null as any,
			}

			render(
				<OpenAICompatible
					apiConfiguration={apiConfiguration as ProviderSettings}
					setApiConfigurationField={mockSetApiConfigurationField}
					organizationAllowList={mockOrganizationAllowList}
				/>,
			)

			const checkboxInput = screen.getByTestId("checkbox-input-settings:includemaxoutputtokens")
			expect(checkboxInput).toBeChecked()
		})
	})

	describe("User Interaction", () => {
		it("should call handleInputChange with correct parameters when checkbox is clicked from checked to unchecked", () => {
			const apiConfiguration: Partial<ProviderSettings> = {
				includeMaxTokens: true,
			}

			render(
				<OpenAICompatible
					apiConfiguration={apiConfiguration as ProviderSettings}
					setApiConfigurationField={mockSetApiConfigurationField}
					organizationAllowList={mockOrganizationAllowList}
				/>,
			)

			const checkboxInput = screen.getByTestId("checkbox-input-settings:includemaxoutputtokens")
			fireEvent.click(checkboxInput)

			// Verify setApiConfigurationField was called with correct parameters
			expect(mockSetApiConfigurationField).toHaveBeenCalledWith("includeMaxTokens", false)
		})

		it("should call handleInputChange with correct parameters when checkbox is clicked from unchecked to checked", () => {
			const apiConfiguration: Partial<ProviderSettings> = {
				includeMaxTokens: false,
			}

			render(
				<OpenAICompatible
					apiConfiguration={apiConfiguration as ProviderSettings}
					setApiConfigurationField={mockSetApiConfigurationField}
					organizationAllowList={mockOrganizationAllowList}
				/>,
			)

			const checkboxInput = screen.getByTestId("checkbox-input-settings:includemaxoutputtokens")
			fireEvent.click(checkboxInput)

			// Verify setApiConfigurationField was called with correct parameters
			expect(mockSetApiConfigurationField).toHaveBeenCalledWith("includeMaxTokens", true)
		})
	})

	describe("Component Updates", () => {
		it("should update checkbox state when apiConfiguration changes", () => {
			const apiConfigurationInitial: Partial<ProviderSettings> = {
				includeMaxTokens: true,
			}

			const { rerender } = render(
				<OpenAICompatible
					apiConfiguration={apiConfigurationInitial as ProviderSettings}
					setApiConfigurationField={mockSetApiConfigurationField}
					organizationAllowList={mockOrganizationAllowList}
				/>,
			)

			// Verify initial state
			let checkboxInput = screen.getByTestId("checkbox-input-settings:includemaxoutputtokens")
			expect(checkboxInput).toBeChecked()

			// Update with new configuration
			const apiConfigurationUpdated: Partial<ProviderSettings> = {
				includeMaxTokens: false,
			}

			rerender(
				<OpenAICompatible
					apiConfiguration={apiConfigurationUpdated as ProviderSettings}
					setApiConfigurationField={mockSetApiConfigurationField}
					organizationAllowList={mockOrganizationAllowList}
				/>,
			)

			// Verify updated state
			checkboxInput = screen.getByTestId("checkbox-input-settings:includemaxoutputtokens")
			expect(checkboxInput).not.toBeChecked()
		})
	})

	describe("UI Structure", () => {
		it("should render the checkbox with description in correct structure", () => {
			const apiConfiguration: Partial<ProviderSettings> = {
				includeMaxTokens: true,
			}

			render(
				<OpenAICompatible
					apiConfiguration={apiConfiguration as ProviderSettings}
					setApiConfigurationField={mockSetApiConfigurationField}
					organizationAllowList={mockOrganizationAllowList}
				/>,
			)

			// Check that the checkbox and description are in a div container
			const checkbox = screen.getByTestId("checkbox-settings:includemaxoutputtokens")
			const parentDiv = checkbox.closest("div")
			expect(parentDiv).toBeInTheDocument()

			// Check that the description has the correct styling classes
			const description = screen.getByText("settings:includeMaxOutputTokensDescription")
			expect(description).toHaveClass("text-sm", "text-vscode-descriptionForeground", "ml-6")
		})
	})
	describe("reasoning effort", () => {
		it("should expose and persist the max reasoning-effort value", () => {
			const apiConfiguration: Partial<ProviderSettings> = {
				enableReasoningEffort: true,
				openAiCustomModelInfo: {
					contextWindow: 128_000,
					supportsPromptCache: false,
				},
			}

			render(
				<OpenAICompatible
					apiConfiguration={apiConfiguration as ProviderSettings}
					setApiConfigurationField={mockSetApiConfigurationField}
					organizationAllowList={mockOrganizationAllowList}
				/>,
			)

			const thinkingBudgetProps = mockThinkingBudget.mock.calls[0][0]
			expect(thinkingBudgetProps.modelInfo.supportsReasoningEffort).toEqual([
				"low",
				"medium",
				"high",
				"xhigh",
				"max",
			])

			thinkingBudgetProps.setApiConfigurationField("reasoningEffort", "max")

			expect(mockSetApiConfigurationField).toHaveBeenCalledWith("openAiCustomModelInfo", {
				...apiConfiguration.openAiCustomModelInfo,
				reasoningEffort: "max",
			})
		})
	})

	describe("Extra Body", () => {
		it("renders an undefined value as an editable empty field without a validation error", () => {
			render(
				<OpenAICompatible
					apiConfiguration={{ openAiExtraBody: undefined } as ProviderSettings}
					setApiConfigurationField={mockSetApiConfigurationField}
					organizationAllowList={mockOrganizationAllowList}
				/>,
			)

			const input = screen.getByTestId("openai-extra-body-input")
			expect(input).toHaveValue("")
			expect(input).not.toHaveAttribute("aria-invalid", "true")
			expect(screen.queryByRole("alert")).not.toBeInTheDocument()

			fireEvent.change(input, { target: { value: '{"store":false}' } })

			expect(mockSetApiConfigurationField).toHaveBeenCalledWith("openAiExtraBody", '{"store":false}')
		})

		it("renders the saved JSON and updates the cached provider field", () => {
			const openAiExtraBody = JSON.stringify({ metadata: { completion_window: "balanced" } }, null, 2)

			render(
				<OpenAICompatible
					apiConfiguration={{ openAiExtraBody } as ProviderSettings}
					setApiConfigurationField={mockSetApiConfigurationField}
					organizationAllowList={mockOrganizationAllowList}
				/>,
			)

			const input = screen.getByTestId("openai-extra-body-input")
			expect(input).toHaveValue(openAiExtraBody)

			fireEvent.change(input, { target: { value: '{"store":false}' } })

			expect(mockSetApiConfigurationField).toHaveBeenCalledWith("openAiExtraBody", '{"store":false}')
		})

		it("marks invalid JSON and describes the validation error", () => {
			render(
				<OpenAICompatible
					apiConfiguration={{ openAiExtraBody: "not json" } as ProviderSettings}
					setApiConfigurationField={mockSetApiConfigurationField}
					organizationAllowList={mockOrganizationAllowList}
				/>,
			)

			const input = screen.getByTestId("openai-extra-body-input")
			expect(input).toHaveAttribute("aria-invalid", "true")
			expect(screen.getByText("settings:validation.openAiExtraBody.invalidJson")).toBeInTheDocument()
		})
	})
})
