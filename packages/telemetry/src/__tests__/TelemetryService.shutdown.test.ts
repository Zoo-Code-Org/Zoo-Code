// pnpm --filter @roo-code/telemetry test src/__tests__/TelemetryService.shutdown.test.ts

import { TelemetryEventName, type TelemetryClient } from "@roo-code/types"

import { TelemetryService } from "../TelemetryService"

describe("TelemetryService.shutdown draining", () => {
	it("awaits in-flight captureEvent calls before shutting down clients", async () => {
		let resolveCapture!: () => void
		const capturePromise = new Promise<void>((resolve) => {
			resolveCapture = resolve
		})

		const captureOrder: string[] = []

		const mockClient: TelemetryClient = {
			setProvider: vi.fn(),
			capture: vi.fn().mockImplementation(async () => {
				await capturePromise
				captureOrder.push("captured")
			}),
			captureException: vi.fn(),
			updateTelemetryState: vi.fn(),
			isTelemetryEnabled: vi.fn().mockReturnValue(true),
			shutdown: vi.fn().mockImplementation(async () => {
				captureOrder.push("shutdown")
			}),
		}

		const service = new TelemetryService([mockClient])

		// Fire a capture whose underlying client.capture() promise hasn't resolved yet.
		service.captureEvent(TelemetryEventName.TASK_CREATED, { taskId: "abc" })

		const shutdownPromise = service.shutdown()

		// Capture is still pending - shutdown must not have run yet.
		expect(captureOrder).toEqual([])

		resolveCapture()
		await shutdownPromise

		// The in-flight capture must complete before the client is shut down.
		expect(captureOrder).toEqual(["captured", "shutdown"])
	})

	it("drains a call already queued before shutdown() started, even across multiple drain passes", async () => {
		// Regression test: shutdown() must not take a single Promise.all snapshot of
		// pendingClientCalls. A promise added to pendingClientCalls *after* Promise.all(set)
		// has already been called is never awaited by that call, even if it never resolves
		// -- Promise.all takes its list of promises to await synchronously, at call time. So a
		// capture that was already in flight (tracked in pendingClientCalls) when shutdown()
		// took its first Promise.all snapshot, but whose *own* async chain enqueues more work
		// tracked via a fresh pendingClientCalls entry, must still be drained by a later pass
		// of the loop rather than being silently dropped by a single-pass drain.
		let resolveFirstCapture!: () => void
		const firstCapturePromise = new Promise<void>((resolve) => {
			resolveFirstCapture = resolve
		})

		let resolveSecondCapture!: () => void
		const secondCapturePromise = new Promise<void>((resolve) => {
			resolveSecondCapture = resolve
		})

		const captureOrder: string[] = []
		let firstCaptureStarted = false

		const mockClient: TelemetryClient = {
			setProvider: vi.fn(),
			capture: vi.fn().mockImplementation(async () => {
				if (!firstCaptureStarted) {
					firstCaptureStarted = true
					await firstCapturePromise
					captureOrder.push("first-captured")
					return
				}

				await secondCapturePromise
				captureOrder.push("second-captured")
			}),
			captureException: vi.fn(),
			updateTelemetryState: vi.fn(),
			isTelemetryEnabled: vi.fn().mockReturnValue(true),
			shutdown: vi.fn().mockImplementation(async () => {
				captureOrder.push("shutdown")
			}),
		}

		const service = new TelemetryService([mockClient])

		// Both captures are fired *before* shutdown() is called, so both are legitimately
		// in flight (tracked in pendingClientCalls) at the moment shutdown() takes its first
		// snapshot -- unlike a capture fired after shutdown() has started, which is expected
		// to be gated out instead (see the "stops accepting new captures" test below).
		service.captureEvent(TelemetryEventName.TASK_CREATED, { taskId: "first" })
		service.captureEvent(TelemetryEventName.TASK_CREATED, { taskId: "second" })

		const shutdownPromise = service.shutdown()

		resolveFirstCapture()
		// Flush several microtask ticks so a buggy single-pass drain has every opportunity
		// to run client.shutdown() before we check -- a couple of ticks isn't enough since
		// the mocked capture/shutdown chain itself spans a few microtask hops.
		for (let i = 0; i < 4; i++) {
			await Promise.resolve()
		}

		// The second capture is still pending (its own resolver hasn't fired) -- shutdown
		// must not have completed yet, otherwise it dropped the second capture.
		expect(captureOrder).not.toContain("shutdown")

		resolveSecondCapture()
		await shutdownPromise

		expect(mockClient.capture).toHaveBeenCalledTimes(2)
		expect(captureOrder).toEqual(["first-captured", "second-captured", "shutdown"])
	})

	it("stops accepting new captures once shutdown() has started", async () => {
		// Finding #4: shutdown() must mark itself as shutting down before draining, so a
		// steady trickle of new captures firing after shutdown() has begun (e.g. from a
		// teardown-time error handler) can't keep pendingClientCalls non-empty forever and
		// prevent the drain loop from ever terminating on its own.
		const mockClient: TelemetryClient = {
			setProvider: vi.fn(),
			capture: vi.fn().mockResolvedValue(undefined),
			captureException: vi.fn(),
			updateTelemetryState: vi.fn(),
			isTelemetryEnabled: vi.fn().mockReturnValue(true),
			shutdown: vi.fn().mockResolvedValue(undefined),
		}

		const service = new TelemetryService([mockClient])

		const shutdownPromise = service.shutdown()

		// Fired after shutdown() has already started -- must be dropped, not tracked/drained.
		service.captureEvent(TelemetryEventName.TASK_CREATED, { taskId: "late" })

		await shutdownPromise

		expect(mockClient.capture).not.toHaveBeenCalled()
	})

	it("does not hang forever when a capture never resolves, bounded by the drain timeout", async () => {
		vi.useFakeTimers()
		try {
			const mockClient: TelemetryClient = {
				setProvider: vi.fn(),
				// Never resolves -- simulates a capture stuck on network I/O.
				capture: vi.fn().mockImplementation(() => new Promise(() => {})),
				captureException: vi.fn(),
				updateTelemetryState: vi.fn(),
				isTelemetryEnabled: vi.fn().mockReturnValue(true),
				shutdown: vi.fn().mockResolvedValue(undefined),
			}

			const service = new TelemetryService([mockClient])

			service.captureEvent(TelemetryEventName.TASK_CREATED, { taskId: "stuck" })

			const shutdownPromise = service.shutdown()
			let settled = false
			void shutdownPromise.then(() => {
				settled = true
			})

			await vi.advanceTimersByTimeAsync(3000)

			expect(settled).toBe(true)
			expect(mockClient.shutdown).toHaveBeenCalledTimes(1)
		} finally {
			vi.useRealTimers()
		}
	})

	it("does not let a rejected capture prevent shutdown from completing", async () => {
		const mockClient: TelemetryClient = {
			setProvider: vi.fn(),
			capture: vi.fn().mockRejectedValue(new Error("capture failed")),
			captureException: vi.fn(),
			updateTelemetryState: vi.fn(),
			isTelemetryEnabled: vi.fn().mockReturnValue(true),
			shutdown: vi.fn().mockResolvedValue(undefined),
		}

		const service = new TelemetryService([mockClient])

		service.captureEvent(TelemetryEventName.TASK_CREATED, { taskId: "abc" })

		await expect(service.shutdown()).resolves.toBeUndefined()
		expect(mockClient.shutdown).toHaveBeenCalledTimes(1)
	})
})
