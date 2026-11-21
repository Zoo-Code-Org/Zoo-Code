import type { Measured } from "./trace.ts"

export interface PriceTableEntry {
	inputPerMillion: number
	outputPerMillion: number
	cacheReadPerMillion: number
	cacheWritePerMillion: number
}

export interface PriceTable {
	id: string
	date: string
	currency: string
	cachePricing: string
	models: Record<string, PriceTableEntry>
}

// Operator-maintained price table. The identifier and date travel with every
// estimated cost. Cache reads and writes are priced separately from input and
// output tokens. Update the entries; never reuse the identifier for new rates.
export const PRICE_TABLE: PriceTable = {
	id: "agent-evals-prices-2026-10",
	date: "2026-10-01",
	currency: "USD",
	cachePricing:
		"cache reads and cache writes are priced per million tokens at their own rates; missing cache counts make the estimate unavailable",
	// No rates are configured. Cost estimates stay unavailable until a
	// maintainer records real rates here. Placeholder or guessed rates must
	// never enter this table, because reports present estimates as measured
	// cost. A rate change needs a new table identifier.
	models: {},
}

export type EstimatedCost =
	| {
			available: true
			usd: number
			priceTableId: string
			priceTableDate: string
			cachePricing: string
	  }
	| { available: false; reason: string }

// Estimates one run's cost from the final cumulative usage snapshot. All four
// token counts must be reported. A missing count is never treated as zero.
export function estimateRunCost(
	modelId: string,
	tokensIn: Measured<number>,
	tokensOut: Measured<number>,
	cacheReads: Measured<number>,
	cacheWrites: Measured<number>,
	table: PriceTable = PRICE_TABLE,
): EstimatedCost {
	const entry = table.models[modelId]
	if (!entry) return { available: false, reason: "modelMissingFromPriceTable" }
	// Every count must be reported. A missing count is never treated as zero.
	if (!tokensIn.available) return { available: false, reason: "tokensInNotReported" }
	if (!tokensOut.available) return { available: false, reason: "tokensOutNotReported" }
	if (!cacheReads.available) return { available: false, reason: "cacheReadsNotReported" }
	if (!cacheWrites.available) return { available: false, reason: "cacheWritesNotReported" }
	const perMillion = (tokens: number, rate: number) => (tokens / 1_000_000) * rate
	const usd =
		perMillion(tokensIn.value, entry.inputPerMillion) +
		perMillion(tokensOut.value, entry.outputPerMillion) +
		perMillion(cacheReads.value, entry.cacheReadPerMillion) +
		perMillion(cacheWrites.value, entry.cacheWritePerMillion)
	return {
		available: true,
		usd,
		priceTableId: table.id,
		priceTableDate: table.date,
		cachePricing: table.cachePricing,
	}
}
