import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { AutoModeOrchestrator } from "../AutoModeOrchestrator"
import type { ToolErrorHealer } from "../ToolErrorHealer"
import type { ResilienceService } from "../ResilienceService"

describe("AutoModeOrchestrator", () => {
	let orchestrator: AutoModeOrchestrator
	let mockLogger: { appendLine: ReturnType<typeof vi.fn> }
	let mockHealer: Partial<ToolErrorHealer>
	let mockResilience: Partial<ResilienceService>

	beforeEach(() => {
		mockLogger = { appendLine: vi.fn() }
		mockHealer = {
			handleToolError: vi.fn(),
		}
		mockResilience = {
			onStreamingFailure: vi.fn(),
		}
		orchestrator = new AutoModeOrchestrator(mockLogger as any)
	})

	afterEach(() => {
		orchestrator.stop()
	})

	describe("constructor", () => {
		it("should use default config when no config provided", () => {
			const config = orchestrator.getConfig()
			expect(config.enabled).toBe(true)
			expect(config.autoCreateModes).toBe(true)
			expect(config.autoHeal).toBe(true)
			expect(config.minPatternConfidence).toBe(0.3)
			expect(config.minPatternFrequency).toBe(2)
			expect(config.reviewIntervalMs).toBe(30000)
		})

		it("should merge provided config with defaults", () => {
			const custom = new AutoModeOrchestrator(mockLogger as any, {
				enabled: false,
				reviewIntervalMs: 10000,
			})
			const config = custom.getConfig()
			expect(config.enabled).toBe(false)
			expect(config.autoCreateModes).toBe(true) // from defaults
			expect(config.reviewIntervalMs).toBe(10000)
			custom.stop()
		})

		it("should accept optional ToolErrorHealer and ResilienceService", () => {
			const custom = new AutoModeOrchestrator(
				mockLogger as any,
				undefined,
				mockHealer as ToolErrorHealer,
				mockResilience as ResilienceService,
			)
			expect(custom).toBeInstanceOf(AutoModeOrchestrator)
			custom.stop()
		})
	})

	describe("updateConfig", () => {
		it("should update config values", () => {
			orchestrator.updateConfig({ enabled: false, autoCreateModes: false })
			const config = orchestrator.getConfig()
			expect(config.enabled).toBe(false)
			expect(config.autoCreateModes).toBe(false)
			expect(config.autoHeal).toBe(true) // unchanged
		})
	})

	describe("start/stop", () => {
		it("should not start timer when disabled", async () => {
			const disabled = new AutoModeOrchestrator(mockLogger as any, { enabled: false })
			await disabled.start()
			disabled.stop() // should be safe
		})

		it("should start timer when enabled", async () => {
			await orchestrator.start()
			orchestrator.stop()
			expect(mockLogger.appendLine).toHaveBeenCalledWith(expect.stringContaining("stopped"))
		})
	})

	describe("onTaskCompleted", () => {
		it("should not process when disabled", async () => {
			orchestrator.updateConfig({ enabled: false })
			await orchestrator.onTaskCompleted(true)
			await orchestrator.onTaskCompleted(false)
		})

		it("should trigger auto-heal on failure", async () => {
			orchestrator.setPatternAnalyzer({} as any)

			await orchestrator.onTaskCompleted(false)
			expect(mockLogger.appendLine).toHaveBeenCalledWith(expect.stringContaining("failure #1 detected"))
		})

		it("should not trigger auto-heal on success", async () => {
			// Spy on private autoHeal by checking logger output
			await orchestrator.onTaskCompleted(true)
			// Should not log failure-related messages
			const failureLogs = mockLogger.appendLine.mock.calls.filter(
				(call: any[]) => typeof call[0] === "string" && call[0].includes("failure"),
			)
			expect(failureLogs.length).toBe(0)
		})
	})

	describe("autoHeal — ToolErrorHealer integration", () => {
		it("should call ToolErrorHealer when missing parameter error detected", async () => {
			const healer: Partial<ToolErrorHealer> = {
				handleToolError: vi.fn().mockReturnValue({
					fix: "Provide a valid regex pattern for the search",
					autoCorrectable: true,
				}),
			}
			const orch = new AutoModeOrchestrator(mockLogger as any, undefined, healer as ToolErrorHealer)
			orch.setPatternAnalyzer({} as any)
			orch.recordFailure("search_files", "Missing required parameter: regex")

			await orch.onTaskCompleted(false)

			expect(healer.handleToolError).toHaveBeenCalledWith("search_files", "regex")
			expect(mockLogger.appendLine).toHaveBeenCalledWith(
				expect.stringContaining("Auto-heal: applied tool error fix"),
			)
			orch.stop()
		})

		it("should not call ToolErrorHealer when no missing parameter error", async () => {
			const healer: Partial<ToolErrorHealer> = {
				handleToolError: vi.fn(),
			}
			const orch = new AutoModeOrchestrator(mockLogger as any, undefined, healer as ToolErrorHealer)
			orch.setPatternAnalyzer({} as any)
			orch.recordFailure("search_files", "Connection timeout")

			await orch.onTaskCompleted(false)

			expect(healer.handleToolError).not.toHaveBeenCalled()
			orch.stop()
		})

		it("should fall through when ToolErrorHealer returns null", async () => {
			const healer: Partial<ToolErrorHealer> = {
				handleToolError: vi.fn().mockReturnValue(null),
			}
			const orch = new AutoModeOrchestrator(mockLogger as any, undefined, healer as ToolErrorHealer)
			orch.setPatternAnalyzer({} as any)
			orch.recordFailure("search_files", "Missing required parameter: regex")

			await orch.onTaskCompleted(false)

			expect(healer.handleToolError).toHaveBeenCalled()
			// Should fall through to pattern analysis fallback
			expect(mockLogger.appendLine).toHaveBeenCalledWith(expect.stringContaining("queued for pattern analysis"))
			orch.stop()
		})
	})

	describe("autoHeal — ResilienceService integration", () => {
		it("should call ResilienceService for transient failures", async () => {
			const resilience: Partial<ResilienceService> = {
				onStreamingFailure: vi.fn().mockReturnValue(2000),
			}
			const orch = new AutoModeOrchestrator(
				mockLogger as any,
				undefined,
				undefined,
				resilience as ResilienceService,
			)
			orch.setPatternAnalyzer({} as any)
			orch.recordFailure("execute_command", "Network timeout")

			await orch.onTaskCompleted(false)

			expect(resilience.onStreamingFailure).toHaveBeenCalled()
			expect(mockLogger.appendLine).toHaveBeenCalledWith(
				expect.stringContaining("Auto-heal: scheduled retry in 2000ms"),
			)
			orch.stop()
		})

		it("should handle max retries exceeded from ResilienceService", async () => {
			const resilience: Partial<ResilienceService> = {
				onStreamingFailure: vi.fn().mockReturnValue(-1),
			}
			const orch = new AutoModeOrchestrator(
				mockLogger as any,
				undefined,
				undefined,
				resilience as ResilienceService,
			)
			orch.setPatternAnalyzer({} as any)
			orch.recordFailure("execute_command", "Network timeout")

			await orch.onTaskCompleted(false)

			expect(resilience.onStreamingFailure).toHaveBeenCalled()
			expect(mockLogger.appendLine).toHaveBeenCalledWith(expect.stringContaining("max retries exceeded"))
			orch.stop()
		})
	})

	describe("autoHeal — setter injection", () => {
		it("should accept ToolErrorHealer via setter", () => {
			const orch = new AutoModeOrchestrator(mockLogger as any)
			orch.setToolErrorHealer(mockHealer as ToolErrorHealer)
			// No error means success
			orch.stop()
		})

		it("should accept ResilienceService via setter", () => {
			const orch = new AutoModeOrchestrator(mockLogger as any)
			orch.setResilienceService(mockResilience as ResilienceService)
			orch.stop()
		})
	})

	describe("getStatus", () => {
		it("should return status object", () => {
			const status = orchestrator.getStatus()
			expect(status.autoModeEnabled).toBe(true)
			expect(status.autoCreateModes).toBe(true)
			expect(status.createdModes).toBe(0)
			expect(status.createdModeSlugs).toEqual([])
			expect(status.lastModeCreation).toBe("never")
		})
	})

	describe("autoCreateModes", () => {
		it("should create modes from candidate patterns", async () => {
			const mockFactory = {
				createModesFromPatterns: vi.fn().mockResolvedValue(["read_file-mode", "command-mode"]),
			}
			orchestrator.setModeFactory(mockFactory as any)
			orchestrator.setPatternProvider(() => [
				{
					id: "p1",
					patternType: "tool",
					state: "active",
					summary: "pattern 1",
					confidenceScore: 0.5,
					frequency: 3,
					successRate: 0.8,
					firstSeenAt: Date.now(),
					lastSeenAt: Date.now(),
					sourceSignals: [],
					context: { toolNames: ["read_file"] },
				},
				{
					id: "p2",
					patternType: "tool",
					state: "active",
					summary: "pattern 2",
					confidenceScore: 0.6,
					frequency: 4,
					successRate: 0.9,
					firstSeenAt: Date.now(),
					lastSeenAt: Date.now(),
					sourceSignals: [],
					context: { toolNames: ["execute_command"] },
				},
			])

			// Trigger auto-create via onTaskCompleted (throttle bypass: first call always allowed)
			await orchestrator.onTaskCompleted(true)

			expect(mockFactory.createModesFromPatterns).toHaveBeenCalled()
			expect(mockLogger.appendLine).toHaveBeenCalledWith(expect.stringContaining("Created 2 custom modes"))
		})

		it("should skip patterns below confidence threshold", async () => {
			const mockFactory = {
				createModesFromPatterns: vi.fn().mockResolvedValue([]),
			}
			orchestrator.setModeFactory(mockFactory as any)
			orchestrator.setPatternProvider(() => [
				{
					id: "p-low",
					patternType: "tool",
					state: "active",
					summary: "low confidence",
					confidenceScore: 0.1,
					frequency: 5,
					successRate: 0.5,
					firstSeenAt: Date.now(),
					lastSeenAt: Date.now(),
					sourceSignals: [],
					context: { toolNames: ["read_file"] },
				},
			])

			await orchestrator.onTaskCompleted(true)

			// No candidates → createModesFromPatterns should not be called
			expect(mockFactory.createModesFromPatterns).not.toHaveBeenCalled()
		})
	})
})
