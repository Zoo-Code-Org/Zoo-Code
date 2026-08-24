import React from "react"
import { renderWithExtensionState, screen } from "@/utils/test-utils"
import type { ProviderSettings } from "@roo-code/types"

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

const mockState: {
	apiConfiguration: ProviderSettings
	currentTaskItem: { id: string } | null
	clineMessages: any[]
	taskHistory: any[]
	experiments: Record<string, boolean>
	taskThinkingEffort: { effort: string; source: string } | undefined
} = {
	apiConfiguration: {
		apiProvider: "anthropic",
		apiKey: "test-key",
		apiModelId: "claude-3-opus-20240229",
	} as ProviderSettings,
	currentTaskItem: { id: "test-task-id" },
	clineMessages: [],
	taskHistory: [],
	experiments: { dynamicThinkingEffort: true },
	taskThinkingEffort: undefined,
}
vi.mock("@src/context/ExtensionStateContext", () => ({
	ExtensionStateContextProvider: ({ children }: any) => children,
	useExtensionState: () => mockState,
}))

vi.mock("@roo/array", () => ({
	findLastIndex: (array: any[], predicate: (item: any) => boolean) => array.map(predicate).findLastIndex(Boolean),
}))

let mockModelInfo: any = {
	contextWindow: 1_000_000,
	maxTokens: 128_000,
	supportsPromptCache: true,
	supportsReasoningEffort: ["low", "medium", "high"],
	reasoningEffort: "medium",
}
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
		mockState.apiConfiguration = {
			apiProvider: "anthropic",
			apiKey: "test-key",
			apiModelId: "claude-3-opus-20240229",
		} as ProviderSettings
		mockModelInfo = {
			contextWindow: 1_000_000,
			maxTokens: 128_000,
			supportsPromptCache: true,
			supportsReasoningEffort: ["low", "medium", "high"],
			reasoningEffort: "medium",
		}
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
		mockState.apiConfiguration = { apiProvider: "anthropic", reasoningEffort: "medium" } as ProviderSettings
		renderChip()
		expect(screen.getByText("medium")).toBeInTheDocument()
		expect(screen.getByText("default")).toBeInTheDocument()
	})

	it("shows the adaptive soft-guidance level with 'Zoo (auto)' for boolean-class models", () => {
		mockModelInfo = {
			contextWindow: 1_000_000,
			maxTokens: 128_000,
			supportsPromptCache: false,
			supportsReasoningEffort: true,
		}
		renderChip()
		expect(screen.getByText("adaptive")).toBeInTheDocument()
		expect(screen.getByText("Zoo (auto)")).toBeInTheDocument()
	})

	it("hides the chip when the dynamic-thinking-effort experiment is disabled", () => {
		mockState.experiments = { dynamicThinkingEffort: false }
		renderChip()
		expect(screen.queryByText("medium")).toBeNull()
	})

	it("hides the chip when the model does not advertise effort support", () => {
		mockModelInfo = { contextWindow: 1_000_000, maxTokens: 128_000, supportsPromptCache: false }
		renderChip()
		expect(screen.queryByText("medium")).toBeNull()
	})
})
