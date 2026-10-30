import {
	CACHE_WRITE_MULTIPLIER_12H,
	CACHE_WRITE_MULTIPLIER_1H,
	OpenAiServiceTier,
	type ModelInfo,
	type ServiceTier,
} from "@roo-code/types"

export interface ApiCostResult {
	totalInputTokens: number
	totalOutputTokens: number
	totalCost: number
}

/**
 * Resolve the per-million rate for a TTL-specific cache-write class.
 *
 * Precedence is fail-closed: an explicit catalog rate wins, then the vendor
 * multiplier applied to the base input price, and only then the aggregate
 * `cacheWritesPrice`. The last step is the pre-split behaviour, reachable only
 * when a model has neither a 1h/12h rate nor an input price to derive one from.
 */
function resolveCacheWriteRate(
	modelInfo: ModelInfo,
	explicit: number | undefined,
	multiplier: number,
): number | undefined {
	if (explicit !== undefined) return explicit
	if (modelInfo.inputPrice !== undefined) return modelInfo.inputPrice * multiplier
	return modelInfo.cacheWritesPrice
}

function applyLongContextPricing(modelInfo: ModelInfo, totalInputTokens: number, serviceTier?: ServiceTier): ModelInfo {
	const pricing = modelInfo.longContextPricing
	if (!pricing || totalInputTokens <= pricing.thresholdTokens) {
		return modelInfo
	}

	const effectiveServiceTier = serviceTier ?? OpenAiServiceTier.Default
	if (pricing.appliesToServiceTiers && !pricing.appliesToServiceTiers.includes(effectiveServiceTier)) {
		return modelInfo
	}

	return {
		...modelInfo,
		inputPrice:
			modelInfo.inputPrice !== undefined && pricing.inputPriceMultiplier !== undefined
				? modelInfo.inputPrice * pricing.inputPriceMultiplier
				: modelInfo.inputPrice,
		outputPrice:
			modelInfo.outputPrice !== undefined && pricing.outputPriceMultiplier !== undefined
				? modelInfo.outputPrice * pricing.outputPriceMultiplier
				: modelInfo.outputPrice,
		cacheWritesPrice:
			modelInfo.cacheWritesPrice !== undefined && pricing.cacheWritesPriceMultiplier !== undefined
				? modelInfo.cacheWritesPrice * pricing.cacheWritesPriceMultiplier
				: modelInfo.cacheWritesPrice,
		// The TTL-specific write rates scale with the same multiplier as the aggregate
		// write rate; leaving them unscaled would under-bill long-context 1h writes.
		cacheWritesPrice1h:
			modelInfo.cacheWritesPrice1h !== undefined && pricing.cacheWritesPriceMultiplier !== undefined
				? modelInfo.cacheWritesPrice1h * pricing.cacheWritesPriceMultiplier
				: modelInfo.cacheWritesPrice1h,
		cacheWritesPrice12h:
			modelInfo.cacheWritesPrice12h !== undefined && pricing.cacheWritesPriceMultiplier !== undefined
				? modelInfo.cacheWritesPrice12h * pricing.cacheWritesPriceMultiplier
				: modelInfo.cacheWritesPrice12h,
		cacheReadsPrice:
			modelInfo.cacheReadsPrice !== undefined && pricing.cacheReadsPriceMultiplier !== undefined
				? modelInfo.cacheReadsPrice * pricing.cacheReadsPriceMultiplier
				: modelInfo.cacheReadsPrice,
	}
}

