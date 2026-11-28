import { render, screen, fireEvent } from "@/utils/test-utils"

import { providerIdentifiers, type ModelInfo, type ProviderSettings } from "@roo-code/types"

import { ReasoningEffortSelector } from "../ReasoningEffortSelector"

vi.mock("@/utils/vscode", () => ({
	vscode: {
		postMessage: vi.fn(),
	},
}))

const extensionState = vi.hoisted(() => ({
	currentApiConfigName: "default" as string | undefined,
}))

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => extensionState,
}))

vi.mock("@/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string) => key,
	}),
}))

vi.mock("@/components/ui/hooks/useRooPortal", () => ({
	useRooPortal: () => document.body,
}))

const selectedModel = vi.hoisted(() => ({
	value: {
		provider: "",
		id: "test-model",
		info: undefined as ModelInfo | undefined,
	},
}))

vi.mock("@/components/ui/hooks/useSelectedModel", () => ({
	useSelectedModel: () => selectedModel.value,
}))

import { vscode } from "@/utils/vscode"

const capableInfo: ModelInfo = {
	contextWindow: 128_000,
	supportsPromptCache: false,
	supportsReasoningEffort: ["low", "medium", "high"],
	reasoningEffort: "medium",
}

describe("ReasoningEffortSelector", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		extensionState.currentApiConfigName = "default"
		selectedModel.value = { provider: providerIdentifiers.openai, id: "test-model", info: capableInfo }
	})

	const renderSelector = (apiConfiguration: ProviderSettings = {}, title = "Reasoning effort") =>
		render(<ReasoningEffortSelector apiConfiguration={apiConfiguration} title={title} />)

	test("renders nothing when the active model does not support reasoning effort", () => {
		selectedModel.value = {
			provider: providerIdentifiers.openai,
			id: "test-model",
			info: { contextWindow: 128_000, supportsPromptCache: false },
		}

		const { container } = renderSelector({})

		expect(container).toBeEmptyDOMElement()
	})

	test("renders nothing when there is no active profile", () => {
		extensionState.currentApiConfigName = undefined

		const { container } = renderSelector({})

		expect(container).toBeEmptyDOMElement()
	})

	test("shows the active effort on the trigger, resolving the model default", () => {
		renderSelector({})

		expect(screen.getByTestId("reasoning-effort-selector-trigger")).toHaveTextContent(
			"settings:providers.reasoningEffort.medium",
		)
	})

	test("shows Off when reasoning is disabled by the profile", () => {
		renderSelector({ enableReasoningEffort: false, reasoningEffort: "high" })

		expect(screen.getByTestId("reasoning-effort-selector-trigger")).toHaveTextContent(
			"chat:reasoningEffortSelector.off",
		)
	})

	test("offers exactly the supported efforts plus Default", () => {
		renderSelector({})

		fireEvent.click(screen.getByTestId("reasoning-effort-selector-trigger"))

		expect(screen.getByTestId("reasoning-effort-item-default")).toBeInTheDocument()
		expect(screen.getByTestId("reasoning-effort-item-low")).toBeInTheDocument()
		expect(screen.getByTestId("reasoning-effort-item-medium")).toBeInTheDocument()
		expect(screen.getByTestId("reasoning-effort-item-high")).toBeInTheDocument()
		expect(screen.queryByTestId("reasoning-effort-item-none")).not.toBeInTheDocument()
		expect(screen.queryByTestId("reasoning-effort-item-xhigh")).not.toBeInTheDocument()
	})

	test("marks Default as current when no override is active", () => {
		renderSelector({})

		fireEvent.click(screen.getByTestId("reasoning-effort-selector-trigger"))

		expect(screen.getByTestId("reasoning-effort-item-default")).toHaveAttribute("aria-current", "true")
		expect(screen.queryByTestId("reasoning-effort-override-indicator")).not.toBeInTheDocument()
	})

	test("reflects the active override on the trigger and in the menu", () => {
		renderSelector({ reasoningEffort: "low", reasoningEffortOverride: "high" })

		const trigger = screen.getByTestId("reasoning-effort-selector-trigger")
		expect(trigger).toHaveTextContent("settings:providers.reasoningEffort.high")
		expect(screen.getByTestId("reasoning-effort-override-indicator")).toBeInTheDocument()

		fireEvent.click(trigger)

		expect(screen.getByTestId("reasoning-effort-item-high")).toHaveAttribute("aria-current", "true")
		expect(screen.getByTestId("reasoning-effort-item-default")).toHaveAttribute("aria-current", "false")
	})

	test("selecting an effort posts the override message with the profile name and provider", () => {
		renderSelector({})

		fireEvent.click(screen.getByTestId("reasoning-effort-selector-trigger"))
		fireEvent.click(screen.getByTestId("reasoning-effort-item-high"))

		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "updateReasoningEffortOverride",
			text: "default",
			values: { expectedProvider: providerIdentifiers.openai, effort: "high" },
		})
	})

	test("selecting Default posts a null effort to clear the override", () => {
		renderSelector({ reasoningEffortOverride: "high" })

		fireEvent.click(screen.getByTestId("reasoning-effort-selector-trigger"))
		fireEvent.click(screen.getByTestId("reasoning-effort-item-default"))

		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "updateReasoningEffortOverride",
			text: "default",
			values: { expectedProvider: providerIdentifiers.openai, effort: null },
		})
	})

	test("labels the disable entry as Off when the model supports it", () => {
		selectedModel.value = {
			provider: providerIdentifiers.openai,
			id: "test-model",
			info: {
				contextWindow: 128_000,
				supportsPromptCache: false,
				supportsReasoningEffort: ["disable", "medium"],
			},
		}

		renderSelector({})

		fireEvent.click(screen.getByTestId("reasoning-effort-selector-trigger"))

		expect(screen.getByTestId("reasoning-effort-item-disable")).toBeInTheDocument()
		expect(screen.getByTestId("reasoning-effort-item-disable")).toHaveTextContent(
			"chat:reasoningEffortSelector.off",
		)
	})

	test("ignores an override the active model does not support", () => {
		renderSelector({ reasoningEffort: "low", reasoningEffortOverride: "xhigh" })

		const trigger = screen.getByTestId("reasoning-effort-selector-trigger")
		expect(trigger).toHaveTextContent("settings:providers.reasoningEffort.low")
		expect(screen.queryByTestId("reasoning-effort-override-indicator")).not.toBeInTheDocument()

		fireEvent.click(trigger)

		expect(screen.getByTestId("reasoning-effort-item-default")).toHaveAttribute("aria-current", "true")
	})
})
