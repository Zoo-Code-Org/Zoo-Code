// npx vitest src/components/chat/__tests__/ChatModelSelector.spec.tsx

import { screen, fireEvent, renderWithExtensionState } from "@/utils/test-utils"
import { act, type ReactNode } from "react"
import { QueryClient } from "@tanstack/react-query"
import { type Mock } from "vitest"

import { type ModelInfo, type ProviderSettings, getProviderDefaultModelId, providerIdentifiers } from "@roo-code/types"

import { useRouterModels } from "@/components/ui/hooks/useRouterModels"
import { useOllamaModels } from "@/components/ui/hooks/useOllamaModels"
import { useLmStudioModels } from "@/components/ui/hooks/useLmStudioModels"
import { useVsCodeLmModels } from "@/components/ui/hooks/useVsCodeLmModels"
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
vi.mock("@/components/ui/hooks/useVsCodeLmModels")
vi.mock("@/components/ui/hooks/useRooPortal", () => ({ useRooPortal: () => document.body }))

const mockUseRouterModels = useRouterModels as Mock<typeof useRouterModels>
const mockUseOllamaModels = useOllamaModels as Mock<typeof useOllamaModels>
const mockUseLmStudioModels = useLmStudioModels as Mock<typeof useLmStudioModels>
const mockUseVsCodeLmModels = useVsCodeLmModels as Mock<typeof useVsCodeLmModels>
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
		mockUseVsCodeLmModels.mockReturnValue({
			data: [],
			isLoading: false,
		} as unknown as ReturnType<typeof useVsCodeLmModels>)
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

	it("disables the trigger when no apiProvider is stored on the active profile", async () => {
		// Profiles without apiProvider get their provider-specific fields stripped
		// by the schema validator, so the adapter must disable the trigger rather
		// than let the user pick a model that would be silently dropped on reload.
		setState({ apiConfiguration: {} })

		renderSelector()

		const trigger = screen.getByTestId("chat-model-selector-trigger")
		expect(trigger).toBeDisabled()

		// Clicking a disabled trigger must not open the popover, so no model
		// option should be reachable.
		await act(async () => {
			fireEvent.click(trigger)
		})

		expect(screen.queryByTestId("model-option-model-a")).not.toBeInTheDocument()
		expect(mockPostMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "upsertApiConfiguration" }))
	})

	it("preserves the stored provider without injecting a provider override", async () => {
		setState({
			apiConfiguration: {
				apiProvider: providerIdentifiers.openrouter,
				openRouterModelId: "model-a",
			},
		})

		renderSelector()

		await act(async () => {
			fireEvent.click(screen.getByTestId("chat-model-selector-trigger"))
		})

		await act(async () => {
			fireEvent.click(screen.getByTestId("model-option-model-b"))
		})

		const payload = mockPostMessage.mock.calls.find(([msg]) => msg.type === "upsertApiConfiguration")?.[0]
		expect(payload?.apiConfiguration).toBeDefined()
		// The adapter must not rewrite apiProvider even though the hook defaults
		// to OpenRouter when no provider is set.
		expect(payload?.apiConfiguration).toHaveProperty("apiProvider", providerIdentifiers.openrouter)
	})

	it("lists VS Code LM models keyed as vendor/family even when custom models are restricted", async () => {
		setState({
			apiConfiguration: { apiProvider: providerIdentifiers.vscodeLm },
			organizationAllowList: {
				allowAll: false,
				providers: { [providerIdentifiers.vscodeLm]: { allowAll: false, models: ["copilot/gpt-4o"] } },
			},
		})
		mockUseVsCodeLmModels.mockReturnValue({
			data: [{ vendor: "copilot", family: "gpt-4o" }],
			isLoading: false,
		} as unknown as ReturnType<typeof useVsCodeLmModels>)

		renderSelector()

		await act(async () => {
			fireEvent.click(screen.getByTestId("chat-model-selector-trigger"))
		})

		expect(screen.getByTestId("model-option-copilot/gpt-4o")).toBeInTheDocument()
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
