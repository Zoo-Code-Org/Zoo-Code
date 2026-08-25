// npx vitest src/components/settings/__tests__/ModelPicker.spec.tsx

import { screen, fireEvent, renderWithExtensionState } from "@/utils/test-utils"
import { act } from "react"
import { QueryClient } from "@tanstack/react-query"
import { type Mock } from "vitest"

import { litellmDefaultModelId, ModelInfo, providerIdentifiers } from "@roo-code/types"

import { ModelPicker } from "../ModelPicker"
import { useRouterModels } from "@src/components/ui/hooks/useRouterModels"

vi.mock("@src/context/ExtensionStateContext", () => ({
	ExtensionStateContextProvider: ({ children }: any) => children,
	useExtensionState: vi.fn(),
}))

vi.mock("@src/components/ui/hooks/useRouterModels")

const mockUseRouterModels = useRouterModels as Mock<typeof useRouterModels>

Element.prototype.scrollIntoView = vi.fn()

describe("ModelPicker", () => {
	const mockSetApiConfigurationField = vi.fn()

	const modelInfo: ModelInfo = {
		maxTokens: 8192,
		contextWindow: 200_000,
		supportsImages: true,
		supportsPromptCache: true,
		inputPrice: 3.0,
		outputPrice: 15.0,
		cacheWritesPrice: 3.75,
		cacheReadsPrice: 0.3,
	}

	const mockModels = {
		model1: { name: "Model 1", description: "Test model 1", ...modelInfo },
		model2: { name: "Model 2", description: "Test model 2", ...modelInfo },
	}

	const defaultProps = {
		apiConfiguration: {},
		defaultModelId: "model1",
		modelIdKey: "openRouterModelId" as const,
		serviceName: "Test Service",
		serviceUrl: "https://test.service",
		recommendedModel: "recommended-model",
		models: mockModels,
		setApiConfigurationField: mockSetApiConfigurationField,
		organizationAllowList: { allowAll: true, providers: {} },
	}

	const queryClient = new QueryClient()

	const renderModelPicker = () => {
		return renderWithExtensionState(<ModelPicker {...defaultProps} />, { queryClient })
	}

	beforeEach(() => {
		vi.clearAllMocks()
		vi.useFakeTimers()
		// Default: no router models available. Provider-specific tests override per test.
		mockUseRouterModels.mockReturnValue({ data: {}, isLoading: false, isError: false } as any)
	})

	afterEach(() => {
		// Clear any pending timers to prevent test flakiness
		vi.clearAllTimers()
		vi.useRealTimers()
	})

	it("calls setApiConfigurationField when a model is selected", async () => {
		await act(async () => renderModelPicker())

		await act(async () => {
			// Open the popover by clicking the button.
			const button = screen.getByTestId("model-picker-button")
			fireEvent.click(button)
		})

		// Wait for popover to open and animations to complete.
		await act(async () => {
			vi.advanceTimersByTime(100)
		})

		await act(async () => {
			// Find and set the input value
			const modelInput = screen.getByTestId("model-input")
			fireEvent.input(modelInput, { target: { value: "model2" } })
		})

		// Need to find and click the CommandItem to trigger onSelect
		await act(async () => {
			// Find the CommandItem for model2 and click it
			const modelItem = screen.getByTestId("model-option-model2")
			fireEvent.click(modelItem)
		})

		// Advance timers to trigger the setTimeout in onSelect
		await act(async () => {
			vi.advanceTimersByTime(100)
		})

		// Verify the API config was updated.
		expect(mockSetApiConfigurationField).toHaveBeenCalledWith(defaultProps.modelIdKey, "model2")
	})

	it("allows setting a custom model ID that's not in the predefined list", async () => {
		await act(async () => renderModelPicker())

		await act(async () => {
			// Open the popover by clicking the button.
			const button = screen.getByTestId("model-picker-button")
			fireEvent.click(button)
		})

		// Wait for popover to open and animations to complete.
		await act(async () => {
			vi.advanceTimersByTime(100)
		})

		const customModelId = "custom-model-id"

		await act(async () => {
			// Find and set the input value to a custom model ID
			const modelInput = screen.getByTestId("model-input")
			fireEvent.input(modelInput, { target: { value: customModelId } })
		})

		// Wait for the UI to update
		await act(async () => {
			vi.advanceTimersByTime(100)
		})

		// Find and click the "Use custom" option
		await act(async () => {
			// Look for text containing our custom model ID
			const customOption = screen.getByTestId("use-custom-model")
			fireEvent.click(customOption)
		})

		// Advance timers to trigger the setTimeout in onSelect
		await act(async () => {
			vi.advanceTimersByTime(100)
		})

		// Verify the API config was updated with the custom model ID
		expect(mockSetApiConfigurationField).toHaveBeenCalledWith(defaultProps.modelIdKey, customModelId)
	})

	describe("Error Message Display", () => {
		it("displays error message when errorMessage prop is provided", async () => {
			const errorMessage = "Model not available for your organization"
			const propsWithError = {
				...defaultProps,
				errorMessage,
			}

			await act(async () => {
				renderWithExtensionState(<ModelPicker {...propsWithError} />, { queryClient })
			})

			// Check that the error message is displayed
			expect(screen.getByTestId("api-error-message")).toBeInTheDocument()
			expect(screen.getByText(errorMessage)).toBeInTheDocument()
		})

		it("does not display error message when errorMessage prop is undefined", async () => {
			await act(async () => renderModelPicker())

			// Check that no error message is displayed
			expect(screen.queryByTestId("api-error-message")).not.toBeInTheDocument()
		})

		it("displays error message below the model selector", async () => {
			const errorMessage = "Invalid model selected"
			const propsWithError = {
				...defaultProps,
				errorMessage,
			}

			await act(async () => {
				renderWithExtensionState(<ModelPicker {...propsWithError} />, { queryClient })
			})

			// Check that both the model selector and error message are present
			const modelSelector = screen.getByTestId("model-picker-button")
			const errorContainer = screen.getByTestId("api-error-message")
			const errorElement = screen.getByText(errorMessage)

			expect(modelSelector).toBeInTheDocument()
			expect(errorContainer).toBeInTheDocument()
			expect(errorElement).toBeInTheDocument()
			expect(errorElement).toBeVisible()
		})

		it("updates error message when errorMessage prop changes", async () => {
			const initialError = "Initial error"
			const updatedError = "Updated error"

			const { rerender } = renderWithExtensionState(
				<ModelPicker {...defaultProps} errorMessage={initialError} />,
				{ queryClient },
			)

			// Check initial error is displayed
			expect(screen.getByTestId("api-error-message")).toBeInTheDocument()
			expect(screen.getByText(initialError)).toBeInTheDocument()

			// Update the error message
			rerender(<ModelPicker {...defaultProps} errorMessage={updatedError} />)

			// Check that the error message has been updated
			expect(screen.getByTestId("api-error-message")).toBeInTheDocument()
			expect(screen.queryByText(initialError)).not.toBeInTheDocument()
			expect(screen.getByText(updatedError)).toBeInTheDocument()
		})

		it("removes error message when errorMessage prop becomes undefined", async () => {
			const errorMessage = "Temporary error"

			const { rerender } = renderWithExtensionState(
				<ModelPicker {...defaultProps} errorMessage={errorMessage} />,
				{ queryClient },
			)

			// Check error is initially displayed
			expect(screen.getByTestId("api-error-message")).toBeInTheDocument()
			expect(screen.getByText(errorMessage)).toBeInTheDocument()

			// Remove the error message
			rerender(<ModelPicker {...defaultProps} errorMessage={undefined} />)

			// Check that the error message has been removed
			expect(screen.queryByTestId("api-error-message")).not.toBeInTheDocument()
			expect(screen.queryByText(errorMessage)).not.toBeInTheDocument()
		})
	})

	describe("automaticFetch hint", () => {
		it("hides the automatic fetch hint for MiMo provider", async () => {
			await act(async () => {
				renderWithExtensionState(
					<ModelPicker {...defaultProps} apiConfiguration={{ apiProvider: providerIdentifiers.mimo }} />,
					{ queryClient },
				)
			})

			expect(screen.queryByTestId("automatic-fetch-hint")).not.toBeInTheDocument()
		})

		it("shows the automatic fetch hint for non-MiMo providers", async () => {
			await act(async () => {
				renderWithExtensionState(
					<ModelPicker {...defaultProps} apiConfiguration={{ apiProvider: providerIdentifiers.openai }} />,
					{ queryClient },
				)
			})

			expect(screen.getByTestId("automatic-fetch-hint")).toBeInTheDocument()
		})
	})

	describe("LiteLLM custom model selection", () => {
		const litellmModels: Record<string, ModelInfo> = {
			"gpt-4o-mini": { description: "LiteLLM proxy model", ...modelInfo },
		}

		const renderLiteLLMPicker = (
			apiConfiguration: Record<string, unknown>,
			setField: (field: string, value: unknown) => void,
		) =>
			renderWithExtensionState(
				<ModelPicker
					apiConfiguration={apiConfiguration as never}
					defaultModelId={litellmDefaultModelId}
					models={litellmModels}
					modelIdKey="litellmModelId"
					serviceName="LiteLLM"
					serviceUrl="https://docs.litellm.ai/"
					setApiConfigurationField={setField as never}
					organizationAllowList={{ allowAll: true, providers: {} }}
				/>,
				{ queryClient },
			)

		beforeEach(() => {
			mockUseRouterModels.mockReturnValue({
				data: { litellm: litellmModels },
				isLoading: false,
				isError: false,
			} as any)
		})

		it("keeps a custom model ID in the picker instead of reverting to the default", async () => {
			// Regression: on the LiteLLM settings screen the user could not change the
			// model ID to a value absent from the fetched /models list -- the picker
			// silently reverted to the hardcoded default model after the selection.
			const customModelId = "my-litellm-alias"
			let apiConfiguration: Record<string, unknown> = { apiProvider: providerIdentifiers.litellm }
			const setField = vi.fn((field: string, value: unknown) => {
				apiConfiguration = { ...apiConfiguration, [field]: value }
			})

			const { rerender } = await act(async () => {
				return renderLiteLLMPicker(apiConfiguration, setField)
			})

			// Before any selection the picker shows the provider default.
			expect(screen.getByTestId("model-picker-button")).toHaveTextContent(litellmDefaultModelId)

			// Open the popover and type a model ID that is not in the fetched list.
			await act(async () => {
				fireEvent.click(screen.getByTestId("model-picker-button"))
			})
			await act(async () => {
				vi.advanceTimersByTime(100)
			})
			await act(async () => {
				fireEvent.input(screen.getByTestId("model-input"), { target: { value: customModelId } })
			})
			await act(async () => {
				vi.advanceTimersByTime(100)
			})
			await act(async () => {
				fireEvent.click(screen.getByTestId("use-custom-model"))
			})
			await act(async () => {
				vi.advanceTimersByTime(100)
			})

			expect(setField).toHaveBeenCalledWith("litellmModelId", customModelId)

			// Re-render with the updated configuration (as SettingsView does after the
			// setter runs) and assert the selection is kept, not reset to the default.
			await act(async () => {
				rerender(
					<ModelPicker
						apiConfiguration={apiConfiguration as never}
						defaultModelId={litellmDefaultModelId}
						models={litellmModels}
						modelIdKey="litellmModelId"
						serviceName="LiteLLM"
						serviceUrl="https://docs.litellm.ai/"
						setApiConfigurationField={setField as never}
						organizationAllowList={{ allowAll: true, providers: {} }}
					/>,
				)
			})

			expect(screen.getByTestId("model-picker-button")).toHaveTextContent(customModelId)
			expect(screen.getByTestId("model-picker-button")).not.toHaveTextContent(litellmDefaultModelId)
		})
	})
})
