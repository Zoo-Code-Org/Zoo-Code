// npx vitest utils/__tests__/cost.spec.ts

import { OpenAiServiceTier, type ModelInfo } from "@roo-code/types"

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

		it("should handle missing cache prices", () => {
			const modelWithoutCachePrices: ModelInfo = {
				...mockModelInfo,
				cacheWritesPrice: undefined,
				cacheReadsPrice: undefined,
			}

			const result = calculateApiCostAnthropic(modelWithoutCachePrices, 1000, 500, 2000, 3000)

			// Should only include input and output costs
			// Input cost: (3.0 / 1_000_000) * 1000 = 0.003
			// Output cost: (15.0 / 1_000_000) * 500 = 0.0075
			// Total: 0.003 + 0.0075 = 0.0105
			expect(result.totalCost).toBe(0.0105)
			expect(result.totalInputTokens).toBe(6000) // 1000 + 2000 + 3000
			expect(result.totalOutputTokens).toBe(500)
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

		it("should handle missing cache prices", () => {
			const modelWithoutCachePrices: ModelInfo = {
				...mockModelInfo,
				cacheWritesPrice: undefined,
				cacheReadsPrice: undefined,
			}

			const result = calculateApiCostOpenAI(modelWithoutCachePrices, 6000, 500, 2000, 3000)

			// Should only include input and output costs
			// Input cost: (3.0 / 1_000_000) * (6000 - 2000 - 3000) = 0.003
			// Output cost: (15.0 / 1_000_000) * 500 = 0.0075
			// Total: 0.003 + 0.0075 = 0.0105
			expect(result.totalCost).toBe(0.0105)
			expect(result.totalInputTokens).toBe(6000) // Total already includes cache
			expect(result.totalOutputTokens).toBe(500)
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

	describe("cache-write TTL split accounting", () => {
		const anthropicModel: ModelInfo = {
			maxTokens: 8192,
			contextWindow: 200_000,
			supportsPromptCache: true,
			inputPrice: 3.0,
			outputPrice: 15.0,
			cacheWritesPrice: 3.75, // 1.25x input
			cacheWritesPrice1h: 6.0, // 2x input
			cacheReadsPrice: 0.3,
		}

		const openAiModel: ModelInfo = {
			maxTokens: 128_000,
			contextWindow: 1_050_000,
			supportsPromptCache: true,
			inputPrice: 4.0,
			outputPrice: 20.0,
			cacheWritesPrice: 5.0, // 1.25x input (30m class)
			cacheWritesPrice12h: 10.0, // 2.5x input
			cacheReadsPrice: 0.4,
		}

		it("bills 100k 1h tokens at the 1h rate, not the 5m rate (37.5% tripwire)", () => {
			const result = calculateApiCostAnthropic(anthropicModel, 0, 0, 100_000, 0, 100_000)

			// 1h writes: (6.0 / 1_000_000) * 100_000 = 0.6
			// The pre-split behaviour would have charged the 5m rate:
			// (3.75 / 1_000_000) * 100_000 = 0.375, under-reporting by 37.5%.
			expect(result.totalCost).toBeCloseTo(0.6, 9)
			expect(result.totalCost).not.toBeCloseTo(0.375, 9)
		})

		it("bills a mixed 5m/1h split per class (0.465 case)", () => {
			// 60k of the 100k writes are 1h, 40k remain at the 5m rate.
			const result = calculateApiCostAnthropic(anthropicModel, 0, 0, 100_000, 0, 60_000)

			// 5m writes: (3.75 / 1_000_000) * 40_000 = 0.15
			// 1h writes: (6.0 / 1_000_000) * 60_000 = 0.36
			// Total: 0.15 + 0.36 = 0.51
			expect(result.totalCost).toBeCloseTo(0.51, 9)
		})

		it("derives the 5m remainder as total minus 1h minus 12h", () => {
			const model: ModelInfo = { ...anthropicModel, cacheWritesPrice12h: 7.5 }
			const result = calculateApiCostAnthropic(model, 0, 0, 100_000, 0, 30_000, 20_000)

			// 5m remainder: 100k - 30k - 20k = 50k at 3.75 => 0.1875
			// 1h: 30k at 6.0 => 0.18
			// 12h: 20k at 7.5 => 0.15
			// Total: 0.1875 + 0.18 + 0.15 = 0.5175
			expect(result.totalCost).toBeCloseTo(0.5175, 9)
		})

		it("clamps the 5m remainder at zero when the split exceeds the total", () => {
			// A malformed response claiming more 1h tokens than the write total must
			// not produce negative 5m writes (which would refund cost).
			const result = calculateApiCostAnthropic(anthropicModel, 0, 0, 100_000, 0, 150_000)

			// 5m remainder clamps to 0; 1h is capped by the clamp on the remainder only,
			// so the 1h class still bills its reported 150k at 6.0 => 0.9
			expect(result.totalCost).toBeCloseTo(0.9, 9)
			expect(result.totalCost).toBeGreaterThan(0)
		})

		it("is byte-identical to the pre-split cost when no split is reported", () => {
			// Invariant I1: absent split fields must reproduce today's pricing exactly.
			const withSplitArgs = calculateApiCostAnthropic(anthropicModel, 1_000, 500, 2_000, 3_000)
			const explicitZeros = calculateApiCostAnthropic(anthropicModel, 1_000, 500, 2_000, 3_000, 0, 0)

			expect(withSplitArgs.totalCost).toBe(0.0189)
			expect(explicitZeros.totalCost).toBe(withSplitArgs.totalCost)
		})

		it("falls back to the 5m rate when a model has no 1h rate and no input price", () => {
			const bareModel: ModelInfo = {
				maxTokens: 8192,
				contextWindow: 200_000,
				supportsPromptCache: true,
				cacheWritesPrice: 3.75,
			}

			// Fail-closed: without a derivable 1h rate the write is billed at the
			// aggregate rate rather than dropped or invented.
			const result = calculateApiCostAnthropic(bareModel, 0, 0, 100_000, 0, 100_000)
			expect(result.totalCost).toBeCloseTo(0.375, 9)
		})

		it("derives the 1h rate from inputPrice when the catalog omits it", () => {
			const modelWithout1h: ModelInfo = {
				maxTokens: 8192,
				contextWindow: 200_000,
				supportsPromptCache: true,
				inputPrice: 3.0,
				outputPrice: 15.0,
				cacheWritesPrice: 3.75,
			}

			const result = calculateApiCostAnthropic(modelWithout1h, 0, 0, 100_000, 0, 100_000)
			// Derived 1h rate = 3.0 * 2 = 6.0 => 0.6
			expect(result.totalCost).toBeCloseTo(0.6, 9)
		})

		it("bills OpenAI 12h writes at the 12h rate, not the 30m rate", () => {
			const result = calculateApiCostOpenAI(openAiModel, 100_000, 0, 100_000, 0, undefined, undefined, 100_000)

			// 12h writes: (10.0 / 1_000_000) * 100_000 = 1.0
			// The pre-split behaviour would have charged the 30m rate:
			// (5.0 / 1_000_000) * 100_000 = 0.5, under-reporting by 50%.
			expect(result.totalCost).toBeCloseTo(1.0, 9)
			expect(result.totalCost).not.toBeCloseTo(0.5, 9)
		})

		it("bills a mixed OpenAI 30m/12h split per class", () => {
			const result = calculateApiCostOpenAI(openAiModel, 100_000, 0, 100_000, 0, undefined, undefined, 40_000)

			// 30m remainder: 100k - 40k = 60k at 5.0 => 0.3
			// 12h: 40k at 10.0 => 0.4
			// Total: 0.7
			expect(result.totalCost).toBeCloseTo(0.7, 9)
		})

		it("scales the 1h write rate with the long-context multiplier", () => {
			const modelWithLongContext: ModelInfo = {
				...anthropicModel,
				longContextPricing: {
					thresholdTokens: 200_000,
					cacheWritesPriceMultiplier: 2,
				},
			}

			// calculateApiCostOpenAI applies long-context pricing; total input 300k > 200k.
			const result = calculateApiCostOpenAI(modelWithLongContext, 300_000, 0, 100_000, 0, undefined, 100_000)

			// Base input: (3.0 / 1_000_000) * (300_000 - 100_000) = 0.6
			// 1h writes scale 6.0 -> 12.0: (12.0 / 1_000_000) * 100_000 = 1.2
			// Total: 0.6 + 1.2 = 1.8. Unscaled 1h would have given 0.6 + 0.6 = 1.2.
			expect(result.totalCost).toBeCloseTo(1.8, 9)
			expect(result.totalCost).not.toBeCloseTo(1.2, 9)
		})

		it("scales the 12h write rate with the long-context multiplier", () => {
			const modelWithLongContext: ModelInfo = {
				...openAiModel,
				longContextPricing: {
					thresholdTokens: 200_000,
					cacheWritesPriceMultiplier: 2,
				},
			}

			const result = calculateApiCostOpenAI(
				modelWithLongContext,
				300_000,
				0,
				100_000,
				0,
				undefined,
				undefined,
				100_000,
			)

			// Base input: (4.0 / 1_000_000) * (300_000 - 100_000) = 0.8
			// 12h writes scale 10.0 -> 20.0: (20.0 / 1_000_000) * 100_000 = 2.0
			// Total: 0.8 + 2.0 = 2.8. Unscaled 12h would have given 0.8 + 1.0 = 1.8.
			expect(result.totalCost).toBeCloseTo(2.8, 9)
			expect(result.totalCost).not.toBeCloseTo(1.8, 9)
		})

		it("leaves the 1h rate undefined when neither a catalog rate nor an input price exists", () => {
			// Covers the `cacheWritesPrice1h !== undefined` false branch of long-context scaling.
			const bareModel: ModelInfo = {
				maxTokens: 8192,
				contextWindow: 200_000,
				supportsPromptCache: true,
				cacheWritesPrice: 3.75,
				longContextPricing: {
					thresholdTokens: 200_000,
					cacheWritesPriceMultiplier: 2,
				},
			}

			const result = calculateApiCostOpenAI(bareModel, 300_000, 0, 100_000, 0, undefined, 100_000)

			// No input price => no derivable 1h rate => falls back to the scaled aggregate
			// write rate (3.75 * 2 = 7.5): (7.5 / 1_000_000) * 100_000 = 0.75
			expect(result.totalCost).toBeCloseTo(0.75, 9)
		})

		it("does not scale TTL rates when long-context pricing has no write multiplier", () => {
			// Covers the `cacheWritesPriceMultiplier !== undefined` false branch for both
			// TTL classes: without a multiplier the rates must pass through unchanged.
			const modelWithoutMultiplier: ModelInfo = {
				...anthropicModel,
				cacheWritesPrice12h: 7.5,
				longContextPricing: {
					thresholdTokens: 200_000,
					inputPriceMultiplier: 2,
				},
			}

			const result = calculateApiCostOpenAI(
				modelWithoutMultiplier,
				300_000,
				0,
				100_000,
				0,
				undefined,
				50_000,
				50_000,
			)

			// Base input scales: (3.0 * 2 / 1_000_000) * (300_000 - 100_000) = 1.2
			// 1h unscaled: (6.0 / 1_000_000) * 50_000 = 0.3
			// 12h unscaled: (7.5 / 1_000_000) * 50_000 = 0.375
			// Total: 1.2 + 0.3 + 0.375 = 1.875
			expect(result.totalCost).toBeCloseTo(1.875, 9)
		})

		it("keeps an undefined 12h rate undefined when a write multiplier is present", () => {
			// Covers the `cacheWritesPrice12h !== undefined` false branch: a model with a
			// long-context write multiplier but no 12h rate must not gain a fabricated one.
			const modelWithout12h: ModelInfo = {
				...anthropicModel,
				longContextPricing: {
					thresholdTokens: 200_000,
					cacheWritesPriceMultiplier: 2,
				},
			}

			const result = calculateApiCostOpenAI(modelWithout12h, 300_000, 0, 100_000, 0, undefined, 100_000)

			// Base input (no inputPriceMultiplier, so unscaled): (3.0 / 1_000_000) * 200_000 = 0.6
			// 1h scales 6.0 -> 12.0: (12.0 / 1_000_000) * 100_000 = 1.2
			// Total: 0.6 + 1.2 = 1.8
			expect(result.totalCost).toBeCloseTo(1.8, 9)
		})

		it("derives the 12h rate from inputPrice when a write multiplier is present but no 12h rate", () => {
			// Distinguishes the guarded branch from an unguarded multiply: an unguarded
			// `undefined * multiplier` yields NaN, which the cost layer reads as 0 and
			// would silently drop the 12h write cost entirely.
			const modelWithout12h: ModelInfo = {
				...anthropicModel,
				longContextPricing: {
					thresholdTokens: 200_000,
					cacheWritesPriceMultiplier: 2,
				},
			}

			const result = calculateApiCostOpenAI(
				modelWithout12h,
				300_000,
				0,
				100_000,
				0,
				undefined,
				undefined,
				100_000,
			)

			// Base input: (3.0 / 1_000_000) * 200_000 = 0.6
			// No 12h rate in the catalog, so it derives from inputPrice * 2.5 = 7.5
			// (the long-context multiplier does not apply to a rate that is not there):
			// (7.5 / 1_000_000) * 100_000 = 0.75
			// Total: 0.6 + 0.75 = 1.35
			expect(result.totalCost).toBeCloseTo(1.35, 9)
			expect(result.totalCost).not.toBeCloseTo(0.6, 9)
		})
	})
})
