// pnpm --filter @roo-code/telemetry test src/__tests__/TelemetryService.circuit-breaker.test.ts

import { TelemetryEventName, type TelemetryClient } from "@roo-code/types"

import { TelemetryService } from "../TelemetryService"

describe("TelemetryService circuit breaker", () => {
	let mockClient: TelemetryClient

	beforeEach(() => {
		vi.useFakeTimers()
		vi.setSystemTime(0)

		mockClient = {
			setProvider: vi.fn(),
			capture: vi.fn().mockResolvedValue(undefined),
			captureException: vi.fn().mockResolvedValue(undefined),
			updateTelemetryState: vi.fn(),
			isTelemetryEnabled: vi.fn().mockReturnValue(true),
			shutdown: vi.fn().mockResolvedValue(undefined),
		}
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it("passes through captures under the trip threshold", () => {
		const service = new TelemetryService([mockClient])

		for (let i = 0; i < 49; i++) {
			service.captureEvent(TelemetryEventName.CODE_INDEX_ERROR, { i })
		}

		expect(mockClient.capture).toHaveBeenCalledTimes(49)
	})

	it("trips at the 50th CODE_INDEX_ERROR capture within the window and drops further ones", () => {
		const service = new TelemetryService([mockClient])

		for (let i = 0; i < 49; i++) {
			service.captureEvent(TelemetryEventName.CODE_INDEX_ERROR, { i })
		}
		expect(mockClient.capture).toHaveBeenCalledTimes(49)

		// 50th capture trips the breaker but is itself dropped.
		service.captureEvent(TelemetryEventName.CODE_INDEX_ERROR, { i: 49 })
		expect(mockClient.capture).toHaveBeenCalledTimes(49)

		// Keeps dropping while tripped.
		service.captureEvent(TelemetryEventName.CODE_INDEX_ERROR, { i: 50 })
		expect(mockClient.capture).toHaveBeenCalledTimes(49)
	})

	it("re-allows captures after the cooldown window elapses", () => {
		const service = new TelemetryService([mockClient])

		for (let i = 0; i < 50; i++) {
			service.captureEvent(TelemetryEventName.CODE_INDEX_ERROR, { i })
		}
		expect(mockClient.capture).toHaveBeenCalledTimes(49)

		// Just under 10 minutes - still tripped.
		vi.setSystemTime(10 * 60 * 1000 - 1)
		service.captureEvent(TelemetryEventName.CODE_INDEX_ERROR, { i: 50 })
		expect(mockClient.capture).toHaveBeenCalledTimes(49)

		// Cooldown elapsed - one more error gets through.
		vi.setSystemTime(10 * 60 * 1000)
		service.captureEvent(TelemetryEventName.CODE_INDEX_ERROR, { i: 51 })
		expect(mockClient.capture).toHaveBeenCalledTimes(50)
	})

	it("does not reset the guarded count when unrelated events are interleaved", () => {
		// A real broken install still does normal things (creates/completes other tasks)
		// while a subsystem like code-index is stuck in a retry loop. Unrelated telemetry
		// must not mask the CODE_INDEX_ERROR burst by resetting its count.
		const service = new TelemetryService([mockClient])

		for (let i = 0; i < 25; i++) {
			service.captureEvent(TelemetryEventName.CODE_INDEX_ERROR, { i })
			service.captureEvent(TelemetryEventName.TASK_CREATED, { taskId: `task-${i}` })
		}
		// 25 CODE_INDEX_ERROR so far - still under the threshold of 50.
		expect(mockClient.capture).toHaveBeenCalledTimes(25 + 25)

		for (let i = 25; i < 49; i++) {
			service.captureEvent(TelemetryEventName.CODE_INDEX_ERROR, { i })
			service.captureEvent(TelemetryEventName.TASK_CREATED, { taskId: `task-${i}` })
		}
		// 49 CODE_INDEX_ERROR so far - still under the threshold of 50.
		expect(mockClient.capture).toHaveBeenCalledTimes(49 + 49)

		// 50th CODE_INDEX_ERROR trips the breaker (and is itself dropped); TASK_CREATED
		// events are never guarded.
		service.captureEvent(TelemetryEventName.CODE_INDEX_ERROR, { i: 49 })
		service.captureEvent(TelemetryEventName.TASK_CREATED, { taskId: "task-49" })
		expect(mockClient.capture).toHaveBeenCalledTimes(49 + 50)

		// Further CODE_INDEX_ERROR captures are dropped even though unrelated events keep flowing.
		service.captureEvent(TelemetryEventName.CODE_INDEX_ERROR, { i: 50 })
		service.captureEvent(TelemetryEventName.TASK_CREATED, { taskId: "task-50" })
		expect(mockClient.capture).toHaveBeenCalledTimes(49 + 51)
	})

	it("expires old occurrences outside the counting window instead of trapping the breaker open forever", () => {
		// A slow trickle of CODE_INDEX_ERROR (below the burst rate) should never trip the
		// breaker, since old occurrences age out of the window rather than accumulating forever.
		const service = new TelemetryService([mockClient])

		for (let i = 0; i < 60; i++) {
			service.captureEvent(TelemetryEventName.CODE_INDEX_ERROR, { i })
			// Advance well past the counting window between each one.
			vi.setSystemTime(Date.now() + 60 * 1000)
		}

		expect(mockClient.capture).toHaveBeenCalledTimes(60)
	})

	it("does not guard other event names", () => {
		const service = new TelemetryService([mockClient])

		for (let i = 0; i < 200; i++) {
			service.captureEvent(TelemetryEventName.TOOL_USED, { tool: "read_file" })
		}

		expect(mockClient.capture).toHaveBeenCalledTimes(200)
	})

	it("returns early on the not-ready (zero-client) branch without touching circuit breaker state", () => {
		// captureEvent's !this.isReady check runs before shouldDropForCircuitBreaker, so with
		// no clients registered, guarded-event bookkeeping should never be reached.
		const service = new TelemetryService([])

		for (let i = 0; i < 50; i++) {
			service.captureEvent(TelemetryEventName.CODE_INDEX_ERROR, { i })
		}

		expect(mockClient.capture).not.toHaveBeenCalled()

		// Prove the 50 zero-client calls didn't count towards the breaker: once a client is
		// registered, the very next capture must still go through instead of being dropped.
		service.register(mockClient)
		service.captureEvent(TelemetryEventName.CODE_INDEX_ERROR, { i: 50 })

		expect(mockClient.capture).toHaveBeenCalledTimes(1)
	})
})
