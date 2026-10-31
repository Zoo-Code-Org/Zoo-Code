import { useEffect, useState } from "react"
import { Minus, Plus, RotateCcw } from "lucide-react"

import { cn } from "@/lib/utils"
import { type AppearanceSetting } from "@/utils/appearance"

interface NumberStepperProps {
	label: string
	description: string
	resetLabel: string
	setting: AppearanceSetting
	/** Undefined = unset (shows `setting.fallback`, reset disabled). */
	value?: number
	onChange: (value: number | undefined) => void
	testId: string
}

/**
 * `[ − ] [ value ] [ + ] unit ↺`.
 * Typing is allowed; the value commits (clamped) on blur/Enter so partial
 * input like "1" on the way to "120" is never saved or applied.
 */
export const NumberStepper = ({
	label,
	description,
	resetLabel,
	setting,
	value,
	onChange,
	testId,
}: NumberStepperProps) => {
	const { min, max, step, fallback, unit } = setting
	const current = value ?? fallback
	const [draft, setDraft] = useState(String(current))
	// Whether the user typed in the box. Leaving or confirming an untouched box must not turn what it shows (the
	// fallback, while nothing is set) into a stored value.
	const [typed, setTyped] = useState(false)

	useEffect(() => {
		setDraft(String(current))
		setTyped(false)
	}, [current])

	// Arrow keys step from what is in the box when the user has typed a number, so the typed value is not lost.
	const stepBase = typed && draft.trim() !== "" && Number.isFinite(Number(draft)) ? Number(draft) : current

	const commitTyped = () => {
		if (!typed) return
		setTyped(false)
		commit(Number(draft))
	}

	const commit = (next: number) => {
		if (!Number.isFinite(next)) {
			setDraft(String(current))
			return
		}
		// An emptied box means "no entry", not 0: revert instead of clamping to the minimum.
		if (draft.trim() === "" && next === 0) {
			setDraft(String(current))
			return
		}
		const clamped = Math.min(max, Math.max(min, Math.round(next)))
		setDraft(String(clamped))
		// Always the number the user chose. `fallback` is only what the box shows while nothing is set; for
		// the font sizes the real default is VS Code's own size, so a typed 12 must stay 12. Only Reset
		// clears the override.
		onChange(clamped)
	}

	const buttonClass =
		"flex items-center justify-center w-8 self-stretch bg-vscode-input-background text-vscode-foreground hover:bg-vscode-list-hoverBackground disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"

	return (
		<div className="flex flex-col gap-1">
			<label className="block font-medium mb-1" htmlFor={`${testId}-input`}>
				{label}
			</label>
			<div className="flex items-center gap-2">
				<div className="inline-flex items-stretch h-7 rounded-md border border-vscode-input-border overflow-hidden">
					<button
						type="button"
						className={buttonClass}
						aria-label={`${label} −`}
						disabled={current <= min}
						onClick={() => commit(current - step)}
						data-testid={`${testId}-decrement`}>
						<Minus className="size-3.5" />
					</button>
					<input
						id={`${testId}-input`}
						className="w-16 text-center bg-vscode-input-background text-vscode-input-foreground border-x border-vscode-input-border outline-none focus:border-vscode-focusBorder tabular-nums"
						inputMode="numeric"
						value={draft}
						aria-describedby={`${testId}-unit ${testId}-description`}
						onChange={(e) => {
							setDraft(e.target.value.replace(/[^\d]/g, ""))
							setTyped(true)
						}}
						onBlur={commitTyped}
						onKeyDown={(e) => {
							if (e.key === "Enter") commitTyped()
							if (e.key === "ArrowUp") {
								e.preventDefault()
								commit(stepBase + step)
							}
							if (e.key === "ArrowDown") {
								e.preventDefault()
								commit(stepBase - step)
							}
						}}
						data-testid={`${testId}-input`}
					/>
					<button
						type="button"
						className={buttonClass}
						aria-label={`${label} +`}
						disabled={current >= max}
						onClick={() => commit(current + step)}
						data-testid={`${testId}-increment`}>
						<Plus className="size-3.5" />
					</button>
				</div>
				<span id={`${testId}-unit`} className="text-vscode-descriptionForeground w-5">
					{unit}
				</span>
				<button
					type="button"
					className={cn(
						"p-1 rounded text-vscode-descriptionForeground hover:text-vscode-foreground cursor-pointer",
						value === undefined && "invisible",
					)}
					title={resetLabel}
					aria-label={resetLabel}
					onClick={() => onChange(undefined)}
					data-testid={`${testId}-reset`}>
					<RotateCcw className="size-3.5" />
				</button>
			</div>
			<div id={`${testId}-description`} className="text-vscode-descriptionForeground text-sm mt-1">
				{description}
			</div>
		</div>
	)
}
