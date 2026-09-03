import { providerIdentifiers } from "@roo-code/types"

import { render, screen, fireEvent } from "@/utils/test-utils"
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
})
