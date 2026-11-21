/**
 * Characterization suite for the leading-edge debounce used by
 * `useScrollLifecycle` (`scrollToBottomSmooth`).
 *
 * Phase 1 of the dependency swap ran this file against a `leadingEdgeDebounce`
 * module that delegated to the `debounce` package. Phase 2 ran the same file,
 * unchanged, against the local implementation. Every assertion, timing and
 * test name is byte-identical between the two phases.
 */
import { leadingEdgeDebounce } from "../leadingEdgeDebounce"

const WAIT = 10

describe("leadingEdgeDebounce (used surface: leading edge + clear)", () => {
	beforeEach(() => {
		vi.useFakeTimers()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	test("invokes on the leading edge, synchronously", () => {
		const fn = vi.fn()
		const debounced = leadingEdgeDebounce(fn, WAIT)

		debounced()

		expect(fn).toHaveBeenCalledTimes(1)
		// No timer advance: the call happened at t=0.
		expect(vi.getTimerCount()).toBe(1)
	})

	test("suppresses a burst of calls inside the window down to one invocation", () => {
		const fn = vi.fn()
		const debounced = leadingEdgeDebounce(fn, WAIT)

		debounced()
		vi.advanceTimersByTime(3)
		debounced()
		vi.advanceTimersByTime(3)
		debounced()

		expect(fn).toHaveBeenCalledTimes(1)
	})

	test("never invokes on the trailing edge", () => {
		const fn = vi.fn()
		const debounced = leadingEdgeDebounce(fn, WAIT)

		debounced()
		vi.advanceTimersByTime(WAIT * 100)

		expect(fn).toHaveBeenCalledTimes(1)
	})

	test("re-invocation inside the window suppresses the call and extends the window", () => {
		const fn = vi.fn()
		const debounced = leadingEdgeDebounce(fn, WAIT)

		debounced() // t=0, fires
		vi.advanceTimersByTime(5)
		debounced() // t=5, suppressed

		// t=10: the original window would have closed here, but the t=5 call
		// restarted it, so this call is still suppressed.
		vi.advanceTimersByTime(5)
		debounced()
		expect(fn).toHaveBeenCalledTimes(1)

		// t=20: `wait` has elapsed since the last call at t=10.
		vi.advanceTimersByTime(10)
		debounced()
		expect(fn).toHaveBeenCalledTimes(2)
	})

	test("reopens the window once `wait` has elapsed since the last call", () => {
		const fn = vi.fn()
		const debounced = leadingEdgeDebounce(fn, WAIT)

		debounced()
		vi.advanceTimersByTime(WAIT)
		debounced()
		vi.advanceTimersByTime(WAIT)
		debounced()

		expect(fn).toHaveBeenCalledTimes(3)
	})

	test("clear() cancels the pending timer", () => {
		const fn = vi.fn()
		const debounced = leadingEdgeDebounce(fn, WAIT)

		debounced()
		expect(vi.getTimerCount()).toBe(1)

		debounced.clear()

		expect(vi.getTimerCount()).toBe(0)
		vi.advanceTimersByTime(WAIT * 100)
		expect(fn).toHaveBeenCalledTimes(1)
	})

	test("clear() reopens the window so the next call fires immediately", () => {
		const fn = vi.fn()
		const debounced = leadingEdgeDebounce(fn, WAIT)

		debounced()
		debounced.clear()
		debounced()

		expect(fn).toHaveBeenCalledTimes(2)
	})

	test("clear() is a no-op when nothing is pending", () => {
		const fn = vi.fn()
		const debounced = leadingEdgeDebounce(fn, WAIT)

		expect(() => debounced.clear()).not.toThrow()
		expect(vi.getTimerCount()).toBe(0)
		expect(fn).not.toHaveBeenCalled()
	})

	test("forwards arguments to the leading call", () => {
		const fn = vi.fn<(a: string, b: number) => void>()
		const debounced = leadingEdgeDebounce(fn, WAIT)

		debounced("LAST", 7)

		expect(fn).toHaveBeenCalledWith("LAST", 7)
	})

	test("returns the leading call's return value", () => {
		const debounced = leadingEdgeDebounce(() => "result", WAIT)

		expect(debounced()).toBe("result")
	})
})
