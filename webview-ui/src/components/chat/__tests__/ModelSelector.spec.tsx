import { providerIdentifiers, retiredProviderIdentifiers } from "@roo-code/types"

import { render, screen, fireEvent, within } from "@/utils/test-utils"
import { vscode } from "@/utils/vscode"

import { ModelSelector } from "../ModelSelector"

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

const { useRouterModelsMock, useSelectedModelMock } = vi.hoisted(() => ({
	useRouterModelsMock: vi.fn(() => ({ data: {} as Record<string, any>, isLoading: false })),
	useSelectedModelMock: vi.fn((): { id: string; info?: { displayName?: string }; isLoading: boolean } => ({
		id: "claude-sonnet-4-5",
		isLoading: false,
	})),
}))

vi.mock("@/components/ui/hooks/useRouterModels", () => ({
	useRouterModels: useRouterModelsMock,
}))

vi.mock("@/components/ui/hooks/useSelectedModel", () => ({
	useSelectedModel: useSelectedModelMock,
}))

vi.mock("@/components/ui", () => ({
	Popover: ({ children, open }: any) => (
		<div data-testid="popover-root" data-open={open}>
			{children}
		</div>
	),
	PopoverTrigger: ({ children, disabled, ...props }: any) => (
		<button data-testid="model-selector-trigger" disabled={disabled} {...props}>
			{children}
		</button>
	),
	PopoverContent: ({ children }: any) => <div data-testid="popover-content">{children}</div>,
	StandardTooltip: ({ children }: any) => <>{children}</>,
}))

const manyDynamicModels = Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`openrouter/model-${index}`, {}]))

