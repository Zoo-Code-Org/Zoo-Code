import type { KeyboardEvent } from "react"

/** Native buttons retain Tab/Enter/Space; arrows also move from search into the result set. */
export function handlePickerNavigation(event: KeyboardEvent<HTMLElement>) {
	if (event.defaultPrevented || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return
	const target = event.target
	if (!(target instanceof HTMLElement)) return
	const fromSearch = target instanceof HTMLInputElement
	if (fromSearch && (event.key === "Home" || event.key === "End")) return
	if (!fromSearch && !target.matches("[data-picker-result]")) return
	const buttons = Array.from(
		event.currentTarget.querySelectorAll<HTMLButtonElement>("button[data-picker-result]:not(:disabled)"),
	)
	if (!buttons.length) return
	event.preventDefault()
	const index = buttons.findIndex((button) => button === target)
	const next =
		event.key === "Home"
			? 0
			: event.key === "End"
				? buttons.length - 1
				: event.key === "ArrowDown"
					? (index + 1) % buttons.length
					: index < 0
						? buttons.length - 1
						: (index - 1 + buttons.length) % buttons.length
	buttons[next].focus()
}

export const pickerResultsClassName = "h-[300px] shrink-0 overflow-y-auto"
