/**
 * Leading-edge debounce: runs `fn` immediately, then ignores calls until `wait`
 * ms have passed since the most recent call.
 *
 * This is the only debounce shape `useScrollLifecycle` needs: a smooth scroll
 * must start on the leading edge so the burst of row-height changes that
 * follows a single render collapses into one scroll command. `react-use`'s
 * `useDebounce` is trailing-only and cannot express it.
 *
 * `.clear()` cancels the pending window; the next call after `.clear()` runs
 * immediately, matching the `debounce` package's `{ immediate: true }` mode.
 */
export type LeadingEdgeDebounced<F extends (...args: never[]) => unknown> = F & {
	clear: () => void
}

export function leadingEdgeDebounce<F extends (...args: never[]) => unknown>(
	fn: F,
	wait: number,
): LeadingEdgeDebounced<F> {
	let timeoutId: ReturnType<typeof setTimeout> | undefined

	const debounced = ((...args: Parameters<F>): ReturnType<F> | undefined => {
		const isLeadingCall = timeoutId === undefined

		if (timeoutId !== undefined) {
			clearTimeout(timeoutId)
		}
		timeoutId = setTimeout(() => {
			timeoutId = undefined
		}, wait)

		return isLeadingCall ? (fn(...args) as ReturnType<F>) : undefined
	}) as LeadingEdgeDebounced<F>

	debounced.clear = () => {
		if (timeoutId === undefined) {
			return
		}
		clearTimeout(timeoutId)
		timeoutId = undefined
	}

	return debounced
}
