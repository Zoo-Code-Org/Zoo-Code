import { type ProviderSettings, opencodeGoModels, providerIdentifiers } from "@roo-code/types"

import { isTemperatureControlSupported } from "../temperatureSupport"

describe("isTemperatureControlSupported", () => {
	const opencodeGo = (modelId: string, apiConfiguration: ProviderSettings = {}) =>
		isTemperatureControlSupported({
			provider: providerIdentifiers.opencodeGo,
			modelId,
			modelInfo: opencodeGoModels[modelId],
			apiConfiguration: {
				apiProvider: providerIdentifiers.opencodeGo,
				opencodeGoModelId: modelId,
				...apiConfiguration,
			},
		})

	describe("OpenCode Go Responses models (Zoo-Code-Org/Zoo-Code#2055)", () => {
		it.each(["grok-4.6", "muse-spark-1.3-contributor", "muse-spark-1.2-contributor"])(
			"shows the control for %s",
			(modelId) => {
				expect(opencodeGo(modelId)).toBe(true)
				expect(opencodeGo(modelId, { reasoningEffort: "low" })).toBe(true)
			},
		)

		it.each(["gpt-5.6-luna", "gpt-6-luna"])("shows the control for %s only with effort none", (modelId) => {
			expect(opencodeGo(modelId, { reasoningEffort: "none" })).toBe(true)
			expect(opencodeGo(modelId, { reasoningEffort: "high" })).toBe(false)
			expect(opencodeGo(modelId, { reasoningEffort: "disable" })).toBe(false)
			expect(opencodeGo(modelId, { enableReasoningEffort: false })).toBe(false)
			// A stale "none" is not sent while reasoning effort is switched off.
			expect(opencodeGo(modelId, { reasoningEffort: "none", enableReasoningEffort: false })).toBe(false)
			// The model default effort ("medium") does not support temperature.
			expect(opencodeGo(modelId)).toBe(false)
		})

		it("hides the control when the model info is not available yet", () => {
			expect(
				isTemperatureControlSupported({
					provider: providerIdentifiers.opencodeGo,
					modelId: "gpt-6-luna",
					modelInfo: undefined,
					apiConfiguration: { reasoningEffort: "none" },
				}),
			).toBe(false)
		})
	})

	it("keeps the supportsTemperature opt-out for OpenCode Go chat-completions models", () => {
		expect(opencodeGo("kimi-k2.6")).toBe(true)
		expect(
			isTemperatureControlSupported({
				provider: providerIdentifiers.opencodeGo,
				modelId: "kimi-k2.6",
				modelInfo: { ...opencodeGoModels["kimi-k2.6"], supportsTemperature: false },
				apiConfiguration: {},
			}),
		).toBe(false)
	})

	it("keeps the supportsTemperature opt-out for other providers", () => {
		const base = { provider: providerIdentifiers.anthropic, modelId: "m", apiConfiguration: {} }

		expect(isTemperatureControlSupported({ ...base, modelInfo: undefined })).toBe(true)
		expect(
			isTemperatureControlSupported({
				...base,
				modelInfo: { contextWindow: 1, supportsPromptCache: false, supportsTemperature: false },
			}),
		).toBe(false)
		// A Responses model ID on another provider does not use the Go rule.
		expect(
			isTemperatureControlSupported({
				...base,
				modelId: "gpt-6-luna",
				modelInfo: { contextWindow: 1, supportsPromptCache: false },
			}),
		).toBe(true)
	})
})
