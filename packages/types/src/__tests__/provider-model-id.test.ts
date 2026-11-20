import { retiredProviderIdentifiers } from "../provider-identifiers.js"
import { providerDefinitionList } from "../providers/index.js"
import {
	getModelId,
	providerIdentifiers,
	providerSettingsSchema,
	PROVIDER_SETTINGS_KEYS,
	type ProviderSettings,
} from "../index.js"

describe("provider model ID fields", () => {
	it.each(
		providerDefinitionList.flatMap((definition) =>
			definition.modelIdKey ? [[definition.apiProvider, definition.modelIdKey] as const] : [],
		),
	)("declares a persisted ProviderSettings key for %s", (_apiProvider, modelIdKey) => {
		expect(PROVIDER_SETTINGS_KEYS).toContain(modelIdKey)
	})
})

describe("getModelId", () => {
	it("uses a provider-specific model ID field instead of the shared apiModelId field", () => {
		const settings: ProviderSettings = {
			apiProvider: providerIdentifiers.openrouter,
			apiModelId: "unrelated-model",
			openRouterModelId: "openrouter-model",
		}

		expect(getModelId(settings)).toBe("openrouter-model")
	})

	it("selects the active provider's field when multiple provider-specific model IDs are present", () => {
		const settings: ProviderSettings = {
			apiProvider: providerIdentifiers.ollama,
			openRouterModelId: "inactive-openrouter-model",
			ollamaModelId: "ollama-model",
		}

		expect(getModelId(settings)).toBe("ollama-model")
	})

	it("uses the nested model selector for VS Code LM", () => {
		const settings: ProviderSettings = {
			apiProvider: providerIdentifiers.vscodeLm,
			vsCodeLmModelSelector: { vendor: "copilot", family: "gpt-4o", id: "vscode-model", version: "1" },
		}

		expect(getModelId(settings)).toBe("vscode-model")
	})

	it("preserves the exact Copilot model ID through the provider settings schema", () => {
		const settings: ProviderSettings = {
			apiProvider: providerIdentifiers.githubCopilot,
			vsCodeLmModelSelector: { vendor: "copilot", family: "gpt-4o", id: "copilot-model", version: "1" },
		}
		expect(getModelId(settings)).toBe("copilot-model")
	})

	it("persists only the selector's identity, never live model capabilities", () => {
		const saved = providerSettingsSchema.parse({
			apiProvider: providerIdentifiers.githubCopilot,
			vsCodeLmModelSelector: { vendor: "copilot", id: "dynamic-model", family: "dynamic-model", version: "1" },
		})
		expect(saved.vsCodeLmModelSelector).toEqual({
			vendor: "copilot",
			id: "dynamic-model",
			family: "dynamic-model",
			version: "1",
		})
	})

	it("drops a stale capability snapshot from profiles saved by earlier builds", () => {
		const saved = providerSettingsSchema.parse({
			apiProvider: providerIdentifiers.githubCopilot,
			vsCodeLmModelSelector: {
				vendor: "copilot",
				id: "old-model",
				modelInfo: { contextWindow: 1, supportsImages: false, supportsPromptCache: false },
			},
		})
		expect(getModelId(saved)).toBe("old-model")
		expect(saved.vsCodeLmModelSelector).not.toHaveProperty("modelInfo")
	})

	it("uses openAiModelId for OpenAI Compatible", () => {
		const settings: ProviderSettings = {
			apiProvider: providerIdentifiers.openai,
			apiModelId: "unrelated-model",
			openAiModelId: "openai-compatible-model",
		}

		expect(getModelId(settings)).toBe("openai-compatible-model")
	})

	it.each([providerIdentifiers.openaiNative, providerIdentifiers.fakeAi])("uses apiModelId for %s", (apiProvider) => {
		const settings: ProviderSettings = { apiProvider, apiModelId: "shared-model" }

		expect(getModelId(settings)).toBe("shared-model")
	})

	it("returns undefined when no provider is selected", () => {
		expect(getModelId({})).toBeUndefined()
	})

	it.each([
		[retiredProviderIdentifiers.cerebras, "apiModelId"],
		[retiredProviderIdentifiers.chutes, "apiModelId"],
		[retiredProviderIdentifiers.deepinfra, "deepInfraModelId"],
		[retiredProviderIdentifiers.doubao, "apiModelId"],
		[retiredProviderIdentifiers.featherless, "apiModelId"],
		[retiredProviderIdentifiers.groq, "apiModelId"],
		[retiredProviderIdentifiers.huggingface, "huggingFaceModelId"],
		[retiredProviderIdentifiers.roo, "apiModelId"],
	] as const)("reads the retired provider's own model ID field for %s", (apiProvider, modelIdField) => {
		const settings = {
			apiProvider,
			[modelIdField]: "retired-model",
			// A field belonging to a different provider must not win.
			requestyModelId: "other-provider-model",
		} as ProviderSettings

		expect(getModelId(settings)).toBe("retired-model")
	})

	it("returns undefined for a retired provider without a model ID", () => {
		expect(getModelId({ apiProvider: retiredProviderIdentifiers.groq })).toBeUndefined()
	})

	it("resolves a model ID for every provider definition without throwing", () => {
		for (const apiProvider of Object.values(providerIdentifiers)) {
			expect(() => getModelId({ apiProvider })).not.toThrow()
		}
	})
})
