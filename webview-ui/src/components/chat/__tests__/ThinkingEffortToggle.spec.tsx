import React from "react"
import { fireEvent, render, screen, within } from "@/utils/test-utils"
import type { ModelInfo, ProviderSettings } from "@roo-code/types"

import { ThinkingEffortToggle } from "../ThinkingEffortToggle"

const mockPostMessage = vi.hoisted(() => vi.fn())
vi.mock("@src/utils/vscode", () => ({
	vscode: {
		postMessage: mockPostMessage,
	},
}))

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string) => key,
	}),
}))

vi.mock("@src/components/ui/hooks/useRooPortal", () => ({
	useRooPortal: () => document.body,
}))

const mockState: {
	experiments: Record<string, boolean>
	apiConfiguration: ProviderSettings
	taskThinkingEffort: { effort: string; source: string } | undefined
} = {
	experiments: { dynamicThinkingEffort: true },
	apiConfiguration: { reasoningEffort: "low" } as ProviderSettings,
	taskThinkingEffort: undefined,
}
vi.mock("@src/context/ExtensionStateContext", () => ({
	useExtensionState: () => mockState,
}))

let mockModelInfo: ModelInfo = {
	contextWindow: 1_000_000,
	maxTokens: 128_000,
	supportsPromptCache: true,
	supportsReasoningEffort: ["disable", "low", "medium", "high", "max"],
}
vi.mock("@src/components/ui/hooks/useSelectedModel", () => ({
	useSelectedModel: () => ({ id: "test-model", info: mockModelInfo }),
}))

