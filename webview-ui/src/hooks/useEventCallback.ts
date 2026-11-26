import { useLayoutEffect, useMemo, useRef, type MutableRefObject } from "react"

// Keep this factory outside the rendering component/hook. Its closure must only
// retain the ref, not a render scope containing old transcripts and callbacks.
function createEventCallback<Args extends unknown[], Result>(
	callback: MutableRefObject<(...args: Args) => Result>,
): (...args: Args) => Result {
	return (...args) => callback.current(...args)
}

/** A stable event handler that invokes the latest committed implementation. */
export function useEventCallback<Args extends unknown[], Result>(
	callback: (...args: Args) => Result,
): (...args: Args) => Result {
	const latest = useRef(callback)
	useLayoutEffect(() => {
		latest.current = callback
	})
	return useMemo(() => createEventCallback(latest), [])
}
