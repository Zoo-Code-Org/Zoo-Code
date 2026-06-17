// npx vitest src/components/settings/__tests__/ThinkingBudget.spec.tsx

import { render, screen, fireEvent } from "@/utils/test-utils"

import type { ModelInfo } from "@roo-code/types"

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
	Select: ({ children, value, onValueChange: _onValueChange }: any) => (
		<div data-testid="select" data-value={value}>
			{children}
		</div>
	),
	SelectTrigger: ({ children }: any) => <button data-testid="select-trigger">{children}</button>,
	SelectValue: ({ placeholder }: any) => <span data-testid="select-value">{placeholder}</span>,
	SelectContent: ({ children }: any) => <div data-testid="select-content">{children}</div>,
	SelectItem: ({ children, value }: any) => (
		<div data-testid={`select-item-${value}`} data-value={value}>
			{children}
		</div>
	),
}))

vi.mock("@/components/ui/hooks/useSelectedModel", () => ({
	useSelectedModel: (apiConfiguration: any) => {
		// Return the model ID based on apiConfiguration for testing
		// For Gemini tests, check if apiProvider is gemini and use apiModelId
		if (apiConfiguration?.apiProvider === "gemini") {
			return {
				id: apiConfiguration?.apiModelId || "gemini-2.0-flash-exp",
				provider: "gemini",
				info: undefined,
			}
		}
		return {
			id: apiConfiguration?.apiModelId || "claude-3-5-sonnet-20241022",
			provider: apiConfiguration?.apiProvider || "anthropic",
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

	it("should render nothing when model doesn't support thinking", () => {
		const { container } = render(
			<ThinkingBudget
				{...defaultProps}
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
					apiProvider: "gemini",
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
					apiProvider: "gemini",
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
					apiProvider: "anthropic",
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

		const glmApiConfiguration = { apiProvider: "zai", apiModelId: "glm-5.1" } as const

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
})
