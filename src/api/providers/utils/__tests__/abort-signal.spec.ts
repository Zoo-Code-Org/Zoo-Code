import { mergeAbortSignalAndTimeout, mergeAbortSignals } from "../abort-signal"

describe("abort-signal utilities", () => {
	describe("mergeAbortSignalAndTimeout", () => {
		it("returns undefined when no signal or positive timeout is provided", () => {
			expect(mergeAbortSignalAndTimeout(undefined, 0)).toBeUndefined()
			expect(mergeAbortSignalAndTimeout(undefined, -1)).toBeUndefined()
			expect(mergeAbortSignalAndTimeout(undefined, NaN)).toBeUndefined()
			expect(mergeAbortSignalAndTimeout()).toBeUndefined()
		})

		it("forwards external signal directly when timeout is disabled", () => {
			const controller = new AbortController()

			expect(mergeAbortSignalAndTimeout(controller.signal, -1)).toBe(controller.signal)
			expect(mergeAbortSignalAndTimeout(controller.signal, NaN)).toBe(controller.signal)
			expect(mergeAbortSignalAndTimeout(controller.signal)).toBe(controller.signal)
		})

		it("creates a self-managed timeout signal when only positive timeout is provided", async () => {
			const result = mergeAbortSignalAndTimeout(undefined, 50)

			expect(result).toBeInstanceOf(AbortSignal)
			expect(result?.aborted).toBe(false)

			await vi.waitFor(() => expect(result?.aborted).toBe(true))
		})

		it("merges external signal and timeout signal", () => {
			const controller = new AbortController()

			const result = mergeAbortSignalAndTimeout(controller.signal, 100)

			expect(result).toBeInstanceOf(AbortSignal)
			expect(result).not.toBe(controller.signal)
			expect(result?.aborted).toBe(false)

			controller.abort()

			expect(result?.aborted).toBe(true)
		})

		it("aborts via timeout alone when the external signal stays active", async () => {
			const controller = new AbortController()

			const result = mergeAbortSignalAndTimeout(controller.signal, 50)

			expect(result).not.toBe(controller.signal)
			expect(result?.aborted).toBe(false)

			await vi.waitFor(() => expect(result?.aborted).toBe(true))
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

		it("aborts merged signal when primary signal is aborted", () => {
			const primaryController = new AbortController()
			const secondaryController = new AbortController()

			const result = mergeAbortSignals(primaryController.signal, secondaryController.signal)

			expect(result.aborted).toBe(false)

			primaryController.abort()

			expect(result.aborted).toBe(true)
		})

		it("returns an aborted signal when primary is already aborted", () => {
			const primaryController = new AbortController()
			const secondaryController = new AbortController()
			primaryController.abort()

			const result = mergeAbortSignals(primaryController.signal, secondaryController.signal)

			expect(result.aborted).toBe(true)
		})
	})
})
