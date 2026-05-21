import { useMemo, type ReactNode } from "react"

import { Slider } from "@src/components/ui"
import { FormattedTextField, unlimitedIntegerFormatter } from "../common/FormattedTextField"

interface MaxOutputTokensControlProps {
	/** Current value (kept as the source of truth on the parent). */
	value: number
	/** Lower bound for the slider thumb. The numeric input still accepts smaller values. */
	min: number
	/** Upper bound for the slider thumb. The numeric input may exceed this; the slider clamps gracefully. */
	max: number
	/** Called whenever the user commits a new value, either via slider or numeric input. */
	onChange: (value: number) => void
	/** Optional disabled flag for both controls. */
	disabled?: boolean
	/** Optional aria-label override for the numeric input. */
	inputAriaLabel?: string
	/**
	 * Optional render slot rendered to the right of the value display. Provider-specific UIs
	 * (e.g. the Bedrock "Detect" button) live here so the layout stays consistent.
	 */
	extraSlot?: ReactNode
	/** Additional helper text rendered below the controls (e.g. detection status). */
	helperText?: ReactNode
	/** Optional fallback value to render when `value` is undefined/zero. */
	defaultValue?: number
}

/**
 * Compute a sensible step for the slider track based on the configured `max`.
 *
 * Goals:
 * - Keep small caps (~16K) responsive (step 1024).
 * - Avoid over-resolving large caps (1M+) where 1K-step granularity is meaningless.
 *
 * The formula targets ~128 distinct slider stops regardless of `max`, rounded to a
 * 1024-token boundary so the slider continues to land on \"nice\" multiples.
 */
const computeStep = (max: number): number => {
	if (!Number.isFinite(max) || max <= 0) return 1024
	const target = Math.round(max / 128 / 1024) * 1024
	return Math.max(1024, target)
}

/**
 * Reusable max-output-tokens control. Combines a slider (bounded by `min`/`max`) with a
 * numeric text input that is the source of truth: users can type any positive integer, even
 * one that exceeds the slider's current `max`, and the slider will clamp without overwriting
 * their typed value. Used today by the Bedrock provider settings; designed so other providers
 * can opt in by passing their own `min`/`max` and (optional) `extraSlot`.
 */
export const MaxOutputTokensControl = ({
	value,
	min,
	max,
	onChange,
	disabled,
	inputAriaLabel,
	extraSlot,
	helperText,
	defaultValue,
}: MaxOutputTokensControlProps) => {
	const effectiveValue = value > 0 ? value : (defaultValue ?? min)
	const sliderMax = Math.max(max, effectiveValue)
	const sliderValue = Math.min(Math.max(effectiveValue, min), sliderMax)
	const step = useMemo(() => computeStep(sliderMax), [sliderMax])

	const handleSliderChange = ([next]: number[]) => {
		// Slider always emits values within [min, sliderMax]; pass through unchanged.
		onChange(next)
	}

	const handleInputChange = (next: number | undefined) => {
		if (next === undefined) {
			// Empty input → revert to the slider minimum so we never persist NaN/0 silently.
			onChange(min)
			return
		}
		onChange(Math.max(min, next))
	}

	return (
		<div className="flex flex-col gap-2">
			{/*
			 * Row 1: slider + numeric input. Slider gets `flex-1 min-w-0` so it can shrink without
			 * pushing siblings off-screen; the number field is a fixed-width flex-shrink-0 column.
			 */}
			<div className="flex items-center gap-3">
				<div className="flex-1 min-w-0">
					<Slider
						min={min}
						max={sliderMax}
						step={step}
						value={[sliderValue]}
						onValueChange={handleSliderChange}
						disabled={disabled}
						data-testid="max-output-tokens-slider"
					/>
				</div>
				<div className="flex-shrink-0" style={{ width: "10ch" }}>
					<FormattedTextField
						value={effectiveValue}
						onValueChange={handleInputChange}
						formatter={unlimitedIntegerFormatter}
						disabled={disabled}
						aria-label={inputAriaLabel}
						style={{ width: "100%" }}
						data-testid="max-output-tokens-input"
					/>
				</div>
			</div>
			{/*
			 * Row 2: provider-specific actions (e.g. the Bedrock probe button). Rendered on its own
			 * line so wide button labels can't be clipped by the absolutely-positioned focus border
			 * of the VSCode text field above.
			 */}
			{extraSlot ? <div className="flex flex-wrap items-center gap-2">{extraSlot}</div> : null}
			{helperText ? <div className="text-sm text-vscode-descriptionForeground">{helperText}</div> : null}
		</div>
	)
}
