// pnpm --filter @roo-code/telemetry test src/__tests__/TelemetryService.exception-single-capture.test.ts

import { ApiProviderError, type TelemetryClient } from "@roo-code/types"

import { TelemetryService } from "../TelemetryService"

function makeApiProviderError(message = "upstream failure", operation = "createMessage"): ApiProviderError {
	return new ApiProviderError(message, "anthropic", "claude-3-5-sonnet-20241022", operation)
}

function makeRecordingClient(): TelemetryClient {
	return {
		setProvider: vi.fn(),
		capture: vi.fn().mockResolvedValue(undefined),
		captureException: vi.fn().mockResolvedValue(undefined),
		updateTelemetryState: vi.fn(),
		isTelemetryEnabled: vi.fn().mockReturnValue(true),
		shutdown: vi.fn().mockResolvedValue(undefined),
	}
}

describe("TelemetryService.captureException single-capture policy", () => {
	let mockClient: TelemetryClient

	beforeEach(() => {
		vi.useFakeTimers()
		mockClient = makeRecordingClient()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it("marks a captured ApiProviderError so re-throws of the same instance are no-ops", () => {
		const service = new TelemetryService([mockClient])
		const apiError = makeApiProviderError()

		service.captureException(apiError)
		service.captureException(apiError)
		service.captureException(apiError)

		expect(mockClient.captureException).toHaveBeenCalledTimes(1)
		expect(mockClient.captureException).toHaveBeenCalledWith(apiError, undefined)
		expect(apiError.captured).toBe(true)
	})

	it("keeps ignoring the same instance after the dedupe window (identity beats the window)", () => {
		const service = new TelemetryService([mockClient])
		const apiError = makeApiProviderError()

		service.captureException(apiError)
		vi.advanceTimersByTime(60_000)
		service.captureException(apiError)

		expect(mockClient.captureException).toHaveBeenCalledTimes(1)
	})

	it("collapses fresh identical ApiProviderErrors built per retry attempt within the window", () => {
		const service = new TelemetryService([mockClient])

		// Simulates the retry loop: each attempt catches a fresh failure, builds
		// a fresh ApiProviderError with the same shape, captures it, and re-throws.
		for (let attempt = 0; attempt < 5; attempt++) {
			service.captureException(makeApiProviderError())
		}

		expect(mockClient.captureException).toHaveBeenCalledTimes(1)
	})

	it("captures an identical fresh error again once the window has passed", () => {
		const service = new TelemetryService([mockClient])

		service.captureException(makeApiProviderError())
		vi.advanceTimersByTime(31_000)
		service.captureException(makeApiProviderError())

		expect(mockClient.captureException).toHaveBeenCalledTimes(2)
	})

	it("slides the window while an identical error keeps recurring", () => {
		const service = new TelemetryService([mockClient])

		service.captureException(makeApiProviderError())
		for (const gapMs of [10_000, 10_000, 10_000, 10_000]) {
			vi.advanceTimersByTime(gapMs)
			service.captureException(makeApiProviderError())
		}

		expect(mockClient.captureException).toHaveBeenCalledTimes(1)
	})

	it("does not collapse distinct errors", () => {
		const service = new TelemetryService([mockClient])

		service.captureException(makeApiProviderError("first failure"))
		service.captureException(makeApiProviderError("second failure"))
		service.captureException(makeApiProviderError("first failure", "completePrompt"))

		expect(mockClient.captureException).toHaveBeenCalledTimes(3)
	})

	it("collapses plain Errors with the same name and message within the window", () => {
		const service = new TelemetryService([mockClient])

		service.captureException(new Error("connection reset"))
		service.captureException(new Error("connection reset"))
		service.captureException(new Error("connection refused"))

		expect(mockClient.captureException).toHaveBeenCalledTimes(2)
	})

	it("leaves the error unmarked when no clients are registered so it can be captured later", () => {
		const idleService = new TelemetryService([])
		const apiError = makeApiProviderError()

		idleService.captureException(apiError)

		expect(mockClient.captureException).not.toHaveBeenCalled()
		expect(apiError.captured).toBeUndefined()

		// The readiness check runs before the flag is set, so an error captured
		// while telemetry was down is not consumed by the failed attempt.
		const readyService = new TelemetryService([mockClient])
		readyService.captureException(apiError)

		expect(mockClient.captureException).toHaveBeenCalledTimes(1)
	})
})
