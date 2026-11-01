import { render, screen, fireEvent } from "@/utils/test-utils"

import { providerIdentifiers, type ProviderSettings } from "@roo-code/types"

import { ModelSelector } from "../ModelSelector"

vi.mock("@/utils/vscode", () => ({
	vscode: {
		postMessage: vi.fn(),
	},
}))

const extensionState = vi.hoisted(() => ({
	organizationAllowList: { allowAll: true, providers: {} } as Record<string, unknown>,
	currentApiConfigName: "default",
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

const routerModelsResult = vi.hoisted(() => ({
	value: { data: undefined, isLoading: false } as { data: unknown; isLoading: boolean },
	calls: [] as unknown[],
}))

vi.mock("@/components/ui/hooks/useRouterModels", () => ({
	useRouterModels: (opts: unknown) => {
		routerModelsResult.calls.push(opts)
		return routerModelsResult.value
	},
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

const selectedModelOverride = vi.hoisted(() => ({
	value: undefined as { id: string; info?: { displayName?: string } } | undefined,
}))

vi.mock("@/components/ui/hooks/useSelectedModel", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/components/ui/hooks/useSelectedModel")>()
	return {
		...actual,
		useSelectedModel: (...args: Parameters<typeof actual.useSelectedModel>) =>
			selectedModelOverride.value ?? actual.useSelectedModel(...args),
	}
})

import { vscode } from "@/utils/vscode"

const base = { contextWindow: 1000, supportsPromptCache: false }

describe("ModelSelector", () => {
	const anthropicConfig: ProviderSettings = {
		apiProvider: providerIdentifiers.anthropic,
		apiModelId: "claude-sonnet-4-5",
	}

	beforeEach(() => {
		vi.clearAllMocks()
		staticModelsOverride.value = undefined
		selectedModelOverride.value = undefined
		routerModelsResult.value = { data: undefined, isLoading: false }
		routerModelsResult.calls = []
		extensionState.organizationAllowList = { allowAll: true, providers: {} }
	})

	test("shows the currently selected model on the trigger for a static-model provider", () => {
		render(<ModelSelector apiConfiguration={anthropicConfig} title="Select model" />)

		expect(screen.getByTestId("model-selector-trigger")).toHaveTextContent("claude-sonnet-4-5")
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

	test("shows the description instead of a search bar when there are 6 or fewer models", () => {
		staticModelsOverride.value = { "model-a": base, "model-b": base }

		render(<ModelSelector apiConfiguration={anthropicConfig} title="Select model" />)
		fireEvent.click(screen.getByTestId("model-selector-trigger"))

		expect(screen.queryByTestId("model-search-input")).not.toBeInTheDocument()
		expect(screen.getByText("chat:modelSelector.description")).toBeInTheDocument()
		expect(screen.getAllByTestId("model-selector-item")).toHaveLength(2)
	})

	test("selecting a model patches the latest profile via updateProfileModel and closes the popover", () => {
		render(<ModelSelector apiConfiguration={anthropicConfig} title="Select model" />)

		fireEvent.click(screen.getByTestId("model-selector-trigger"))
		fireEvent.change(screen.getByTestId("model-search-input"), { target: { value: "claude-opus-4-6" } })

		fireEvent.click(screen.getAllByTestId("model-selector-item")[0])

		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "updateProfileModel",
			text: "default",
			values: {
				expectedProvider: providerIdentifiers.anthropic,
				patch: expect.objectContaining({
					apiModelId: "claude-opus-4-6",
					reasoningEffort: null,
					modelMaxTokens: null,
					modelMaxThinkingTokens: null,
				}),
			},
		})
		expect(screen.queryByTestId("model-search-input")).not.toBeInTheDocument()
	})

	test("selecting a Bedrock model clears the ARN fields with null, never an empty string", () => {
		staticModelsOverride.value = { "model-a": base, "model-b": base }
		const bedrockConfig: ProviderSettings = {
			apiProvider: providerIdentifiers.bedrock,
			apiModelId: "model-a",
			awsCustomArn: "arn:aws:bedrock:us-east-1:123456789012:inference-profile/old",
		}
		render(<ModelSelector apiConfiguration={bedrockConfig} title="Select model" />)

		fireEvent.click(screen.getByTestId("model-selector-trigger"))
		fireEvent.click(screen.getAllByTestId("model-selector-item")[1])

		const [message] = vi.mocked(vscode.postMessage).mock.calls[0]
		const patch: Record<string, unknown> = message.values?.patch ?? {}
		expect(patch).toMatchObject({
			apiModelId: "model-b",
			awsCustomArn: null,
			awsCustomArnBaseModelId: null,
			awsModelContextWindow: null,
		})
		expect(Object.values(patch)).not.toContain("")
	})

	describe("display names", () => {
		const named = {
			"model-a": { ...base, displayName: "Alpha Fast" },
			"model-b": { ...base, displayName: "Beta Deep" },
		}

		test("shows the selected model's display name instead of its id on the trigger", () => {
			selectedModelOverride.value = { id: "model-a", info: { displayName: "Alpha Fast" } }

			render(<ModelSelector apiConfiguration={anthropicConfig} title="Select model" />)

			const trigger = screen.getByTestId("model-selector-trigger")
			expect(trigger).toHaveTextContent("Alpha Fast")
			expect(trigger).not.toHaveTextContent("model-a")
		})

		test("lists display names and finds a model by searching its display name", () => {
			staticModelsOverride.value = {
				...named,
				"model-c": { ...base, displayName: "Gamma" },
				"model-d": { ...base, displayName: "Delta" },
				"model-e": { ...base, displayName: "Epsilon" },
				"model-f": { ...base, displayName: "Zeta" },
				"model-g": { ...base, displayName: "Eta" },
			}

			render(
				<ModelSelector apiConfiguration={{ ...anthropicConfig, apiModelId: "model-a" }} title="Select model" />,
			)
			fireEvent.click(screen.getByTestId("model-selector-trigger"))
			expect(screen.getByText("Beta Deep")).toBeInTheDocument()

			fireEvent.change(screen.getByTestId("model-search-input"), { target: { value: "Beta Deep" } })

			const items = screen.getAllByTestId("model-selector-item")
			expect(items).toHaveLength(1)
			expect(items[0]).toHaveTextContent("Beta Deep")

			fireEvent.click(items[0])
			expect(vi.mocked(vscode.postMessage).mock.calls[0][0].values?.patch).toMatchObject({
				apiModelId: "model-b",
			})
		})
	})

	test("hides the Bedrock custom-arn pseudo-model unless it is already selected", () => {
		staticModelsOverride.value = { "model-a": base, "custom-arn": base }
		const bedrockConfig: ProviderSettings = { apiProvider: providerIdentifiers.bedrock, apiModelId: "model-a" }
		const { unmount } = render(<ModelSelector apiConfiguration={bedrockConfig} title="Select model" />)

		fireEvent.click(screen.getByTestId("model-selector-trigger"))
		expect(screen.getAllByTestId("model-selector-item")).toHaveLength(1)
		expect(screen.queryByText("custom-arn")).not.toBeInTheDocument()
		unmount()

		render(
			<ModelSelector
				apiConfiguration={{
					...bedrockConfig,
					apiModelId: "custom-arn",
					awsCustomArn: "arn:aws:bedrock:us-east-1:123456789012:inference-profile/x",
				}}
				title="Select model"
			/>,
		)
		fireEvent.click(screen.getByTestId("model-selector-trigger"))
		expect(screen.getAllByTestId("model-selector-item")).toHaveLength(2)
	})

	test("model items are real buttons so keyboard users can select them", () => {
		staticModelsOverride.value = { "model-a": base, "model-b": base }

		render(<ModelSelector apiConfiguration={anthropicConfig} title="Select model" />)
		fireEvent.click(screen.getByTestId("model-selector-trigger"))

		for (const item of screen.getAllByTestId("model-selector-item")) {
			expect(item.tagName).toBe("BUTTON")
		}
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

	test("hides models excluded by the organization allow-list", () => {
		staticModelsOverride.value = { "model-a": base, "model-b": base, "model-c": base }
		extensionState.organizationAllowList = {
			allowAll: false,
			providers: { [providerIdentifiers.anthropic]: { allowAll: false, models: ["model-a", "model-c"] } },
		}

		render(
			<ModelSelector
				apiConfiguration={{ apiProvider: providerIdentifiers.anthropic, apiModelId: "model-a" }}
				title="Select model"
			/>,
		)
		fireEvent.click(screen.getByTestId("model-selector-trigger"))

		const labels = screen.getAllByTestId("model-selector-item").map((el) => el.textContent)
		expect(labels).toEqual(["model-a", "model-c"])
	})

	describe("dynamic-model providers", () => {
		const openRouterConfig: ProviderSettings = {
			apiProvider: providerIdentifiers.openrouter,
			openRouterModelId: "vendor/model-one",
		}

		test("lists router models and selects through openRouterModelId", () => {
			routerModelsResult.value = {
				isLoading: false,
				data: { openrouter: { "vendor/model-one": base, "vendor/model-two": base } },
			}

			render(<ModelSelector apiConfiguration={openRouterConfig} title="Select model" />)
			fireEvent.click(screen.getByTestId("model-selector-trigger"))

			const items = screen.getAllByTestId("model-selector-item")
			expect(items.map((el) => el.textContent)).toEqual(["vendor/model-one", "vendor/model-two"])

			fireEvent.click(items[1])

			expect(vscode.postMessage).toHaveBeenCalledWith({
				type: "updateProfileModel",
				text: "default",
				values: {
					expectedProvider: providerIdentifiers.openrouter,
					patch: expect.objectContaining({ openRouterModelId: "vendor/model-two" }),
				},
			})
		})

		test("shows a loading state, not 'no results', while router models load", () => {
			routerModelsResult.value = { data: undefined, isLoading: true }

			render(<ModelSelector apiConfiguration={openRouterConfig} title="Select model" />)
			fireEvent.click(screen.getByTestId("model-selector-trigger"))

			expect(screen.getByText("chat:modelSelector.loading")).toBeInTheDocument()
			expect(screen.queryByText("common:ui.no_results")).not.toBeInTheDocument()
		})

		test("shows 'no results' when the router returns no models", () => {
			routerModelsResult.value = { data: { openrouter: {} }, isLoading: false }

			render(<ModelSelector apiConfiguration={openRouterConfig} title="Select model" />)
			fireEvent.click(screen.getByTestId("model-selector-trigger"))

			expect(screen.getByText("common:ui.no_results")).toBeInTheDocument()
			expect(screen.queryByText("chat:modelSelector.loading")).not.toBeInTheDocument()
		})

		test("shows 'no results' when the router request failed", () => {
			routerModelsResult.value = { data: undefined, isLoading: false }

			render(<ModelSelector apiConfiguration={openRouterConfig} title="Select model" />)
			fireEvent.click(screen.getByTestId("model-selector-trigger"))

			expect(screen.getByText("common:ui.no_results")).toBeInTheDocument()
		})

		test("does not request router models for providers without a model field", () => {
			render(
				<ModelSelector apiConfiguration={{ apiProvider: providerIdentifiers.fakeAi }} title="Select model" />,
			)

			expect(routerModelsResult.calls.length).toBeGreaterThan(0)
			expect(routerModelsResult.calls.every((opts) => (opts as { enabled: boolean }).enabled === false)).toBe(
				true,
			)
			expect(screen.getByTestId("model-selector-unsupported-trigger")).toBeInTheDocument()
		})
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
