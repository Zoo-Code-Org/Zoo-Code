import { screen, render } from "@/utils/test-utils"
import userEvent from "@testing-library/user-event"
import { type ModelInfo, type ProviderSettings, type OrganizationAllowList, providerIdentifiers } from "@roo-code/types"

import { ProfileQuickSettings } from "../ProfileQuickSettings"
import type { ProfileModelCatalog } from "../model-picker"
import { setupNativePickerFocus } from "./pickerTestFocus"

setupNativePickerFocus()

const mocks = vi.hoisted(() => ({
	configuration: {} as ProviderSettings,
	info: {} as ModelInfo,
	catalog: {} as ProfileModelCatalog,
	allowList: undefined as OrganizationAllowList | undefined,
	profileName: "Work",
	selectionLoading: false,
	postMessage: vi.fn(),
	setApiConfiguration: vi.fn(),
	refetch: vi.fn(),
}))

vi.mock("@/utils/vscode", () => ({ vscode: { postMessage: mocks.postMessage } }))
vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({
		apiConfiguration: mocks.configuration,
		currentApiConfigName: mocks.profileName,
		setApiConfiguration: mocks.setApiConfiguration,
		organizationAllowList: mocks.allowList,
	}),
}))
vi.mock("@/components/ui/hooks/useSelectedModel", () => ({
	useSelectedModel: () => ({
		id: mocks.configuration.apiModelId ?? mocks.configuration.openAiModelId,
		info: mocks.info,
		isLoading: mocks.selectionLoading,
	}),
}))
vi.mock("../model-picker/useProfileModelCatalog", () => ({ useProfileModelCatalog: () => mocks.catalog }))

