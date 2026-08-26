import React from "react"
import { renderWithExtensionState, screen } from "@/utils/test-utils"
import type { ClineMessage, Experiments, HistoryItem, ModelInfo, ProviderSettings } from "@roo-code/types"

import TaskHeader, { TaskHeaderProps } from "../TaskHeader"

// i18n: keys, with exact badge strings for the thinking-effort keys
const effortKeys: Record<string, string> = {
	"chat:thinkingEffort.sourceYou": "you",
	"chat:thinkingEffort.sourceAuto": "Zoo (auto)",
	"chat:thinkingEffort.sourceDefault": "default",
	"chat:thinkingEffort.chipTooltip": "thinking-effort-chip",
}
vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string) => effortKeys[key] ?? key,
	}),
	initReactI18next: {
		type: "3rdParty",
		init: vi.fn(),
	},
}))

const { mockPostMessage } = vi.hoisted(() => ({ mockPostMessage: vi.fn() }))
vi.mock("@/utils/vscode", () => ({
	vscode: {
		postMessage: mockPostMessage,
	},
}))

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeBadge: ({ children }: { children: React.ReactNode }) => <div data-testid="vscode-badge">{children}</div>,
}))

// DTE series 4/5: typed test doubles — structurally valid ExtensionState subset,
// full ModelInfo / HistoryItem values and a ProviderSettings fixture factory
// instead of any-typed assertions.
const makeTaskItem = (id: string): HistoryItem => ({
	id,
	number: 1,
	ts: Date.now(),
	task: "Test task",
	tokensIn: 100,
	tokensOut: 50,
	totalCost: 0.05,
})

const anthropicSettings = (overrides: Pick<ProviderSettings, "reasoningEffort"> = {}): ProviderSettings => ({
	apiProvider: "anthropic",
	apiKey: "test-key",
	apiModelId: "claude-3-opus-20240229",
	...overrides,
})

const baseModelInfo: ModelInfo = {
	contextWindow: 1_000_000,
	maxTokens: 128_000,
	supportsPromptCache: true,
	supportsReasoningEffort: ["low", "medium", "high"],
	reasoningEffort: "medium",
}

const mockState: {
	apiConfiguration: ProviderSettings
	currentTaskItem: HistoryItem | null
	clineMessages: ClineMessage[]
	taskHistory: HistoryItem[]
	experiments: Experiments
	taskThinkingEffort: { effort: string; source: string } | undefined
} = {
	apiConfiguration: anthropicSettings(),
	currentTaskItem: makeTaskItem("test-task-id"),
	clineMessages: [],
	taskHistory: [],
	experiments: { dynamicThinkingEffort: true },
	taskThinkingEffort: undefined,
}
vi.mock("@src/context/ExtensionStateContext", () => ({
	ExtensionStateContextProvider: ({ children }: { children: React.ReactNode }) => children,
	useExtensionState: () => mockState,
}))

vi.mock("@roo/array", () => ({
	findLastIndex: <T,>(array: T[], predicate: (item: T) => boolean): number =>
		array.map(predicate).findLastIndex(Boolean),
}))

let mockModelInfo: ModelInfo = { ...baseModelInfo }
vi.mock("@/components/ui/hooks/useSelectedModel", () => ({
	useSelectedModel: () => ({
		provider: "anthropic",
		id: "test-model",
		info: mockModelInfo,
		isLoading: false,
		isError: false,
	}),
}))

let mockMaxOutputTokens = 0
vi.mock("@roo/api", () => ({
	getModelMaxOutputTokens: () => mockMaxOutputTokens,
}))

describe("TaskHeader - thinking effort chip (DTE series 4/5)", () => {
	const defaultProps: TaskHeaderProps = {
		task: { type: "say", ts: Date.now(), text: "Test task", images: [] },
		tokensIn: 100,
		tokensOut: 50,
		totalCost: 0.05,
		contextTokens: 200,
		buttonsDisabled: false,
		handleCondenseContext: vi.fn(),
	} as TaskHeaderProps

	beforeEach(() => {
		mockMaxOutputTokens = 0
		mockState.experiments = { dynamicThinkingEffort: true }
		mockState.taskThinkingEffort = undefined
		mockState.apiConfiguration = anthropicSettings()
		mockModelInfo = { ...baseModelInfo }
	})

	const renderChip = () => renderWithExtensionState(<TaskHeader {...defaultProps} />)

	it("shows the effective effort with a 'you' source badge for a task-local override", () => {
		mockState.taskThinkingEffort = { effort: "high", source: "you" }
		renderChip()
		expect(screen.getByText("high")).toBeInTheDocument()
		expect(screen.getByText("you")).toBeInTheDocument()
	})

	it("shows the 'Zoo (auto)' source badge for model/parent-sourced overrides", () => {
		mockState.taskThinkingEffort = { effort: "low", source: "model" }
		renderChip()
		expect(screen.getByText("low")).toBeInTheDocument()
		expect(screen.getByText("Zoo (auto)")).toBeInTheDocument()
	})

	it("shows the settings-derived effort with a 'default' source badge", () => {
		mockState.apiConfiguration = anthropicSettings({ reasoningEffort: "medium" })
		renderChip()
		expect(screen.getByText("medium")).toBeInTheDocument()
		expect(screen.getByText("default")).toBeInTheDocument()
	})

	it("shows the adaptive soft-guidance level with 'Zoo (auto)' for boolean-class models", () => {
		mockModelInfo = { ...baseModelInfo, supportsPromptCache: false, supportsReasoningEffort: true }
		renderChip()
		expect(screen.getByText("adaptive")).toBeInTheDocument()
		expect(screen.getByText("Zoo (auto)")).toBeInTheDocument()
	})

	it("shows the chip when the dynamic-thinking-effort experiment is disabled", () => {
		mockState.experiments = { dynamicThinkingEffort: false }
		renderChip()
		// The chip is a normal feature: gated by model capability, not the experiment.
		expect(screen.getByText("medium")).toBeInTheDocument()
		expect(screen.getByText("default")).toBeInTheDocument()
	})

	it("hides the chip when the model does not advertise effort support", () => {
		mockModelInfo = { contextWindow: 1_000_000, maxTokens: 128_000, supportsPromptCache: false }
		renderChip()
		expect(screen.queryByText("medium")).toBeNull()
	})
})
