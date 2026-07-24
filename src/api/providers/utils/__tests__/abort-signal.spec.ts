import { mergeAbortSignalAndTimeout, mergeAbortSignals } from "../abort-signal"

describe("abort-signal utilities", () => {
	describe("mergeAbortSignalAndTimeout", () => {
		afterEach(() => {
			vi.useRealTimers()
		})

		it("returns no signal and noop cleanup when no signal or positive timeout is provided", () => {
			const result = mergeAbortSignalAndTimeout(undefined, 0)

			expect(result.signal).toBeUndefined()
			expect(() => result.cleanup()).not.toThrow()
		})

		it("forwards external signal directly when timeout is disabled", () => {
			const controller = new AbortController()

			const result = mergeAbortSignalAndTimeout(controller.signal, -1)

			expect(result.signal).toBe(controller.signal)
			expect(() => result.cleanup()).not.toThrow()
		})

		it("creates a timeout signal when only positive timeout is provided", async () => {
			vi.useFakeTimers()

			const result = mergeAbortSignalAndTimeout(undefined, 100)

			expect(result.signal).toBeInstanceOf(AbortSignal)
			expect(result.signal?.aborted).toBe(false)

			await vi.advanceTimersByTimeAsync(100)

			expect(result.signal?.aborted).toBe(true)
		})

		it("merges external signal and timeout signal", async () => {
			vi.useFakeTimers()
			const controller = new AbortController()

			const result = mergeAbortSignalAndTimeout(controller.signal, 100)

			expect(result.signal).toBeInstanceOf(AbortSignal)
			expect(result.signal).not.toBe(controller.signal)
			expect(result.signal?.aborted).toBe(false)

			controller.abort()

			expect(result.signal?.aborted).toBe(true)

			await vi.advanceTimersByTimeAsync(100)
			expect(result.signal?.aborted).toBe(true)
		})

		it("clears timeout during cleanup", async () => {
			vi.useFakeTimers()

			const result = mergeAbortSignalAndTimeout(undefined, 100)
			result.cleanup()

			await vi.advanceTimersByTimeAsync(100)

			expect(result.signal?.aborted).toBe(false)
			expect(vi.getTimerCount()).toBe(0)
		})
	})

	describe("mergeAbortSignals", () => {
		it("returns primary signal directly when secondary signal is absent", () => {
			const controller = new AbortController()

			const result = mergeAbortSignals(controller.signal)

			expect(result).toBe(controller.signal)
		})

		it("returns a merged signal when secondary signal is present", () => {
			const primaryController = new AbortController()
			const secondaryController = new AbortController()

			const result = mergeAbortSignals(primaryController.signal, secondaryController.signal)

			expect(result).not.toBe(primaryController.signal)
			expect(result).not.toBe(secondaryController.signal)
			expect(result.aborted).toBe(false)

			secondaryController.abort()

			expect(result.aborted).toBe(true)
		})
	})
})
