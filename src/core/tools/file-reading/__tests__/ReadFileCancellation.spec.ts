import { ReadFileCancellation } from "../ReadFileCancellation"
import { ReadFileCancelledError } from "../ReadFileCancelledError"

describe("ReadFileCancellation", () => {
	it.each([
		{ abort: false, abandoned: false, cancelled: false },
		{ abort: true, abandoned: false, cancelled: true },
		{ abort: false, abandoned: true, cancelled: true },
		{ abort: true, abandoned: true, cancelled: true },
	])("observes abort=$abort and abandoned=$abandoned without changing them", ({ abort, abandoned, cancelled }) => {
		const task = { abort, abandoned }
		const cancellation = new ReadFileCancellation(task)

		expect(cancellation.isCancelled()).toBe(cancelled)
		if (cancelled) {
			expect(() => cancellation.throwIfCancelled()).toThrow(ReadFileCancelledError)
		} else {
			expect(() => cancellation.throwIfCancelled()).not.toThrow()
		}
		expect(task).toEqual({ abort, abandoned })
	})

	it.each(["abort", "abandoned"] as const)(
		"observes later changes to %s rather than capturing a snapshot",
		(flag) => {
			const task = { abort: false, abandoned: false }
			const cancellation = new ReadFileCancellation(task)

			expect(cancellation.isCancelled()).toBe(false)
			task[flag] = true
			expect(cancellation.isCancelled()).toBe(true)
			expect(() => cancellation.throwIfCancelled()).toThrow("File read cancelled")
			task[flag] = false
			expect(cancellation.isCancelled()).toBe(false)
			expect(() => cancellation.throwIfCancelled()).not.toThrow()
		},
	)

	describe("checked async operations", () => {
		it("returns a successful result without changing task flags", async () => {
			const task = { abort: false, abandoned: false }
			const cancellation = new ReadFileCancellation(task)
			const result = { fullPath: "/workspace/file.txt" }
			const operation = vi.fn(async () => result)

			await expect(cancellation.run(operation)).resolves.toBe(result)
			expect(operation).toHaveBeenCalledOnce()
			expect(task).toEqual({ abort: false, abandoned: false })
		})

		it.each(["abort", "abandoned"] as const)("does not start an operation when %s is already set", async (flag) => {
			const task = { abort: false, abandoned: false }
			task[flag] = true
			const operation = vi.fn(async () => "unexpected content")

			await expect(new ReadFileCancellation(task).run(operation)).rejects.toBeInstanceOf(ReadFileCancelledError)
			expect(operation).not.toHaveBeenCalled()
		})

		it.each(["abort", "abandoned"] as const)(
			"discards a result when %s changes during the operation",
			async (flag) => {
				const task = { abort: false, abandoned: false }
				const cancellation = new ReadFileCancellation(task)

				await expect(
					cancellation.run(async () => {
						task[flag] = true
						return "late content"
					}),
				).rejects.toBeInstanceOf(ReadFileCancelledError)
			},
		)

		it.each(["abort", "abandoned"] as const)(
			"prioritizes cancellation over a late rejection after %s",
			async (flag) => {
				const task = { abort: false, abandoned: false }
				const cancellation = new ReadFileCancellation(task)
				const filesystemError = Object.assign(new Error("late filesystem failure"), { code: "ENOENT" })

				await expect(
					cancellation.run(async () => {
						task[flag] = true
						throw filesystemError
					}),
				).rejects.toBeInstanceOf(ReadFileCancelledError)
			},
		)

		it("preserves the original cancellation error and stack without checking cancellation again", async () => {
			const task = { abort: false, abandoned: false }
			const cancellation = new ReadFileCancellation(task)
			const error = new ReadFileCancelledError()
			const originalStack = error.stack
			const check = vi.spyOn(cancellation, "throwIfCancelled")

			await expect(
				cancellation.run(async () => {
					task.abort = true
					throw error
				}),
			).rejects.toBe(error)
			expect(error.stack).toBe(originalStack)
			expect(check).toHaveBeenCalledOnce()
		})

		it.each([new Error("filesystem failure"), "non-Error failure"])(
			"preserves an unrelated rejection when the task is active: %s",
			async (error) => {
				const cancellation = new ReadFileCancellation({ abort: false, abandoned: false })

				await expect(
					cancellation.run(async () => {
						throw error
					}),
				).rejects.toBe(error)
			},
		)

		it("handles synchronous operation failures without replacing the original error", async () => {
			const cancellation = new ReadFileCancellation({ abort: false, abandoned: false })
			const error = new Error("synchronous operation failure")

			await expect(
				cancellation.run(() => {
					throw error
				}),
			).rejects.toBe(error)
		})
	})
})
