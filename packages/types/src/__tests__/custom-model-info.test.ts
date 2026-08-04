import { applyCustomModelInfo, customModelInfoSchema, type ModelInfo } from "../model.js"
import { providerIdentifiers, providerSettingsSchemaDiscriminated } from "../index.js"

describe("custom model info", () => {
	it("overlays only supported metadata and preserves provider-owned fields", () => {
		const model: ModelInfo = {
			maxTokens: 4096,
			contextWindow: 8192,
			supportsImages: false,
			supportsPromptCache: false,
			inputPrice: 0.1,
			outputPrice: 0.2,
			description: "Provider metadata",
		}

		expect(
			applyCustomModelInfo(model, {
				customModelInfo: {
					contextWindow: 128_000,
					maxTokens: 16_384,
					supportsImages: true,
					supportsPromptCache: true,
				},
			}),
		).toEqual({
			...model,
			contextWindow: 128_000,
			maxTokens: 16_384,
			supportsImages: true,
			supportsPromptCache: true,
		})
	})

	it("does not synthesize model info without a valid context window", () => {
		expect(
			applyCustomModelInfo(undefined, {
				customModelInfo: {
					contextWindow: 0,
					maxTokens: -1,
					supportsImages: true,
				},
			}),
		).toBeUndefined()
	})

	it("synthesizes safe defaults when only a context window is supplied", () => {
		expect(
			applyCustomModelInfo(undefined, {
				customModelInfo: { contextWindow: 64_000, supportsImages: true },
			}),
		).toEqual({
			maxTokens: undefined,
			contextWindow: 64_000,
			supportsImages: true,
			supportsPromptCache: false,
		})
	})

	it("rejects unsupported pricing fields in the persisted override schema", () => {
		expect(customModelInfoSchema.safeParse({ contextWindow: 64_000, inputPrice: 1 }).success).toBe(false)
		expect(
			providerSettingsSchemaDiscriminated.safeParse({
				apiProvider: providerIdentifiers.openrouter,
				customModelInfo: { contextWindow: 64_000, outputPrice: 1 },
			}).success,
		).toBe(false)
	})
})
