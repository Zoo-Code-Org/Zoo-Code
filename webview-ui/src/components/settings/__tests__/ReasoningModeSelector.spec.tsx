// npx vitest src/components/settings/__tests__/ReasoningModeSelector.spec.tsx

import React from "react"
import type { ReactNode } from "react"

import { render, screen, fireEvent } from "@/utils/test-utils"

import type { ModelInfo, ProviderSettings } from "@roo-code/types"

import { ReasoningModeSelector } from "../ReasoningModeSelector"

// Typed mock-prop interfaces for the Select primitives. Keeping these typed
// means a prop rename on the real Select components surfaces here as a compile
// error instead of being silently swallowed by `any`.
interface SelectMockProps {
	children?: ReactNode
	value?: string
	onValueChange?: (value: string) => void
}
interface SelectTriggerMockProps {
	children?: ReactNode
	className?: string
}
interface SelectValueMockProps {
	placeholder?: string
}
interface SelectContentMockProps {
	children?: ReactNode
	onValueChange?: (value: string) => void
}
interface SelectItemMockProps {
	children?: ReactNode
	value: string
	onValueChange?: (value: string) => void
}

// Mock the Select primitives so we can drive selection without Radix deps.
vi.mock("@/components/ui", () => ({
	Select: ({ children, value, onValueChange }: SelectMockProps) => (
		<div data-testid="select" data-value={value} data-onvaluechange={onValueChange}>
			{React.Children.map(children, (child) =>
				React.isValidElement(child)
					? React.cloneElement(child as React.ReactElement, { onValueChange })
					: child,
			)}
		</div>
	),
	SelectTrigger: ({ children }: SelectTriggerMockProps) => <button data-testid="select-trigger">{children}</button>,
	SelectValue: ({ placeholder }: SelectValueMockProps) => <span data-testid="select-value">{placeholder}</span>,
	SelectContent: ({ children, onValueChange }: SelectContentMockProps) => (
		<div data-testid="select-content">
			{React.Children.map(children, (child) =>
				React.isValidElement(child)
					? React.cloneElement(child as React.ReactElement, { onValueChange })
					: child,
			)}
		</div>
	),
	SelectItem: ({ children, value, onValueChange }: SelectItemMockProps) => (
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

// Minimal typed ModelInfo fixture. ProviderSettings and ModelInfo are Zod
// objects whose fields are all optional, so an empty object is a valid value —
// no `as any` is needed. Spread in capability overrides per scenario.
const baseModelInfo: ModelInfo = {
	contextWindow: 200000,
	supportsPromptCache: true,
}

describe("ReasoningModeSelector", () => {
	const mockSetApiConfigurationField = vi.fn()

	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("renders nothing when the model does not support reasoning effort", () => {
		const apiConfiguration: ProviderSettings = {}

		render(
			<ReasoningModeSelector
				apiConfiguration={apiConfiguration}
				setApiConfigurationField={mockSetApiConfigurationField}
				modelInfo={baseModelInfo}
			/>,
		)

		expect(screen.queryByTestId("reasoning-effort")).toBeNull()
		expect(screen.queryByTestId("select")).toBeNull()
	})

	it("renders nothing when no model info is available", () => {
		const apiConfiguration: ProviderSettings = {}

		render(
			<ReasoningModeSelector
				apiConfiguration={apiConfiguration}
				setApiConfigurationField={mockSetApiConfigurationField}
				modelInfo={undefined}
			/>,
		)

		expect(screen.queryByTestId("reasoning-effort")).toBeNull()
	})

	it("shows [disable, low, medium, high] when supportsReasoningEffort is boolean true", () => {
		const apiConfiguration: ProviderSettings = {}

		render(
			<ReasoningModeSelector
				apiConfiguration={apiConfiguration}
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
		// The fetcher advertises a verbatim array including "disable" for models
		// that honor think: false (qwen3) and omitting it for models that don't
		// (gpt-oss). The selector must surface the array as-is — no "none"
		// prepend, no auto-added "disable" for explicit arrays.
		const apiConfiguration: ProviderSettings = {}

		render(
			<ReasoningModeSelector
				apiConfiguration={apiConfiguration}
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
		const apiConfiguration: ProviderSettings = {}

		render(
			<ReasoningModeSelector
				apiConfiguration={apiConfiguration}
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
		const apiConfiguration: ProviderSettings = {
			enableReasoningEffort: true,
			reasoningEffort: "high",
		}

		render(
			<ReasoningModeSelector
				apiConfiguration={apiConfiguration}
				setApiConfigurationField={mockSetApiConfigurationField}
				modelInfo={{ ...baseModelInfo, supportsReasoningEffort: true }}
			/>,
		)

		fireEvent.click(screen.getByTestId("select-item-disable"))

		expect(mockSetApiConfigurationField).toHaveBeenCalledWith("enableReasoningEffort", false)
		expect(mockSetApiConfigurationField).toHaveBeenCalledWith("reasoningEffort", "disable")
	})

	it("reflects the currently persisted reasoning effort as the select value", () => {
		const apiConfiguration: ProviderSettings = {
			reasoningEffort: "medium",
		}

		render(
			<ReasoningModeSelector
				apiConfiguration={apiConfiguration}
				setApiConfigurationField={mockSetApiConfigurationField}
				modelInfo={{ ...baseModelInfo, supportsReasoningEffort: ["low", "medium", "high"] }}
			/>,
		)

		expect(screen.getByTestId("select").getAttribute("data-value")).toBe("medium")
	})
})
