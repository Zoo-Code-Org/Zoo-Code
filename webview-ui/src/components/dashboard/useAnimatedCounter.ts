// Animated counter hook for smooth numeric transitions.
// See docs/260729_0001_session_branch-recovery/dashboard-streaming-architecture.md
// (Sub-task 7: animate numeric values, reduced-motion disables animation).

import { useEffect, useRef, useState } from "react"

// ── Types ────────────────────────────────────────────────────────────────────

export interface UseAnimatedCounterOptions {
	/** Duration of the animation in milliseconds. Default 600. */
	duration?: number
	/**
	 * Whether to respect the user's prefers-reduced-motion setting.
	 * When true (default) and reduced-motion is active, the hook
	 * snaps to the target value immediately without animation.
	 */
	respectReducedMotion?: boolean
}

// ── Hook ─────────────────────────────────────────────────────────────────────

/**
 * Smoothly animates from the previous value to the new target value using
 * `requestAnimationFrame` with an ease-out curve.
 *
 * - On first render, the value snaps immediately (no animation).
 * - If `prefers-reduced-motion` is active and `respectReducedMotion` is true,
 *   the value snaps immediately.
 * - When the component unmounts, the animation frame is cancelled.
 */
export function useAnimatedCounter(targetValue: number, options: UseAnimatedCounterOptions = {}): number {
	const { duration = 600, respectReducedMotion = true } = options

	const [displayValue, setDisplayValue] = useState(targetValue)
	const animationFrameRef = useRef<number | null>(null)
	const startValueRef = useRef(targetValue)
	const startTimeRef = useRef<number | null>(null)
	const reducedMotionRef = useRef(false)

	// Check reduced-motion preference once on mount.
	useEffect(() => {
		if (!respectReducedMotion) {
			reducedMotionRef.current = false
			return
		}

		const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)")
		reducedMotionRef.current = mediaQuery.matches

		const handleChange = (e: MediaQueryListEvent) => {
			reducedMotionRef.current = e.matches
		}
		mediaQuery.addEventListener("change", handleChange)
		return () => mediaQuery.removeEventListener("change", handleChange)
	}, [respectReducedMotion])

	// Animate towards targetValue whenever it changes.
	useEffect(() => {
		// If reduced motion is active, snap immediately.
		if (reducedMotionRef.current) {
			startValueRef.current = targetValue
			setDisplayValue(targetValue)
			return
		}

		// If the value hasn't changed, do nothing.
		if (targetValue === displayValue) return

		// Cancel any in-flight animation.
		if (animationFrameRef.current !== null) {
			cancelAnimationFrame(animationFrameRef.current)
		}

		const startValue = displayValue
		startValueRef.current = startValue
		startTimeRef.current = null

		// If start and target are the same, no animation needed.
		if (startValue === targetValue) return

		const animate = (timestamp: number) => {
			if (startTimeRef.current === null) {
				startTimeRef.current = timestamp
			}
			const elapsed = timestamp - startTimeRef.current
			const progress = Math.min(elapsed / duration, 1)

			// Ease-out cubic: 1 - (1 - t)^3
			const eased = 1 - Math.pow(1 - progress, 3)
			const current = startValue + (targetValue - startValue) * eased

			setDisplayValue(current)

			if (progress < 1) {
				animationFrameRef.current = requestAnimationFrame(animate)
			} else {
				animationFrameRef.current = null
			}
		}

		animationFrameRef.current = requestAnimationFrame(animate)

		return () => {
			if (animationFrameRef.current !== null) {
				cancelAnimationFrame(animationFrameRef.current)
				animationFrameRef.current = null
			}
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [targetValue, duration])

	return displayValue
}
