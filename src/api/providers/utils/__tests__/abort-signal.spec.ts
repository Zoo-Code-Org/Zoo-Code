import {
	createAbortError,
	isRequestAborted,
	mergeAbortSignalAndTimeout,
	mergeAbortSignals,
	rejectOnAbort,
	throwIfAborted,
} from "../abort-signal"
import { settlesWithin } from "../../../../test-utils/promise"

const SETTLE_MS = 200

describe("rejectOnAbort", () => {
	it("resolves with the pending value when it settles before the signal aborts", async () => {
		const controller = new AbortController()

		await expect(
			settlesWithin(rejectOnAbort(Promise.resolve("done"), controller.signal, "TestProvider"), SETTLE_MS),
		).resolves.toBe("done")
		expect(controller.signal.aborted).toBe(false)
	})

	it("rejects with the provider abort error when the signal aborts first", async () => {
		const controller = new AbortController()
		// Never settles: the race must end purely via the abort.
		const pending = new Promise<never>(() => {})
		const race = rejectOnAbort(pending, controller.signal, "TestProvider")
		controller.abort()

		await expect(settlesWithin(race, SETTLE_MS)).rejects.toMatchObject({
			name: "AbortError",
			message: "The TestProvider request was aborted",
		})
	})

	it("rejects immediately when the signal is already aborted", async () => {
		const controller = new AbortController()
		controller.abort()
		const pending = new Promise<never>(() => {})

		await expect(
			settlesWithin(rejectOnAbort(pending, controller.signal, "TestProvider"), SETTLE_MS),
		).rejects.toMatchObject({
			name: "AbortError",
		})
	})

	it("propagates the pending rejection when the signal stays active", async () => {
		const controller = new AbortController()
		const boom = new Error("lookup failed")

		await expect(
			settlesWithin(rejectOnAbort(Promise.reject(boom), controller.signal, "TestProvider"), SETTLE_MS),
		).rejects.toBe(boom)
	})

	it("detaches the exact abort listener it registered once the pending settles", async () => {
		const controller = new AbortController()
		const addSpy = vi.spyOn(controller.signal, "addEventListener")
		const removeSpy = vi.spyOn(controller.signal, "removeEventListener")

		await expect(
			settlesWithin(rejectOnAbort(Promise.resolve("done"), controller.signal, "TestProvider"), SETTLE_MS),
		).resolves.toBe("done")

		const registeredListener = addSpy.mock.calls[0]?.[1]
		expect(registeredListener).toBeTypeOf("function")
		expect(removeSpy).toHaveBeenCalledWith("abort", registeredListener)
		addSpy.mockRestore()
		removeSpy.mockRestore()
	})

	it("detaches the exact abort listener it registered when the pending rejects", async () => {
		const controller = new AbortController()
		const addSpy = vi.spyOn(controller.signal, "addEventListener")
		const removeSpy = vi.spyOn(controller.signal, "removeEventListener")
		const lookupError = new Error("lookup failed")

		await expect(
			settlesWithin(rejectOnAbort(Promise.reject(lookupError), controller.signal, "TestProvider"), SETTLE_MS),
		).rejects.toBe(lookupError)

		const registeredListener = addSpy.mock.calls[0]?.[1]
		expect(registeredListener).toBeTypeOf("function")
		expect(removeSpy).toHaveBeenCalledWith("abort", registeredListener)
		addSpy.mockRestore()
		removeSpy.mockRestore()
	})

	it("registers the abort listener with { once: true }", async () => {
		const controller = new AbortController()
		const addSpy = vi.spyOn(controller.signal, "addEventListener")
		// Never settles: the race must end purely via the abort.
		const pending = new Promise<never>(() => {})
		const race = rejectOnAbort(pending, controller.signal, "TestProvider")
		controller.abort()

		await expect(settlesWithin(race, SETTLE_MS)).rejects.toMatchObject({ name: "AbortError" })
		const registeredListener = addSpy.mock.calls[0]?.[1]
		expect(registeredListener).toBeTypeOf("function")
		expect(addSpy).toHaveBeenCalledWith("abort", registeredListener, { once: true })
		addSpy.mockRestore()
	})
})

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

	describe("throwIfAborted", () => {
		it("does not throw when signal is undefined", () => {
			expect(() => throwIfAborted()).not.toThrow()
		})

		it("does not throw when signal is not aborted", () => {
			const controller = new AbortController()

			expect(() => throwIfAborted(controller.signal)).not.toThrow()
		})

		it("throws an AbortError when signal is already aborted", () => {
			const controller = new AbortController()
			controller.abort()

			let caught: unknown
			try {
				throwIfAborted(controller.signal)
			} catch (error) {
				caught = error
			}

			expect(caught).toBeInstanceOf(Error)
			expect((caught as Error).name).toBe("AbortError")
			expect((caught as Error).message).toBe("This operation was aborted")
		})
	})

	describe("isRequestAborted", () => {
		it("returns true when the caller signal is aborted", () => {
			const controller = new AbortController()
			controller.abort()

			expect(isRequestAborted(new Error("boom"), controller.signal)).toBe(true)
			expect(isRequestAborted(undefined, controller.signal)).toBe(true)
		})

		it("returns true for a native AbortError or the OpenAI SDK APIUserAbortError", () => {
			const native = new Error("This operation was aborted")
			native.name = "AbortError"
			expect(isRequestAborted(native)).toBe(true)

			const sdk = new Error("whatever")
			sdk.name = "APIUserAbortError"
			expect(isRequestAborted(sdk)).toBe(true)
		})

		it("matches the OpenAI SDK abort message exactly, not as a substring", () => {
			expect(isRequestAborted(new Error("Request was aborted."))).toBe(true)
			expect(isRequestAborted(new Error("Request was aborted"))).toBe(false)
			expect(isRequestAborted(new Error("Request was aborted. Please retry"))).toBe(false)
		})

		it("returns false for unrelated errors, nullish errors, and live signals", () => {
			expect(isRequestAborted(new Error("the abort failed"))).toBe(false)
			expect(isRequestAborted(undefined)).toBe(false)
			expect(isRequestAborted(null)).toBe(false)

			const controller = new AbortController()
			expect(isRequestAborted(new Error("boom"), controller.signal)).toBe(false)
		})
	})

	describe("createAbortError", () => {
		it("builds an error satisfying the Task.ts abort contract", () => {
			const error = createAbortError("LM Studio")

			expect(error).toBeInstanceOf(Error)
			expect(error.name).toBe("AbortError")
			expect(error.message).toBe("The LM Studio request was aborted")
		})

		it("interpolates the provider name", () => {
			expect(createAbortError("Qwen Code").message).toBe("The Qwen Code request was aborted")
		})

		it("returns a fresh error on each call", () => {
			expect(createAbortError("X")).not.toBe(createAbortError("X"))
		})
	})
})
