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
	const [prefersReducedMotion, setPrefersReducedMotion] = useState(false)
	const animationFrameRef = useRef<number | null>(null)
	const currentDisplayValueRef = useRef(targetValue)
	const startTimeRef = useRef<number | null>(null)

	// Check reduced-motion preference and track changes.
	useEffect(() => {
		if (!respectReducedMotion) {
			setPrefersReducedMotion(false)
			return
		}

		if (typeof window === "undefined" || !window.matchMedia) {
			return
		}

		const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)")
		setPrefersReducedMotion(mediaQuery.matches)

		const handleChange = (e: MediaQueryListEvent) => {
			setPrefersReducedMotion(e.matches)
		}
		mediaQuery.addEventListener("change", handleChange)
		return () => mediaQuery.removeEventListener("change", handleChange)
	}, [respectReducedMotion])

	// Animate towards targetValue whenever it changes or motion preference changes.
	useEffect(() => {
		// Cancel any in-flight animation frame.
		if (animationFrameRef.current !== null) {
			cancelAnimationFrame(animationFrameRef.current)
			animationFrameRef.current = null
		}

		// If reduced motion is active or duration is invalid/zero, snap immediately.
		if (prefersReducedMotion || !Number.isFinite(duration) || duration <= 0) {
			currentDisplayValueRef.current = targetValue
			setDisplayValue(targetValue)
			return
		}

		const startValue = currentDisplayValueRef.current

		// If start and target are the same, no animation needed.
		if (startValue === targetValue) {
			return
		}

		startTimeRef.current = null

		const animate = (timestamp: number) => {
			if (startTimeRef.current === null) {
				startTimeRef.current = timestamp
			}
			const elapsed = timestamp - startTimeRef.current
			const progress = Math.min(elapsed / duration, 1)

			// Ease-out cubic: 1 - (1 - t)^3
			const eased = 1 - Math.pow(1 - progress, 3)
			const current = startValue + (targetValue - startValue) * eased

			currentDisplayValueRef.current = current
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
	}, [targetValue, duration, prefersReducedMotion])

	return displayValue
}
