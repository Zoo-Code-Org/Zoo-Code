// npx vitest src/components/chat/__tests__/ReasoningEffortSelector.spec.tsx

import type { ReactNode } from "react"

import { render, screen, fireEvent } from "@/utils/test-utils"

import { ReasoningEffortSelector } from "../ReasoningEffortSelector"

const { postMessageMock, extensionState, selectedModel } = vi.hoisted(() => ({
	postMessageMock: vi.fn(),
	extensionState: {
		currentApiConfigName: "default" as string | undefined,
		apiConfiguration: {} as Record<string, unknown>,
	},
	selectedModel: {
		provider: "ollama" as string,
		id: "qwen3" as string | undefined,
		info: undefined as Record<string, unknown> | undefined,
	},
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
vi.mock("@src/components/ui", () => ({
	Popover: ({ children, open }: { children?: ReactNode; open?: boolean }) => (
		<div data-testid="popover-root" data-open={open}>
			{children}
		</div>
	),
	PopoverTrigger: ({ children, disabled, ...props }: { children?: ReactNode; disabled?: boolean }) => (
		<button data-testid="reasoning-effort-trigger" disabled={disabled} {...props}>
			{children}
		</button>
	),
	PopoverContent: ({ children }: { children?: ReactNode }) => <div data-testid="popover-content">{children}</div>,
	StandardTooltip: ({ children }: { children?: ReactNode }) => <>{children}</>,
}))

describe("ReasoningEffortSelector", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		extensionState.currentApiConfigName = "default"
		extensionState.apiConfiguration = { apiProvider: "ollama", ollamaModelId: "qwen3" }
		selectedModel.provider = "ollama"
		selectedModel.id = "qwen3"
		selectedModel.info = undefined
	})

	it("renders nothing for non-Ollama providers without advertised reasoning effort", () => {
		selectedModel.provider = "anthropic"
		selectedModel.info = {}

		render(<ReasoningEffortSelector />)

		expect(screen.queryByTestId("reasoning-effort-trigger")).not.toBeInTheDocument()
	})

	it("shows the stored effort for an ollama model that advertises levels including max", () => {
		selectedModel.info = { supportsReasoningEffort: ["low", "medium", "high", "max"] }
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

	it("always lists None as an option for ollama, regardless of model info", () => {
		// No advertised info yet (router still loading). Selector should still
		// render with the synthesized [None, low, medium, high] set so the chat
		// bar is usable immediately on app boot.
		selectedModel.info = undefined
		extensionState.apiConfiguration = {
			apiProvider: "ollama",
			ollamaModelId: "deepseek-v4-flash:0731",
			enableReasoningEffort: true,
		}

		render(<ReasoningEffortSelector />)

		expect(screen.getByTestId("reasoning-effort-trigger")).toBeInTheDocument()
		expect(screen.getByTestId("reasoning-effort-option-none")).toBeInTheDocument()
		expect(screen.getByTestId("reasoning-effort-option-low")).toBeInTheDocument()
		expect(screen.getByTestId("reasoning-effort-option-medium")).toBeInTheDocument()
		expect(screen.getByTestId("reasoning-effort-option-high")).toBeInTheDocument()
	})

	it("prepends None to a model's advertised options when missing", () => {
		// Some ollama cloud models advertise ["low","medium","high","max"] but
		// not "none". The chat selector prepends "none" so users can pick it.
		selectedModel.info = { supportsReasoningEffort: ["low", "medium", "high", "max"] }
		extensionState.apiConfiguration = {
			apiProvider: "ollama",
			ollamaModelId: "qwen3",
			reasoningEffort: "medium",
			enableReasoningEffort: true,
		}

		render(<ReasoningEffortSelector />)

		expect(screen.getByTestId("reasoning-effort-option-none")).toBeInTheDocument()
		expect(screen.getByTestId("reasoning-effort-option-max")).toBeInTheDocument()
	})

	it("persists only reasoningEffort so enableReasoningEffort stays in sync with the settings checkbox", () => {
		selectedModel.info = { supportsReasoningEffort: ["low", "medium", "high", "max"] }
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

	it("stores reasoningEffort: 'none' when None is selected without flipping enableReasoningEffort", () => {
		// The chat selector is a soft toggle: it only writes reasoningEffort,
		// leaving the Enable Thinking checkbox in the settings page in charge of
		// enableReasoningEffort. Selecting None here mirrors what the settings
		// dropdown does (same field, same value).
		selectedModel.info = { supportsReasoningEffort: ["low", "medium", "high", "max"] }
		extensionState.apiConfiguration = {
			apiProvider: "ollama",
			ollamaModelId: "qwen3",
			reasoningEffort: "high",
			enableReasoningEffort: true,
		}

		render(<ReasoningEffortSelector />)
		fireEvent.click(screen.getByTestId("reasoning-effort-option-none"))

		expect(postMessageMock).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "upsertApiConfiguration",
				apiConfiguration: expect.objectContaining({
					reasoningEffort: "none",
					enableReasoningEffort: true,
				}),
			}),
		)
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
		selectedModel.info = { supportsReasoningEffort: ["low", "medium", "high", "max"] }
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
		selectedModel.info = { supportsReasoningEffort: true }
		extensionState.apiConfiguration = { apiProvider: "ollama", ollamaModelId: "qwen3" }

		render(<ReasoningEffortSelector />)

		expect(screen.queryByTestId("reasoning-effort-trigger")).not.toBeInTheDocument()
	})

	it("renders the selector for required-reasoning models even when the flag is unset", () => {
		// requiredReasoningEffort means reasoning is mandatory, so the selector
		// stays available without an explicit opt-in.
		selectedModel.info = { supportsReasoningEffort: true, requiredReasoningEffort: true }
		extensionState.apiConfiguration = { apiProvider: "ollama", ollamaModelId: "kimi-k2" }

		render(<ReasoningEffortSelector />)

		expect(screen.getByTestId("reasoning-effort-trigger")).toBeInTheDocument()
	})

	it("does not persist when there is no active profile", () => {
		extensionState.currentApiConfigName = undefined
		selectedModel.provider = "ollama"
		selectedModel.info = { supportsReasoningEffort: ["low", "medium", "high", "max"] }
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
})
