import { useLayoutEffect, useRef } from "react"

/**
 * A ref that holds the value of the latest commit, for callbacks that run outside of React (a window message, a timer)
 * and compare something with what is on the screen. It is updated in the commit phase: a passive effect runs after
 * the paint, and for some updates it is not flushed at once, so a message that arrives between the commit and that
 * effect would be compared with the value of the commit before.
 */
export function useLatestRef<T>(value: T) {
	const ref = useRef(value)
	useLayoutEffect(() => {
		ref.current = value
	}, [value])
	return ref
}