function calculateApiCostInternal(
	modelInfo: ModelInfo,
	inputTokens: number,
	outputTokens: number,
	cacheCreationInputTokens: number,
	cacheReadInputTokens: number,
	totalInputTokens: number,
	totalOutputTokens: number,
	cacheCreation1hInputTokens = 0,
	cacheCreation12hInputTokens = 0,
): ApiCostResult {
	// The per-TTL counts are a decomposition of `cacheCreationInputTokens`, never
	// an addition to it. Deriving the 5m remainder this way keeps the aggregate
	// path byte-identical when a vendor reports no split (both terms are 0).
	const writes1h = Math.max(0, cacheCreation1hInputTokens)
	const writes12h = Math.max(0, cacheCreation12hInputTokens)
	const writes5m = Math.max(0, cacheCreationInputTokens - writes1h - writes12h)

	const writes5mRate = modelInfo.cacheWritesPrice || 0
	const writes1hRate = resolveCacheWriteRate(modelInfo, modelInfo.cacheWritesPrice1h, CACHE_WRITE_MULTIPLIER_1H) || 0
	const writes12hRate =
		resolveCacheWriteRate(modelInfo, modelInfo.cacheWritesPrice12h, CACHE_WRITE_MULTIPLIER_12H) || 0

	const cacheWritesCost =
		(writes5mRate / 1_000_000) * writes5m +
		(writes1hRate / 1_000_000) * writes1h +
		(writes12hRate / 1_000_000) * writes12h
	const cacheReadsCost = ((modelInfo.cacheReadsPrice || 0) / 1_000_000) * cacheReadInputTokens
	const baseInputCost = ((modelInfo.inputPrice || 0) / 1_000_000) * inputTokens
	const outputCost = ((modelInfo.outputPrice || 0) / 1_000_000) * outputTokens
	const totalCost = cacheWritesCost + cacheReadsCost + baseInputCost + outputCost

	return {
		totalInputTokens,
		totalOutputTokens,
		totalCost,
	}
}

// For Anthropic compliant usage, the input tokens count does NOT include the
// cached tokens.
export function calculateApiCostAnthropic(
	modelInfo: ModelInfo,
	inputTokens: number,
	outputTokens: number,
	cacheCreationInputTokens?: number,
	cacheReadInputTokens?: number,
	cacheCreation1hInputTokens?: number,
	cacheCreation12hInputTokens?: number,
): ApiCostResult {
	const cacheCreation = cacheCreationInputTokens || 0
	const cacheRead = cacheReadInputTokens || 0

	// For Anthropic: inputTokens does NOT include cached tokens
	// Total input = base input + cache creation + cache reads
	const totalInputTokens = inputTokens + cacheCreation + cacheRead

	return calculateApiCostInternal(
		modelInfo,
		inputTokens,
		outputTokens,
		cacheCreation,
		cacheRead,
		totalInputTokens,
		outputTokens,
		cacheCreation1hInputTokens,
		cacheCreation12hInputTokens,
	)
}

// For OpenAI compliant usage, the input tokens count INCLUDES the cached tokens.
export function calculateApiCostOpenAI(
	modelInfo: ModelInfo,
	inputTokens: number,
	outputTokens: number,
	cacheCreationInputTokens?: number,
	cacheReadInputTokens?: number,
	serviceTier?: ServiceTier,
	cacheCreation1hInputTokens?: number,
	cacheCreation12hInputTokens?: number,
): ApiCostResult {
	const cacheCreationInputTokensNum = cacheCreationInputTokens || 0
	const cacheReadInputTokensNum = cacheReadInputTokens || 0
	const nonCachedInputTokens = Math.max(0, inputTokens - cacheCreationInputTokensNum - cacheReadInputTokensNum)
	const effectiveModelInfo = applyLongContextPricing(modelInfo, inputTokens, serviceTier)

	// For OpenAI: inputTokens ALREADY includes all tokens (cached + non-cached)
	// So we pass the original inputTokens as the total
	return calculateApiCostInternal(
		effectiveModelInfo,
		nonCachedInputTokens,
		outputTokens,
		cacheCreationInputTokensNum,
		cacheReadInputTokensNum,
		inputTokens,
		outputTokens,
		cacheCreation1hInputTokens,
		cacheCreation12hInputTokens,
	)
}

export const parseApiPrice = (price: any) => (price ? parseFloat(price) * 1_000_000 : undefined)
