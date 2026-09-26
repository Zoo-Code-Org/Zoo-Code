import type { ReactNode } from "react"
import { render, screen, fireEvent } from "@/utils/test-utils"
import { providerIdentifiers } from "@roo-code/types"
import { vscode } from "@/utils/vscode"

import { ChatModelSelector } from "../ChatModelSelector"
import { useChatModelSelector } from "../hooks/useChatModelSelector"

// Mock the dependencies
vi.mock("@/utils/vscode", () => ({
	vscode: {
		postMessage: vi.fn(),
	},
}))

vi.mock("@/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string) => key,
	}),
}))

vi.mock("@/components/ui/hooks/useRooPortal", () => ({
	useRooPortal: () => document.body,
}))

// Mock the ExtensionStateContext
vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({
		apiConfiguration: {
			apiProvider: providerIdentifiers.anthropic,
			apiModelId: "claude-opus-4-20250514",
		},
		organizationAllowList: { allowAll: true, providers: {} },
		currentApiConfigName: "default",
	}),
}))

// Mock useSelectedModel
vi.mock("@/components/ui/hooks/useSelectedModel", () => ({
	useSelectedModel: () => ({ id: "claude-opus-4-20250514", info: undefined }),
}))

// Mock useChatModelSelector hook
vi.mock("../hooks/useChatModelSelector", () => ({
	useChatModelSelector: vi.fn(),
}))

// Mock Popover components to be testable
vi.mock("@/components/ui", () => {
	type PopoverProps = { children: ReactNode; open?: boolean; onOpenChange?: (open: boolean) => void }
	type TriggerProps = {
		children: ReactNode
		disabled?: boolean
		className?: string
		onClick?: () => void
	}
	return {
		Popover: ({ children, open }: PopoverProps) => (
			<div data-testid="popover-root" data-open={open}>
				{children}
			</div>
		),
		PopoverTrigger: ({ children, disabled, className, onClick }: TriggerProps) => (
			<button
				data-testid="chat-model-selector-trigger"
				disabled={disabled}
				className={className}
				onClick={onClick}>
				{children}
			</button>
		),
		PopoverContent: ({ children }: { children: ReactNode }) => <div data-testid="popover-content">{children}</div>,
		StandardTooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
	}
})

const mockUseChatModelSelector = useChatModelSelector as ReturnType<typeof vi.fn>

const anthropicModels = {
	"claude-opus-4-20250514": {
		maxTokens: 32000,
		contextWindow: 200000,
		supportsPromptCache: true,
		supportsImages: true,
	},
	"claude-sonnet-4-20250514": {
		maxTokens: 32000,
		contextWindow: 200000,
		supportsPromptCache: true,
		supportsImages: true,
	},
}

describe("ChatModelSelector", () => {
	const defaultProps = {
		title: "Select model",
	}

	beforeEach(() => {
		vi.clearAllMocks()
		mockUseChatModelSelector.mockReturnValue({
			provider: providerIdentifiers.anthropic,
			models: anthropicModels,
			modelIdKey: "apiModelId",
			defaultModelId: "claude-opus-4-20250514",
			isLoading: false,
		})
	})

	test("renders the trigger with the current model id", () => {
		render(<ChatModelSelector {...defaultProps} />)

		const trigger = screen.getByTestId("chat-model-selector-trigger")
		expect(trigger).toBeInTheDocument()
		expect(trigger).toHaveTextContent("claude-opus-4-20250514")
	})

	test("disables the trigger when disabled prop is true", () => {
		render(<ChatModelSelector {...defaultProps} disabled={true} />)

		const trigger = screen.getByTestId("chat-model-selector-trigger")
		expect(trigger).toBeDisabled()
	})

	test("renders model list when opened", () => {
		render(<ChatModelSelector {...defaultProps} />)

		const trigger = screen.getByTestId("chat-model-selector-trigger")
		fireEvent.click(trigger)

		// The mocked Popover always renders content, so the models are visible.
		// Use testids instead of text queries because the selected model id also
		// appears in the trigger label.
		expect(screen.getByTestId("chat-model-option-claude-opus-4-20250514")).toBeInTheDocument()
		expect(screen.getByTestId("chat-model-option-claude-sonnet-4-20250514")).toBeInTheDocument()
	})

	test("selecting a model posts upsertApiConfiguration message", () => {
		render(<ChatModelSelector {...defaultProps} />)

		const trigger = screen.getByTestId("chat-model-selector-trigger")
		fireEvent.click(trigger)

		const option = screen.getByTestId("chat-model-option-claude-sonnet-4-20250514")
		fireEvent.click(option)

		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "upsertApiConfiguration",
			text: "default",
			apiConfiguration: {
				apiProvider: providerIdentifiers.anthropic,
				apiModelId: "claude-sonnet-4-20250514",
			},
		})
	})

	test("supports custom model via search", () => {
		render(<ChatModelSelector {...defaultProps} />)

		const trigger = screen.getByTestId("chat-model-selector-trigger")
		fireEvent.click(trigger)

		// Type in the search box (present in the always-rendered PopoverContent)
		const searchInput = screen.getByPlaceholderText("chat:searchModel")
		fireEvent.change(searchInput, { target: { value: "claude-3-5-haiku" } })

		const customOption = screen.getByTestId("chat-model-use-custom")
		fireEvent.click(customOption)

		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "upsertApiConfiguration",
			text: "default",
			apiConfiguration: {
				apiProvider: providerIdentifiers.anthropic,
				apiModelId: "claude-3-5-haiku",
			},
		})
	})
})
