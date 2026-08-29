// npx vitest src/components/chat/__tests__/ReasoningEffortSelector.spec.tsx

import type { ReactNode } from "react"

import { render, screen, fireEvent } from "@/utils/test-utils"

import type { ModelInfo, ProviderSettings } from "@roo-code/types"

import { ReasoningEffortSelector } from "../ReasoningEffortSelector"

// Typed shape the selector reads from useExtensionState. Only the fields the
// component touches are modeled so a schema change to ExtensionState surfaces
// here as a compile error rather than being swallowed by `any`.
interface ExtensionStateShape {
	currentApiConfigName: string | undefined
	apiConfiguration: ProviderSettings
}

// Typed shape the selector reads from useSelectedModel. `info` is the model's
// advertised capability surface; setting `supportsReasoningEffort` drives the
// option set the dropdown renders.
interface SelectedModelShape {
	provider: string
	id: string | undefined
	info: ModelInfo | undefined
}

const { postMessageMock, extensionState, selectedModel } = vi.hoisted(() => ({
	postMessageMock: vi.fn(),
	extensionState: {
		currentApiConfigName: "default",
		apiConfiguration: {} as ProviderSettings,
	} as ExtensionStateShape,
	selectedModel: {
		provider: "ollama",
		id: "qwen3",
		info: undefined as ModelInfo | undefined,
	} as SelectedModelShape,
}))

vi.mock("@src/utils/vscode", () => ({
	vscode: { postMessage: postMessageMock },
}))

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string) => key,
	}),
}))

vi.mock("@src/components/ui/hooks/useRooPortal", () => ({
	useRooPortal: () => document.body,
}))

vi.mock("@src/context/ExtensionStateContext", () => ({
	useExtensionState: () => extensionState,
}))

vi.mock("@src/components/ui/hooks/useSelectedModel", () => ({
	useSelectedModel: () => selectedModel,
}))

// Mock Popover components to be testable, mirroring ApiConfigSelector.spec.
// Typed props keep the mock in sync with the real Popover surface so a prop
// rename in the real components breaks the test instead of being silently
// swallowed by `any`.
interface PopoverMockProps {
	children?: ReactNode
	open?: boolean
	onOpenChange?: (open: boolean) => void
	"data-testid"?: string
}
interface PopoverTriggerMockProps {
	children?: ReactNode
	disabled?: boolean
	className?: string
	"data-testid"?: string
}
interface PopoverContentMockProps {
	children?: ReactNode
	className?: string
}
vi.mock("@src/components/ui", () => ({
	Popover: ({ children, open, ...rest }: PopoverMockProps) => (
		<div data-testid="popover-root" data-open={open} {...rest}>
			{children}
		</div>
	),
	PopoverTrigger: ({ children, disabled, ...props }: PopoverTriggerMockProps) => (
		<button data-testid="reasoning-effort-trigger" disabled={disabled} {...props}>
			{children}
		</button>
	),
	PopoverContent: ({ children }: PopoverContentMockProps) => <div data-testid="popover-content">{children}</div>,
	StandardTooltip: ({ children }: { children?: ReactNode }) => <>{children}</>,
}))

