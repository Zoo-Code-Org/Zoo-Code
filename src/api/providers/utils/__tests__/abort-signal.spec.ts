import {
	createAbortError,
	isRequestAborted,
	mergeAbortSignalAndTimeout,
	mergeAbortSignals,
	rejectOnAbort,
	resolveModelWithAbort,
} from "../abort-signal"
import { withSettleGuard } from "../../../../test-utils/settle-guard"

describe("rejectOnAbort", () => {
	it("resolves with the pending value when it settles before the signal aborts", async () => {
		const controller = new AbortController()

		await expect(
			withSettleGuard(rejectOnAbort(Promise.resolve("done"), controller.signal, "TestProvider")),
		).resolves.toBe("done")
		expect(controller.signal.aborted).toBe(false)
	})

	it("rejects with the provider abort error when the signal aborts first", async () => {
		const controller = new AbortController()
		// Never settles: the race must end purely via the abort.
		const pending = new Promise<never>(() => {})
		const race = rejectOnAbort(pending, controller.signal, "TestProvider")
		controller.abort()

		await expect(withSettleGuard(race)).rejects.toMatchObject({
			name: "AbortError",
			message: "The TestProvider request was aborted",
		})
	})

	it("rejects immediately when the signal is already aborted", async () => {
		const controller = new AbortController()
		controller.abort()
		const pending = new Promise<never>(() => {})

		await expect(withSettleGuard(rejectOnAbort(pending, controller.signal, "TestProvider"))).rejects.toMatchObject({
			name: "AbortError",
			message: "The TestProvider request was aborted",
		})
	})

	it("propagates the pending rejection when the signal stays active", async () => {
		const controller = new AbortController()
		const boom = new Error("lookup failed")

		await expect(
			withSettleGuard(rejectOnAbort(Promise.reject(boom), controller.signal, "TestProvider")),
		).rejects.toBe(boom)
	})

	it("detaches the abort listener once the pending settles", async () => {
		const controller = new AbortController()
		const addSpy = vi.spyOn(controller.signal, "addEventListener")
		const removeSpy = vi.spyOn(controller.signal, "removeEventListener")

		await expect(
			withSettleGuard(rejectOnAbort(Promise.resolve("done"), controller.signal, "TestProvider")),
		).resolves.toBe("done")

		// The settle path must remove the exact listener that was registered, not just any
		// function: removing a different reference would leave the original abort listener
		// attached to the signal. First require the registration to have happened at all,
		// so a missing registration cannot silently degrade to an undefined comparison.
		expect(addSpy).toHaveBeenCalledTimes(1)
		const registeredListener = addSpy.mock.calls[0]?.[1] as EventListener | undefined
		expect(typeof registeredListener).toBe("function")
		expect(removeSpy).toHaveBeenCalledWith("abort", registeredListener)
		addSpy.mockRestore()
		removeSpy.mockRestore()
	})

	it("detaches the abort listener when the pending rejects", async () => {
		const controller = new AbortController()
		const addSpy = vi.spyOn(controller.signal, "addEventListener")
		const removeSpy = vi.spyOn(controller.signal, "removeEventListener")
		const lookupError = new Error("lookup failed")

		await expect(
			withSettleGuard(rejectOnAbort(Promise.reject(lookupError), controller.signal, "TestProvider")),
		).rejects.toBe(lookupError)

		// The settle path must remove the exact listener that was registered, not just any
		// function: removing a different reference would leave the original abort listener
		// attached to the signal. First require the registration to have happened at all,
		// so a missing registration cannot silently degrade to an undefined comparison.
		expect(addSpy).toHaveBeenCalledTimes(1)
		const registeredListener = addSpy.mock.calls[0]?.[1] as EventListener | undefined
		expect(typeof registeredListener).toBe("function")
		expect(removeSpy).toHaveBeenCalledWith("abort", registeredListener)
		addSpy.mockRestore()
		removeSpy.mockRestore()
	})
})

describe("resolveModelWithAbort", () => {
	it("fast-fails with the provider abort error when the signal is already aborted", async () => {
		const controller = new AbortController()
		controller.abort()
		let lookupRan = false

		await expect(
			withSettleGuard(
				resolveModelWithAbort(
					async () => {
						lookupRan = true
						return "model"
					},
					controller.signal,
					"TestProvider",
				),
			),
		).rejects.toMatchObject({
			name: "AbortError",
			message: "The TestProvider request was aborted",
		})
		// The entry guard must run before the lookup starts at all.
		expect(lookupRan).toBe(false)
	})

	it("resolves the model when no abort signal is present", async () => {
		await expect(resolveModelWithAbort(async () => "model", undefined, "TestProvider")).resolves.toBe("model")
	})

	it("propagates a raw resolution failure unchanged when no abort signal is present", async () => {
		const boom = new Error("lookup failed")

		await expect(
			resolveModelWithAbort(
				async () => {
					throw boom
				},
				undefined,
				"TestProvider",
			),
		).rejects.toBe(boom)
	})

	it("rejects with the provider abort error when the signal aborts while resolution is pending", async () => {
		const controller = new AbortController()
		let release: (value: string) => void = () => {}
		const pending = new Promise<string>((resolve) => {
			release = resolve
		})
		const race = withSettleGuard(resolveModelWithAbort(async () => pending, controller.signal, "TestProvider"))

		setTimeout(() => controller.abort(), 10)

		await expect(race).rejects.toMatchObject({
			name: "AbortError",
			message: "The TestProvider request was aborted",
		})
		// A late resolution after the abort won the race must not surface.
		release("late model")
	})

	it("normalizes an abort-flavored resolution failure to the provider abort error", async () => {
		const controller = new AbortController()
		const abortFlavored = new Error("The operation was aborted.")
		abortFlavored.name = "AbortError"

		const error = await resolveModelWithAbort(
			async () => {
				throw abortFlavored
			},
			controller.signal,
			"TestProvider",
		).catch((caught: unknown) => caught)

		expect(error).not.toBe(abortFlavored)
		expect(error).toMatchObject({
			name: "AbortError",
			message: "The TestProvider request was aborted",
		})
	})

	it("propagates non-abort resolution failures unchanged when a signal is present", async () => {
		const controller = new AbortController()
		const boom = new Error("lookup failed")

		await expect(
			withSettleGuard(
				resolveModelWithAbort(
					async () => {
						throw boom
					},
					controller.signal,
					"TestProvider",
				),
			),
		).rejects.toBe(boom)
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

		it("requires an Error instance for the name and message checks", () => {
			// A plain object that merely looks like an abort must not be
			// classified as one: the instanceof guard keeps such failures
			// propagating unchanged so callers can inspect the real shape.
			const fakeAbort = { name: "AbortError", message: "Request was aborted." }
			expect(isRequestAborted(fakeAbort)).toBe(false)
			expect(isRequestAborted(Object.assign(Object.create(null), { name: "APIUserAbortError" }))).toBe(false)
			expect(isRequestAborted("Request was aborted.")).toBe(false)
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
