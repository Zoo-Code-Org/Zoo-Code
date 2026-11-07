import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { PRICE_TABLE, estimateRunCost } from "./coding-pricing.ts"
import { CODING_MODEL_ID } from "./coding-fixtures.ts"

const reported = (value: number) => ({ available: true as const, value })

describe("shipped price table", () => {
	it("contains no rates, so no placeholder price can look measured", () => {
		assert.deepEqual(Object.keys(PRICE_TABLE.models), [])
	})

	it("keeps the suite model cost unavailable until real rates are configured", () => {
		const cost = estimateRunCost(
			CODING_MODEL_ID,
			reported(1_000_000),
			reported(100_000),
			reported(400_000),
			reported(200_000),
		)
		assert.equal(cost.available, false)
		if (!cost.available) assert.equal(cost.reason, "modelMissingFromPriceTable")
	})

	it("estimates from an explicitly configured table", () => {
		const cost = estimateRunCost(
			CODING_MODEL_ID,
			reported(1_000_000),
			reported(100_000),
			reported(400_000),
			reported(200_000),
			{
				id: "configured",
				date: "2026-01-01",
				currency: "USD",
				cachePricing: "separate cache rates",
				models: {
					[CODING_MODEL_ID]: {
						inputPerMillion: 1,
						outputPerMillion: 2,
						cacheReadPerMillion: 0.5,
						cacheWritePerMillion: 0.25,
					},
				},
			},
		)
		assert.equal(cost.available, true)
		if (cost.available) {
			assert.ok(Math.abs(cost.usd - (1 + 0.2 + 0.2 + 0.05)) < 1e-9)
			assert.equal(cost.priceTableId, "configured")
		}
	})
})
