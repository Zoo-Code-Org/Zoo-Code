import {
	createAbortError,
	isRequestAborted,
	mergeAbortSignalAndTimeout,
	mergeAbortSignals,
	settleOnAbort,
	throwIfAborted,
} from "../abort-signal"

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
			// The exact message is part of the abort contract: callers (Task.ts,
			// provider guards) must be able to recognize this error shape.
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

	describe("settleOnAbort", () => {
		it("returns the pending promise unchanged when the signal is undefined", async () => {
			expect(await settleOnAbort(Promise.resolve(42), undefined, "Test")).toBe(42)
		})

		it("rejects immediately when the signal is already aborted", async () => {
			// A listener registered on an already-aborted signal never fires,
			// so the aborted state must be checked up front; the pending work
			// keeps running (a helper that skipped the check would resolve
			// with the sentinel instead of rejecting).
			const controller = new AbortController()
			controller.abort()
			const pending = new Promise<number>((resolve) => {
				setTimeout(() => resolve(1), 20)
			})

			let caught: unknown
			try {
				await settleOnAbort(pending, controller.signal, "Qwen Code")
			} catch (error) {
				caught = error
			}
			await new Promise((resolve) => setTimeout(resolve, 30)) // let the sentinel arrive

			expect(caught).toBeInstanceOf(Error)
			expect((caught as Error).name).toBe("AbortError")
			expect((caught as Error).message).toBe("The Qwen Code request was aborted")
		})

		it("resolves with the pending value when it settles before the signal aborts", async () => {
			const controller = new AbortController()
			const pending = new Promise<number>((resolve) => {
				setTimeout(() => resolve(7), 10)
			})

			expect(await settleOnAbort(pending, controller.signal, "Test")).toBe(7)
		})

		it("rejects with the abort contract error when the signal aborts before the pending promise settles", async () => {
			const controller = new AbortController()
			let resolvePending!: (value: number) => void
			const pending = new Promise<number>((resolve) => {
				resolvePending = resolve
			})
			const racing = settleOnAbort(pending, controller.signal, "LM Studio")
			controller.abort()

			let caught: unknown
			try {
				await racing
			} catch (error) {
				caught = error
			}
			resolvePending(1) // the underlying work still settles; it must not leak a rejection

			expect(caught).toBeInstanceOf(Error)
			expect((caught as Error).name).toBe("AbortError")
			expect((caught as Error).message).toBe("The LM Studio request was aborted")
		})

		it("removes the abort listener once the pending promise settles", async () => {
			const controller = new AbortController()
			const addSpy = vi.spyOn(controller.signal, "addEventListener")
			const removeSpy = vi.spyOn(controller.signal, "removeEventListener")

			expect(await settleOnAbort(Promise.resolve("done"), controller.signal, "Test")).toBe("done")

			expect(addSpy).toHaveBeenCalledWith("abort", expect.any(Function))
			expect(removeSpy).toHaveBeenCalledTimes(1)
			expect(removeSpy).toHaveBeenCalledWith("abort", expect.any(Function))
		})

		it("removes the abort listener when the pending promise settles after an abort", async () => {
			const controller = new AbortController()
			let resolvePending!: (value: number) => void
			const pending = new Promise<number>((resolve) => {
				resolvePending = resolve
			})
			const addSpy = vi.spyOn(controller.signal, "addEventListener")
			const removeSpy = vi.spyOn(controller.signal, "removeEventListener")
			const racing = settleOnAbort(pending, controller.signal, "Test")
			controller.abort()

			let caught: unknown
			try {
				await racing
			} catch (error) {
				caught = error
			}
			resolvePending(1) // settles the underlying work, which triggers the cleanup
			await Promise.resolve()

			expect(caught).toBeInstanceOf(Error)
			expect((caught as Error).name).toBe("AbortError")
			expect(addSpy).toHaveBeenCalledWith("abort", expect.any(Function))
			expect(removeSpy).toHaveBeenCalledTimes(1)
		})

		it("propagates a pending promise rejection unchanged and detaches the abort listener", async () => {
			const controller = new AbortController()
			const addSpy = vi.spyOn(controller.signal, "addEventListener")
			const removeSpy = vi.spyOn(controller.signal, "removeEventListener")
			const failure = new Error("count failed")

			let caught: unknown
			try {
				await settleOnAbort(Promise.reject(failure), controller.signal, "Test")
			} catch (error) {
				caught = error
			}

			expect(caught).toBe(failure)
			// The rejection path must detach the listener too: a leaked listener
			// would keep this helper's closure alive for the life of the signal.
			expect(addSpy).toHaveBeenCalledWith("abort", expect.any(Function))
			expect(removeSpy).toHaveBeenCalledTimes(1)
			expect(removeSpy).toHaveBeenCalledWith("abort", expect.any(Function))
		})
	})
})