describe("ReasoningEffortSelector", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		extensionState.currentApiConfigName = "default"
		extensionState.apiConfiguration = {
			apiProvider: "ollama",
			ollamaModelId: "qwen3",
		}
		selectedModel.provider = "ollama"
		selectedModel.id = "qwen3"
		selectedModel.info = undefined
	})

	it("renders nothing for non-Ollama providers without advertised reasoning effort", () => {
		selectedModel.provider = "anthropic"
		selectedModel.info = { contextWindow: 200000, supportsPromptCache: true }

		render(<ReasoningEffortSelector />)

		expect(screen.queryByTestId("reasoning-effort-trigger")).not.toBeInTheDocument()
	})

	it("shows the stored effort for an ollama model that advertises levels including max", () => {
		// The fetcher advertises ["disable","low","medium","high","max"] for
		// thinking models that honor think: false (qwen3). The selector passes
		// that array through verbatim, so "max" is selectable.
		selectedModel.info = {
			contextWindow: 40960,
			supportsPromptCache: true,
			supportsReasoningEffort: ["disable", "low", "medium", "high", "max"],
		}
		extensionState.apiConfiguration = {
			apiProvider: "ollama",
			ollamaModelId: "qwen3",
			reasoningEffort: "max",
			enableReasoningEffort: true,
		}

		render(<ReasoningEffortSelector />)

		expect(screen.getByTestId("reasoning-effort-trigger")).toHaveTextContent(
			"settings:providers.reasoningEffort.max",
		)
		expect(screen.getByTestId("reasoning-effort-option-max")).toBeInTheDocument()
	})

	it("lists Disable (None) as an option for ollama when the model advertises it, via the verbatim array", () => {
		// No advertised info yet (router still loading). The shared fallback
		// synthesizes ["disable","low","medium","high"] so the chat bar is usable
		// immediately on app boot. "disable" is the UI sentinel for think: false,
		// not a fake "none" thinking level.
		selectedModel.info = undefined
		extensionState.apiConfiguration = {
			apiProvider: "ollama",
			ollamaModelId: "deepseek-v4-flash:0731",
			enableReasoningEffort: true,
		}

		render(<ReasoningEffortSelector />)

		expect(screen.getByTestId("reasoning-effort-trigger")).toBeInTheDocument()
		expect(screen.getByTestId("reasoning-effort-option-disable")).toBeInTheDocument()
		expect(screen.getByTestId("reasoning-effort-option-low")).toBeInTheDocument()
		expect(screen.getByTestId("reasoning-effort-option-medium")).toBeInTheDocument()
		expect(screen.getByTestId("reasoning-effort-option-high")).toBeInTheDocument()
	})

	it("does not prepend a 'none'/'disable' option to an advertised array that omits it (gpt-oss)", () => {
		// gpt-oss ignores think: false, so the fetcher advertises exactly
		// ["low","medium","high"] with no "disable". The selector must surface that
		// verbatim and must not inject a disable/none option the model can't honor.
		selectedModel.info = {
			contextWindow: 131072,
			supportsPromptCache: true,
			supportsReasoningEffort: ["low", "medium", "high"],
		}
		extensionState.apiConfiguration = {
			apiProvider: "ollama",
			ollamaModelId: "gpt-oss:20b",
			reasoningEffort: "medium",
			enableReasoningEffort: true,
		}

		render(<ReasoningEffortSelector />)

		expect(screen.getByTestId("reasoning-effort-option-low")).toBeInTheDocument()
		expect(screen.getByTestId("reasoning-effort-option-medium")).toBeInTheDocument()
		expect(screen.getByTestId("reasoning-effort-option-high")).toBeInTheDocument()
		expect(screen.queryByTestId("reasoning-effort-option-disable")).not.toBeInTheDocument()
		expect(screen.queryByTestId("reasoning-effort-option-none")).not.toBeInTheDocument()
	})

	it("persists only reasoningEffort so enableReasoningEffort stays in sync with the settings checkbox", () => {
		selectedModel.info = {
			contextWindow: 40960,
			supportsPromptCache: true,
			supportsReasoningEffort: ["disable", "low", "medium", "high", "max"],
		}
		extensionState.apiConfiguration = {
			apiProvider: "ollama",
			ollamaModelId: "qwen3",
			reasoningEffort: "max",
			enableReasoningEffort: true,
		}

		render(<ReasoningEffortSelector />)
		fireEvent.click(screen.getByTestId("reasoning-effort-option-low"))

		expect(postMessageMock).toHaveBeenCalledWith({
			type: "upsertApiConfiguration",
			text: "default",
			apiConfiguration: {
				apiProvider: "ollama",
				ollamaModelId: "qwen3",
				reasoningEffort: "low",
				enableReasoningEffort: true,
			},
		})
	})

	it("stores reasoningEffort: 'disable' when None is selected without flipping enableReasoningEffort", () => {
		// The chat selector is a soft toggle: it only writes reasoningEffort,
		// leaving the Enable Thinking checkbox in the settings page in charge of
		// enableReasoningEffort. Selecting None (the "disable" option) stores
		// reasoningEffort: "disable". There is no separate reasoning: "none"
		// field; Ollama has no native string "none" level, and "disable" maps to
		// think: false via getOllamaThinkParam().
		selectedModel.info = {
			contextWindow: 40960,
			supportsPromptCache: true,
			supportsReasoningEffort: ["disable", "low", "medium", "high", "max"],
		}
		extensionState.apiConfiguration = {
			apiProvider: "ollama",
			ollamaModelId: "qwen3",
			reasoningEffort: "high",
			enableReasoningEffort: true,
		}

		render(<ReasoningEffortSelector />)
		fireEvent.click(screen.getByTestId("reasoning-effort-option-disable"))

		expect(postMessageMock).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "upsertApiConfiguration",
				apiConfiguration: expect.objectContaining({
					reasoningEffort: "disable",
					enableReasoningEffort: true,
				}),
			}),
		)
	})

	it("normalizes a stale 'disable' to the clamped fallback on switch from a disable-capable model to gpt-oss", () => {
		// Regression: the user saved "disable" on qwen3 (which honors think:
		// false) and then selected gpt-oss (which omits "disable" from its
		// capability array). The selector's useEffect must persist the clamped
		// fallback (gpt-oss's first option "low") so the stored effort matches
		// what the UI shows and what the native request mapper sends, instead of
		// leaving reasoningEffort: "disable" to map to think: false.
		selectedModel.provider = "ollama"
		selectedModel.id = "gpt-oss:20b"
		selectedModel.info = {
			contextWindow: 131072,
			supportsPromptCache: true,
			supportsReasoningEffort: ["low", "medium", "high"],
		}
		extensionState.apiConfiguration = {
			apiProvider: "ollama",
			ollamaModelId: "gpt-oss:20b",
			reasoningEffort: "disable",
			enableReasoningEffort: true,
		}

		render(<ReasoningEffortSelector />)

		expect(postMessageMock).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "upsertApiConfiguration",
				text: "default",
				apiConfiguration: expect.objectContaining({
					reasoningEffort: "low",
					// enableReasoningEffort is untouched (chat selector is a soft toggle)
					enableReasoningEffort: true,
				}),
			}),
		)
	})

	it("does not persist when the stored effort is still valid for the selected model", () => {
		// "low" is valid for gpt-oss, so switching to gpt-oss with a stored "low"
		// must not fire a normalization write.
		selectedModel.provider = "ollama"
		selectedModel.id = "gpt-oss:20b"
		selectedModel.info = {
			contextWindow: 131072,
			supportsPromptCache: true,
			supportsReasoningEffort: ["low", "medium", "high"],
		}
		extensionState.apiConfiguration = {
			apiProvider: "ollama",
			ollamaModelId: "gpt-oss:20b",
			reasoningEffort: "low",
			enableReasoningEffort: true,
		}

		render(<ReasoningEffortSelector />)

		expect(postMessageMock).not.toHaveBeenCalled()
	})

	it("renders for ollama even when no model info has loaded", () => {
		// The user expects the chat bar to show a reasoning selector for ollama
		// no matter what — this is the primary use case for the chat selector.
		selectedModel.info = undefined
		extensionState.apiConfiguration = {
			apiProvider: "ollama",
			ollamaModelId: "deepseek-v4-flash:0731",
			enableReasoningEffort: true,
		}

		render(<ReasoningEffortSelector />)

		expect(screen.getByTestId("reasoning-effort-trigger")).toBeInTheDocument()
	})

	it("hides the selector when Enable Thinking (enableReasoningEffort) is unticked", () => {
		// The settings checkbox owns enableReasoningEffort. Unticking it and
		// saving must collapse the chat-bar selector even though the model
		// supports reasoning effort and a value is still stored.
		selectedModel.info = {
			contextWindow: 40960,
			supportsPromptCache: true,
			supportsReasoningEffort: ["disable", "low", "medium", "high", "max"],
		}
		extensionState.apiConfiguration = {
			apiProvider: "ollama",
			ollamaModelId: "qwen3",
			reasoningEffort: "high",
			enableReasoningEffort: false,
		}

		render(<ReasoningEffortSelector />)

		expect(screen.queryByTestId("reasoning-effort-trigger")).not.toBeInTheDocument()
	})

	it("hides the selector when enableReasoningEffort is unset", () => {
		// A fresh profile with no thinking selection has no explicit opt-in, so
		// the selector stays hidden until the user enables thinking in settings.
		selectedModel.info = {
			contextWindow: 40960,
			supportsPromptCache: true,
			supportsReasoningEffort: true,
		}
		extensionState.apiConfiguration = { apiProvider: "ollama", ollamaModelId: "qwen3" }

		render(<ReasoningEffortSelector />)

		expect(screen.queryByTestId("reasoning-effort-trigger")).not.toBeInTheDocument()
	})

	it("renders the selector for required-reasoning models even when the flag is unset", () => {
		// requiredReasoningEffort means reasoning is mandatory, so the selector
		// stays available without an explicit opt-in.
		selectedModel.info = {
			contextWindow: 256000,
			supportsPromptCache: true,
			supportsReasoningEffort: true,
			requiredReasoningEffort: true,
		}
		extensionState.apiConfiguration = { apiProvider: "ollama", ollamaModelId: "kimi-k2" }

		render(<ReasoningEffortSelector />)

		expect(screen.getByTestId("reasoning-effort-trigger")).toBeInTheDocument()
	})

	it("does not persist when there is no active profile", () => {
		extensionState.currentApiConfigName = undefined
		selectedModel.provider = "ollama"
		selectedModel.info = {
			contextWindow: 40960,
			supportsPromptCache: true,
			supportsReasoningEffort: ["disable", "low", "medium", "high", "max"],
		}
		extensionState.apiConfiguration = {
			apiProvider: "ollama",
			ollamaModelId: "qwen3",
			reasoningEffort: "high",
			enableReasoningEffort: true,
		}

		render(<ReasoningEffortSelector />)
		fireEvent.click(screen.getByTestId("reasoning-effort-option-low"))

		expect(postMessageMock).not.toHaveBeenCalled()
	})

	describe("keyboard interaction", () => {
		it("renders native button options with listbox/option semantics so they are keyboard-operable", () => {
			// Regression: the previous implementation rendered non-focusable
			// <div onClick> rows, so keyboard users could not select an effort and
			// screen readers did not announce them as selectable items. The fix
			// renders native <button> elements (focusable, Enter/Space-activated) with
			// role="option" and aria-selected inside a role="listbox" container that
			// handles ArrowUp/ArrowDown/Home/End navigation. Asserting the structure
			// here is the durable proof the rows are keyboard-operable; this
			// JSDOM environment stubs HTMLElement.prototype.focus (see vitest.setup.ts)
			// so document.activeElement never moves, which is why we assert structure
			// rather than driving real focus.
			selectedModel.info = {
				contextWindow: 40960,
				supportsPromptCache: true,
				supportsReasoningEffort: ["disable", "low", "medium", "high", "max"],
			}
			extensionState.apiConfiguration = {
				apiProvider: "ollama",
				ollamaModelId: "qwen3",
				reasoningEffort: "medium",
				enableReasoningEffort: true,
			}

			render(<ReasoningEffortSelector />)

			// The container is a listbox.
			expect(screen.getByRole("listbox")).toBeInTheDocument()

			// Every option is a native focusable <button> with option semantics.
			const options = screen.getAllByRole("option")
			expect(options.length).toBe(5)
			for (const option of options) {
				expect(option.tagName).toBe("BUTTON")
				expect(option).toHaveAttribute("aria-selected")
			}

			// The currently-selected option is marked selected.
			expect(screen.getByTestId("reasoning-effort-option-medium")).toHaveAttribute("aria-selected", "true")
		})

		it("activates an option via click (the path Enter/Space takes on a native button)", () => {
			// Native <button> elements fire click on Enter and Space, so the
			// existing click handler is the keyboard activation path. Assert it
			// persists the selection.
			selectedModel.info = {
				contextWindow: 40960,
				supportsPromptCache: true,
				supportsReasoningEffort: ["disable", "low", "medium", "high", "max"],
			}
			extensionState.apiConfiguration = {
				apiProvider: "ollama",
				ollamaModelId: "qwen3",
				reasoningEffort: "disable",
				enableReasoningEffort: true,
			}

			render(<ReasoningEffortSelector />)

			fireEvent.click(screen.getByTestId("reasoning-effort-option-low"))

			expect(postMessageMock).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "upsertApiConfiguration",
					apiConfiguration: expect.objectContaining({ reasoningEffort: "low" }),
				}),
			)
		})

		it("prevents default on arrow keys so the listbox handler owns navigation", () => {
			// The listbox container's onKeyDown calls preventDefault on ArrowDown so
			// the browser does not scroll the page while the user navigates options.
			selectedModel.info = {
				contextWindow: 40960,
				supportsPromptCache: true,
				supportsReasoningEffort: ["disable", "low", "medium", "high", "max"],
			}
			extensionState.apiConfiguration = {
				apiProvider: "ollama",
				ollamaModelId: "qwen3",
				reasoningEffort: "medium",
				enableReasoningEffort: true,
			}

			render(<ReasoningEffortSelector />)

			const option = screen.getByTestId("reasoning-effort-option-medium")
			const event = new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })
			const preventDefaultSpy = vi.spyOn(event, "preventDefault")
			option.dispatchEvent(event)

			expect(preventDefaultSpy).toHaveBeenCalled()
			preventDefaultSpy.mockRestore()
		})
	})
})
