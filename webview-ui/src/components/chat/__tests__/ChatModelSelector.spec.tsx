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

// Mock the ExtensionStateContext (configurable per test)
const { mockUseExtensionState } = vi.hoisted(() => ({
	mockUseExtensionState: vi.fn(),
}))

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: (...args: unknown[]) => mockUseExtensionState(...args),
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

// Minimal ModelInfo factory for ad-hoc fixtures.
const modelInfo = (overrides: Record<string, unknown> = {}) => ({
	maxTokens: 32000,
	contextWindow: 200000,
	supportsPromptCache: true,
	...overrides,
})

describe("ChatModelSelector", () => {
	const defaultProps = {
		title: "Select model",
	}

	/** Helper: render the selector and open the popover so options are visible. */
	const renderOpen = (disabled = false) => {
		render(<ChatModelSelector {...defaultProps} disabled={disabled} />)
		fireEvent.click(screen.getByTestId("chat-model-selector-trigger"))
	}

	/** Helper: read the visible option ids in DOM order. */
	const visibleOptionIds = () =>
		screen
			.getAllByTestId(/^chat-model-option-/)
			.map((element) => element.getAttribute("data-testid")!.replace("chat-model-option-", ""))

	beforeEach(() => {
		vi.clearAllMocks()
		mockUseExtensionState.mockReturnValue({
			apiConfiguration: {
				apiProvider: providerIdentifiers.anthropic,
				apiModelId: "claude-opus-4-20250514",
			},
			organizationAllowList: { allowAll: true, providers: {} },
			currentApiConfigName: "default",
		})
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

	test("clears the search query via the clear button", () => {
		render(<ChatModelSelector {...defaultProps} />)

		const trigger = screen.getByTestId("chat-model-selector-trigger")
		fireEvent.click(trigger)

		const searchInput = screen.getByPlaceholderText("chat:searchModel") as HTMLInputElement
		fireEvent.change(searchInput, { target: { value: "claude-3" } })
		expect(searchInput.value).toBe("claude-3")

		const clearButton = searchInput.parentElement?.querySelector(".codicon-close") as HTMLElement | null
		expect(clearButton).toBeTruthy()
		fireEvent.click(clearButton!)

		expect((screen.getByPlaceholderText("chat:searchModel") as HTMLInputElement).value).toBe("")
	})

	test("filters model ids case-insensitively", () => {
		mockUseChatModelSelector.mockReturnValue({
			provider: providerIdentifiers.anthropic,
			models: {
				"Claude-Opus-4": modelInfo(),
				"Claude-Sonnet-4": modelInfo(),
			},
			modelIdKey: "apiModelId",
			defaultModelId: "Claude-Opus-4",
			isLoading: false,
		})

		renderOpen()

		// Uppercase query must match the lowercase portion of the model id.
		fireEvent.change(screen.getByPlaceholderText("chat:searchModel"), { target: { value: "SONNET" } })

		expect(screen.getByTestId("chat-model-option-Claude-Sonnet-4")).toBeInTheDocument()
		expect(screen.queryByTestId("chat-model-option-Claude-Opus-4")).not.toBeInTheDocument()
	})

	test("renders the empty state when no models are available", () => {
		mockUseChatModelSelector.mockReturnValue({
			provider: providerIdentifiers.anthropic,
			models: {},
			modelIdKey: "apiModelId",
			defaultModelId: "claude-opus-4-20250514",
			isLoading: false,
		})

		renderOpen()

		expect(screen.getByText("chat:modelListEmpty")).toBeInTheDocument()
		expect(screen.queryByTestId(/^chat-model-option-/)).not.toBeInTheDocument()
	})

	test("shows a loading label and hides the empty state while loading", () => {
		mockUseChatModelSelector.mockReturnValue({
			provider: providerIdentifiers.anthropic,
			models: null,
			modelIdKey: "apiModelId",
			defaultModelId: "claude-opus-4-20250514",
			isLoading: true,
		})

		render(<ChatModelSelector {...defaultProps} />)

		// The trigger collapses to an ellipsis while loading, regardless of the
		// resolved display/default value.
		expect(screen.getByTestId("chat-model-selector-trigger")).toHaveTextContent("…")
		// The empty-state message must not appear while a load is in flight.
		expect(screen.queryByText("chat:modelListEmpty")).not.toBeInTheDocument()
	})

	test("does not post a message when selecting with no apiConfiguration", () => {
		// Keep modelIdKey defined so the guard under test is the `!apiConfiguration`
		// early return, not the `!modelIdKey` guard.
		mockUseExtensionState.mockReturnValue({
			apiConfiguration: undefined,
			organizationAllowList: { allowAll: true, providers: {} },
			currentApiConfigName: "default",
		})

		renderOpen()

		fireEvent.click(screen.getByTestId("chat-model-option-claude-opus-4-20250514"))

		expect(vscode.postMessage).not.toHaveBeenCalled()
	})

	test("renders the display-transformed value for compound configs (e.g. VSCode LM)", () => {
		mockUseExtensionState.mockReturnValue({
			apiConfiguration: {
				apiProvider: providerIdentifiers.vscodeLm,
				vsCodeLmModelSelector: { vendor: "copilot", family: "gpt-4o" },
			},
			organizationAllowList: { allowAll: true, providers: {} },
			currentApiConfigName: "default",
		})
		mockUseChatModelSelector.mockReturnValue({
			provider: providerIdentifiers.vscodeLm,
			models: { "copilot/gpt-4o": { maxTokens: 1, contextWindow: 1 } },
			modelIdKey: "vsCodeLmModelSelector",
			defaultModelId: undefined,
			isLoading: false,
			displayTransform: (value: unknown) => {
				const selector = value as { vendor?: string; family?: string }
				return selector.vendor && selector.family ? `${selector.vendor}/${selector.family}` : ""
			},
		})

		render(<ChatModelSelector {...defaultProps} />)

		// The trigger shows the display-transformed value instead of the raw model id.
		const trigger = screen.getByTestId("chat-model-selector-trigger")
		expect(trigger).toHaveTextContent("copilot/gpt-4o")
	})

	describe("organization allow-list", () => {
		test("filters models down to the provider allow-list", () => {
			mockUseExtensionState.mockReturnValue({
				apiConfiguration: {
					apiProvider: providerIdentifiers.anthropic,
					apiModelId: "test-model-not-real",
				},
				organizationAllowList: {
					allowAll: false,
					providers: {
						[providerIdentifiers.anthropic]: {
							allowAll: false,
							models: ["claude-sonnet-4-20250514"],
						},
					},
				},
				currentApiConfigName: "default",
			})

			renderOpen()

			expect(screen.getByTestId("chat-model-option-claude-sonnet-4-20250514")).toBeInTheDocument()
			expect(screen.queryByTestId("chat-model-option-claude-opus-4-20250514")).not.toBeInTheDocument()
		})

		test("shows the empty state when the provider is absent from the allow-list", () => {
			mockUseExtensionState.mockReturnValue({
				apiConfiguration: {
					apiProvider: providerIdentifiers.anthropic,
					apiModelId: "test-model-not-real",
				},
				organizationAllowList: { allowAll: false, providers: {} },
				currentApiConfigName: "default",
			})

			renderOpen()

			expect(screen.queryByTestId(/^chat-model-option-/)).not.toBeInTheDocument()
			expect(screen.getByText("chat:modelListEmpty")).toBeInTheDocument()
		})

		test("hides the custom-model row when the allow-list forbids the typed id", () => {
			mockUseExtensionState.mockReturnValue({
				apiConfiguration: {
					apiProvider: providerIdentifiers.anthropic,
					apiModelId: "test-model-not-real",
				},
				organizationAllowList: {
					allowAll: false,
					providers: {
						[providerIdentifiers.anthropic]: {
							allowAll: false,
							models: ["claude-opus-4-20250514"],
						},
					},
				},
				currentApiConfigName: "default",
			})

			renderOpen()

			fireEvent.change(screen.getByPlaceholderText("chat:searchModel"), {
				target: { value: "unauthorized-model" },
			})

			expect(screen.queryByTestId("chat-model-use-custom")).not.toBeInTheDocument()
		})

		test("offers and posts the custom-model row when the allow-list permits it", () => {
			mockUseExtensionState.mockReturnValue({
				apiConfiguration: {
					apiProvider: providerIdentifiers.anthropic,
					apiModelId: "test-model-not-real",
				},
				organizationAllowList: {
					allowAll: false,
					providers: {
						[providerIdentifiers.anthropic]: {
							allowAll: false,
							models: ["claude-opus-4-20250514", "approved-custom"],
						},
					},
				},
				currentApiConfigName: "default",
			})
			mockUseChatModelSelector.mockReturnValue({
				provider: providerIdentifiers.anthropic,
				models: { "claude-opus-4-20250514": modelInfo() },
				modelIdKey: "apiModelId",
				defaultModelId: "claude-opus-4-20250514",
				isLoading: false,
			})

			renderOpen()

			fireEvent.change(screen.getByPlaceholderText("chat:searchModel"), {
				target: { value: "approved-custom" },
			})

			fireEvent.click(screen.getByTestId("chat-model-use-custom"))

			expect(vscode.postMessage).toHaveBeenCalledWith({
				type: "upsertApiConfiguration",
				text: "default",
				apiConfiguration: {
					apiProvider: providerIdentifiers.anthropic,
					apiModelId: "approved-custom",
				},
			})
		})
	})

	test("guards the visible list: sorts ids, drops unselected deprecated models and keeps the selected one", () => {
		mockUseChatModelSelector.mockReturnValue({
			provider: providerIdentifiers.anthropic,
			// Intentionally unsorted, with one deprecated model that is also the
			// selected one (must survive) and one deprecated model that is not.
			models: {
				"zeta-model": modelInfo(),
				"claude-opus-4-20250514": modelInfo({ deprecated: true }),
				"legacy-model": modelInfo({ deprecated: true }),
				"alpha-model": modelInfo(),
				"middle-model": modelInfo(),
			},
			modelIdKey: "apiModelId",
			defaultModelId: "claude-opus-4-20250514",
			isLoading: false,
		})

		renderOpen()

		// Rendered ids are sorted alphabetically and exclude the unselected deprecated model.
		expect(visibleOptionIds()).toEqual(["alpha-model", "claude-opus-4-20250514", "middle-model", "zeta-model"])
		expect(screen.queryByTestId("chat-model-option-legacy-model")).not.toBeInTheDocument()
		expect(screen.getByTestId("chat-model-option-claude-opus-4-20250514")).toBeInTheDocument()
	})

	test("disables the trigger when there is no modelIdKey", () => {
		mockUseChatModelSelector.mockReturnValue({
			provider: undefined,
			models: null,
			modelIdKey: undefined,
			defaultModelId: "",
			isLoading: false,
		})

		render(<ChatModelSelector {...defaultProps} />)

		const trigger = screen.getByTestId("chat-model-selector-trigger")
		expect(trigger).toBeDisabled()
		expect(trigger).toHaveClass("cursor-not-allowed")
	})

	test("exposes model options as keyboard-activatable buttons", () => {
		renderOpen()

		const option = screen.getByTestId("chat-model-option-claude-sonnet-4-20250514")
		// A native <button type="button"> is in the tab order (tabIndex 0) and is
		// activated by Enter/Space, giving the option keyboard accessibility.
		expect(option.tagName).toBe("BUTTON")
		expect(option).toHaveAttribute("type", "button")
		expect(option.tabIndex).toBe(0)
		// Keyboard focus styling must be present so focus is visible.
		expect(option).toHaveClass("focus-visible:ring-vscode-focusBorder")

		// Simulate the activation a keyboard Enter/Space would trigger on a
		// native button (jsdom does not synthesise the click itself).
		fireEvent.click(option)

		expect(vscode.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "upsertApiConfiguration" }))
	})

	test("keeps the trigger keyboard focusable with a visible focus ring", () => {
		render(<ChatModelSelector {...defaultProps} />)

		const trigger = screen.getByTestId("chat-model-selector-trigger")
		expect(trigger.tagName).toBe("BUTTON")
		expect(trigger.tabIndex).toBe(0)
		expect(trigger).toHaveClass("focus-visible:ring-vscode-focusBorder")
	})
})