describe("ModelSelector", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		useRouterModelsMock.mockReturnValue({ data: {}, isLoading: false })
		useSelectedModelMock.mockReturnValue({ id: "claude-sonnet-4-5", isLoading: false })
	})

	it("renders the static model list for a static provider and sends upsertApiConfiguration on select", () => {
		render(
			<ModelSelector
				apiConfiguration={
					{ apiProvider: providerIdentifiers.anthropic, apiModelId: "claude-sonnet-4-5" } as any
				}
				currentApiConfigName="default"
				title="Select model"
			/>,
		)

		expect(screen.getByTestId("model-selector-trigger")).not.toBeDisabled()

		const anotherModel = screen.getAllByText(/claude-3-5-haiku/i)[0]
		fireEvent.click(anotherModel)

		expect(vscode.postMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "upsertApiConfiguration",
				text: "default",
				apiConfiguration: expect.objectContaining({ apiModelId: expect.stringContaining("claude-3-5-haiku") }),
			}),
		)
	})

	it("resets reasoning/thinking-token overrides and closes the popover after selecting a model", () => {
		render(
			<ModelSelector
				apiConfiguration={
					{
						apiProvider: providerIdentifiers.anthropic,
						apiModelId: "claude-sonnet-4-5",
						reasoningEffort: "high",
						modelMaxTokens: 4096,
						modelMaxThinkingTokens: 2048,
					} as any
				}
				currentApiConfigName="default"
				title="Select model"
			/>,
		)

		fireEvent.click(screen.getAllByText(/claude-3-5-haiku/i)[0])

		expect(vscode.postMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				apiConfiguration: expect.objectContaining({
					reasoningEffort: undefined,
					modelMaxTokens: undefined,
					modelMaxThinkingTokens: undefined,
				}),
			}),
		)
		expect(screen.getByTestId("popover-root")).toHaveAttribute("data-open", "false")
	})

	it("prefers a model's displayName over its raw id when present", () => {
		useRouterModelsMock.mockReturnValue({
			data: {
				openrouter: {
					"openrouter/model-a": { displayName: "Model A (friendly)" },
					"openrouter/model-b": {},
				},
			},
			isLoading: false,
		})
		useSelectedModelMock.mockReturnValue({
			id: "openrouter/model-a",
			info: { displayName: "Model A (friendly)" },
			isLoading: false,
		})

		render(
			<ModelSelector
				apiConfiguration={
					{ apiProvider: providerIdentifiers.openrouter, openRouterModelId: "openrouter/model-a" } as any
				}
				currentApiConfigName="default"
				title="Select model"
			/>,
		)

		// Trigger shows the displayName, not the raw id.
		expect(screen.getByTestId("model-selector-trigger")).toHaveTextContent("Model A (friendly)")
		expect(screen.queryByText("openrouter/model-a")).not.toBeInTheDocument()

		// List item for the model without a displayName still falls back to its raw id.
		expect(screen.getByText("openrouter/model-b")).toBeInTheDocument()
	})

	it("renders the dynamic router model list for a dynamic provider", () => {
		useRouterModelsMock.mockReturnValue({
			data: { openrouter: { "openrouter/model-a": {}, "openrouter/model-b": {} } },
			isLoading: false,
		})
		useSelectedModelMock.mockReturnValue({ id: "openrouter/model-a", isLoading: false })

		render(
			<ModelSelector
				apiConfiguration={
					{ apiProvider: providerIdentifiers.openrouter, openRouterModelId: "openrouter/model-a" } as any
				}
				currentApiConfigName="default"
				title="Select model"
			/>,
		)

		expect(screen.getByText("openrouter/model-b")).toBeInTheDocument()

		fireEvent.click(screen.getByText("openrouter/model-b"))

		expect(vscode.postMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "upsertApiConfiguration",
				apiConfiguration: expect.objectContaining({ openRouterModelId: "openrouter/model-b" }),
			}),
		)
	})

	it("requests router models for a dynamic provider with fetching enabled", () => {
		render(
			<ModelSelector
				apiConfiguration={{ apiProvider: providerIdentifiers.openrouter } as any}
				currentApiConfigName="default"
				title="Select model"
			/>,
		)

		expect(useRouterModelsMock).toHaveBeenCalledWith({
			provider: providerIdentifiers.openrouter,
			enabled: true,
		})
	})

	it("requests router models with fetching disabled for a static provider", () => {
		render(
			<ModelSelector
				apiConfiguration={{ apiProvider: providerIdentifiers.anthropic } as any}
				currentApiConfigName="default"
				title="Select model"
			/>,
		)

		expect(useRouterModelsMock).toHaveBeenCalledWith({
			provider: undefined,
			enabled: false,
		})
	})

	it("shows the disabled view with an openrouter fallback label for a retired provider", () => {
		useSelectedModelMock.mockReturnValue({ id: "", isLoading: false })

		render(
			<ModelSelector
				apiConfiguration={{ apiProvider: retiredProviderIdentifiers.groq } as any}
				currentApiConfigName="default"
				title="Select model"
			/>,
		)

		// Retired providers have no model config of their own, so they never fetch router
		// models and always render the unsupported/disabled view with an openrouter fallback.
		expect(useRouterModelsMock).toHaveBeenCalledWith({ provider: undefined, enabled: false })
		expect(screen.getByTestId("model-selector-disabled")).toHaveTextContent(providerIdentifiers.openrouter)
	})

	it("disables the selector for a provider outside the supported scope", () => {
		useSelectedModelMock.mockReturnValue({ id: "", isLoading: false })

		render(
			<ModelSelector
				apiConfiguration={{ apiProvider: providerIdentifiers.ollama } as any}
				currentApiConfigName="default"
				title="Select model"
			/>,
		)

		expect(screen.queryByTestId("model-selector-trigger")).not.toBeInTheDocument()
		expect(screen.getByTestId("model-selector-disabled")).toBeInTheDocument()

		fireEvent.click(screen.getByTestId("model-selector-disabled"))

		expect(vscode.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "switchTab", tab: "settings" }))
	})

	it("falls back to the provider name in the unsupported trigger when there is no selected model label", () => {
		useSelectedModelMock.mockReturnValue({ id: "", isLoading: false })

		render(
			<ModelSelector
				apiConfiguration={{ apiProvider: providerIdentifiers.ollama } as any}
				currentApiConfigName="default"
				title="Select model"
			/>,
		)

		expect(screen.getByTestId("model-selector-disabled")).toHaveTextContent(providerIdentifiers.ollama)
	})

	it("disables the enabled selector's trigger when the disabled prop is set", () => {
		render(
			<ModelSelector
				apiConfiguration={{ apiProvider: providerIdentifiers.anthropic } as any}
				currentApiConfigName="default"
				title="Select model"
				disabled
			/>,
		)

		const trigger = screen.getByTestId("model-selector-trigger")
		expect(trigger).toBeDisabled()
		expect(trigger).toHaveClass("cursor-not-allowed")
		expect(trigger).not.toHaveClass("opacity-100")
	})

	it("shows the loading label instead of the selected model while the selection is loading", () => {
		useSelectedModelMock.mockReturnValue({ id: "claude-sonnet-4-5", isLoading: true })

		render(
			<ModelSelector
				apiConfiguration={{ apiProvider: providerIdentifiers.anthropic } as any}
				currentApiConfigName="default"
				title="Select model"
			/>,
		)

		const trigger = screen.getByTestId("model-selector-trigger")
		expect(trigger).toHaveTextContent("common:ui.loading")
		expect(trigger).not.toHaveTextContent("claude-sonnet-4-5")
	})

	it("does not open the popover until the user interacts with the trigger", () => {
		render(
			<ModelSelector
				apiConfiguration={{ apiProvider: providerIdentifiers.anthropic } as any}
				currentApiConfigName="default"
				title="Select model"
			/>,
		)

		expect(screen.getByTestId("popover-root")).toHaveAttribute("data-open", "false")
	})

	it("does not append anything to the trigger class name by default", () => {
		render(
			<ModelSelector
				apiConfiguration={{ apiProvider: providerIdentifiers.anthropic } as any}
				currentApiConfigName="default"
				title="Select model"
			/>,
		)

		expect(screen.getByTestId("model-selector-trigger")).not.toHaveClass("Stryker")
	})

	it("applies a custom trigger class name when provided", () => {
		render(
			<ModelSelector
				apiConfiguration={{ apiProvider: providerIdentifiers.anthropic } as any}
				currentApiConfigName="default"
				title="Select model"
				triggerClassName="my-custom-trigger"
			/>,
		)

		expect(screen.getByTestId("model-selector-trigger")).toHaveClass("my-custom-trigger")
	})

	it("highlights the currently selected model with a check mark and not other models", () => {
		useRouterModelsMock.mockReturnValue({
			data: { openrouter: { "openrouter/model-a": {}, "openrouter/model-b": {} } },
			isLoading: false,
		})
		useSelectedModelMock.mockReturnValue({ id: "openrouter/model-a", isLoading: false })

		render(
			<ModelSelector
				apiConfiguration={
					{ apiProvider: providerIdentifiers.openrouter, openRouterModelId: "openrouter/model-a" } as any
				}
				currentApiConfigName="default"
				title="Select model"
			/>,
		)

		const list = within(screen.getByTestId("popover-content"))
		const currentItem = list.getByText("openrouter/model-a").parentElement
		const otherItem = list.getByText("openrouter/model-b").parentElement

		expect(currentItem).toHaveClass("bg-vscode-list-activeSelectionBackground")
		expect(currentItem?.querySelector(".codicon-check")).toBeInTheDocument()

		expect(otherItem).not.toHaveClass("bg-vscode-list-activeSelectionBackground")
		expect(otherItem?.querySelector(".codicon-check")).not.toBeInTheDocument()
	})

	it("does not show a search box when there are few models", () => {
		useRouterModelsMock.mockReturnValue({
			data: { openrouter: { "openrouter/model-a": {}, "openrouter/model-b": {} } },
			isLoading: false,
		})
		useSelectedModelMock.mockReturnValue({ id: "openrouter/model-a", isLoading: false })

		render(
			<ModelSelector
				apiConfiguration={
					{ apiProvider: providerIdentifiers.openrouter, openRouterModelId: "openrouter/model-a" } as any
				}
				currentApiConfigName="default"
				title="Select model"
			/>,
		)

		expect(screen.queryByLabelText("common:ui.search_placeholder")).not.toBeInTheDocument()
	})

	it("shows an empty search box above the search threshold and filters the model list as the user types", () => {
		useRouterModelsMock.mockReturnValue({ data: { openrouter: manyDynamicModels }, isLoading: false })
		useSelectedModelMock.mockReturnValue({ id: "openrouter/model-0", isLoading: false })

		render(
			<ModelSelector
				apiConfiguration={
					{ apiProvider: providerIdentifiers.openrouter, openRouterModelId: "openrouter/model-0" } as any
				}
				currentApiConfigName="default"
				title="Select model"
			/>,
		)

		const searchInput = screen.getByLabelText("common:ui.search_placeholder")
		expect(searchInput).toHaveValue("")
		const list = within(screen.getByTestId("popover-content"))
		expect(Object.keys(manyDynamicModels).every((id) => list.getByText(id) !== null)).toBe(true)

		fireEvent.change(searchInput, { target: { value: "model-3" } })

		expect(list.getByText("openrouter/model-3")).toBeInTheDocument()
		expect(list.queryByText("openrouter/model-0")).not.toBeInTheDocument()
	})

	it("shows a no-results message when the search does not match any model", () => {
		useRouterModelsMock.mockReturnValue({ data: { openrouter: manyDynamicModels }, isLoading: false })
		useSelectedModelMock.mockReturnValue({ id: "openrouter/model-0", isLoading: false })

		render(
			<ModelSelector
				apiConfiguration={
					{ apiProvider: providerIdentifiers.openrouter, openRouterModelId: "openrouter/model-0" } as any
				}
				currentApiConfigName="default"
				title="Select model"
			/>,
		)

		fireEvent.change(screen.getByLabelText("common:ui.search_placeholder"), {
			target: { value: "no-such-model" },
		})

		expect(screen.getByText("common:ui.no_results")).toBeInTheDocument()
	})

	it("shows a clear icon only once the user has typed a search value, and clears the search when clicked", () => {
		useRouterModelsMock.mockReturnValue({ data: { openrouter: manyDynamicModels }, isLoading: false })
		useSelectedModelMock.mockReturnValue({ id: "openrouter/model-0", isLoading: false })

		const { container } = render(
			<ModelSelector
				apiConfiguration={
					{ apiProvider: providerIdentifiers.openrouter, openRouterModelId: "openrouter/model-0" } as any
				}
				currentApiConfigName="default"
				title="Select model"
			/>,
		)

		expect(container.querySelector(".codicon-close")).not.toBeInTheDocument()

		const searchInput = screen.getByLabelText("common:ui.search_placeholder")
		fireEvent.change(searchInput, { target: { value: "model-3" } })

		const clearIcon = container.querySelector(".codicon-close")
		expect(clearIcon).toBeInTheDocument()

		fireEvent.click(clearIcon as Element)

		expect(searchInput).toHaveValue("")
		expect(container.querySelector(".codicon-close")).not.toBeInTheDocument()
		expect(within(screen.getByTestId("popover-content")).getByText("openrouter/model-0")).toBeInTheDocument()
	})
})
