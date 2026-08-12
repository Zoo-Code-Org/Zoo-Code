import { getModelId, modelIdKeys, providerIdentifiers, type ProviderSettings } from "../index.js"

const expectedModelIdKeys = [
	"apiModelId",
	"openRouterModelId",
	"openAiModelId",
	"ollamaModelId",
	"lmStudioModelId",
	"lmStudioDraftModelId",
	"requestyModelId",
	"unboundModelId",
	"litellmModelId",
	"vercelAiGatewayModelId",
	"opencodeGoModelId",
	"kenariModelId",
	"zooGatewayModelId",
] as const

describe("modelIdKeys", () => {
	it("preserves every model ID setting and its legacy precedence order", () => {
		expect(modelIdKeys).toEqual(expectedModelIdKeys)
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

	it("preserves legacy model ID precedence for retired providers", () => {
		const settings: ProviderSettings = {
			apiProvider: "groq",
			lmStudioDraftModelId: "draft-model",
			requestyModelId: "requesty-model",
		}

		expect(getModelId(settings)).toBe("draft-model")
	})

	it("resolves a model ID for every provider definition without throwing", () => {
		for (const apiProvider of Object.values(providerIdentifiers)) {
			expect(() => getModelId({ apiProvider })).not.toThrow()
		}
	})
})
