import type { ReactNode } from "react"
import userEvent from "@testing-library/user-event"
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

// Exercise the real popover's focus management and Escape handling.
vi.mock("@/components/ui", async () => ({
	...(await import("@/components/ui/popover")),
	StandardTooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
}))

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

	const focusDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "focus")!

	beforeAll(() => {
		// The global FAST compatibility mock makes focus a no-op. Borrow JSDOM's
		// native implementation from a fresh realm for keyboard interaction tests.
		const iframe = document.createElement("iframe")
		document.body.appendChild(iframe)
		const nativeFocus = iframe.contentDocument!.createElement("button").focus
		Object.defineProperty(HTMLElement.prototype, "focus", {
			configurable: true,
			writable: true,
			value: nativeFocus,
		})
		iframe.remove()
	})

	afterAll(() => {
		Object.defineProperty(HTMLElement.prototype, "focus", focusDescriptor)
	})

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
			defaultModelId: "claude-sonnet-4-20250514",
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

		// Type in the search box.
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

		const clearButton = screen.getByRole("button", { name: "chat:clearSearch" })
		fireEvent.click(clearButton)

		expect((screen.getByPlaceholderText("chat:searchModel") as HTMLInputElement).value).toBe("")
	})

	test("does not post a message when modelIdKey becomes unset", () => {
		const { rerender } = render(<ChatModelSelector {...defaultProps} />)
		fireEvent.click(screen.getByTestId("chat-model-selector-trigger"))
		mockUseChatModelSelector.mockReturnValue({
			provider: providerIdentifiers.anthropic,
			models: anthropicModels,
			modelIdKey: undefined,
			defaultModelId: undefined,
			isLoading: false,
		})
		rerender(<ChatModelSelector {...defaultProps} />)

		expect(screen.getByTestId("chat-model-selector-trigger")).toBeDisabled()
		fireEvent.click(screen.getByTestId("chat-model-option-claude-opus-4-20250514"))
		expect(vscode.postMessage).not.toHaveBeenCalled()
	})

	test("does not post a message when apiConfiguration is missing and modelIdKey is set", () => {
		mockUseExtensionState.mockReturnValue({
			apiConfiguration: undefined,
			organizationAllowList: { allowAll: true, providers: {} },
			currentApiConfigName: "default",
		})
		render(<ChatModelSelector {...defaultProps} />)
		const trigger = screen.getByTestId("chat-model-selector-trigger")
		expect(trigger).toBeEnabled()
		fireEvent.click(trigger)
		fireEvent.click(screen.getByTestId("chat-model-option-claude-opus-4-20250514"))
		expect(vscode.postMessage).not.toHaveBeenCalled()
	})

	test("opens, navigates options, and selects a model using the keyboard", async () => {
		const user = userEvent.setup()
		render(<ChatModelSelector {...defaultProps} />)
		await user.tab()
		await user.keyboard("{Enter}")
		expect(screen.getByRole("textbox")).toHaveFocus()
		await user.keyboard("{ArrowDown}")
		expect(screen.getByTestId("chat-model-option-claude-opus-4-20250514")).toHaveFocus()
		await user.keyboard("{End}")
		expect(screen.getByRole("button", { name: "claude-sonnet-4-20250514" })).toHaveFocus()
		await user.keyboard("{Home}{ArrowUp}")
		expect(screen.getByRole("textbox")).toHaveFocus()
		await user.keyboard("{ArrowUp}{Enter}")
		expect(vscode.postMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				apiConfiguration: expect.objectContaining({ apiModelId: "claude-sonnet-4-20250514" }),
			}),
		)
		expect(screen.queryByRole("textbox")).not.toBeInTheDocument()
		expect(screen.getByTestId("chat-model-selector-trigger")).toHaveFocus()
	})

	test("selects the first filtered model with Enter from search", async () => {
		const user = userEvent.setup()
		render(<ChatModelSelector {...defaultProps} />)
		await user.click(screen.getByTestId("chat-model-selector-trigger"))
		await user.keyboard("sonnet{Enter}")
		expect(vscode.postMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				apiConfiguration: expect.objectContaining({ apiModelId: "claude-sonnet-4-20250514" }),
			}),
		)
	})

	test.each(["{Enter}", "{ArrowDown} "])("selects a custom model with %s", async (keys) => {
		const user = userEvent.setup()
		render(<ChatModelSelector {...defaultProps} />)
		await user.click(screen.getByTestId("chat-model-selector-trigger"))
		await user.keyboard(`custom-model${keys}`)
		expect(vscode.postMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				apiConfiguration: expect.objectContaining({ apiModelId: "custom-model" }),
			}),
		)
	})

	test("clears search by keyboard and dismisses the popover with Escape", async () => {
		const user = userEvent.setup()
		render(<ChatModelSelector {...defaultProps} />)
		await user.click(screen.getByTestId("chat-model-selector-trigger"))
		await user.keyboard("sonnet")
		await user.tab()
		expect(screen.getByRole("button", { name: "chat:clearSearch" })).toHaveFocus()
		await user.keyboard(" ")
		expect(screen.getByRole("textbox")).toHaveValue("")
		expect(screen.getByRole("textbox")).toHaveFocus()
		await user.keyboard("{Escape}")
		expect(screen.queryByRole("textbox")).not.toBeInTheDocument()
		expect(screen.getByTestId("chat-model-selector-trigger")).toHaveFocus()
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

	test("disables the trigger when currentApiConfigName is missing", () => {
		mockUseExtensionState.mockReturnValue({
			apiConfiguration: {
				apiProvider: providerIdentifiers.anthropic,
				apiModelId: "claude-opus-4-20250514",
			},
			organizationAllowList: { allowAll: true, providers: {} },
			currentApiConfigName: undefined,
		})

		render(<ChatModelSelector {...defaultProps} />)

		// Without a resolved profile name the upsert would be dropped, so the
		// control must not be interactive — and must not look interactive.
		expect(screen.getByTestId("chat-model-selector-trigger")).toBeDisabled()
	})

	test("hides the custom-model escape hatch when the provider is restricted", () => {
		mockUseExtensionState.mockReturnValue({
			apiConfiguration: {
				apiProvider: providerIdentifiers.anthropic,
				apiModelId: "claude-opus-4-20250514",
			},
			organizationAllowList: {
				allowAll: false,
				providers: {
					[providerIdentifiers.anthropic]: { allowAll: false, models: ["claude-sonnet-4-20250514"] },
				},
			},
			currentApiConfigName: "default",
		})

		render(<ChatModelSelector {...defaultProps} />)
		fireEvent.click(screen.getByTestId("chat-model-selector-trigger"))
		fireEvent.change(screen.getByPlaceholderText("chat:searchModel"), { target: { value: "gpt-999" } })

		// The provider is narrowed to an allow-list, so free-form ids are not offered.
		expect(screen.queryByTestId("chat-model-use-custom")).not.toBeInTheDocument()
	})

	test("filters out models that the organization policy disallows", () => {
		mockUseExtensionState.mockReturnValue({
			apiConfiguration: {
				apiProvider: providerIdentifiers.anthropic,
				apiModelId: "claude-opus-4-20250514",
			},
			organizationAllowList: {
				allowAll: false,
				providers: {
					[providerIdentifiers.anthropic]: { allowAll: false, models: ["claude-sonnet-4-20250514"] },
				},
			},
			currentApiConfigName: "default",
		})

		render(<ChatModelSelector {...defaultProps} />)
		fireEvent.click(screen.getByTestId("chat-model-selector-trigger"))

		// Only the allow-listed model is offered; the disallowed Opus entry is absent.
		expect(screen.getByTestId("chat-model-option-claude-sonnet-4-20250514")).toBeInTheDocument()
		expect(screen.queryByTestId("chat-model-option-claude-opus-4-20250514")).not.toBeInTheDocument()
	})
})
