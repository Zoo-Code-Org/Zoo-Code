import { applyCustomModelInfo, customModelInfoSchema, toCustomModelInfo, type ModelInfo } from "../model.js"
import { providerIdentifiers, providerSettingsSchemaDiscriminated } from "../index.js"

describe("custom model info", () => {
	const catalogModel: ModelInfo = {
		maxTokens: 4096,
		contextWindow: 8192,
		supportsImages: false,
		supportsPromptCache: false,
		inputPrice: 0.1,
		outputPrice: 0.2,
		cacheWritesPrice: 0.3,
		cacheReadsPrice: 0.4,
		description: "Provider metadata",
	}

	it("replaces discovered metadata with the configured snapshot", () => {
		const resolved = applyCustomModelInfo(catalogModel, {
			customModelInfo: {
				contextWindow: 128_000,
				maxTokens: 16_384,
				supportsImages: true,
				supportsPromptCache: true,
			},
		})

		expect(resolved).toMatchObject({
			contextWindow: 128_000,
			maxTokens: 16_384,
			supportsImages: true,
			supportsPromptCache: true,
		})
		// The snapshot wins wholesale: catalog metadata it does not carry is dropped
		// rather than merged, so the resolved value matches what the user configured.
		expect(resolved?.description).toBeUndefined()
	})

	it("keeps provider-owned pricing from the catalog entry", () => {
		const resolved = applyCustomModelInfo(catalogModel, {
			customModelInfo: { contextWindow: 128_000, supportsPromptCache: false },
		})

		expect(resolved).toMatchObject({
			inputPrice: 0.1,
			outputPrice: 0.2,
			cacheWritesPrice: 0.3,
			cacheReadsPrice: 0.4,
		})
	})

	it("resolves an unlisted model without any catalog entry", () => {
		const resolved = applyCustomModelInfo(undefined, {
			customModelInfo: { contextWindow: 64_000, maxTokens: 8_192, supportsPromptCache: false },
		})

		expect(resolved).toMatchObject({ contextWindow: 64_000, maxTokens: 8_192 })
	})

	it("does not invent pricing when the catalog has none", () => {
		const resolved = applyCustomModelInfo(undefined, {
			customModelInfo: { contextWindow: 64_000, supportsPromptCache: false },
		})

		expect(resolved && "inputPrice" in resolved).toBe(false)
		expect(resolved && "tiers" in resolved).toBe(false)
	})

	it("passes discovered metadata through untouched when nothing is configured", () => {
		expect(applyCustomModelInfo(catalogModel, {})).toEqual(catalogModel)
		expect(applyCustomModelInfo(catalogModel, { customModelInfo: null })).toEqual(catalogModel)
		expect(applyCustomModelInfo(undefined, {})).toBeUndefined()
	})

	it("strips pricing when seeding the editor from a catalog entry", () => {
		const seeded = toCustomModelInfo(catalogModel)

		expect(seeded).toMatchObject({ contextWindow: 8192, maxTokens: 4096, description: "Provider metadata" })
		expect("inputPrice" in seeded).toBe(false)
		expect("cacheReadsPrice" in seeded).toBe(false)
	})

	it("rejects pricing fields in the persisted override schema", () => {
		expect(
			customModelInfoSchema.safeParse({ contextWindow: 64_000, supportsPromptCache: false, inputPrice: 1 })
				.success,
		).toBe(false)
		expect(
			providerSettingsSchemaDiscriminated.safeParse({
				apiProvider: providerIdentifiers.openrouter,
				customModelInfo: { contextWindow: 64_000, supportsPromptCache: false, outputPrice: 1 },
			}).success,
		).toBe(false)
	})

	it("requires a context window in the persisted override schema", () => {
		expect(customModelInfoSchema.safeParse({ supportsPromptCache: false }).success).toBe(false)
		expect(customModelInfoSchema.safeParse({ contextWindow: 64_000, supportsPromptCache: false }).success).toBe(
			true,
		)
	})
})
