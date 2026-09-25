import { providerIdentifiers } from "@roo-code/types"
// npx vitest src/components/settings/__tests__/ThinkingBudget.spec.tsx

import React from "react"

import { render, screen, fireEvent } from "@/utils/test-utils"

import type { ModelInfo, ProviderSettings } from "@roo-code/types"

import { ThinkingBudget } from "../ThinkingBudget"

vi.mock("@/components/ui", () => ({
	Slider: ({ value, onValueChange, min, max, step }: any) => (
		<input
			type="range"
			data-testid="slider"
			min={min}
			max={max}
			step={step}
			value={value[0]}
			onChange={(e) => onValueChange([parseInt(e.target.value)])}
		/>
	),
	Select: ({ children, value, onValueChange }: any) => (
		<div data-testid="select" data-value={value} data-onvaluechange={onValueChange}>
			{React.Children.map(children, (child) => React.cloneElement(child, { onValueChange }))}
		</div>
	),
	SelectTrigger: ({ children }: any) => <button data-testid="select-trigger">{children}</button>,
	SelectValue: ({ placeholder }: any) => <span data-testid="select-value">{placeholder}</span>,
	SelectContent: ({ children, onValueChange }: any) => (
		<div data-testid="select-content">
			{React.Children.map(children, (child) => React.cloneElement(child, { onValueChange }))}
		</div>
	),
	SelectItem: ({ children, value, onValueChange }: any) => (
		<div data-testid={`select-item-${value}`} data-value={value} onClick={() => onValueChange?.(value)}>
			{children}
		</div>
	),
}))

vi.mock("@/components/ui/hooks/useSelectedModel", () => ({
	useSelectedModel: (apiConfiguration: any) => {
		// Return the model ID based on apiConfiguration for testing
		// For Gemini tests, check if apiProvider is gemini and use apiModelId
		if (apiConfiguration?.apiProvider === providerIdentifiers.gemini) {
			return {
				id: apiConfiguration?.apiModelId || "gemini-2.0-flash-exp",
				provider: providerIdentifiers.gemini,
				info: undefined,
			}
		}
		return {
			id: apiConfiguration?.apiModelId || "claude-3-5-sonnet-20241022",
			provider: apiConfiguration?.apiProvider || providerIdentifiers.anthropic,
			info: undefined,
		}
	},
}))

