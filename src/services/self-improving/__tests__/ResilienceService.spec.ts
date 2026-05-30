import { describe, it, expect, vi, beforeEach } from "vitest"
import { ResilienceService } from "../ResilienceService"

describe("ResilienceService", () => {
	let service: ResilienceService

	beforeEach(() => {
		service = new ResilienceService({ appendLine: vi.fn() } as any)
	})

	describe("onStreamingFailure", () => {
		it("should return backoff delay on first failure", () => {
			const delay = service.onStreamingFailure()
			expect(delay).toBeGreaterThanOrEqual(2000)
			expect(delay).toBeLessThanOrEqual(2200) // base + jitter
		})

		it("should return -1 when max retries exceeded", () => {
			for (let i = 0; i < 5; i++) {
				service.onStreamingFailure()
			}
			const delay = service.onStreamingFailure() // 6th call
			expect(delay).toBe(-1)
		})

		it("should return -1 when disabled", () => {
			const disabled = new ResilienceService({ appendLine: vi.fn() } as any, { enabled: false })
			expect(disabled.onStreamingFailure()).toBe(-1)
		})

		it("should increase delay exponentially", () => {
			const d1 = service.onStreamingFailure()
			const d2 = service.onStreamingFailure()
			const d3 = service.onStreamingFailure()
			expect(d2).toBeGreaterThan(d1)
			expect(d3).toBeGreaterThan(d2)
		})
	})

	describe("onToolParameterError", () => {
		it("should return retry action on first error", () => {
			const result = service.onToolParameterError("search_files", "regex")
			expect(result).not.toBeNull()
			expect(result!.action).toBe("retry")
			expect(result!.delay).toBeGreaterThanOrEqual(2000)
		})

		it("should return abort action when max retries exceeded", () => {
			for (let i = 0; i < 5; i++) {
				service.onToolParameterError("search_files", "regex")
			}
			const result = service.onToolParameterError("search_files", "regex")
			expect(result!.action).toBe("abort")
		})

		it("should include suggestion in result", () => {
			const result = service.onToolParameterError("search_files", "regex")
			expect(result!.suggestion).toContain("regex")
		})
	})

	describe("onTaskSuccess", () => {
		it("should reset consecutive failures", () => {
			service.onStreamingFailure()
			service.onStreamingFailure()
			service.onTaskSuccess()
			const delay = service.onStreamingFailure()
			expect(delay).toBeGreaterThanOrEqual(2000) // back to base delay
		})
	})

	describe("getRecoverySuggestion", () => {
		it("should return empty string when not in recovery mode", () => {
			expect(service.getRecoverySuggestion()).toBe("")
		})

		it("should return recovery command when in recovery mode", () => {
			service.onStreamingFailure()
			service.onStreamingFailure()
			service.onStreamingFailure()
			service.onStreamingFailure()
			service.onStreamingFailure()
			service.onStreamingFailure() // triggers recovery mode
			const suggestion = service.getRecoverySuggestion()
			expect(suggestion.length).toBeGreaterThan(0)
		})
	})

	describe("getStatus", () => {
		it("should return status object", () => {
			const status = service.getStatus()
			expect(status.enabled).toBe(true)
			expect(status.consecutiveFailures).toBe(0)
			expect(status.isInRecoveryMode).toBe(false)
		})
	})
})
