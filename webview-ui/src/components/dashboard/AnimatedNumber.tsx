// AnimatedNumber: displays a numeric value with smooth count-up animation.
// See docs/260729_0001_session_branch-recovery/dashboard-streaming-architecture.md
// (Sub-task 7: animate numeric values, reduced-motion disables animation).

import React, { memo } from "react"

import { useAnimatedCounter } from "./useAnimatedCounter"

// ── Types ────────────────────────────────────────────────────────────────────

export interface AnimatedNumberProps {
	/** The target numeric value to display. */
	value: number
	/**
	 * Formatter function that converts the animated display value
	 * to a string. Defaults to `Math.round(value).toLocaleString()`.
	 */
	format?: (value: number) => string
	/** Animation duration in milliseconds. Default 600. */
	duration?: number
	/** Optional className for the rendered span. */
	className?: string
}

// ── AnimatedNumber ───────────────────────────────────────────────────────────

const defaultFormat = (value: number) => Math.round(value).toLocaleString()

/**
 * Renders a `<span>` whose text content smoothly animates from the previous
 * value to the new `value` prop using an ease-out cubic curve.
 *
 * Respects `prefers-reduced-motion`: when active, the value snaps immediately.
 */
const AnimatedNumber = memo(({ value, format = defaultFormat, duration = 600, className }: AnimatedNumberProps) => {
	const displayValue = useAnimatedCounter(value, { duration })
	return (
		<span className={className} data-testid="animated-number">
			{format(displayValue)}
		</span>
	)
})

AnimatedNumber.displayName = "AnimatedNumber"

export default AnimatedNumber
