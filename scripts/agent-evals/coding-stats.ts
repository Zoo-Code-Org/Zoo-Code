import type { CodingRunOutcome } from "./coding-outcomes.ts"

// Uncertainty constant for the Wilson score interval at the 95% level. The
// interval describes uncertainty. It is not a significance test.
export const UNCERTAINTY_Z = 1.96

export const DEFAULT_REPETITIONS = 3

export const STATISTICAL_POLICY = {
	method: "success-rate-with-wilson-95-percent-interval-and-paired-deltas",
	significanceClaim: "none. Three repetitions can show large regressions. They cannot show small improvements.",
	repetitionsDefault: DEFAULT_REPETITIONS,
} as const

export interface SuccessRate {
	successes: number
	total: number
	rate: number
	interval: { lower: number; upper: number } | undefined
}

// Wilson score interval. n = 0 yields no interval.
export function wilsonInterval(
	successes: number,
	n: number,
	z: number = UNCERTAINTY_Z,
): { lower: number; upper: number } {
	if (n <= 0) return { lower: 0, upper: 0 }
	const p = successes / n
	const z2 = z * z
	const denominator = 1 + z2 / n
	const center = (p + z2 / (2 * n)) / denominator
	const spread = (z / denominator) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))
	return { lower: Math.max(0, center - spread), upper: Math.min(1, center + spread) }
}

export function successRate(outcomes: readonly CodingRunOutcome[]): SuccessRate {
	const total = outcomes.length
	const successes = outcomes.filter((outcome) => outcome === "correct").length
	return {
		successes,
		total,
		rate: total === 0 ? 0 : successes / total,
		interval: total === 0 ? undefined : wilsonInterval(successes, total),
	}
}

export interface PairedOutcomeDiff {
	pairs: number
	improved: number
	regressed: number
	unchanged: number
	definition: string
}

// Paired by repetition index. Improvement means the candidate run is correct
// where the baseline run is not. Regression is the reverse. No significance
// claim follows from these counts.
export function pairedOutcomeDiffs(
	baseline: readonly CodingRunOutcome[],
	candidate: readonly CodingRunOutcome[],
): PairedOutcomeDiff {
	const pairs = Math.min(baseline.length, candidate.length)
	let improved = 0
	let regressed = 0
	let unchanged = 0
	for (let index = 0; index < pairs; index++) {
		const baseCorrect = baseline[index] === "correct"
		const candCorrect = candidate[index] === "correct"
		if (baseCorrect === candCorrect) unchanged++
		else if (candCorrect) improved++
		else regressed++
	}
	return {
		pairs,
		improved,
		regressed,
		unchanged,
		definition: "paired by repetition index; correct versus not correct",
	}
}

export interface PairedNumericDiff {
	pairs: { baseline: number; candidate: number; delta: number }[]
	missingPairs: number
	meanDelta?: number
	minDelta?: number
	maxDelta?: number
}

// Paired numeric deltas. A pair needs both sides reported; pairs with a
// missing value on either side are counted as missing, never as zero.
export function pairedNumericDiffs(
	baseline: readonly (number | undefined)[],
	candidate: readonly (number | undefined)[],
): PairedNumericDiff {
	const pairs: { baseline: number; candidate: number; delta: number }[] = []
	let missingPairs = 0
	const count = Math.min(baseline.length, candidate.length)
	for (let index = 0; index < count; index++) {
		const base = baseline[index]
		const cand = candidate[index]
		if (base === undefined || cand === undefined) {
			missingPairs++
			continue
		}
		pairs.push({ baseline: base, candidate: cand, delta: cand - base })
	}
	if (pairs.length === 0) return { pairs, missingPairs }
	const deltas = pairs.map((pair) => pair.delta)
	return {
		pairs,
		missingPairs,
		meanDelta: deltas.reduce((sum, delta) => sum + delta, 0) / deltas.length,
		minDelta: Math.min(...deltas),
		maxDelta: Math.max(...deltas),
	}
}
