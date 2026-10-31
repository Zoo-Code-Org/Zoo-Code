// npx vitest utils/__tests__/cost.spec.ts

import { OpenAiServiceTier, deepSeekModels, friendliModels, moonshotModels, type ModelInfo } from "@roo-code/types"

import { calculateApiCostAnthropic, calculateApiCostOpenAI } from "../../shared/cost"

describe("Cost Utility", () => {
	describe("calculateApiCostAnthropic", () => {
		const mockModelInfo: ModelInfo = {
			maxTokens: 8192,
			contextWindow: 200_000,
			supportsPromptCache: true,
			inputPrice: 3.0, // $3 per million tokens
			outputPrice: 15.0, // $15 per million tokens
			cacheWritesPrice: 3.75, // $3.75 per million tokens
			cacheReadsPrice: 0.3, // $0.30 per million tokens
		}

		it("should calculate basic input/output costs correctly", () => {
			const result = calculateApiCostAnthropic(mockModelInfo, 1000, 500)

			// Input cost: (3.0 / 1_000_000) * 1000 = 0.003
			// Output cost: (15.0 / 1_000_000) * 500 = 0.0075
			// Total: 0.003 + 0.0075 = 0.0105
			expect(result.totalCost).toBe(0.0105)
			expect(result.totalInputTokens).toBe(1000)
			expect(result.totalOutputTokens).toBe(500)
		})

		it("should handle cache writes cost", () => {
			const result = calculateApiCostAnthropic(mockModelInfo, 1000, 500, 2000)

			// Input cost: (3.0 / 1_000_000) * 1000 = 0.003
			// Output cost: (15.0 / 1_000_000) * 500 = 0.0075
			// Cache writes: (3.75 / 1_000_000) * 2000 = 0.0075
			// Total: 0.003 + 0.0075 + 0.0075 = 0.018
			expect(result.totalCost).toBeCloseTo(0.018, 6)
			expect(result.totalInputTokens).toBe(3000) // 1000 + 2000
			expect(result.totalOutputTokens).toBe(500)
		})

		it("should handle cache reads cost", () => {
			const result = calculateApiCostAnthropic(mockModelInfo, 1000, 500, undefined, 3000)

			// Input cost: (3.0 / 1_000_000) * 1000 = 0.003
			// Output cost: (15.0 / 1_000_000) * 500 = 0.0075
			// Cache reads: (0.3 / 1_000_000) * 3000 = 0.0009
			// Total: 0.003 + 0.0075 + 0.0009 = 0.0114
			expect(result.totalCost).toBe(0.0114)
			expect(result.totalInputTokens).toBe(4000) // 1000 + 3000
			expect(result.totalOutputTokens).toBe(500)
		})

		it("should handle all cost components together", () => {
			const result = calculateApiCostAnthropic(mockModelInfo, 1000, 500, 2000, 3000)

			// Input cost: (3.0 / 1_000_000) * 1000 = 0.003
			// Output cost: (15.0 / 1_000_000) * 500 = 0.0075
			// Cache writes: (3.75 / 1_000_000) * 2000 = 0.0075
			// Cache reads: (0.3 / 1_000_000) * 3000 = 0.0009
			// Total: 0.003 + 0.0075 + 0.0075 + 0.0009 = 0.0189
			expect(result.totalCost).toBe(0.0189)
			expect(result.totalInputTokens).toBe(6000) // 1000 + 2000 + 3000
			expect(result.totalOutputTokens).toBe(500)
		})

		it("should handle missing prices gracefully", () => {
			const modelWithoutPrices: ModelInfo = {
				maxTokens: 8192,
				contextWindow: 200_000,
				supportsPromptCache: true,
			}

			const result = calculateApiCostAnthropic(modelWithoutPrices, 1000, 500, 2000, 3000)
			expect(result.totalCost).toBe(0)
			expect(result.totalInputTokens).toBe(6000) // 1000 + 2000 + 3000
			expect(result.totalOutputTokens).toBe(500)
		})

		it("should handle zero tokens", () => {
			const result = calculateApiCostAnthropic(mockModelInfo, 0, 0, 0, 0)
			expect(result.totalCost).toBe(0)
			expect(result.totalInputTokens).toBe(0)
			expect(result.totalOutputTokens).toBe(0)
		})

		it("should handle undefined cache values", () => {
			const result = calculateApiCostAnthropic(mockModelInfo, 1000, 500)

			// Input cost: (3.0 / 1_000_000) * 1000 = 0.003
			// Output cost: (15.0 / 1_000_000) * 500 = 0.0075
			// Total: 0.003 + 0.0075 = 0.0105
			expect(result.totalCost).toBe(0.0105)
			expect(result.totalInputTokens).toBe(1000)
			expect(result.totalOutputTokens).toBe(500)
		})

		it("bills cache tokens at the input price when the catalog omits cache prices", () => {
			const modelWithoutCachePrices: ModelInfo = {
				...mockModelInfo,
				cacheWritesPrice: undefined,
				cacheReadsPrice: undefined,
			}

			const result = calculateApiCostAnthropic(modelWithoutCachePrices, 1000, 500, 2000, 3000)

			// A model that prices input but publishes no cache price still charges for
			// the tokens it cached; the input price is the only rate it declares.
			// Input cost: (3.0 / 1_000_000) * 1000 = 0.003
			// Cache writes: (3.0 / 1_000_000) * 2000 = 0.006
			// Cache reads: (3.0 / 1_000_000) * 3000 = 0.009
			// Output cost: (15.0 / 1_000_000) * 500 = 0.0075
			// Total: 0.003 + 0.006 + 0.009 + 0.0075 = 0.0255
			expect(result.totalCost).toBeCloseTo(0.0255, 9)
			expect(result.totalInputTokens).toBe(6000) // 1000 + 2000 + 3000
			expect(result.totalOutputTokens).toBe(500)
		})

		it("honors an explicit zero cache price instead of falling back to the input price", () => {
			// A provider that publishes `cacheWritesPrice: 0` charges nothing for
			// writes. Only a *missing* cache price falls back to the input price, so
			// `??` is load-bearing here and `||` would silently re-price this row.
			const modelWithFreeWrites: ModelInfo = {
				...mockModelInfo,
				cacheWritesPrice: 0,
				cacheReadsPrice: 0,
			}

			const result = calculateApiCostAnthropic(modelWithFreeWrites, 1000, 500, 2000, 3000)

			// Input cost: (3.0 / 1_000_000) * 1000 = 0.003
			// Output cost: (15.0 / 1_000_000) * 500 = 0.0075
			// Cache writes and reads: 0 by the catalog's own price
			expect(result.totalCost).toBeCloseTo(0.0105, 9)
		})

		it("bills nothing when the model declares no prices at all", () => {
			// `undefined * 0` is NaN, so the fallback chain has to end in a real 0.
			const unpricedModel: ModelInfo = {
				maxTokens: 8192,
				contextWindow: 200_000,
				supportsPromptCache: true,
			}

			const result = calculateApiCostAnthropic(unpricedModel, 1000, 500, 2000, 3000)

			expect(result.totalCost).toBe(0)
			expect(Number.isNaN(result.totalCost)).toBe(false)
		})
	})

	describe("calculateApiCostOpenAI", () => {
		const mockModelInfo: ModelInfo = {
			maxTokens: 8192,
			contextWindow: 200_000,
			supportsPromptCache: true,
			inputPrice: 3.0, // $3 per million tokens
			outputPrice: 15.0, // $15 per million tokens
			cacheWritesPrice: 3.75, // $3.75 per million tokens
			cacheReadsPrice: 0.3, // $0.30 per million tokens
		}

		it("should calculate basic input/output costs correctly", () => {
			const result = calculateApiCostOpenAI(mockModelInfo, 1000, 500)

			// Input cost: (3.0 / 1_000_000) * 1000 = 0.003
			// Output cost: (15.0 / 1_000_000) * 500 = 0.0075
			// Total: 0.003 + 0.0075 = 0.0105
			expect(result.totalCost).toBe(0.0105)
			expect(result.totalInputTokens).toBe(1000)
			expect(result.totalOutputTokens).toBe(500)
		})

		it("should handle cache writes cost", () => {
			const result = calculateApiCostOpenAI(mockModelInfo, 3000, 500, 2000)

			// Input cost: (3.0 / 1_000_000) * (3000 - 2000) = 0.003
			// Output cost: (15.0 / 1_000_000) * 500 = 0.0075
			// Cache writes: (3.75 / 1_000_000) * 2000 = 0.0075
			// Total: 0.003 + 0.0075 + 0.0075 = 0.018
			expect(result.totalCost).toBeCloseTo(0.018, 6)
			expect(result.totalInputTokens).toBe(3000) // Total already includes cache
			expect(result.totalOutputTokens).toBe(500)
		})

		it("should handle cache reads cost", () => {
			const result = calculateApiCostOpenAI(mockModelInfo, 4000, 500, undefined, 3000)

			// Input cost: (3.0 / 1_000_000) * (4000 - 3000) = 0.003
			// Output cost: (15.0 / 1_000_000) * 500 = 0.0075
			// Cache reads: (0.3 / 1_000_000) * 3000 = 0.0009
			// Total: 0.003 + 0.0075 + 0.0009 = 0.0114
			expect(result.totalCost).toBe(0.0114)
			expect(result.totalInputTokens).toBe(4000) // Total already includes cache
			expect(result.totalOutputTokens).toBe(500)
		})

		it("should handle all cost components together", () => {
			const result = calculateApiCostOpenAI(mockModelInfo, 6000, 500, 2000, 3000)

			// Input cost: (3.0 / 1_000_000) * (6000 - 2000 - 3000) = 0.003
			// Output cost: (15.0 / 1_000_000) * 500 = 0.0075
			// Cache writes: (3.75 / 1_000_000) * 2000 = 0.0075
			// Cache reads: (0.3 / 1_000_000) * 3000 = 0.0009
			// Total: 0.003 + 0.0075 + 0.0075 + 0.0009 = 0.0189
			expect(result.totalCost).toBe(0.0189)
			expect(result.totalInputTokens).toBe(6000) // Total already includes cache
			expect(result.totalOutputTokens).toBe(500)
		})

		it("should handle missing prices gracefully", () => {
			const modelWithoutPrices: ModelInfo = {
				maxTokens: 8192,
				contextWindow: 200_000,
				supportsPromptCache: true,
			}

			const result = calculateApiCostOpenAI(modelWithoutPrices, 1000, 500, 2000, 3000)
			expect(result.totalCost).toBe(0)
			expect(result.totalInputTokens).toBe(1000) // Total already includes cache
			expect(result.totalOutputTokens).toBe(500)
		})

		it("should handle zero tokens", () => {
			const result = calculateApiCostOpenAI(mockModelInfo, 0, 0, 0, 0)
			expect(result.totalCost).toBe(0)
			expect(result.totalInputTokens).toBe(0)
			expect(result.totalOutputTokens).toBe(0)
		})

		it("should handle undefined cache values", () => {
			const result = calculateApiCostOpenAI(mockModelInfo, 1000, 500)

			// Input cost: (3.0 / 1_000_000) * 1000 = 0.003
			// Output cost: (15.0 / 1_000_000) * 500 = 0.0075
			// Total: 0.003 + 0.0075 = 0.0105
			expect(result.totalCost).toBe(0.0105)
			expect(result.totalInputTokens).toBe(1000)
			expect(result.totalOutputTokens).toBe(500)
		})

		it("bills cache tokens at the input price when the catalog omits cache prices", () => {
			const modelWithoutCachePrices: ModelInfo = {
				...mockModelInfo,
				cacheWritesPrice: undefined,
				cacheReadsPrice: undefined,
			}

			const result = calculateApiCostOpenAI(modelWithoutCachePrices, 6000, 500, 2000, 3000)

			// OpenAI usage counts cached tokens inside prompt_tokens, so the cache
			// buckets are removed from the input pool and re-priced. With no cache
			// price published, the input price is the only rate the model declares.
			// Uncached input: (3.0 / 1_000_000) * (6000 - 2000 - 3000) = 0.003
			// Cache writes: (3.0 / 1_000_000) * 2000 = 0.006
			// Cache reads: (3.0 / 1_000_000) * 3000 = 0.009
			// Output cost: (15.0 / 1_000_000) * 500 = 0.0075
			// Total: 0.003 + 0.006 + 0.009 + 0.0075 = 0.0255
			expect(result.totalCost).toBeCloseTo(0.0255, 9)
			expect(result.totalInputTokens).toBe(6000) // Total already includes cache
			expect(result.totalOutputTokens).toBe(500)
		})

		it("honors an explicit zero cache price instead of falling back to the input price", () => {
			// friendli's GLM rows and every moonshot row publish `cacheWritesPrice: 0`
			// on purpose. A zero is a price, not an absence, so those rows must not be
			// re-priced at the input price.
			const modelWithFreeWrites: ModelInfo = {
				...mockModelInfo,
				cacheWritesPrice: 0,
				cacheReadsPrice: 0,
			}

			const result = calculateApiCostOpenAI(modelWithFreeWrites, 6000, 500, 2000, 3000)

			// Uncached input: (3.0 / 1_000_000) * (6000 - 2000 - 3000) = 0.003
			// Output cost: (15.0 / 1_000_000) * 500 = 0.0075
			expect(result.totalCost).toBeCloseTo(0.0105, 9)
		})

		it("bills nothing when the model declares no prices at all", () => {
			const unpricedModel: ModelInfo = {
				maxTokens: 8192,
				contextWindow: 200_000,
				supportsPromptCache: true,
			}

			const result = calculateApiCostOpenAI(unpricedModel, 6000, 500, 2000, 3000)

			expect(result.totalCost).toBe(0)
			expect(Number.isNaN(result.totalCost)).toBe(false)
		})

		it("stays byte-identical for the DeepSeek catalog, whose input price is zero by design", () => {
			// All four deepSeekModels rows set `inputPrice: 0` and price misses through
			// cacheWritesPrice. A fallback that resolved through `inputPrice` would
			// zero out their cache-write revenue, so the rows are pinned exactly.
			expect(deepSeekModels["deepseek-flash"].inputPrice).toBe(0)

			const result = calculateApiCostOpenAI(deepSeekModels["deepseek-flash"], 1000, 500, 400, 100)

			// Cache writes: (0.3 / 1_000_000) * 400 = 0.00012
			// Cache reads: (0.006 / 1_000_000) * 100 = 0.0000006
			// Uncached input: (0 / 1_000_000) * 500 = 0
			// Output cost: (1.2 / 1_000_000) * 500 = 0.0006
			expect(result.totalCost).toBeCloseTo(0.0007206, 9)
		})

		describe("catalog rows with an explicit zero cache price", () => {
			// These rows publish `cacheWritesPrice: 0` deliberately: the provider
			// charges nothing for writes. They are the cells that a `||` fallback
			// would silently re-price at the input price, so each is pinned to the
			// exact total it bills today.
			it.each([
				["friendli GLM-5.2", friendliModels["zai-org/GLM-5.2"]],
				["moonshot kimi-k3", moonshotModels["kimi-k3"]],
			])("leaves %s byte-identical", (_name, modelInfo) => {
				expect(modelInfo.cacheWritesPrice).toBe(0)

				const result = calculateApiCostOpenAI(modelInfo, 1000, 500, 400, 100)

				const expected =
					((modelInfo.inputPrice ?? 0) / 1_000_000) * 500 + // uncached input
					((modelInfo.outputPrice ?? 0) / 1_000_000) * 500 + // output
					((modelInfo.cacheReadsPrice ?? 0) / 1_000_000) * 100 // reads only; writes are free

				expect(result.totalCost).toBeCloseTo(expected, 9)
			})
		})

		it("bills the miss share of a custom priced model instead of giving it away", () => {
			// The defect this repairs: a custom OpenAI-compatible model that prices
			// input but publishes no cache price. Miss tokens arrived as cache
			// writes, were subtracted from the input pool, and were then priced at
			// zero, so the user was billed for neither.
			const customModel: ModelInfo = {
				maxTokens: 8192,
				contextWindow: 200_000,
				supportsPromptCache: true,
				inputPrice: 3.0,
				outputPrice: 15.0,
				cacheReadsPrice: 0.3,
			}

			// 1000 prompt tokens: 400 missed the cache, 100 hit it, 500 were plain.
			const result = calculateApiCostOpenAI(customModel, 1000, 500, 400, 100)

			// Uncached input: (3.0 / 1_000_000) * 500 = 0.0015
			// Cache writes: (3.0 / 1_000_000) * 400 = 0.0012 (input price, since none published)
			// Cache reads: (0.3 / 1_000_000) * 100 = 0.00003
			// Output cost: (15.0 / 1_000_000) * 500 = 0.0075
			// Total: 0.0015 + 0.0012 + 0.00003 + 0.0075 = 0.01023
			expect(result.totalCost).toBeCloseTo(0.01023, 9)

			// The under-bill the defect produced, kept as the regression's own number:
			// pricing the same 400 tokens at zero yields 0.00903, 11.7% short.
			expect(result.totalCost).not.toBeCloseTo(0.00903, 9)
		})

		it("should not apply long-context pricing at the threshold", () => {
			const modelWithLongContextPricing: ModelInfo = {
				...mockModelInfo,
				longContextPricing: {
					thresholdTokens: 272_000,
					inputPriceMultiplier: 2,
					outputPriceMultiplier: 1.5,
					cacheWritesPriceMultiplier: 2,
					cacheReadsPriceMultiplier: 2,
				},
			}

			const result = calculateApiCostOpenAI(modelWithLongContextPricing, 272_000, 1_000, undefined, 100_000)

			// Input cost: (3.0 / 1_000_000) * (272000 - 100000) = 0.516
			// Output cost: (15.0 / 1_000_000) * 1000 = 0.015
			// Cache reads: (0.3 / 1_000_000) * 100000 = 0.03
			// Total: 0.516 + 0.015 + 0.03 = 0.561
			expect(result.totalCost).toBeCloseTo(0.561, 6)
		})

		it("should apply long-context pricing above the threshold", () => {
			const modelWithLongContextPricing: ModelInfo = {
				maxTokens: 128_000,
				contextWindow: 1_050_000,
				supportsPromptCache: true,
				inputPrice: 2.5,
				outputPrice: 15.0,
				cacheWritesPrice: 5.0,
				cacheReadsPrice: 0.25,
				longContextPricing: {
					thresholdTokens: 272_000,
					inputPriceMultiplier: 2,
					outputPriceMultiplier: 1.5,
					cacheWritesPriceMultiplier: 2,
					cacheReadsPriceMultiplier: 2,
				},
			}

			const result = calculateApiCostOpenAI(modelWithLongContextPricing, 300_000, 1_000, 20_000, 100_000)

			// Input cost: (5.0 / 1_000_000) * (300000 - 20000 - 100000) = 0.9
			// Output cost: (22.5 / 1_000_000) * 1000 = 0.0225
			// Cache writes: (10.0 / 1_000_000) * 20000 = 0.2
			// Cache reads: (0.5 / 1_000_000) * 100000 = 0.05
			// Total: 0.9 + 0.0225 + 0.2 + 0.05 = 1.1725
			expect(result.totalCost).toBeCloseTo(1.1725, 6)
		})

		it("should skip long-context pricing for service tiers outside the allowed list", () => {
			const modelWithLongContextPricing: ModelInfo = {
				maxTokens: 128_000,
				contextWindow: 1_050_000,
				supportsPromptCache: true,
				inputPrice: 5.0,
				outputPrice: 30.0,
				cacheReadsPrice: 0.5,
				longContextPricing: {
					thresholdTokens: 272_000,
					inputPriceMultiplier: 2,
					outputPriceMultiplier: 1.5,
					appliesToServiceTiers: [OpenAiServiceTier.Default, OpenAiServiceTier.Flex],
				},
			}

			const result = calculateApiCostOpenAI(
				modelWithLongContextPricing,
				300_000,
				1_000,
				undefined,
				100_000,
				OpenAiServiceTier.Priority,
			)

			// Input cost: (5.0 / 1_000_000) * (300000 - 100000) = 1.0
			// Output cost: (30.0 / 1_000_000) * 1000 = 0.03
			// Cache reads: (0.5 / 1_000_000) * 100000 = 0.05
			// Total: 1.0 + 0.03 + 0.05 = 1.08
			expect(result.totalCost).toBeCloseTo(1.08, 6)
		})
	})
})
