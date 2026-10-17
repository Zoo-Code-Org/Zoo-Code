import { providerIdentifiers, type ProviderSettings } from "@roo-code/types"

import { DEFAULT_CONTEXT_WINDOW, getContextWindow } from "../context-window.js"

describe("getContextWindow", () => {
	it.each([
		[providerIdentifiers.openrouter, "openRouterModelId"],
		[providerIdentifiers.ollama, "ollamaModelId"],
		[providerIdentifiers.lmstudio, "lmStudioModelId"],
		[providerIdentifiers.openai, "openAiModelId"],
		[providerIdentifiers.requesty, "requestyModelId"],
		[providerIdentifiers.unbound, "unboundModelId"],
		[providerIdentifiers.litellm, "litellmModelId"],
		[providerIdentifiers.vercelAiGateway, "vercelAiGatewayModelId"],
		[providerIdentifiers.opencodeGo, "opencodeGoModelId"],
		[providerIdentifiers.kenari, "kenariModelId"],
		[providerIdentifiers.ioIntelligence, "ioIntelligenceModelId"],
		[providerIdentifiers.nanogpt, "nanoGptModelId"],
		[providerIdentifiers.zooGateway, "zooGatewayModelId"],
	] as const)("uses the provider-specific model field for %s", (provider, modelField) => {
		const config = { apiProvider: provider, [modelField]: "selected-model" } as ProviderSettings
		const routerModels = { [provider]: { "selected-model": { contextWindow: 123_456 } } }

		expect(getContextWindow(routerModels, config)).toBe(123_456)
	})

	describe("GitHub Copilot", () => {
		const provider = providerIdentifiers.githubCopilot
		const routerModels = { [provider]: { "selected-model": { contextWindow: 123_456 } } }

		it("takes the model from the saved selector, where Copilot keeps it", () => {
			const config: ProviderSettings = {
				apiProvider: provider,
				vsCodeLmModelSelector: { vendor: "copilot", id: "selected-model" },
			}

			expect(getContextWindow(routerModels, config)).toBe(123_456)
		})

		it("ignores apiModelId, which Copilot profiles do not use", () => {
			const config: ProviderSettings = {
				apiProvider: provider,
				apiModelId: "other-model",
				vsCodeLmModelSelector: { vendor: "copilot", id: "selected-model" },
			}

			expect(getContextWindow(routerModels, config)).toBe(123_456)
		})

		it.each([
			["no selector", undefined],
			["a selector that names a family but no id", { vendor: "copilot", family: "gpt-5.5" }],
		])("returns the default for %s", (_label, vsCodeLmModelSelector) => {
			const config: ProviderSettings = { apiProvider: provider, vsCodeLmModelSelector }

			expect(getContextWindow(routerModels, config)).toBe(DEFAULT_CONTEXT_WINDOW)
		})

		it("returns the default when the selected model is not in the list", () => {
			const config: ProviderSettings = {
				apiProvider: provider,
				vsCodeLmModelSelector: { vendor: "copilot", id: "unlisted-model" },
			}

			expect(getContextWindow(routerModels, config)).toBe(DEFAULT_CONTEXT_WINDOW)
		})
	})

	it("uses apiModelId for providers without a specialized model field", () => {
		const config: ProviderSettings = {
			apiProvider: providerIdentifiers.anthropic,
			apiModelId: "selected-model",
		}
		const routerModels = {
			[providerIdentifiers.anthropic]: { "selected-model": { contextWindow: 64_000 } },
		}

		expect(getContextWindow(routerModels, config)).toBe(64_000)
	})

	it("returns the default when the selected model is unavailable", () => {
		expect(getContextWindow({}, { apiProvider: providerIdentifiers.openrouter })).toBe(DEFAULT_CONTEXT_WINDOW)
	})
})