describe("ProfileQuickSettings", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.profileName = "Work"
		mocks.selectionLoading = false
		mocks.allowList = undefined
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
		mocks.catalog = {
			provider: providerIdentifiers.openaiNative,
			field: "apiModelId",
			models: { "model-a": mocks.info, "model-b": { ...mocks.info, displayName: "Friendly Beta" } },
			isLoading: false,
			isError: false,
			isUnsupported: false,
			fallbackMessage: undefined,
			refetch: mocks.refetch,
		}
	})

	it("does not save on mount; fuzzy searches display names and clears without changing geometry", async () => {
		const user = userEvent.setup()
		render(<ProfileQuickSettings />)
		expect(mocks.postMessage).not.toHaveBeenCalled()
		const results = screen.getByRole("group", { name: "chat:modelPicker.providerModels" })
		expect(results).toHaveClass("h-[300px]", "shrink-0", "overflow-y-auto")
		await user.type(screen.getByRole("textbox"), "FrBt")
		expect(screen.getByRole("button", { name: "Friendly Beta" })).toBeInTheDocument()
		expect(screen.queryByRole("button", { name: "model-a" })).not.toBeInTheDocument()
		await user.clear(screen.getByRole("textbox"))
		await user.type(screen.getByRole("textbox"), "zzzzzz")
		expect(screen.getByText("common:ui.no_results")).toBeInTheDocument()
		expect(results).toHaveClass("h-[300px]")
		await user.click(screen.getByRole("button", { name: "chat:modelPicker.clearSearch" }))
		expect(screen.getByRole("textbox")).toHaveFocus()
		expect(screen.getByRole("button", { name: "model-a" })).toBeInTheDocument()
	})

	it("blocks stale effort until host confirms the new model, without optimistic state", async () => {
		const user = userEvent.setup()
		const { rerender } = render(<ProfileQuickSettings />)
		await user.click(screen.getByRole("button", { name: "Friendly Beta" }))
		expect(mocks.postMessage).toHaveBeenLastCalledWith({
			type: "updateProfileModel",
			text: "Work",
			values: {
				expectedProvider: providerIdentifiers.openaiNative,
				patch: {
					apiModelId: "model-b",
					enableReasoningEffort: null,
					reasoningEffort: null,
					modelMaxTokens: null,
					modelMaxThinkingTokens: null,
				},
			},
		})
		const effort = screen.getByRole("button", { name: "chat:modelPicker.effort.low" })
		expect(effort).toBeDisabled()
		// Reverse selection cannot race the pending request: all model results are disabled too.
		const previousModel = screen.getByRole("button", { name: "model-a" })
		const pendingModel = screen.getByRole("button", { name: "Friendly Beta" })
		expect(previousModel).toBeDisabled()
		expect(pendingModel).toBeDisabled()
		await user.click(previousModel)
		await user.click(pendingModel)
		await user.click(effort)
		expect(mocks.postMessage).toHaveBeenCalledTimes(1)
		// An unrelated state post must not make the old model's controls actionable.
		mocks.configuration = { ...mocks.configuration, apiKey: "rotated" }
		rerender(<ProfileQuickSettings />)
		expect(effort).toBeDisabled()
		expect(previousModel).toBeDisabled()
		mocks.configuration = { ...mocks.configuration, apiModelId: "model-b" }
		rerender(<ProfileQuickSettings />)
		expect(effort).toBeEnabled()
		expect(previousModel).toBeEnabled()
		expect(pendingModel).toBeEnabled()
		await user.click(pendingModel)
		expect(mocks.postMessage).toHaveBeenCalledTimes(1)
		await user.click(screen.getByRole("button", { name: "chat:modelPicker.effort.low" }))
		expect(mocks.postMessage).toHaveBeenLastCalledWith({
			type: "updateProfileModel",
			text: "Work",
			values: {
				expectedProvider: providerIdentifiers.openaiNative,
				patch: { reasoningEffort: "low", enableReasoningEffort: true },
			},
		})
		expect(mocks.setApiConfiguration).not.toHaveBeenCalled()
		expect(screen.queryByRole("button", { name: "chat:modelPicker.off" })).not.toBeInTheDocument()
	})

	it("keeps stale model controls disabled until the picker remounts after rejection", async () => {
		const user = userEvent.setup()
		const { unmount } = render(<ProfileQuickSettings />)
		await user.click(screen.getByRole("button", { name: "Friendly Beta" }))
		expect(screen.getByRole("button", { name: "model-a" })).toBeDisabled()
		expect(screen.getByRole("button", { name: "chat:modelPicker.effort.low" })).toBeDisabled()
		unmount()
		render(<ProfileQuickSettings />)
		expect(screen.getByRole("button", { name: "model-a" })).toBeEnabled()
		expect(screen.getByRole("button", { name: "chat:modelPicker.effort.low" })).toBeEnabled()
	})

	it("does not reset reasoning when the already selected model is clicked", async () => {
		const user = userEvent.setup()
		render(<ProfileQuickSettings />)
		await user.click(screen.getByRole("button", { name: "model-a" }))
		expect(mocks.postMessage).not.toHaveBeenCalled()
		expect(screen.getByRole("button", { name: "Friendly Beta" })).toBeEnabled()
		expect(screen.getByRole("button", { name: "chat:modelPicker.effort.low" })).toBeEnabled()
		expect(screen.getByRole("textbox")).toBeInTheDocument()
	})

	it("blocks model and effort writes until the selected model metadata resolves", async () => {
		mocks.selectionLoading = true
		const user = userEvent.setup()
		const { rerender } = render(<ProfileQuickSettings />)
		await user.click(screen.getByRole("button", { name: "Friendly Beta" }))
		await user.click(screen.getByRole("button", { name: "chat:modelPicker.effort.low" }))
		expect(mocks.postMessage).not.toHaveBeenCalled()
		mocks.selectionLoading = false
		rerender(<ProfileQuickSettings />)
		await user.click(screen.getByRole("button", { name: "Friendly Beta" }))
		expect(mocks.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "updateProfileModel" }))
	})

	it("selects via keyboard from search and keeps the controls mounted", async () => {
		const user = userEvent.setup()
		render(<ProfileQuickSettings />)
		await user.click(screen.getByRole("textbox"))
		await user.keyboard("{ArrowDown}{End}{Enter}")
		expect(screen.getByRole("button", { name: "Friendly Beta" })).toHaveFocus()
		expect(mocks.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "updateProfileModel" }))
		expect(screen.getByRole("textbox")).toBeInTheDocument()
	})

	it("applies organization restrictions and hides deprecated models except the selected one", () => {
		mocks.catalog.models = {
			...mocks.catalog.models,
			"model-a": { ...mocks.info, deprecated: true },
			retired: { ...mocks.info, deprecated: true },
			forbidden: mocks.info,
		}
		mocks.allowList = {
			allowAll: false,
			providers: {
				[providerIdentifiers.openaiNative]: { allowAll: false, models: ["model-a", "model-b", "retired"] },
			},
		}
		render(<ProfileQuickSettings />)
		expect(screen.getByRole("button", { name: "model-a" })).toBeInTheDocument()
		expect(screen.queryByRole("button", { name: "retired" })).not.toBeInTheDocument()
		expect(screen.queryByRole("button", { name: "forbidden" })).not.toBeInTheDocument()
	})

	it.each([false, true])("allows Bedrock custom-arn only when configured (%s)", (configured) => {
		mocks.configuration = {
			apiProvider: providerIdentifiers.bedrock,
			apiModelId: "model-a",
			awsCustomArn: configured ? "arn:configured" : undefined,
		}
		mocks.catalog = {
			...mocks.catalog,
			provider: providerIdentifiers.bedrock,
			models: { "model-a": mocks.info, "custom-arn": mocks.info, "arn:new": mocks.info },
		}
		render(<ProfileQuickSettings />)
		expect(!!screen.queryByRole("button", { name: "custom-arn" })).toBe(configured)
		expect(screen.queryByRole("button", { name: "arn:new" })).not.toBeInTheDocument()
	})

	it("uses nested OpenAI effort patches without sending custom metadata snapshots", async () => {
		mocks.configuration = { apiProvider: providerIdentifiers.openai, openAiModelId: "model-a" }
		mocks.catalog = { ...mocks.catalog, provider: providerIdentifiers.openai, field: "openAiModelId" }
		const user = userEvent.setup()
		render(<ProfileQuickSettings />)
		await user.click(screen.getByRole("button", { name: "chat:modelPicker.effort.xhigh" }))
		expect(mocks.postMessage).toHaveBeenLastCalledWith({
			type: "updateProfileModel",
			text: "Work",
			values: {
				expectedProvider: providerIdentifiers.openai,
				patch: {
					enableReasoningEffort: true,
					reasoningEffort: null,
					openAiCustomModelInfo: { reasoningEffort: "xhigh" },
				},
			},
		})
	})

	it.each(["loading", "error", "unsupported", "empty"] as const)(
		"keeps %s inside fixed results and retains Settings/retry",
		async (state) => {
			mocks.catalog = {
				...mocks.catalog,
				models: null,
				isLoading: state === "loading",
				isError: state === "error",
				isUnsupported: state === "unsupported",
			}
			const user = userEvent.setup()
			render(<ProfileQuickSettings />)
			expect(screen.getByRole("group", { name: "chat:modelPicker.providerModels" })).toHaveClass(
				"h-[300px]",
				"shrink-0",
				"overflow-y-auto",
			)
			if (state === "loading") expect(screen.getByRole("status")).toHaveTextContent("chat:modelSelector.loading")
			else {
				await user.click(screen.getByRole("button", { name: "chat:modelSelector.settings" }))
				expect(mocks.postMessage).toHaveBeenCalledWith({ type: "switchTab", tab: "settings" })
			}
			if (state === "error") {
				await user.click(screen.getByRole("button", { name: "chat:retry.title" }))
				expect(mocks.refetch).toHaveBeenCalledTimes(1)
			}
			// Settings-only catalogs must not remove otherwise supported reasoning controls.
			expect(screen.getByRole("group", { name: "chat:modelPicker.reasoningEffort" })).toBeInTheDocument()
		},
	)

	it("hides effort controls for models without support", () => {
		mocks.info = { contextWindow: 128000, supportsPromptCache: false }
		render(<ProfileQuickSettings />)
		expect(screen.queryByRole("group", { name: "chat:modelPicker.reasoningEffort" })).not.toBeInTheDocument()
	})

	it.each(["disabled", "unnamed"])("prevents writes for %s profiles", async (state) => {
		if (state === "unnamed") mocks.profileName = ""
		const user = userEvent.setup()
		render(<ProfileQuickSettings disabled={state === "disabled"} />)
		await user.click(screen.getByRole("button", { name: "Friendly Beta" }))
		await user.click(screen.getByRole("button", { name: "chat:modelPicker.effort.low" }))
		expect(mocks.postMessage).not.toHaveBeenCalled()
	})
})
