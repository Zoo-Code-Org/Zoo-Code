import { type ReactNode } from "react"

import {
	providerIdentifiers,
	retiredProviderIdentifiers,
	type ModelInfo,
	type OrganizationAllowList,
	type ProviderSettings,
	type RouterModels,
} from "@roo-code/types"

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
	useRouterModelsMock: vi.fn((): { data: Partial<RouterModels> | undefined; isLoading: boolean } => ({
		data: undefined,
		isLoading: false,
	})),
	useSelectedModelMock: vi.fn((): { id: string; info?: ModelInfo; isLoading: boolean } => ({
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

vi.mock("@/components/ui", async () => {
	const { createContext, useContext } = await import("react")

	type PopoverContextValue = {
		open: boolean
		onOpenChange: (open: boolean) => void
	}

	const PopoverContext = createContext<PopoverContextValue>({
		open: false,
		onOpenChange: () => {},
	})

	type PopoverProps = {
		children: ReactNode
		open?: boolean
		onOpenChange?: (open: boolean) => void
	}

	type PopoverTriggerProps = {
		children: ReactNode
		disabled?: boolean
		className?: string
		"data-testid"?: string
	}

	type PopoverContentProps = {
		children: ReactNode
		align?: string
		sideOffset?: number
		container?: HTMLElement | null
		className?: string
	}

	type StandardTooltipProps = {
		children: ReactNode
		content?: string
	}

	return {
		Popover: ({ children, open, onOpenChange }: PopoverProps) => (
			<PopoverContext.Provider value={{ open: open ?? false, onOpenChange: onOpenChange ?? (() => {}) }}>
				<div data-testid="popover-root" data-open={open ?? false}>
					{children}
				</div>
			</PopoverContext.Provider>
		),
		PopoverTrigger: ({ children, disabled, ...props }: PopoverTriggerProps) => {
			const { open, onOpenChange } = useContext(PopoverContext)
			return (
				<button
					data-testid="model-selector-trigger"
					disabled={disabled}
					{...props}
					onClick={() => onOpenChange(!open)}>
					{children}
				</button>
			)
		},
		PopoverContent: ({ children }: PopoverContentProps) => {
			const { open } = useContext(PopoverContext)
			return open ? <div data-testid="popover-content">{children}</div> : null
		},
		StandardTooltip: ({ children }: StandardTooltipProps) => <>{children}</>,
	}
})

const modelInfo = (overrides: Partial<ModelInfo> = {}): ModelInfo => ({
	contextWindow: 4096,
	supportsPromptCache: false,
	...overrides,
})

const allowAllList: OrganizationAllowList = { allowAll: true, providers: {} }

/** Opens the popover by clicking the trigger and returns the content container. */
const openPopover = () => {
	fireEvent.click(screen.getByTestId("model-selector-trigger"))
	return within(screen.getByTestId("popover-content"))
}

describe("ModelSelector", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		useRouterModelsMock.mockReturnValue({ data: undefined, isLoading: false })
		useSelectedModelMock.mockReturnValue({ id: "claude-sonnet-4-5", isLoading: false })
	})

	it("renders the static model list for a static provider and sends upsertApiConfiguration on select", () => {
		const apiConfiguration: ProviderSettings = {
			apiProvider: providerIdentifiers.anthropic,
			apiModelId: "claude-sonnet-4-5",
			reasoningEffort: "high",
			modelMaxTokens: 8192,
			modelMaxThinkingTokens: 4096,
		}

		render(
			<ModelSelector
				apiConfiguration={apiConfiguration}
				currentApiConfigName="default"
				title="Select model"
				organizationAllowList={allowAllList}
			/>,
		)

		expect(screen.getByTestId("model-selector-trigger")).not.toBeDisabled()

		const content = openPopover()
		const anotherModel = content.getAllByText(/claude-3-5-haiku/i)[0]
		fireEvent.click(anotherModel)

		expect(vscode.postMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "upsertApiConfiguration",
				text: "default",
				apiConfiguration: expect.objectContaining({
					apiModelId: expect.stringContaining("claude-3-5-haiku"),
					reasoningEffort: undefined,
					modelMaxTokens: undefined,
					modelMaxThinkingTokens: undefined,
				}),
			}),
		)
	})

	it("prefers a model's displayName over its raw id when present", () => {
		useRouterModelsMock.mockReturnValue({
			data: {
				openrouter: {
					"openrouter/model-a": modelInfo({ displayName: "Model A (friendly)" }),
					"openrouter/model-b": modelInfo(),
				},
			},
			isLoading: false,
		})
		useSelectedModelMock.mockReturnValue({
			id: "openrouter/model-a",
			info: modelInfo({ displayName: "Model A (friendly)" }),
			isLoading: false,
		})

		render(
			<ModelSelector
				apiConfiguration={
					{
						apiProvider: providerIdentifiers.openrouter,
						openRouterModelId: "openrouter/model-a",
					} as ProviderSettings
				}
				currentApiConfigName="default"
				title="Select model"
				organizationAllowList={allowAllList}
			/>,
		)

		// Trigger shows the displayName, not the raw id.
		expect(screen.getByTestId("model-selector-trigger")).toHaveTextContent("Model A (friendly)")
		expect(screen.queryByText("openrouter/model-a")).not.toBeInTheDocument()

		// List item for the model without a displayName still falls back to its raw id.
		const content = openPopover()
		expect(content.getByText("openrouter/model-b")).toBeInTheDocument()
	})

	it("renders the dynamic router model list for a dynamic provider", () => {
		useRouterModelsMock.mockReturnValue({
			data: {
				openrouter: {
					"openrouter/model-a": modelInfo(),
					"openrouter/model-b": modelInfo(),
				},
			},
			isLoading: false,
		})
		useSelectedModelMock.mockReturnValue({ id: "openrouter/model-a", isLoading: false })

		const apiConfiguration: ProviderSettings = {
			apiProvider: providerIdentifiers.openrouter,
			openRouterModelId: "openrouter/model-a",
			reasoningEffort: "medium",
			modelMaxTokens: 4096,
			modelMaxThinkingTokens: 2048,
		}

		render(
			<ModelSelector
				apiConfiguration={apiConfiguration}
				currentApiConfigName="default"
				title="Select model"
				organizationAllowList={allowAllList}
			/>,
		)

		const content = openPopover()
		expect(content.getByText("openrouter/model-b")).toBeInTheDocument()

		fireEvent.click(content.getByText("openrouter/model-b"))

		expect(vscode.postMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "upsertApiConfiguration",
				apiConfiguration: expect.objectContaining({
					openRouterModelId: "openrouter/model-b",
					reasoningEffort: undefined,
					modelMaxTokens: undefined,
					modelMaxThinkingTokens: undefined,
				}),
			}),
		)
	})

	it("disables the selector for a provider outside the supported scope", () => {
		useSelectedModelMock.mockReturnValue({ id: "", isLoading: false })

		render(
			<ModelSelector
				apiConfiguration={{ apiProvider: providerIdentifiers.ollama } as ProviderSettings}
				currentApiConfigName="default"
				title="Select model"
			/>,
		)

		expect(screen.queryByTestId("model-selector-trigger")).not.toBeInTheDocument()
		expect(screen.getByTestId("model-selector-disabled")).toBeInTheDocument()

		fireEvent.click(screen.getByTestId("model-selector-disabled"))

		expect(vscode.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "switchTab", tab: "settings" }))
	})

	it("shows the loading trigger instead of the unsupported fallback while a dynamic provider's models are loading", () => {
		// Isolate the router-model loading scenario: the router-models query is
		// still loading while selected-model resolution has already completed.
		// This verifies the component gates the unsupported fallback on
		// router-model loading, not just on selected-model loading.
		useRouterModelsMock.mockReturnValue({ data: undefined, isLoading: true })
		useSelectedModelMock.mockReturnValue({ id: "", isLoading: false })

		render(
			<ModelSelector
				apiConfiguration={
					{
						apiProvider: providerIdentifiers.openrouter,
						openRouterModelId: "openrouter/model-a",
					} as ProviderSettings
				}
				currentApiConfigName="default"
				title="Select model"
				organizationAllowList={allowAllList}
			/>,
		)

		// The unsupported fallback must not appear while loading.
		expect(screen.queryByTestId("model-selector-disabled")).not.toBeInTheDocument()

		// The trigger is visible and shows the loading label.
		const trigger = screen.getByTestId("model-selector-trigger")
		expect(trigger).toBeInTheDocument()
		expect(trigger).toHaveTextContent("common:ui.loading")
	})

	it("does not render model options until the trigger is activated", () => {
		render(
			<ModelSelector
				apiConfiguration={
					{
						apiProvider: providerIdentifiers.anthropic,
						apiModelId: "claude-sonnet-4-5",
					} as ProviderSettings
				}
				currentApiConfigName="default"
				title="Select model"
				organizationAllowList={allowAllList}
			/>,
		)

		// Before opening, model options are not rendered (PopoverContent is hidden).
		expect(screen.queryByTestId("popover-content")).not.toBeInTheDocument()
		expect(screen.queryAllByRole("option")).toHaveLength(0)

		// After clicking the trigger, the popover content and model options appear.
		fireEvent.click(screen.getByTestId("model-selector-trigger"))

		expect(screen.getByTestId("popover-content")).toBeInTheDocument()
		expect(screen.queryAllByRole("option")).not.toHaveLength(0)
	})

	it("filters models by search query, shows no-results, and restores the list when cleared", () => {
		const models: Record<string, ModelInfo> = {
			"openrouter/alpha": modelInfo(),
			"openrouter/bravo": modelInfo(),
			"openrouter/charlie": modelInfo(),
			"openrouter/delta": modelInfo(),
			"openrouter/echo": modelInfo(),
			"openrouter/foxtrot": modelInfo(),
			"openrouter/golf": modelInfo(),
			"openrouter/hotel": modelInfo(),
		}

		useRouterModelsMock.mockReturnValue({
			data: { openrouter: models },
			isLoading: false,
		})
		useSelectedModelMock.mockReturnValue({ id: "openrouter/alpha", isLoading: false })

		render(
			<ModelSelector
				apiConfiguration={
					{
						apiProvider: providerIdentifiers.openrouter,
						openRouterModelId: "openrouter/alpha",
					} as ProviderSettings
				}
				currentApiConfigName="default"
				title="Select model"
				organizationAllowList={allowAllList}
			/>,
		)

		// Open the popover to reveal the search input (> SEARCH_THRESHOLD models).
		const content = openPopover()

		const searchInput = screen.getByLabelText("common:ui.search_placeholder")

		// All eight models are visible initially.
		expect(content.getByText("openrouter/alpha")).toBeInTheDocument()
		expect(content.getByText("openrouter/hotel")).toBeInTheDocument()

		// Type a query that matches only "alpha".
		fireEvent.change(searchInput, { target: { value: "alpha" } })

		expect(content.getByText("openrouter/alpha")).toBeInTheDocument()
		expect(content.queryByText("openrouter/bravo")).not.toBeInTheDocument()
		expect(content.queryByText("openrouter/hotel")).not.toBeInTheDocument()

		// Type a query that matches nothing.
		fireEvent.change(searchInput, { target: { value: "zzz-no-match" } })

		expect(screen.getByText("common:ui.no_results")).toBeInTheDocument()
		expect(content.queryByText("openrouter/alpha")).not.toBeInTheDocument()

		// Clear the query to restore the full list.
		fireEvent.change(searchInput, { target: { value: "" } })

		expect(content.getByText("openrouter/alpha")).toBeInTheDocument()
		expect(content.getByText("openrouter/hotel")).toBeInTheDocument()
	})

	it("selects a model via keyboard activation", () => {
		render(
			<ModelSelector
				apiConfiguration={
					{
						apiProvider: providerIdentifiers.anthropic,
						apiModelId: "claude-sonnet-4-5",
					} as ProviderSettings
				}
				currentApiConfigName="default"
				title="Select model"
				organizationAllowList={allowAllList}
			/>,
		)

		// Open the popover.
		fireEvent.click(screen.getByTestId("model-selector-trigger"))

		// The model option is a keyboard-accessible native button (role="option").
		// Native <button> elements are focusable and fire a click event on Enter
		// or Space as a browser default action, enabling keyboard activation
		// without a pointer device.
		//
		// NOTE: vitest.setup.ts mocks HTMLElement.prototype.focus as a no-op for
		// FAST Foundation compatibility, so user.tab()/user.keyboard("{Enter}")
		// cannot drive focus. We simulate the keyboard path directly: dispatch
		// keyDown(Enter) then the click event the browser would fire as the
		// default action on a focused <button>.
		const option = screen.getAllByRole("option", { name: /claude-3-5-haiku/i })[0]
		expect(option.tagName).toBe("BUTTON")

		fireEvent.keyDown(option, { key: "Enter", code: "Enter", charCode: 13 })
		fireEvent.click(option)

		expect(vscode.postMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "upsertApiConfiguration",
				apiConfiguration: expect.objectContaining({
					apiModelId: expect.stringContaining("claude-3-5-haiku"),
				}),
			}),
		)
	})

	it("filters models according to the organization allowlist", () => {
		useRouterModelsMock.mockReturnValue({
			data: {
				openrouter: {
					"openrouter/allowed": modelInfo(),
					"openrouter/blocked": modelInfo(),
				},
			},
			isLoading: false,
		})
		useSelectedModelMock.mockReturnValue({ id: "openrouter/allowed", isLoading: false })

		const restrictiveList: OrganizationAllowList = {
			allowAll: false,
			providers: {
				openrouter: {
					allowAll: false,
					models: ["openrouter/allowed"],
				},
			},
		}

		render(
			<ModelSelector
				apiConfiguration={
					{
						apiProvider: providerIdentifiers.openrouter,
						openRouterModelId: "openrouter/allowed",
					} as ProviderSettings
				}
				currentApiConfigName="default"
				title="Select model"
				organizationAllowList={restrictiveList}
			/>,
		)

		const content = openPopover()
		expect(content.getByText("openrouter/allowed")).toBeInTheDocument()
		expect(content.queryByText("openrouter/blocked")).not.toBeInTheDocument()
	})

	it("excludes the custom-arn pseudo-model from the Bedrock model list while keeping real models selectable", () => {
		render(
			<ModelSelector
				apiConfiguration={
					{
						apiProvider: providerIdentifiers.bedrock,
						apiModelId: "claude-3-5-sonnet-20241022-v2:0",
					} as ProviderSettings
				}
				currentApiConfigName="default"
				title="Select model"
				organizationAllowList={allowAllList}
			/>,
		)

		const content = openPopover()

		// The custom-arn pseudo-model must not appear as a selectable option.
		expect(content.queryByText(/custom-arn/i)).not.toBeInTheDocument()

		// Normal Bedrock models remain selectable.
		expect(content.queryAllByRole("option")).not.toHaveLength(0)
	})

	it("shows the unsupported fallback for a retired provider and navigates to settings on click", () => {
		useSelectedModelMock.mockReturnValue({ id: "", isLoading: false })

		render(
			<ModelSelector
				apiConfiguration={
					{
						apiProvider: retiredProviderIdentifiers.groq,
					} as ProviderSettings
				}
				currentApiConfigName="default"
				title="Select model"
			/>,
		)

		// A retired provider has no model config, so the unsupported shortcut renders.
		expect(screen.queryByTestId("model-selector-trigger")).not.toBeInTheDocument()
		expect(screen.getByTestId("model-selector-disabled")).toBeInTheDocument()

		fireEvent.click(screen.getByTestId("model-selector-disabled"))

		expect(vscode.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "switchTab", tab: "settings" }))
	})

	it("shows the unsupported fallback when the organization allowlist filters out every model", () => {
		useRouterModelsMock.mockReturnValue({
			data: {
				openrouter: {
					"openrouter/allowed": modelInfo(),
					"openrouter/blocked": modelInfo(),
				},
			},
			isLoading: false,
		})
		useSelectedModelMock.mockReturnValue({ id: "openrouter/allowed", isLoading: false })

		// An allowlist that blocks every model for this provider.
		const blockAllList: OrganizationAllowList = {
			allowAll: false,
			providers: {
				openrouter: {
					allowAll: false,
					models: [],
				},
			},
		}

		render(
			<ModelSelector
				apiConfiguration={
					{
						apiProvider: providerIdentifiers.openrouter,
						openRouterModelId: "openrouter/allowed",
					} as ProviderSettings
				}
				currentApiConfigName="default"
				title="Select model"
				organizationAllowList={blockAllList}
			/>,
		)

		// With zero models after filtering, the unsupported shortcut renders.
		expect(screen.queryByTestId("model-selector-trigger")).not.toBeInTheDocument()
		expect(screen.getByTestId("model-selector-disabled")).toBeInTheDocument()
	})
})