describe("ThinkingBudget", () => {
	const mockModelInfo: ModelInfo = {
		supportsReasoningBudget: true,
		requiredReasoningBudget: true,
		maxTokens: 16384,
		contextWindow: 200000,
		supportsPromptCache: true,
		supportsImages: true,
	}

	const defaultProps = {
		apiConfiguration: {},
		setApiConfigurationField: vi.fn(),
		modelInfo: mockModelInfo,
	}

	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("should render nothing when model information is unavailable", () => {
		const { container } = render(<ThinkingBudget {...defaultProps} modelInfo={undefined} />)

		expect(container.firstChild).toBeNull()
	})

	it("should render nothing when model doesn't support thinking", () => {
		const { container } = render(
			<ThinkingBudget
				{...defaultProps}
				apiConfiguration={{ apiModelId: "gpt-4", apiProvider: "openai" }}
				modelInfo={{
					...mockModelInfo,
					maxTokens: 16384,
					contextWindow: 200000,
					supportsPromptCache: true,
					supportsImages: true,
					supportsReasoningBudget: false,
				}}
			/>,
		)

		expect(container.firstChild).toBeNull()
	})

	it("should render simple reasoning toggle when model has supportsReasoningBinary (binary reasoning)", () => {
		render(
			<ThinkingBudget
				{...defaultProps}
				modelInfo={{
					...mockModelInfo,
					supportsReasoningBinary: true,
					supportsReasoningBudget: false,
					supportsReasoningEffort: false,
				}}
			/>,
		)

		// Should show the reasoning checkbox (translation key)
		expect(screen.getByText("settings:providers.useReasoning")).toBeInTheDocument()

		// Should NOT show sliders or other complex reasoning controls
		expect(screen.queryByTestId("reasoning-budget")).not.toBeInTheDocument()
		expect(screen.queryByTestId("reasoning-effort")).not.toBeInTheDocument()
	})

	it("should render sliders when model supports thinking", () => {
		render(<ThinkingBudget {...defaultProps} />)

		expect(screen.getAllByTestId("slider")).toHaveLength(2)
	})

	it("should update modelMaxThinkingTokens", () => {
		const setApiConfigurationField = vi.fn()

		render(
			<ThinkingBudget
				{...defaultProps}
				apiConfiguration={{ modelMaxThinkingTokens: 4096 }}
				setApiConfigurationField={setApiConfigurationField}
			/>,
		)

		const sliders = screen.getAllByTestId("slider")
		fireEvent.change(sliders[1], { target: { value: "5000" } })

		expect(setApiConfigurationField).toHaveBeenCalledWith("modelMaxThinkingTokens", 5000)
	})

	it("should cap thinking tokens at 80% of max tokens", () => {
		const setApiConfigurationField = vi.fn()

		render(
			<ThinkingBudget
				{...defaultProps}
				apiConfiguration={{ modelMaxTokens: 10000, modelMaxThinkingTokens: 9000 }}
				setApiConfigurationField={setApiConfigurationField}
			/>,
		)

		// Effect should trigger and cap the value
		expect(setApiConfigurationField).toHaveBeenCalledWith("modelMaxThinkingTokens", 8000, false) // 80% of 10000
	})

	it("should use default thinking tokens if not provided", () => {
		render(<ThinkingBudget {...defaultProps} apiConfiguration={{ modelMaxTokens: 10000 }} />)

		// Default is 80% of max tokens, capped at 8192
		const sliders = screen.getAllByTestId("slider")
		expect(sliders[1]).toHaveValue("8000") // 80% of 10000
	})

	it("should use min thinking tokens of 1024 for non-Gemini models", () => {
		render(<ThinkingBudget {...defaultProps} apiConfiguration={{ modelMaxTokens: 1000 }} />)

		const sliders = screen.getAllByTestId("slider")
		expect(sliders[1].getAttribute("min")).toBe("1024")
	})

	it("should use min thinking tokens of 128 for Gemini 2.5 Pro models", () => {
		render(
			<ThinkingBudget
				{...defaultProps}
				apiConfiguration={{
					modelMaxTokens: 10000,
					apiProvider: providerIdentifiers.gemini,
					apiModelId: "gemini-2.5-pro-002",
				}}
			/>,
		)

		const sliders = screen.getAllByTestId("slider")
		expect(sliders[1].getAttribute("min")).toBe("128")
	})

	it("should use step of 128 for Gemini 2.5 Pro models", () => {
		render(
			<ThinkingBudget
				{...defaultProps}
				apiConfiguration={{
					modelMaxTokens: 10000,
					apiProvider: providerIdentifiers.gemini,
					apiModelId: "gemini-2.5-pro-002",
				}}
			/>,
		)

		const sliders = screen.getAllByTestId("slider")
		expect(sliders[1].getAttribute("step")).toBe("128")
	})

	it("should use step of 1024 for non-Gemini models", () => {
		render(
			<ThinkingBudget
				{...defaultProps}
				apiConfiguration={{
					modelMaxTokens: 10000,
					apiProvider: providerIdentifiers.anthropic,
					apiModelId: "claude-3-5-sonnet-20241022",
				}}
			/>,
		)

		const sliders = screen.getAllByTestId("slider")
		expect(sliders[1].getAttribute("step")).toBe("1024")
	})

	it("should update max tokens when slider changes", () => {
		const setApiConfigurationField = vi.fn()

		render(
			<ThinkingBudget
				{...defaultProps}
				apiConfiguration={{ modelMaxTokens: 10000 }}
				setApiConfigurationField={setApiConfigurationField}
			/>,
		)

		const sliders = screen.getAllByTestId("slider")
		fireEvent.change(sliders[0], { target: { value: "12000" } })

		expect(setApiConfigurationField).toHaveBeenCalledWith("modelMaxTokens", 12000)
	})

	describe("reasoning effort dropdown", () => {
		const reasoningEffortModelInfo: ModelInfo = {
			supportsReasoningEffort: true,
			contextWindow: 200000,
			supportsPromptCache: true,
		}

		it("should show 'disable' option when supportsReasoningEffort is boolean true", () => {
			render(<ThinkingBudget {...defaultProps} modelInfo={reasoningEffortModelInfo} />)

			expect(screen.getByTestId("reasoning-effort")).toBeInTheDocument()
			// "disable" should be shown when supportsReasoningEffort is true (boolean)
			expect(screen.getByTestId("select-item-disable")).toBeInTheDocument()
			expect(screen.getByTestId("select-item-low")).toBeInTheDocument()
			expect(screen.getByTestId("select-item-medium")).toBeInTheDocument()
			expect(screen.getByTestId("select-item-high")).toBeInTheDocument()
		})

		it("should NOT show 'disable' option when supportsReasoningEffort is an explicit array without disable", () => {
			render(
				<ThinkingBudget
					{...defaultProps}
					modelInfo={{
						...reasoningEffortModelInfo,
						supportsReasoningEffort: ["low", "high"],
					}}
				/>,
			)

			expect(screen.getByTestId("reasoning-effort")).toBeInTheDocument()
			// "disable" should NOT be shown when model explicitly specifies only ["low", "high"]
			expect(screen.queryByTestId("select-item-disable")).not.toBeInTheDocument()
			expect(screen.getByTestId("select-item-low")).toBeInTheDocument()
			expect(screen.queryByTestId("select-item-medium")).not.toBeInTheDocument()
			expect(screen.getByTestId("select-item-high")).toBeInTheDocument()
		})

		it("should fall back to first available option when stored value is not in the explicit array", () => {
			const setApiConfigurationField = vi.fn()
			// Covers the clamp branch: defaultReasoningEffort="disable" but array omits "disable"
			render(
				<ThinkingBudget
					{...defaultProps}
					apiConfiguration={{}}
					setApiConfigurationField={setApiConfigurationField}
					modelInfo={{
						...reasoningEffortModelInfo,
						supportsReasoningEffort: ["low", "high"],
					}}
				/>,
			)

			// The select value should be "low" (first item), not "disable"
			expect(screen.getByTestId("select")).toHaveAttribute("data-value", "low")
			expect(setApiConfigurationField).toHaveBeenCalledWith("reasoningEffort", "low")
			expect(setApiConfigurationField).toHaveBeenCalledWith("enableReasoningEffort", true, false)
		})

		it("should use and persist an optional model's advertised reasoning default", () => {
			const setApiConfigurationField = vi.fn()
			render(
				<ThinkingBudget
					{...defaultProps}
					apiConfiguration={{}}
					setApiConfigurationField={setApiConfigurationField}
					modelInfo={{
						...reasoningEffortModelInfo,
						supportsReasoningEffort: ["disable", "high", "max"],
						reasoningEffort: "high",
					}}
				/>,
			)

			expect(screen.getByTestId("select")).toHaveAttribute("data-value", "high")
			expect(setApiConfigurationField).toHaveBeenCalledWith("reasoningEffort", "high")
			expect(setApiConfigurationField).toHaveBeenCalledWith("enableReasoningEffort", true, false)
		})

		it("should preserve an explicit disable selection for optional reasoning", () => {
			const setApiConfigurationField = vi.fn()
			render(
				<ThinkingBudget
					{...defaultProps}
					apiConfiguration={{ reasoningEffort: "disable", enableReasoningEffort: false }}
					setApiConfigurationField={setApiConfigurationField}
					modelInfo={{
						...reasoningEffortModelInfo,
						supportsReasoningEffort: ["disable", "high", "max"],
						reasoningEffort: "high",
					}}
				/>,
			)

			expect(screen.getByTestId("select")).toHaveAttribute("data-value", "disable")
			expect(setApiConfigurationField).not.toHaveBeenCalled()
		})

		it("should normalize an invalid disabled value to the default for required reasoning", () => {
			const setApiConfigurationField = vi.fn()
			render(
				<ThinkingBudget
					{...defaultProps}
					apiConfiguration={{ reasoningEffort: "disable" }}
					setApiConfigurationField={setApiConfigurationField}
					modelInfo={{
						...reasoningEffortModelInfo,
						supportsReasoningEffort: ["low", "high", "max"],
						requiredReasoningEffort: true,
						reasoningEffort: "max",
					}}
				/>,
			)

			expect(screen.getByTestId("select")).toHaveAttribute("data-value", "max")
			expect(setApiConfigurationField).toHaveBeenCalledWith("reasoningEffort", "max")
		})

		it("should use the first supported effort when required reasoning has no advertised default", () => {
			const setApiConfigurationField = vi.fn()
			render(
				<ThinkingBudget
					{...defaultProps}
					apiConfiguration={{}}
					setApiConfigurationField={setApiConfigurationField}
					modelInfo={{
						...reasoningEffortModelInfo,
						supportsReasoningEffort: ["low", "high"],
						requiredReasoningEffort: true,
					}}
				/>,
			)

			expect(screen.getByTestId("select")).toHaveAttribute("data-value", "low")
			expect(setApiConfigurationField).toHaveBeenCalledWith("reasoningEffort", "low")
			expect(setApiConfigurationField).toHaveBeenCalledWith("enableReasoningEffort", true, false)
		})

		it("should normalize stale disable to the first supported effort after switching to a required model", () => {
			const setApiConfigurationField = vi.fn()
			const { rerender } = render(
				<ThinkingBudget
					{...defaultProps}
					apiConfiguration={{ reasoningEffort: "disable" }}
					setApiConfigurationField={setApiConfigurationField}
					modelInfo={{ ...reasoningEffortModelInfo, supportsReasoningEffort: true }}
				/>,
			)

			setApiConfigurationField.mockClear()

			rerender(
				<ThinkingBudget
					{...defaultProps}
					apiConfiguration={{ reasoningEffort: "disable" }}
					setApiConfigurationField={setApiConfigurationField}
					modelInfo={{
						...reasoningEffortModelInfo,
						supportsReasoningEffort: ["low", "high"],
						requiredReasoningEffort: true,
					}}
				/>,
			)

			expect(setApiConfigurationField).toHaveBeenCalledWith("reasoningEffort", "low")
			expect(setApiConfigurationField).toHaveBeenCalledWith("enableReasoningEffort", true, false)
			// The two effects fire only what is needed: no third enableReasoningEffort write.
			expect(setApiConfigurationField).not.toHaveBeenCalledWith("reasoningEffort", "disable")
		})

		it("should use medium when boolean reasoning support is required without an advertised default", () => {
			const setApiConfigurationField = vi.fn()
			render(
				<ThinkingBudget
					{...defaultProps}
					apiConfiguration={{}}
					setApiConfigurationField={setApiConfigurationField}
					modelInfo={{
						...reasoningEffortModelInfo,
						requiredReasoningEffort: true,
					}}
				/>,
			)

			expect(screen.getByTestId("select")).toHaveAttribute("data-value", "medium")
			expect(setApiConfigurationField).toHaveBeenCalledWith("reasoningEffort", "medium")
		})

		it("should synchronize a default when model reasoning metadata changes", () => {
			const setApiConfigurationField = vi.fn()
			const { rerender } = render(
				<ThinkingBudget
					{...defaultProps}
					apiConfiguration={{}}
					setApiConfigurationField={setApiConfigurationField}
					modelInfo={{ ...reasoningEffortModelInfo, supportsReasoningEffort: false }}
				/>,
			)

			setApiConfigurationField.mockClear()
			rerender(
				<ThinkingBudget
					{...defaultProps}
					apiConfiguration={{}}
					setApiConfigurationField={setApiConfigurationField}
					modelInfo={{
						...reasoningEffortModelInfo,
						supportsReasoningEffort: ["disable", "high"],
						reasoningEffort: "high",
					}}
				/>,
			)

			expect(setApiConfigurationField).toHaveBeenCalledWith("reasoningEffort", "high")
		})

		it.each<{
			name: string
			apiConfiguration: ProviderSettings
			modelInfo: ModelInfo
			expected: string
			expectedWrite?: string
		}>([
			{
				name: "keeps a supported stored effort over the model default",
				apiConfiguration: { reasoningEffort: "low", enableReasoningEffort: true },
				modelInfo: {
					...reasoningEffortModelInfo,
					supportsReasoningEffort: ["disable", "low", "high"],
					reasoningEffort: "high",
				},
				expected: "low",
				expectedWrite: undefined,
			},
			{
				name: "normalizes an unsupported stored effort to the model default",
				apiConfiguration: { reasoningEffort: "max", enableReasoningEffort: true },
				modelInfo: {
					...reasoningEffortModelInfo,
					supportsReasoningEffort: ["disable", "low", "high"],
					reasoningEffort: "high",
				},
				expected: "high",
				expectedWrite: "high",
			},
			{
				name: "defaults optional boolean reasoning support to disabled",
				apiConfiguration: {},
				modelInfo: reasoningEffortModelInfo,
				expected: "disable",
				expectedWrite: undefined,
			},
		])("$name", ({ apiConfiguration, modelInfo, expected, expectedWrite }) => {
			const setApiConfigurationField = vi.fn()
			render(
				<ThinkingBudget
					{...defaultProps}
					apiConfiguration={apiConfiguration}
					setApiConfigurationField={setApiConfigurationField}
					modelInfo={modelInfo}
				/>,
			)

			expect(screen.getByTestId("select")).toHaveAttribute("data-value", expected)
			if (expectedWrite) {
				expect(setApiConfigurationField).toHaveBeenCalledWith("reasoningEffort", expectedWrite)
			} else {
				expect(setApiConfigurationField).not.toHaveBeenCalledWith("reasoningEffort", expect.anything())
				expect(setApiConfigurationField).not.toHaveBeenCalledWith(
					"enableReasoningEffort",
					expect.anything(),
					false,
				)
			}
		})

		it("should fall back to rawReasoningEffort when availableOptions is empty", () => {
			// Covers the ?? rawReasoningEffort branch when availableOptions[0] is undefined
			render(
				<ThinkingBudget
					{...defaultProps}
					apiConfiguration={{ reasoningEffort: "medium" }}
					modelInfo={{
						...reasoningEffortModelInfo,
						supportsReasoningEffort: [] as const,
					}}
				/>,
			)

			// With an empty options array, falls back to the stored value "medium"
			expect(screen.getByTestId("select")).toHaveAttribute("data-value", "medium")
		})

		it("should retain the disabled fallback when availableOptions is empty and settings are unset", () => {
			const setApiConfigurationField = vi.fn()
			render(
				<ThinkingBudget
					{...defaultProps}
					apiConfiguration={{}}
					setApiConfigurationField={setApiConfigurationField}
					modelInfo={{
						...reasoningEffortModelInfo,
						supportsReasoningEffort: [] as const,
					}}
				/>,
			)

			expect(screen.getByTestId("select")).toHaveAttribute("data-value", "disable")
			const writtenFields = setApiConfigurationField.mock.calls.map(([field]) => field)
			expect(writtenFields).not.toContain("reasoningEffort")
			expect(writtenFields).not.toContain("enableReasoningEffort")
		})

		it("should show 'disable' option when supportsReasoningEffort array explicitly includes disable", () => {
			render(
				<ThinkingBudget
					{...defaultProps}
					modelInfo={{
						...reasoningEffortModelInfo,
						supportsReasoningEffort: ["disable", "low", "high"],
					}}
				/>,
			)

			expect(screen.getByTestId("reasoning-effort")).toBeInTheDocument()
			// "disable" should be shown when model explicitly includes it in the array
			expect(screen.getByTestId("select-item-disable")).toBeInTheDocument()
			expect(screen.getByTestId("select-item-low")).toBeInTheDocument()
			expect(screen.queryByTestId("select-item-medium")).not.toBeInTheDocument()
			expect(screen.getByTestId("select-item-high")).toBeInTheDocument()
		})

		it("should show 'none' option when supportsReasoningEffort array includes none", () => {
			render(
				<ThinkingBudget
					{...defaultProps}
					modelInfo={{
						...reasoningEffortModelInfo,
						supportsReasoningEffort: ["none", "low", "medium", "high"],
					}}
				/>,
			)

			expect(screen.getByTestId("reasoning-effort")).toBeInTheDocument()
			// Only values from the explicit array should be shown
			expect(screen.queryByTestId("select-item-disable")).not.toBeInTheDocument()
			expect(screen.getByTestId("select-item-none")).toBeInTheDocument()
			expect(screen.getByTestId("select-item-low")).toBeInTheDocument()
			expect(screen.getByTestId("select-item-medium")).toBeInTheDocument()
			expect(screen.getByTestId("select-item-high")).toBeInTheDocument()
		})

		it("should show 'xhigh' option when supportsReasoningEffort array includes xhigh (e.g. gpt-5.5)", () => {
			render(
				<ThinkingBudget
					{...defaultProps}
					modelInfo={{
						...reasoningEffortModelInfo,
						supportsReasoningEffort: ["none", "low", "medium", "high", "xhigh"],
					}}
				/>,
			)

			expect(screen.getByTestId("reasoning-effort")).toBeInTheDocument()
			// Exactly the declared options — no unsupported tiers or auto-added "disable"
			expect(screen.getByTestId("select-item-none")).toBeInTheDocument()
			expect(screen.getByTestId("select-item-low")).toBeInTheDocument()
			expect(screen.getByTestId("select-item-medium")).toBeInTheDocument()
			expect(screen.getByTestId("select-item-high")).toBeInTheDocument()
			expect(screen.getByTestId("select-item-xhigh")).toBeInTheDocument()
			expect(screen.queryByTestId("select-item-disable")).not.toBeInTheDocument()
			expect(screen.queryByTestId("select-item-max")).not.toBeInTheDocument()
		})

		it("should enable reasoning and persist 'xhigh' when xhigh is selected", () => {
			const setApiConfigurationField = vi.fn()

			render(
				<ThinkingBudget
					{...defaultProps}
					setApiConfigurationField={setApiConfigurationField}
					modelInfo={{
						...reasoningEffortModelInfo,
						supportsReasoningEffort: ["none", "low", "medium", "high", "xhigh"],
					}}
				/>,
			)

			fireEvent.click(screen.getByTestId("select-item-xhigh"))

			expect(setApiConfigurationField).toHaveBeenCalledWith("enableReasoningEffort", true)
			expect(setApiConfigurationField).toHaveBeenCalledWith("reasoningEffort", "xhigh")
		})
	})

	describe("configurable max output tokens (supportsMaxTokens)", () => {
		// Mirrors Z.ai GLM models: max output budget plus a reasoning-effort dropdown,
		// but no reasoning-budget control.
		const glmModelInfo: ModelInfo = {
			supportsMaxTokens: true,
			supportsReasoningEffort: ["disable", "medium"],
			maxTokens: 131072,
			contextWindow: 200000,
			supportsPromptCache: true,
		}

		const glmApiConfiguration = { apiProvider: providerIdentifiers.zai, apiModelId: "glm-5.1" } as const

		it("should render the max output tokens slider alongside the reasoning effort dropdown", () => {
			render(<ThinkingBudget {...defaultProps} apiConfiguration={glmApiConfiguration} modelInfo={glmModelInfo} />)

			expect(screen.getByTestId("max-output-tokens")).toBeInTheDocument()
			expect(screen.getByTestId("reasoning-effort")).toBeInTheDocument()
		})

		it("should default the slider to the 20% clamp when modelMaxTokens is unset", () => {
			render(<ThinkingBudget {...defaultProps} apiConfiguration={glmApiConfiguration} modelInfo={glmModelInfo} />)

			// 20% of 200000 = 40000 (the runtime clamp), since maxTokens (131072) exceeds it.
			const slider = screen.getByTestId("max-output-tokens").querySelector("input[type='range']")!
			expect(slider).toHaveValue("40000")
		})

		it("should reflect an explicit modelMaxTokens override on the slider", () => {
			render(
				<ThinkingBudget
					{...defaultProps}
					apiConfiguration={{ ...glmApiConfiguration, modelMaxTokens: 100000 }}
					modelInfo={glmModelInfo}
				/>,
			)

			const slider = screen.getByTestId("max-output-tokens").querySelector("input[type='range']")!
			expect(slider).toHaveValue("100000")
		})

		it("should NOT persist modelMaxTokens on initial render (no user action)", () => {
			const setApiConfigurationField = vi.fn()
			render(
				<ThinkingBudget
					{...defaultProps}
					setApiConfigurationField={setApiConfigurationField}
					apiConfiguration={glmApiConfiguration}
					modelInfo={glmModelInfo}
				/>,
			)

			// Initialization must not write the default clamp back to settings.
			expect(setApiConfigurationField).not.toHaveBeenCalledWith("modelMaxTokens", expect.anything())
			expect(setApiConfigurationField).not.toHaveBeenCalledWith(
				"modelMaxTokens",
				expect.anything(),
				expect.anything(),
			)
		})

		it("should persist modelMaxTokens as a user action when the slider changes", () => {
			const setApiConfigurationField = vi.fn()
			render(
				<ThinkingBudget
					{...defaultProps}
					setApiConfigurationField={setApiConfigurationField}
					apiConfiguration={glmApiConfiguration}
					modelInfo={glmModelInfo}
				/>,
			)

			const slider = screen.getByTestId("max-output-tokens").querySelector("input[type='range']")!
			fireEvent.change(slider, { target: { value: "65536" } })

			// A real user edit persists modelMaxTokens without the isUserAction=false flag.
			expect(setApiConfigurationField).toHaveBeenCalledWith("modelMaxTokens", 65536)
		})

		it("should not render the standalone slider when supportsMaxTokens is absent", () => {
			render(
				<ThinkingBudget
					{...defaultProps}
					apiConfiguration={glmApiConfiguration}
					modelInfo={{
						supportsReasoningEffort: ["disable", "medium"],
						maxTokens: 131072,
						contextWindow: 200000,
						supportsPromptCache: true,
					}}
				/>,
			)

			expect(screen.queryByTestId("max-output-tokens")).not.toBeInTheDocument()
			expect(screen.getByTestId("reasoning-effort")).toBeInTheDocument()
		})
	})

	describe("Anthropic max output tokens override", () => {
		it("should show max output tokens slider for Anthropic hybrid models when reasoning is disabled", () => {
			render(
				<ThinkingBudget
					{...defaultProps}
					apiConfiguration={{ apiProvider: "anthropic", apiModelId: "claude-sonnet-4-5" }}
					modelInfo={{
						supportsReasoningBudget: true,
						maxTokens: 64000,
						contextWindow: 200000,
						supportsPromptCache: true,
					}}
				/>,
			)

			expect(screen.getByTestId("max-output-tokens")).toBeInTheDocument()
			expect(screen.queryByTestId("reasoning-budget")).not.toBeInTheDocument()
			const slider = screen.getByTestId("max-output-tokens").querySelector("input[type='range']")!
			expect(slider).toHaveValue("8192")
			expect(slider.getAttribute("max")).toBe("64000")
		})

		it("should show reasoning budget slider when reasoning is enabled for Anthropic hybrid models", () => {
			render(
				<ThinkingBudget
					{...defaultProps}
					apiConfiguration={{
						apiProvider: "anthropic",
						apiModelId: "claude-sonnet-4-5",
						enableReasoningEffort: true,
					}}
					modelInfo={{
						supportsReasoningBudget: true,
						maxTokens: 64000,
						contextWindow: 200000,
						supportsPromptCache: true,
					}}
				/>,
			)

			expect(screen.queryByTestId("max-output-tokens")).not.toBeInTheDocument()
			expect(screen.getByTestId("reasoning-budget")).toBeInTheDocument()
		})

		it("should show max output tokens slider for Anthropic binary reasoning models", () => {
			render(
				<ThinkingBudget
					{...defaultProps}
					apiConfiguration={{ apiProvider: "anthropic", apiModelId: "claude-sonnet-5" }}
					modelInfo={{
						supportsReasoningBudget: true,
						supportsReasoningBinary: true,
						maxTokens: 128000,
						contextWindow: 1000000,
						supportsPromptCache: true,
					}}
				/>,
			)

			expect(screen.getByTestId("max-output-tokens")).toBeInTheDocument()
		})

		it("should show max output tokens slider for OpenRouter Anthropic models when reasoning is disabled", () => {
			render(
				<ThinkingBudget
					{...defaultProps}
					apiConfiguration={{
						apiProvider: "openrouter",
						apiModelId: "anthropic/claude-sonnet-4-20250514",
					}}
					modelInfo={{
						supportsReasoningBudget: true,
						maxTokens: 64000,
						contextWindow: 200000,
						supportsPromptCache: true,
					}}
				/>,
			)

			expect(screen.getByTestId("max-output-tokens")).toBeInTheDocument()
			const slider = screen.getByTestId("max-output-tokens").querySelector("input[type='range']")!
			expect(slider).toHaveValue("8192")
			expect(slider.getAttribute("max")).toBe("64000")
		})

		it("should show max output tokens slider for non-reasoning Anthropic models", () => {
			render(
				<ThinkingBudget
					{...defaultProps}
					apiConfiguration={{ apiProvider: "anthropic", apiModelId: "claude-3-5-sonnet-20241022" }}
					modelInfo={{
						maxTokens: 8192,
						contextWindow: 200000,
						supportsPromptCache: true,
					}}
				/>,
			)

			expect(screen.getByTestId("max-output-tokens")).toBeInTheDocument()
		})

		it("should use a minimum of 8192 for the Anthropic standalone max output slider", () => {
			render(
				<ThinkingBudget
					{...defaultProps}
					apiConfiguration={{ apiProvider: "anthropic", apiModelId: "claude-sonnet-4-5" }}
					modelInfo={{
						supportsReasoningBudget: true,
						maxTokens: 64000,
						contextWindow: 200000,
						supportsPromptCache: true,
					}}
				/>,
			)

			const slider = screen.getByTestId("max-output-tokens").querySelector("input[type='range']")!
			expect(slider.getAttribute("min")).toBe("8192")
		})

		it("should keep a minimum of 1024 for non-reasoning Anthropic models with small maxTokens", () => {
			render(
				<ThinkingBudget
					{...defaultProps}
					apiConfiguration={{ apiProvider: "anthropic", apiModelId: "claude-3-haiku-20240307" }}
					modelInfo={{
						maxTokens: 4096,
						contextWindow: 200000,
						supportsPromptCache: true,
					}}
				/>,
			)

			const slider = screen.getByTestId("max-output-tokens").querySelector("input[type='range']")!
			expect(slider.getAttribute("min")).toBe("1024")
			expect(slider.getAttribute("max")).toBe("4096")
		})

		it("should clamp modelMaxTokens to 8192 when reasoning is enabled for an Anthropic hybrid model", () => {
			const setApiConfigurationField = vi.fn()

			render(
				<ThinkingBudget
					{...defaultProps}
					setApiConfigurationField={setApiConfigurationField}
					apiConfiguration={{
						apiProvider: "anthropic",
						apiModelId: "claude-sonnet-4-5",
						modelMaxTokens: 1024,
						enableReasoningEffort: true,
					}}
					modelInfo={{
						supportsReasoningBudget: true,
						maxTokens: 64000,
						contextWindow: 200000,
						supportsPromptCache: true,
					}}
				/>,
			)

			expect(setApiConfigurationField).toHaveBeenCalledWith("modelMaxTokens", 8192, false)
		})
	})
})
