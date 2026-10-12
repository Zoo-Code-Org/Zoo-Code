// npx vitest src/components/chat/__tests__/ChatModelSelector.spec.tsx

import { screen, fireEvent, renderWithExtensionState } from "@/utils/test-utils"
import { act, type ReactNode } from "react"
import { QueryClient } from "@tanstack/react-query"
import { type Mock } from "vitest"

import { type ModelInfo, type ProviderSettings, getProviderDefaultModelId, providerIdentifiers } from "@roo-code/types"

import { useRouterModels } from "@/components/ui/hooks/useRouterModels"
import { useOllamaModels } from "@/components/ui/hooks/useOllamaModels"
import { useLmStudioModels } from "@/components/ui/hooks/useLmStudioModels"
import { useExtensionState } from "@src/context/ExtensionStateContext"
import { vscode } from "@/utils/vscode"

import { ChatModelSelector } from "../ChatModelSelector"

vi.mock("@/utils/vscode", () => ({
	vscode: {
		postMessage: vi.fn(),
	},
}))

vi.mock("@src/context/ExtensionStateContext", () => ({
	ExtensionStateContextProvider: ({ children }: { children: ReactNode }) => children,
	useExtensionState: vi.fn(),
}))

vi.mock("@/components/ui/hooks/useRouterModels")
vi.mock("@/components/ui/hooks/useOllamaModels")
vi.mock("@/components/ui/hooks/useLmStudioModels")
vi.mock("@/components/ui/hooks/useRooPortal", () => ({ useRooPortal: () => document.body }))

const mockUseRouterModels = useRouterModels as Mock<typeof useRouterModels>
const mockUseOllamaModels = useOllamaModels as Mock<typeof useOllamaModels>
const mockUseLmStudioModels = useLmStudioModels as Mock<typeof useLmStudioModels>
const mockUseExtensionState = useExtensionState as Mock<typeof useExtensionState>
const mockPostMessage = vscode.postMessage as Mock

Element.prototype.scrollIntoView = vi.fn()

type Story = Pick<
	ReturnType<typeof useExtensionState>,
	"apiConfiguration" | "organizationAllowList" | "currentApiConfigName" | "routerModels"
>

describe("ChatModelSelector", () => {
	const modelInfo: ModelInfo = {
		maxTokens: 8192,
		contextWindow: 200_000,
		supportsImages: true,
		supportsPromptCache: true,
	}

	const routerModels = {
		openrouter: {
			"model-a": { name: "Model A", ...modelInfo },
			"model-b": { name: "Model B", ...modelInfo },
		},
	}

	const queryClient = new QueryClient()

	const setState = (story: Partial<Story>) => {
		mockUseExtensionState.mockReturnValue({
			apiConfiguration: { apiProvider: providerIdentifiers.openrouter } as ProviderSettings,
			organizationAllowList: { allowAll: true, providers: {} },
			currentApiConfigName: "Default",
			...story,
		} as unknown as ReturnType<typeof useExtensionState>)
	}

	const renderSelector = () => renderWithExtensionState(<ChatModelSelector title="Select model" />, { queryClient })

	beforeEach(() => {
		vi.clearAllMocks()
		mockUseRouterModels.mockReturnValue({
			data: routerModels,
			isLoading: false,
			isError: false,
		} as unknown as ReturnType<typeof useRouterModels>)
		mockUseOllamaModels.mockReturnValue({
			data: undefined,
			isLoading: false,
		} as unknown as ReturnType<typeof useOllamaModels>)
		mockUseLmStudioModels.mockReturnValue({
			data: undefined,
			isLoading: false,
		} as unknown as ReturnType<typeof useLmStudioModels>)
		setState({})
	})

	it("renders the default model id when no model is selected", () => {
		renderSelector()

		const trigger = screen.getByTestId("chat-model-selector-trigger")
		expect(trigger).toBeInTheDocument()
		expect(trigger).toHaveTextContent(getProviderDefaultModelId(providerIdentifiers.openrouter))
	})

	it("renders the selected model id from the active configuration", () => {
		setState({
			apiConfiguration: { apiProvider: providerIdentifiers.anthropic, apiModelId: "claude-3-opus-20240229" },
		})

		renderSelector()

		expect(screen.getByTestId("chat-model-selector-trigger")).toHaveTextContent("claude-3-opus-20240229")
	})

	it("persists the selection to the active profile via upsertApiConfiguration", async () => {
		renderSelector()

		await act(async () => {
			fireEvent.click(screen.getByTestId("chat-model-selector-trigger"))
		})

		await act(async () => {
			fireEvent.click(screen.getByTestId("model-option-model-a"))
		})

		expect(mockPostMessage).toHaveBeenCalledWith({
			type: "upsertApiConfiguration",
			text: "Default",
			apiConfiguration: expect.objectContaining({
				apiProvider: providerIdentifiers.openrouter,
				openRouterModelId: "model-a",
			}),
		})
	})

	it("is disabled and does not persist when there is no active profile", async () => {
		setState({ currentApiConfigName: undefined })

		renderSelector()

		expect(screen.getByTestId("chat-model-selector-trigger")).toBeDisabled()
		expect(mockPostMessage).not.toHaveBeenCalled()
	})

	it("hides the custom-model escape hatch for a restricted provider", async () => {
		setState({
			organizationAllowList: {
				allowAll: false,
				providers: { [providerIdentifiers.openrouter]: { allowAll: false } },
			},
		})

		renderSelector()

		await act(async () => {
			fireEvent.click(screen.getByTestId("chat-model-selector-trigger"))
		})

		await act(async () => {
			fireEvent.change(screen.getByTestId("model-input"), { target: { value: "my-custom-model" } })
		})

		expect(screen.queryByTestId("use-custom-model")).not.toBeInTheDocument()
	})
})
