/**
 * Clamps the tool-repetition soft limit so that it always stays strictly below
 * the hard stop limit (the consecutive mistake limit).
 *
 * The detector in `ToolRepetitionDetector.check()` checks the hard limit first
 * and the soft limit second. If the soft limit is greater than or equal to the
 * hard limit, the soft-block path becomes unreachable (the hard block always
 * fires first). To keep the soft warning meaningful, the soft limit must be
 * strictly less than the hard limit.
 *
 * Special cases:
 * - A hard limit of 0 means the hard stop is disabled (unlimited). In that case
 *   the soft limit has no upper bound and is only clamped to be non-negative.
 * - Negative inputs are clamped to 0.
 *
 * @param softValue The requested soft limit value.
 * @param hardLimit The hard stop limit (consecutive mistake limit).
 * @returns The soft limit clamped to `[0, hardLimit - 1]` (or `[0, ∞)` when the
 *   hard limit is 0/disabled).
 */
export function clampToolRepetitionSoftLimit(softValue: number, hardLimit: number): number {
	const soft = Math.max(0, softValue)

	// Hard stop disabled (unlimited) -> no upper bound from the hard limit.
	if (hardLimit <= 0) {
		return soft
	}

	// Soft must stay strictly below the hard stop so the soft-block path is reachable,
	// while never dropping below zero (e.g. a fractional hard limit like 0.5).
	return Math.max(0, Math.min(soft, hardLimit - 1))
}
