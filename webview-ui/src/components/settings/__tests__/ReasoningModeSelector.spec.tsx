// npx vitest src/components/settings/__tests__/ReasoningModeSelector.spec.tsx

import React from "react"

import { render, screen, fireEvent } from "@/utils/test-utils"

import type { ModelInfo } from "@roo-code/types"

import { ReasoningModeSelector } from "../ReasoningModeSelector"

// Mock the Select primitives so we can drive selection without Radix deps.
vi.mock("@/components/ui", () => ({
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

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string) => key,
	}),
}))

describe("ReasoningModeSelector", () => {
	const mockSetApiConfigurationField = vi.fn()

	const baseModelInfo: ModelInfo = {
		contextWindow: 200000,
		supportsPromptCache: true,
	}

	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("renders nothing when the model does not support reasoning effort", () => {
		render(
			<ReasoningModeSelector
				apiConfiguration={{} as any}
				setApiConfigurationField={mockSetApiConfigurationField}
				modelInfo={baseModelInfo}
			/>,
		)

		expect(screen.queryByTestId("reasoning-effort")).toBeNull()
		expect(screen.queryByTestId("select")).toBeNull()
	})

	it("renders nothing when no model info is available", () => {
		render(
			<ReasoningModeSelector
				apiConfiguration={{} as any}
				setApiConfigurationField={mockSetApiConfigurationField}
				modelInfo={undefined}
			/>,
		)

		expect(screen.queryByTestId("reasoning-effort")).toBeNull()
	})

	it("shows [disable, low, medium, high] when supportsReasoningEffort is boolean true", () => {
		render(
			<ReasoningModeSelector
				apiConfiguration={{} as any}
				setApiConfigurationField={mockSetApiConfigurationField}
				modelInfo={{ ...baseModelInfo, supportsReasoningEffort: true }}
			/>,
		)

		const select = screen.getByTestId("select")
		// default is "disable"
		expect(select.getAttribute("data-value")).toBe("disable")

		expect(screen.getByTestId("select-item-disable")).toBeInTheDocument()
		expect(screen.getByTestId("select-item-low")).toBeInTheDocument()
		expect(screen.getByTestId("select-item-medium")).toBeInTheDocument()
		expect(screen.getByTestId("select-item-high")).toBeInTheDocument()
		// boolean true never synthesizes "max"
		expect(screen.queryByTestId("select-item-max")).toBeNull()
	})

	it("shows exactly the advertised array values (e.g. Ollama thinking models)", () => {
		render(
			<ReasoningModeSelector
				apiConfiguration={{} as any}
				setApiConfigurationField={mockSetApiConfigurationField}
				modelInfo={{ ...baseModelInfo, supportsReasoningEffort: ["low", "medium", "high", "max"] }}
			/>,
		)

		expect(screen.getByTestId("select-item-low")).toBeInTheDocument()
		expect(screen.getByTestId("select-item-medium")).toBeInTheDocument()
		expect(screen.getByTestId("select-item-high")).toBeInTheDocument()
		expect(screen.getByTestId("select-item-max")).toBeInTheDocument()
		// An explicit array must not auto-add a "disable" option.
		expect(screen.queryByTestId("select-item-disable")).toBeNull()
	})

	it("selecting a non-disable effort enables reasoning and persists the effort", () => {
		render(
			<ReasoningModeSelector
				apiConfiguration={{} as any}
				setApiConfigurationField={mockSetApiConfigurationField}
				modelInfo={{ ...baseModelInfo, supportsReasoningEffort: true }}
			/>,
		)

		// The mocked SelectItem wires onClick to the Select's onValueChange.
		fireEvent.click(screen.getByTestId("select-item-high"))

		expect(mockSetApiConfigurationField).toHaveBeenCalledWith("enableReasoningEffort", true)
		expect(mockSetApiConfigurationField).toHaveBeenCalledWith("reasoningEffort", "high")
	})

	it("selecting 'disable' turns reasoning off and persists the disable sentinel", () => {
		render(
			<ReasoningModeSelector
				apiConfiguration={{ enableReasoningEffort: true, reasoningEffort: "high" } as any}
				setApiConfigurationField={mockSetApiConfigurationField}
				modelInfo={{ ...baseModelInfo, supportsReasoningEffort: true }}
			/>,
		)

		fireEvent.click(screen.getByTestId("select-item-disable"))

		expect(mockSetApiConfigurationField).toHaveBeenCalledWith("enableReasoningEffort", false)
		expect(mockSetApiConfigurationField).toHaveBeenCalledWith("reasoningEffort", "disable")
	})

	it("reflects the currently persisted reasoning effort as the select value", () => {
		render(
			<ReasoningModeSelector
				apiConfiguration={{ reasoningEffort: "medium" } as any}
				setApiConfigurationField={mockSetApiConfigurationField}
				modelInfo={{ ...baseModelInfo, supportsReasoningEffort: ["low", "medium", "high"] }}
			/>,
		)

		expect(screen.getByTestId("select").getAttribute("data-value")).toBe("medium")
	})
})
