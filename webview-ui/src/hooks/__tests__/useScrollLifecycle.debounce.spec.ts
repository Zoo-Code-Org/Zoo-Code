/**
 * Characterization suite for `useScrollLifecycle`'s debounced scroll command.
 *
 * `scrollToBottomSmooth` is a leading-edge debounce (10 ms window) that is
 * `.clear()`ed on unmount. This file pins that observable behaviour so the
 * underlying debounce implementation can be swapped without drifting.
 *
 * Phase 1 of the swap ran this file against the `debounce` package; phase 2
 * runs it against the local `leadingEdgeDebounce` helper. Only the hook's
 * import changed; every assertion and timing here is unchanged.
 */
import { act, renderHook } from "@testing-library/react"
import type { VirtuosoHandle } from "react-virtuoso"

import { useScrollLifecycle } from "../useScrollLifecycle"

const SMOOTH_WINDOW_MS = 10

type ScrollCall = { index: "LAST"; align: "end"; behavior: "auto" | "smooth" }

function makeVirtuosoRef() {
	const scrollToIndex = vi.fn<(options: ScrollCall) => void>()
	const ref = { current: { scrollToIndex } as unknown as VirtuosoHandle }
	return { ref, scrollToIndex }
}

function makeContainerRef() {
	const element = document.createElement("div")
	document.body.appendChild(element)
	return { current: element }
}

function renderScrollLifecycle(
	overrides: Partial<Parameters<typeof useScrollLifecycle>[0]> = {},
	virtuosoRef = makeVirtuosoRef(),
) {
	const hook = renderHook(() =>
		useScrollLifecycle({
			virtuosoRef: virtuosoRef.ref,
			scrollContainerRef: makeContainerRef(),
			taskTs: undefined,
			isStreaming: false,
			isHidden: false,
			hasTask: true,
			...overrides,
		}),
	)
	return { ...hook, scrollToIndex: virtuosoRef.scrollToIndex }
}

/** Drives the hook into ANCHORED_FOLLOWING with `isAtBottomRef` set. */
function enterAnchoredFollowing(result: { current: ReturnType<typeof useScrollLifecycle> }) {
	act(() => {
		result.current.atBottomStateChangeCallback(true)
	})
	expect(result.current.scrollPhaseRef.current).toBe("ANCHORED_FOLLOWING")
	expect(result.current.isAtBottomRef.current).toBe(true)
}

const smoothCalls = (scrollToIndex: ReturnType<typeof makeVirtuosoRef>["scrollToIndex"]) =>
	scrollToIndex.mock.calls.filter(([options]) => options.behavior === "smooth")

describe("useScrollLifecycle debounced scroll command", () => {
	beforeEach(() => {
		vi.useFakeTimers()
	})

	afterEach(() => {
		vi.useRealTimers()
		document.body.innerHTML = ""
	})

	test("a taller row in anchored follow scrolls smoothly on the leading edge", () => {
		const { result, scrollToIndex } = renderScrollLifecycle()
		enterAnchoredFollowing(result)

		act(() => {
			result.current.handleRowHeightChange(true)
		})

		expect(smoothCalls(scrollToIndex)).toHaveLength(1)
		expect(smoothCalls(scrollToIndex)[0][0]).toEqual({ index: "LAST", align: "end", behavior: "smooth" })
	})

	test("a burst of taller rows collapses into one smooth scroll", () => {
		const { result, scrollToIndex } = renderScrollLifecycle()
		enterAnchoredFollowing(result)

		act(() => {
			result.current.handleRowHeightChange(true)
			vi.advanceTimersByTime(3)
			result.current.handleRowHeightChange(true)
			vi.advanceTimersByTime(3)
			result.current.handleRowHeightChange(true)
		})

		expect(smoothCalls(scrollToIndex)).toHaveLength(1)
	})

	test("the smooth scroll is never deferred to the trailing edge", () => {
		const { result, scrollToIndex } = renderScrollLifecycle()
		enterAnchoredFollowing(result)

		act(() => {
			result.current.handleRowHeightChange(true)
		})
		expect(smoothCalls(scrollToIndex)).toHaveLength(1)

		act(() => {
			vi.advanceTimersByTime(SMOOTH_WINDOW_MS * 100)
		})

		expect(smoothCalls(scrollToIndex)).toHaveLength(1)
	})

	test("the window reopens once 10 ms have elapsed since the last taller row", () => {
		const { result, scrollToIndex } = renderScrollLifecycle()
		enterAnchoredFollowing(result)

		act(() => {
			result.current.handleRowHeightChange(true)
		})
		act(() => {
			vi.advanceTimersByTime(SMOOTH_WINDOW_MS)
		})
		act(() => {
			result.current.handleRowHeightChange(true)
		})

		expect(smoothCalls(scrollToIndex)).toHaveLength(2)
	})

	test("a shorter row scrolls immediately with behavior auto, not through the debounce", () => {
		const { result, scrollToIndex } = renderScrollLifecycle()
		enterAnchoredFollowing(result)

		act(() => {
			result.current.handleRowHeightChange(false)
		})

		expect(scrollToIndex).toHaveBeenCalledWith({ index: "LAST", align: "end", behavior: "auto" })
		expect(smoothCalls(scrollToIndex)).toHaveLength(0)
	})

	test("unmount clears the pending window so a late timer cannot scroll", () => {
		const { result, scrollToIndex, unmount } = renderScrollLifecycle()
		enterAnchoredFollowing(result)

		act(() => {
			result.current.handleRowHeightChange(true)
		})
		expect(smoothCalls(scrollToIndex)).toHaveLength(1)

		unmount()

		act(() => {
			vi.advanceTimersByTime(SMOOTH_WINDOW_MS * 100)
		})

		expect(smoothCalls(scrollToIndex)).toHaveLength(1)
		expect(vi.getTimerCount()).toBe(0)
	})

	test("no smooth scroll is issued while the user browses history", () => {
		const { result, scrollToIndex } = renderScrollLifecycle()

		act(() => {
			result.current.handleRowHeightChange(true)
		})

		expect(smoothCalls(scrollToIndex)).toHaveLength(0)
	})
})
