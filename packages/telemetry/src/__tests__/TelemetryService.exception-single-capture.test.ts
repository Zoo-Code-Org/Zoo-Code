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

// FieldsDistinct: delimiters in real provider fields must not merge distinct errors.
it.each(["|", "||", "model|suffix"])("keeps field boundaries for %s", (separator) => {
	const client = makeRecordingClient()
	const service = new TelemetryService([client])
	service.captureException(new ApiProviderError("failure", `a${separator}b`, "c", "createMessage"))
	service.captureException(new ApiProviderError("failure", "a", `b${separator}c`, "createMessage"))
	expect(client.captureException).toHaveBeenCalledTimes(2)
})

it.each([29_999, 30_000, 40_000, 600_000])("applies the window at a %i ms retry gap", (gap) => {
	vi.useFakeTimers()
	try {
		const client = makeRecordingClient()
		const service = new TelemetryService([client])
		service.captureException(makeApiProviderError())
		vi.advanceTimersByTime(gap)
		service.captureException(makeApiProviderError())
		expect(client.captureException).toHaveBeenCalledTimes(gap < 30_000 ? 1 : 2)
	} finally {
		vi.useRealTimers()
	}
})

it("bounds the cache and evicts the least recently observed fingerprint", () => {
	const client = makeRecordingClient()
	const service = new TelemetryService([client])
	for (let i = 0; i < 100; i++) service.captureException(makeApiProviderError(`failure ${i}`))
	service.captureException(makeApiProviderError("failure 0"))
	service.captureException(makeApiProviderError("failure 100"))
	expect(service["recentExceptionFingerprints"].size).toBe(100)
	service.captureException(makeApiProviderError("failure 0"))
	expect(client.captureException).toHaveBeenCalledTimes(101)
	service.captureException(makeApiProviderError("failure 1"))
	expect(client.captureException).toHaveBeenCalledTimes(102)
	expect(service["recentExceptionFingerprints"].size).toBe(100)
})

it("does not consume an error during shutdown", async () => {
	const client = makeRecordingClient()
	const service = new TelemetryService([client])
	await service.shutdown()
	const error = makeApiProviderError()
	service.captureException(error)
	expect(error.captured).toBeUndefined()
	expect(service["recentExceptionFingerprints"].size).toBe(0)
	expect(client.captureException).not.toHaveBeenCalled()
})

// WindowDecision: enumerate all short traces over equal, distinct, and expired fresh errors.
it("matches the sliding-window invariant over every four-call trace", () => {
	vi.useFakeTimers()
	try {
		for (let trace = 0; trace < 256; trace++) {
			const client = makeRecordingClient()
			const service = new TelemetryService([client])
			const lastSeen = new Map<string, number>()
			let expected = 0
			let choices = trace
			for (let step = 0; step < 4; step++) {
				const choice = choices % 4
				choices = Math.floor(choices / 4)
				const message = choice === 1 ? "different" : "failure"
				vi.advanceTimersByTime(choice === 2 ? 30_000 : choice === 3 ? 10_000 : 0)
				const now = Date.now()
				const previous = lastSeen.get(message)
				if (previous === undefined || now - previous >= 30_000) expected++
				lastSeen.set(message, now)
				service.captureException(makeApiProviderError(message))
				expect(client.captureException, `trace ${trace}, step ${step}`).toHaveBeenCalledTimes(expected)
			}
		}
	} finally {
		vi.useRealTimers()
	}
})
