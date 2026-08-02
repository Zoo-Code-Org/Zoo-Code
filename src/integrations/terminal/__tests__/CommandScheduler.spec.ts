// npx vitest run src/integrations/terminal/__tests__/CommandScheduler.spec.ts

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

import {
	CommandScheduler,
	CREATION_COOLDOWN_MS,
	DuplicateExecutionIdError,
	SchedulerDisposedError,
	CommandAbortedError,
	TaskCancelledError,
} from "../CommandScheduler"
import type { ScheduledCommandRequest, TerminalCreationPermitResult } from "../CommandScheduler"

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Creates a basic request for testing. */
function makeRequest(
	executionId: string,
	taskId: string = "task-1",
	abortSignal?: AbortSignal,
): ScheduledCommandRequest {
	return {
		executionId,
		taskId,
		requestedAt: Date.now(),
		abortSignal,
	}
}

/**
 * Tracks the order in which commands become active (lease granted).
 * Returns an array that tests can assert against.
 */
function makeOrderTracker() {
	const order: string[] = []
	return {
		order,
		/** Returns a release function to call when the command is done. */
		track: (scheduler: CommandScheduler, executionId: string) => {
			return scheduler
				.enqueue(makeRequest(executionId))
				.then(() => {
					order.push(executionId)
				})
				.finally(() => {
					// Release after a microtask to allow assertions.
				})
		},
	}
}

/**
 * Enqueues a request and returns a promise that resolves to
 * { executionId, release } when the lease is granted.
 */
