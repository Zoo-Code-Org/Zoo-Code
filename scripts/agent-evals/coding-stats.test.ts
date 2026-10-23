import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
	DEFAULT_REPETITIONS,
	STATISTICAL_POLICY,
	pairedNumericDiffs,
	pairedOutcomeDiffs,
	successRate,
	wilsonInterval,
} from "./coding-stats.ts"

describe("statistics", () => {
	it("defaults to three repetitions per fixture per commit", () => {
		assert.equal(DEFAULT_REPETITIONS, 3)
		assert.equal(STATISTICAL_POLICY.repetitionsDefault, 3)
	})

	it("computes the Wilson interval without claiming significance", () => {
		const perfect = wilsonInterval(3, 3)
		assert.ok(perfect.lower > 0.29, `lower bound too low: ${perfect.lower}`)
		assert.ok(perfect.upper <= 1)
		const none = wilsonInterval(0, 3)
		assert.equal(none.lower, 0)
		assert.ok(none.upper < 0.71)
		assert.deepEqual(wilsonInterval(1, 0), { lower: 0, upper: 0 })
		assert.match(STATISTICAL_POLICY.significanceClaim, /cannot show small improvements/)
		assert.equal(STATISTICAL_POLICY.method.includes("wilson"), true)
	})

	it("summarizes success rates over outcomes", () => {
		const rate = successRate(["correct", "correct", "incorrect"] as const)
		assert.equal(rate.successes, 2)
		assert.equal(rate.total, 3)
		assert.ok(Math.abs(rate.rate - 2 / 3) < 1e-9)
		assert.ok(rate.interval !== undefined)
		assert.equal(successRate([]).interval, undefined)
	})

	it("pairs outcome differences by repetition index", () => {
		const diff = pairedOutcomeDiffs(
			["correct", "incorrect", "correct", "correct"],
			["incorrect", "correct", "correct", "grading-failure"],
		)
		assert.equal(diff.pairs, 4)
		assert.equal(diff.improved, 1)
		assert.equal(diff.regressed, 2)
		assert.equal(diff.unchanged, 1)
	})

	it("pairs numeric deltas and counts missing pairs without zero filling", () => {
		const diff = pairedNumericDiffs([1, 2, undefined, 4], [3, undefined, 5, 8])
		assert.equal(diff.pairs.length, 2)
		assert.equal(diff.missingPairs, 2)
		assert.deepEqual(
			diff.pairs.map((pair) => pair.delta).sort((a, b) => a - b),
			[2, 4],
		)
		assert.ok(Math.abs((diff.meanDelta ?? 0) - 3) < 1e-9)
		const empty = pairedNumericDiffs([], [])
		assert.equal(empty.meanDelta, undefined)
	})
})