// Faithful popover double: the trigger flips the open state; content mounts only while open.
const PopoverState = React.createContext<{ open: boolean; setOpen: (open: boolean) => void } | null>(null)
vi.mock("@src/components/ui", () => ({
	Popover: ({
		children,
		open,
		onOpenChange,
	}: {
		children: React.ReactNode
		open: boolean
		onOpenChange?: (open: boolean) => void
	}) => (
		<PopoverState.Provider value={{ open, setOpen: (next) => onOpenChange?.(next) }}>
			{children}
		</PopoverState.Provider>
	),
	PopoverTrigger: (props: {
		children?: React.ReactNode
		disabled?: boolean
		className?: string
		"data-testid"?: string
	}) => {
		const state = React.useContext(PopoverState)
		const { children, ...rest } = props
		return (
			<button {...rest} onClick={() => state?.setOpen(true)}>
				{children}
			</button>
		)
	},
	PopoverContent: (props: { children?: React.ReactNode; "data-testid"?: string }) => {
		const state = React.useContext(PopoverState)
		if (!state?.open) {
			return null
		}
		const { children, ...rest } = props
		return <div {...rest}>{children}</div>
	},
	StandardTooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

const renderToggle = (props: { disabled?: boolean } = {}) => render(<ThinkingEffortToggle {...props} />)

const openMenu = () => {
	fireEvent.click(screen.getByTestId("thinking-effort-toggle-trigger"))
	return screen.getByTestId("thinking-effort-toggle-menu")
}

const option = (level: string) => screen.getByTestId("thinking-effort-option-" + level)

describe("ThinkingEffortToggle (DTE series 4/5)", () => {
	beforeEach(() => {
		mockPostMessage.mockClear()
		mockState.experiments = { dynamicThinkingEffort: true }
		mockState.apiConfiguration = { reasoningEffort: "low" } as ProviderSettings
		mockState.taskThinkingEffort = undefined
		mockModelInfo = {
			contextWindow: 1_000_000,
			maxTokens: 128_000,
			supportsPromptCache: true,
			supportsReasoningEffort: ["disable", "low", "medium", "high", "max"],
		}
	})

	it("renders when the dynamic-thinking-effort experiment is disabled", () => {
		mockState.experiments = { dynamicThinkingEffort: false }
		renderToggle()
		// The manual toggle is a normal feature: gated by model capability, not the experiment.
		expect(screen.getByTestId("thinking-effort-toggle-trigger")).toBeInTheDocument()
		expect(screen.getByTestId("thinking-effort-toggle-trigger")).toHaveAttribute(
			"aria-label",
			"chat:thinkingEffort.toggleTitle",
		)
	})

	it("exposes the localized accessible name on the icon-only trigger", () => {
		renderToggle()
		// The mocked i18n returns keys, so the exact localized label is the raw key.
		expect(screen.getByTestId("thinking-effort-toggle-trigger")).toHaveAttribute(
			"aria-label",
			"chat:thinkingEffort.toggleTitle",
		)
	})

	it("renders nothing when the model does not advertise effort support", () => {
		mockModelInfo = { contextWindow: 1_000_000, maxTokens: 128_000, supportsPromptCache: false }
		const { container } = renderToggle()
		expect(screen.queryByTestId("thinking-effort-toggle-trigger")).toBeNull()
		expect(container.textContent).toBe("")
	})

	it("renders nothing when the capability array only advertises the disable sentinel", () => {
		mockModelInfo = {
			contextWindow: 1_000_000,
			maxTokens: 128_000,
			supportsPromptCache: false,
			supportsReasoningEffort: ["disable"],
		}
		const { container } = renderToggle()
		expect(screen.queryByTestId("thinking-effort-toggle-trigger")).toBeNull()
		expect(container.textContent).toBe("")
	})

	it("lists only the model-supported levels (never the disable sentinel)", () => {
		renderToggle()
		const menu = openMenu()
		expect(menu).toHaveTextContent("chat:thinkingEffort.toggleTitle")
		for (const level of ["low", "medium", "high", "max"]) {
			expect(within(menu).getByTestId("thinking-effort-option-" + level)).toBeInTheDocument()
		}
		expect(screen.queryByTestId("thinking-effort-option-disable")).toBeNull()
	})

	it("marks the currently effective level and follows the task-local override", () => {
		const view = renderToggle()
		openMenu()
		expect(option("low").querySelector("svg")).not.toBeNull()
		expect(option("high").querySelector("svg")).toBeNull()
		fireEvent.click(screen.getByTestId("thinking-effort-toggle-trigger"))

		mockState.taskThinkingEffort = { effort: "high", source: "you" }
		view.rerender(<ThinkingEffortToggle />)
		openMenu()
		expect(option("high").querySelector("svg")).not.toBeNull()
		expect(option("low").querySelector("svg")).toBeNull()
	})

	it("posts a task-local set request when a level is selected and closes the menu", () => {
		renderToggle()
		openMenu()
		fireEvent.click(option("max"))

		expect(mockPostMessage).toHaveBeenCalledWith({ type: "setTaskThinkingEffort", effort: "max" })
		expect(screen.queryByTestId("thinking-effort-toggle-menu")).toBeNull()
	})

	it("dims and disables the trigger when the disabled prop is set", () => {
		renderToggle({ disabled: true })
		expect(screen.getByTestId("thinking-effort-toggle-trigger")).toHaveClass("opacity-50")
		// The trigger button still mounts while disabled (Radix blocks the open).
		fireEvent.click(screen.getByTestId("thinking-effort-toggle-trigger"))
		expect(screen.queryByTestId("thinking-effort-toggle-menu")).toBeNull()
	})

	it("highlights the trigger icon for a user-sourced override", () => {
		mockState.taskThinkingEffort = { effort: "medium", source: "you" }
		renderToggle()
		const icon = screen.getByTestId("thinking-effort-toggle-trigger").querySelector("svg")
		expect(icon).toHaveClass("text-vscode-textLink-foreground")
	})

	it("shows the current effective effort value in the trigger", () => {
		// Settings-derived default.
		const view = renderToggle()
		expect(screen.getByTestId("thinking-effort-toggle-trigger")).toHaveTextContent("low")
		// Follows the task-local override.
		mockState.taskThinkingEffort = { effort: "high", source: "you" }
		view.rerender(<ThinkingEffortToggle />)
		expect(screen.getByTestId("thinking-effort-toggle-trigger")).toHaveTextContent("high")
	})

	it("applies the sibling-selector hover treatment when enabled", () => {
		renderToggle()
		const trigger = screen.getByTestId("thinking-effort-toggle-trigger")
		expect(trigger).toHaveClass("hover:border-vscode-focusBorder")
		expect(trigger).toHaveClass("hover:bg-vscode-toolbar-hoverBackground")
	})

	it("drops the user highlight when the override lands on the resolved default", () => {
		// settings effort is "low" — a user override to "low" displays as default.
		mockState.taskThinkingEffort = { effort: "low", source: "you" }
		renderToggle()
		const icon = screen.getByTestId("thinking-effort-toggle-trigger").querySelector("svg")
		expect(icon).not.toHaveClass("text-vscode-textLink-foreground")
	})

	it("shows the adaptive soft-guidance hint and a single adaptive level for boolean-class models", () => {
		mockModelInfo = {
			contextWindow: 1_000_000,
			maxTokens: 128_000,
			supportsPromptCache: false,
			supportsReasoningEffort: true,
		}
		mockState.apiConfiguration = {} as ProviderSettings
		renderToggle()
		const menu = openMenu()
		expect(menu).toHaveTextContent("chat:thinkingEffort.adaptiveHint")
		expect(within(menu).getByTestId("thinking-effort-option-adaptive")).toBeInTheDocument()
		fireEvent.click(within(menu).getByTestId("thinking-effort-option-adaptive"))
		expect(mockPostMessage).toHaveBeenCalledWith({ type: "setTaskThinkingEffort", effort: "adaptive" })
	})
})