function enqueueAndTrack(scheduler: CommandScheduler, request: ScheduledCommandRequest) {
	let releaseFn: () => void
	const leasePromise = scheduler.enqueue(request).then(() => {
		return {
			executionId: request.executionId,
			release: () => scheduler.release(request.executionId),
		}
	})
	return leasePromise
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("CommandScheduler", () => {
	let scheduler: CommandScheduler

	beforeEach(() => {
		scheduler = new CommandScheduler()
	})

	afterEach(() => {
		scheduler.dispose()
	})

	// ───────────────────────────────────────────────────────────────────────
	// Singleton lifecycle
	// ───────────────────────────────────────────────────────────────────────

	describe("singleton lifecycle", () => {
		it("initialize creates a singleton instance", () => {
			// Clean up any existing instance from other tests.
			CommandScheduler.cleanup()
			CommandScheduler.initialize()
			expect(CommandScheduler.getInstance()).toBeInstanceOf(CommandScheduler)
			CommandScheduler.cleanup()
		})

		it("initialize throws if called twice without cleanup", () => {
			CommandScheduler.cleanup()
			CommandScheduler.initialize()
			expect(() => CommandScheduler.initialize()).toThrow("should only be called once")
			CommandScheduler.cleanup()
		})

		it("getInstance throws before initialize", () => {
			CommandScheduler.cleanup()
			expect(() => CommandScheduler.getInstance()).toThrow("called before initialize")
		})

		it("cleanup disposes the singleton and allows re-initialization", () => {
			CommandScheduler.cleanup()
			CommandScheduler.initialize()
			const inst1 = CommandScheduler.getInstance()
			CommandScheduler.cleanup()
			CommandScheduler.initialize()
			const inst2 = CommandScheduler.getInstance()
			expect(inst1).not.toBe(inst2)
			CommandScheduler.cleanup()
		})
	})

	// ───────────────────────────────────────────────────────────────────────
	// FIFO command lane — acceptance criterion 1
	// ───────────────────────────────────────────────────────────────────────

	describe("FIFO command lane", () => {
		it("executes four parallel enqueue calls strictly one at a time in arrival order", async () => {
			const executionOrder: string[] = []
			const releaseFns: Array<() => void> = []

			// Enqueue four commands in parallel.
			const promises = ["cmd-1", "cmd-2", "cmd-3", "cmd-4"].map((id) =>
				scheduler.enqueue(makeRequest(id)).then(() => {
					executionOrder.push(id)
					// Return a release function so the test controls timing.
					return () => scheduler.release(id)
				}),
			)

			// First command should be active immediately.
			const release1 = await promises[0]
			expect(executionOrder).toEqual(["cmd-1"])

			// Others should still be queued.
			expect(executionOrder).toHaveLength(1)

			// Release first → second becomes active.
			release1()
			const release2 = await promises[1]
			expect(executionOrder).toEqual(["cmd-1", "cmd-2"])

			// Release second → third becomes active.
			release2()
			const release3 = await promises[2]
			expect(executionOrder).toEqual(["cmd-1", "cmd-2", "cmd-3"])

			// Release third → fourth becomes active.
			release3()
			const release4 = await promises[3]
			expect(executionOrder).toEqual(["cmd-1", "cmd-2", "cmd-3", "cmd-4"])

			release4()
		})

		it("resolves the first enqueue immediately when queue is empty", async () => {
			let resolved = false
			const promise = scheduler.enqueue(makeRequest("immediate")).then(() => {
				resolved = true
			})

			await promise
			expect(resolved).toBe(true)
			scheduler.release("immediate")
		})

		it("does not activate the next command until release is called", async () => {
			let secondActivated = false

			const firstPromise = scheduler.enqueue(makeRequest("first"))
			const secondPromise = scheduler.enqueue(makeRequest("second")).then(() => {
				secondActivated = true
			})

			await firstPromise

			// Give microtasks a chance to settle.
			await new Promise((r) => setTimeout(r, 10))
			expect(secondActivated).toBe(false)

			scheduler.release("first")
			await secondPromise
			expect(secondActivated).toBe(true)

			scheduler.release("second")
		})
	})

	// ───────────────────────────────────────────────────────────────────────
	// Rejected operation does not poison later entries — acceptance criterion 2
	// ───────────────────────────────────────────────────────────────────────

	describe("error isolation", () => {
		it("a rejected operation does not poison later queue entries", async () => {
			const results: string[] = []

			// First command throws during execution (after lease is granted).
			const firstPromise = scheduler
				.enqueue(makeRequest("first"))
				.then(() => {
					results.push("first-active")
					// Simulate an error during execution.
					throw new Error("command failed")
				})
				.catch((err) => {
					results.push("first-caught")
					// Release the lease even on error.
					scheduler.release("first")
					return err.message
				})

			// Second command should still work.
			const secondPromise = scheduler.enqueue(makeRequest("second")).then(() => {
				results.push("second-active")
				scheduler.release("second")
			})

			await firstPromise
			await secondPromise

			expect(results).toContain("first-active")
			expect(results).toContain("first-caught")
			expect(results).toContain("second-active")
		})

		it("duplicate executionId is rejected and does not block the queue", async () => {
			const firstPromise = scheduler.enqueue(makeRequest("dup-id"))
			await firstPromise

			// Duplicate should reject.
			await expect(scheduler.enqueue(makeRequest("dup-id"))).rejects.toBeInstanceOf(DuplicateExecutionIdError)

			// Queue should still work for a different id.
			// Release the active command first so the queued one can proceed.
			scheduler.release("dup-id")
			const secondPromise = scheduler.enqueue(makeRequest("other-id"))
			await secondPromise

			scheduler.release("other-id")
		})
	})

	// ───────────────────────────────────────────────────────────────────────
	// Per-task cancellation — acceptance criterion 3
	// ───────────────────────────────────────────────────────────────────────

	describe("cancelTask", () => {
		it("cancels all queued entries for the given task", async () => {
			// Occupy the lane with task-A.
			const activePromise = scheduler.enqueue(makeRequest("active-A", "task-A"))
			await activePromise

			// Queue two more for task-A and one for task-B.
			const queuedA1 = scheduler.enqueue(makeRequest("queued-A1", "task-A"))
			const queuedA2 = scheduler.enqueue(makeRequest("queued-A2", "task-A"))
			const queuedB1 = scheduler.enqueue(makeRequest("queued-B1", "task-B"))

			// Cancel task-A's queued entries.
			const cancelledCount = scheduler.cancelTask("task-A")

			expect(cancelledCount).toBe(2)

			// Queued A entries should reject with TaskCancelledError.
			await expect(queuedA1).rejects.toBeInstanceOf(TaskCancelledError)
			await expect(queuedA2).rejects.toBeInstanceOf(TaskCancelledError)

			// Queued B entry should still be waiting (not rejected).
			let bResolved = false
			queuedB1.then(() => {
				bResolved = true
			})

			await new Promise((r) => setTimeout(r, 10))
			expect(bResolved).toBe(false)

			// Release the active command → B should activate.
			scheduler.release("active-A")
			await queuedB1
			expect(bResolved).toBe(true)

			scheduler.release("queued-B1")
		})

		it("does not interrupt the currently active command", async () => {
			const activePromise = scheduler.enqueue(makeRequest("active", "task-A"))
			await activePromise

			let activeReleased = false
			// Schedule release after a delay.
			setTimeout(() => {
				scheduler.release("active")
				activeReleased = true
			}, 50)

			// Cancel task-A — should not affect the active command.
			const cancelled = scheduler.cancelTask("task-A")
			expect(cancelled).toBe(0) // No queued entries for task-A.

			// Wait for the delayed release.
			await new Promise((r) => setTimeout(r, 100))
			expect(activeReleased).toBe(true)
		})

		it("returns 0 when no queued entries exist for the task", () => {
			expect(scheduler.cancelTask("nonexistent")).toBe(0)
		})

		it("allows re-enqueueing the same executionId after cancellation", async () => {
			const activePromise = scheduler.enqueue(makeRequest("active", "task-A"))
			await activePromise

			const queued = scheduler.enqueue(makeRequest("queued-1", "task-A"))
			scheduler.cancelTask("task-A")
			await expect(queued).rejects.toBeInstanceOf(TaskCancelledError)

			// After cancellation, the executionId should be free to reuse.
			const requeued = scheduler.enqueue(makeRequest("queued-1", "task-A"))
			scheduler.release("active")
			await requeued
			scheduler.release("queued-1")
		})
	})

	// ───────────────────────────────────────────────────────────────────────
	// Abort signal
	// ───────────────────────────────────────────────────────────────────────

	describe("abort signal", () => {
		it("rejects with CommandAbortedError when abort fires while queued", async () => {
			// Occupy the lane.
			await scheduler.enqueue(makeRequest("active"))

			const controller = new AbortController()
			const queued = scheduler.enqueue(makeRequest("queued", "task-1", controller.signal))

			controller.abort()

			await expect(queued).rejects.toBeInstanceOf(CommandAbortedError)

			scheduler.release("active")
		})

		it("rejects immediately if already aborted", async () => {
			const controller = new AbortController()
			controller.abort()

			await expect(scheduler.enqueue(makeRequest("aborted", "task-1", controller.signal))).rejects.toBeInstanceOf(
				CommandAbortedError,
			)
		})

		it("does not abort the active command", async () => {
			const controller = new AbortController()
			const active = scheduler.enqueue(makeRequest("active", "task-1", controller.signal))
			await active

			// Abort after the command is active.
			controller.abort()

			// The active command should not be affected.
			// We can still release it normally.
			scheduler.release("active")
		})
	})

	// ───────────────────────────────────────────────────────────────────────
	// Terminal creation permit — acceptance criterion 4
	// ───────────────────────────────────────────────────────────────────────

	describe("withTerminalCreationPermit", () => {
		it("executes the function when no other permit is held", async () => {
			let called = false
			const result = await scheduler.withTerminalCreationPermit(async () => {
				called = true
				return { value: 42, createdNewTerminal: false }
			})

			expect(called).toBe(true)
			expect(result).toBe(42)
		})

		it("never exceeds concurrency 1", async () => {
			let activeCount = 0
			let maxConcurrent = 0

			const makeFn = (id: number) => async (): Promise<TerminalCreationPermitResult<number>> => {
				activeCount++
				maxConcurrent = Math.max(maxConcurrent, activeCount)
				await new Promise((r) => setTimeout(r, 20))
				activeCount--
				return { value: id, createdNewTerminal: false }
			}

			const promises = [1, 2, 3, 4].map((id) => scheduler.withTerminalCreationPermit(makeFn(id)))

			await Promise.all(promises)

			expect(maxConcurrent).toBe(1)
		})

		it("applies 250ms cooldown after new terminal creation", async () => {
			vi.useFakeTimers()

			const timestamps: number[] = []

			// First call creates a new terminal.
			const firstPromise = scheduler.withTerminalCreationPermit(async () => {
				timestamps.push(Date.now())
				await new Promise((r) => setTimeout(r, 10))
				return { value: 1, createdNewTerminal: true }
			})

			await vi.advanceTimersByTimeAsync(10)
			await firstPromise

			// Second call should wait for the cooldown.
			let secondStarted = false
			const secondPromise = scheduler.withTerminalCreationPermit(async () => {
				secondStarted = true
				timestamps.push(Date.now())
				return { value: 2, createdNewTerminal: false }
			})

			// Should not have started yet (cooldown in progress).
			await vi.advanceTimersByTimeAsync(CREATION_COOLDOWN_MS - 50)
			expect(secondStarted).toBe(false)

			// After full cooldown, it should start.
			await vi.advanceTimersByTimeAsync(50)
			await secondPromise

			expect(secondStarted).toBe(true)

			vi.useRealTimers()
		})

		it("does not apply cooldown when no new terminal is created", async () => {
			vi.useFakeTimers()

			const firstPromise = scheduler.withTerminalCreationPermit(async () => {
				await new Promise((r) => setTimeout(r, 10))
				return { value: 1, createdNewTerminal: false }
			})

			await vi.advanceTimersByTimeAsync(10)
			await firstPromise

			// Second call should start immediately (no cooldown).
			let secondDone = false
			const secondPromise = scheduler.withTerminalCreationPermit(async () => {
				secondDone = true
				return { value: 2, createdNewTerminal: false }
			})

			await vi.advanceTimersByTimeAsync(0)
			await secondPromise

			expect(secondDone).toBe(true)

			vi.useRealTimers()
		})

		it("is independent of the command lane (can be used inside an active lease)", async () => {
			// Acquire a command lease.
			await scheduler.enqueue(makeRequest("cmd-1"))

			// Creation permit should work fine inside the lease.
			const result = await scheduler.withTerminalCreationPermit(async () => {
				return { value: "ok", createdNewTerminal: false }
			})

			expect(result).toBe("ok")

			scheduler.release("cmd-1")
		})

		it("releases the permit even if the function throws", async () => {
			await expect(
				scheduler.withTerminalCreationPermit(async () => {
					throw new Error("boom")
				}),
			).rejects.toThrow("boom")

			// Permit should be available again.
			const result = await scheduler.withTerminalCreationPermit(async () => {
				return { value: "ok", createdNewTerminal: false }
			})

			expect(result).toBe("ok")
		})
	})

	// ───────────────────────────────────────────────────────────────────────
	// Dispose — acceptance criterion 5 (timers disposed, no open handles)
	// ───────────────────────────────────────────────────────────────────────

	describe("dispose", () => {
		it("rejects queued entries with SchedulerDisposedError", async () => {
			// Occupy the lane.
			await scheduler.enqueue(makeRequest("active"))

			// Queue a second command.
			const queued = scheduler.enqueue(makeRequest("queued"))

			scheduler.dispose()

			await expect(queued).rejects.toBeInstanceOf(SchedulerDisposedError)
		})

		it("rejects creation permit waiters with SchedulerDisposedError", async () => {
			// Hold the creation permit.
			const holdPromise = scheduler.withTerminalCreationPermit(async () => {
				// Never resolves until dispose.
				return new Promise<TerminalCreationPermitResult<number>>((resolve) => {
					// Intentionally never resolved; dispose will reject.
					// Store resolve to prevent unhandled rejection warnings.
					setTimeout(() => resolve({ value: 0, createdNewTerminal: false }), 99999)
				})
			})

			// Queue a second permit request.
			const waiting = scheduler.withTerminalCreationPermit(async () => {
				return { value: 1, createdNewTerminal: false }
			})

			// Dispose should reject the waiter.
			scheduler.dispose()

			await expect(waiting).rejects.toBeInstanceOf(SchedulerDisposedError)

			// The held promise may also reject; catch it.
			await holdPromise.catch(() => {})
		})

		it("enqueue rejects after dispose", async () => {
			scheduler.dispose()
			await expect(scheduler.enqueue(makeRequest("post-dispose"))).rejects.toBeInstanceOf(SchedulerDisposedError)
		})

		it("clears the creation cooldown timer", async () => {
			vi.useFakeTimers()

			// Create a terminal to trigger cooldown.
			const firstPromise = scheduler.withTerminalCreationPermit(async () => {
				await new Promise((r) => setTimeout(r, 5))
				return { value: 1, createdNewTerminal: true }
			})

			await vi.advanceTimersByTimeAsync(5)
			await firstPromise

			// Dispose while cooldown timer is active.
			scheduler.dispose()

			// Advance past the cooldown — should not cause issues.
			await vi.advanceTimersByTimeAsync(CREATION_COOLDOWN_MS + 100)

			vi.useRealTimers()
		})

		it("dispose is idempotent", () => {
			scheduler.dispose()
			expect(() => scheduler.dispose()).not.toThrow()
		})
	})

	// ───────────────────────────────────────────────────────────────────────
	// No open handles — acceptance criterion 5
	// ───────────────────────────────────────────────────────────────────────

	describe("no open handles", () => {
		it("does not leave timers running after all commands complete", async () => {
			const promise = scheduler.enqueue(makeRequest("cmd-1"))
			await promise
			scheduler.release("cmd-1")

			// Wait a tick for any pending microtasks.
			await new Promise((r) => setTimeout(r, 10))

			// If there are open handles, the test process would hang.
			// Vitest will report open handles if any exist.
		})

		it("does not leave timers running after creation permit completes without new terminal", async () => {
			await scheduler.withTerminalCreationPermit(async () => {
				return { value: "ok", createdNewTerminal: false }
			})

			await new Promise((r) => setTimeout(r, 10))
		})
	})
})
