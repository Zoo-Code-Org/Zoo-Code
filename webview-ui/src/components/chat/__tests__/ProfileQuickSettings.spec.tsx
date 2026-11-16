import { fireEvent, render, screen } from "@testing-library/react"
import { type ModelInfo, type ProviderSettings, providerIdentifiers } from "@roo-code/types"

import { ProfileQuickSettings } from "../ProfileQuickSettings"

const mocks = vi.hoisted(() => ({
	configuration: {} as ProviderSettings,
	info: {
		contextWindow: 128000,
		supportsPromptCache: false,
		supportsReasoningEffort: ["low", "high"],
		requiredReasoningEffort: true,
		reasoningEffort: "high",
	} as ModelInfo,
	postMessage: vi.fn(),
	setApiConfiguration: vi.fn(),
}))

vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: mocks.postMessage } }))
vi.mock("@src/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({
		apiConfiguration: mocks.configuration,
		currentApiConfigName: "Work",
		setApiConfiguration: mocks.setApiConfiguration,
		organizationAllowList: { allowAll: true },
	}),
}))
vi.mock("@src/components/ui/hooks/useSelectedModel", () => ({
	useSelectedModel: () => ({
		id: mocks.configuration.apiModelId ?? mocks.configuration.openAiModelId,
		info: mocks.info,
	}),
}))
vi.mock("@src/components/ui/hooks/useRouterModels", () => ({ useRouterModels: () => ({ data: {} }) }))
vi.mock("@src/components/settings/utils/providerModelConfig", () => ({
	getProviderModelConfig: (provider: string) => ({
		field: provider === providerIdentifiers.openai ? "openAiModelId" : "apiModelId",
	}),
	getStaticModelsForProvider: () => ({ "model-a": {}, "model-b": {} }),
}))

describe("ProfileQuickSettings", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.configuration = {
			apiProvider: providerIdentifiers.openaiNative,
			apiModelId: "model-a",
			apiKey: "keep-secret",
		}
		mocks.info = {
			contextWindow: 128000,
			supportsPromptCache: false,
			supportsReasoningEffort: ["low", "high"],
			requiredReasoningEffort: true,
			reasoningEffort: "high",
		}
	})

	it("does not save on mount and filters available models", () => {
		render(<ProfileQuickSettings />)
		expect(mocks.postMessage).not.toHaveBeenCalled()
		expect(
			screen.getByRole("textbox", { name: "chat:modelPicker.searchModels" }).parentElement?.parentElement,
		).toHaveClass("py-2")
		fireEvent.change(screen.getByRole("textbox", { name: "chat:modelPicker.searchModels" }), {
			target: { value: "model-b" },
		})
		expect(screen.queryByRole("button", { name: "model-a" })).not.toBeInTheDocument()
		expect(screen.getByRole("button", { name: "model-b" })).toBeInTheDocument()
	})

	it("saves a selected model in the active profile and preserves credentials", () => {
		render(<ProfileQuickSettings />)
		fireEvent.click(screen.getByRole("button", { name: "model-b" }))
		expect(mocks.postMessage).toHaveBeenCalledWith({
			type: "upsertApiConfiguration",
			text: "Work",
			apiConfiguration: expect.objectContaining({
				apiModelId: "model-b",
				apiKey: "keep-secret",
				reasoningEffort: undefined,
			}),
		})
		expect(screen.getByRole("textbox", { name: "chat:modelPicker.searchModels" })).toBeInTheDocument()
	})

	it("saves effort after a model change without reverting the model", () => {
		render(<ProfileQuickSettings />)
		fireEvent.click(screen.getByRole("button", { name: "model-b" }))
		fireEvent.click(screen.getByRole("button", { name: "chat:modelPicker.effort.low" }))
		expect(mocks.postMessage).toHaveBeenLastCalledWith(
			expect.objectContaining({
				apiConfiguration: expect.objectContaining({
					apiModelId: "model-b",
					reasoningEffort: "low",
					enableReasoningEffort: true,
				}),
			}),
		)
		expect(screen.queryByRole("button", { name: "chat:modelPicker.off" })).not.toBeInTheDocument()
	})

	it("hides effort controls for a model without support", () => {
		mocks.info = { contextWindow: 128000, supportsPromptCache: false, supportsReasoningEffort: false }
		render(<ProfileQuickSettings />)
		expect(screen.queryByRole("group", { name: "chat:modelPicker.reasoningEffort" })).not.toBeInTheDocument()
	})

	it("loads OpenAI-compatible models and persists effort in custom model metadata", () => {
		mocks.configuration = {
			apiProvider: providerIdentifiers.openai,
			openAiModelId: "custom",
			openAiBaseUrl: "https://example.com/v1",
		}
		render(<ProfileQuickSettings />)
		expect(mocks.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "requestOpenAiModels" }))
		fireEvent(
			window,
			new MessageEvent("message", { data: { type: "openAiModels", openAiModels: ["custom", "other"] } }),
		)
		fireEvent.click(screen.getByRole("button", { name: "other" }))
		fireEvent.click(screen.getByRole("button", { name: "chat:modelPicker.effort.xhigh" }))
		expect(mocks.postMessage).toHaveBeenLastCalledWith(
			expect.objectContaining({
				apiConfiguration: expect.objectContaining({
					openAiModelId: "other",
					enableReasoningEffort: true,
					openAiCustomModelInfo: expect.objectContaining({ reasoningEffort: "xhigh" }),
				}),
			}),
		)
	})

	it("disables writes while profile selection is disabled", () => {
		render(<ProfileQuickSettings disabled />)
		fireEvent.click(screen.getByRole("button", { name: "model-b" }))
		fireEvent.click(screen.getByRole("button", { name: "chat:modelPicker.effort.low" }))
		expect(mocks.postMessage).not.toHaveBeenCalled()
	})

	it("requests closing only after saving a model, not after changing effort", () => {
		const onModelSelected = vi.fn()
		render(<ProfileQuickSettings onModelSelected={onModelSelected} />)
		fireEvent.click(screen.getByRole("button", { name: "chat:modelPicker.effort.low" }))
		expect(onModelSelected).not.toHaveBeenCalled()
		fireEvent.click(screen.getByRole("button", { name: "model-b" }))
		expect(mocks.postMessage).toHaveBeenLastCalledWith(
			expect.objectContaining({
				type: "upsertApiConfiguration",
				apiConfiguration: expect.objectContaining({ apiModelId: "model-b" }),
			}),
		)
		expect(onModelSelected).toHaveBeenCalledTimes(1)
	})
})
