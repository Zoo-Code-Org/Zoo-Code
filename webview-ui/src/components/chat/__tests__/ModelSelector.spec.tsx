import { render, screen, fireEvent } from "@/utils/test-utils"

import { providerIdentifiers, type ProviderSettings } from "@roo-code/types"

import { ModelSelector } from "../ModelSelector"

vi.mock("@/utils/vscode", () => ({
	vscode: {
		postMessage: vi.fn(),
	},
}))

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({
		organizationAllowList: { allowAll: true, providers: {} },
		currentApiConfigName: "default",
	}),
}))

vi.mock("@/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string) => key,
	}),
}))

vi.mock("@/components/ui/hooks/useRooPortal", () => ({
	useRooPortal: () => document.body,
}))

const staticModelsOverride = vi.hoisted(() => ({ value: undefined as Record<string, unknown> | undefined }))

vi.mock("@/components/settings/utils/providerModelConfig", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/components/settings/utils/providerModelConfig")>()
	return {
		...actual,
		getStaticModelsForProvider: (...args: Parameters<typeof actual.getStaticModelsForProvider>) =>
			staticModelsOverride.value ?? actual.getStaticModelsForProvider(...args),
	}
})

import { vscode } from "@/utils/vscode"

describe("ModelSelector", () => {
	const anthropicConfig: ProviderSettings = {
		apiProvider: providerIdentifiers.anthropic,
		apiModelId: "claude-sonnet-4-5",
	}

	beforeEach(() => {
		vi.clearAllMocks()
		staticModelsOverride.value = undefined
	})

	test("re-selecting the active model does not post a config update", () => {
		render(<ModelSelector apiConfiguration={anthropicConfig} title="Select model" />)

		fireEvent.click(screen.getByTestId("model-selector-trigger"))
		fireEvent.change(screen.getByTestId("model-search-input"), { target: { value: "claude-sonnet-4-5" } })
		const items = screen.getAllByTestId("model-selector-item")
		const active = items.find((el) => el.querySelector(".lucide-check"))!
		fireEvent.click(active)

		expect(vscode.postMessage).not.toHaveBeenCalled()
		expect(screen.queryByTestId("model-search-input")).not.toBeInTheDocument()
	})

	test("hides deprecated models except the currently selected one", () => {
		const base = { contextWindow: 1000, supportsPromptCache: false }
		staticModelsOverride.value = {
			"model-active": { ...base, deprecated: true },
			"model-old": { ...base, deprecated: true },
			"model-new": base,
		}

		render(
			<ModelSelector
				apiConfiguration={{ apiProvider: providerIdentifiers.anthropic, apiModelId: "model-active" }}
				title="Select model"
			/>,
		)

		fireEvent.click(screen.getByTestId("model-selector-trigger"))

		const labels = screen.getAllByTestId("model-selector-item").map((el) => el.textContent)
		expect(labels).toEqual(["model-active", "model-new"])
	})

	test("shows the currently selected model on the trigger for a static-model provider", () => {
		render(<ModelSelector apiConfiguration={anthropicConfig} title="Select model" />)

		expect(screen.getByTestId("model-selector-trigger")).toBeInTheDocument()
	})

	test("disables the trigger when disabled", () => {
		render(<ModelSelector apiConfiguration={anthropicConfig} title="Select model" disabled />)

		expect(screen.getByTestId("model-selector-trigger")).toBeDisabled()
	})

	test("shows a search bar since anthropic has more than 6 models and filters the list", () => {
		render(<ModelSelector apiConfiguration={anthropicConfig} title="Select model" />)

		fireEvent.click(screen.getByTestId("model-selector-trigger"))

		expect(screen.getByTestId("model-search-input")).toBeInTheDocument()
		const allItems = screen.getAllByTestId("model-selector-item")
		expect(allItems.length).toBeGreaterThan(6)

		fireEvent.change(screen.getByTestId("model-search-input"), { target: { value: "claude-opus-4-6" } })

		const filteredItems = screen.getAllByTestId("model-selector-item")
		expect(filteredItems.length).toBeLessThan(allItems.length)
	})

	test("selecting a model persists it via upsertApiConfiguration and closes the popover", () => {
		render(<ModelSelector apiConfiguration={anthropicConfig} title="Select model" />)

		fireEvent.click(screen.getByTestId("model-selector-trigger"))
		fireEvent.change(screen.getByTestId("model-search-input"), { target: { value: "claude-opus-4-6" } })

		fireEvent.click(screen.getAllByTestId("model-selector-item")[0])

		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "upsertApiConfiguration",
			text: "default",
			apiConfiguration: expect.objectContaining({ apiModelId: "claude-opus-4-6" }),
		})
		expect(screen.queryByTestId("model-search-input")).not.toBeInTheDocument()
	})

	test("falls back to a degraded trigger for providers without a simple model list, and jumps to Settings on click", () => {
		render(
			<ModelSelector
				apiConfiguration={{ apiProvider: providerIdentifiers.openai, openAiModelId: "custom-model" }}
				title="Select model"
			/>,
		)

		expect(screen.queryByTestId("model-selector-trigger")).not.toBeInTheDocument()
		const unsupportedTrigger = screen.getByTestId("model-selector-unsupported-trigger")
		expect(unsupportedTrigger).toBeInTheDocument()

		fireEvent.click(unsupportedTrigger)

		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "switchTab", tab: "settings" })
	})
})
