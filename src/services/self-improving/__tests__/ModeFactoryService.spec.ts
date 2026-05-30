import { describe, it, expect, vi, beforeEach } from "vitest"
import { ModeFactoryService } from "../ModeFactoryService"
import type { LearnedPattern } from "../types"

describe("ModeFactoryService", () => {
	let factory: ModeFactoryService

	beforeEach(() => {
		factory = new ModeFactoryService({
			appendLine: vi.fn(),
		} as any)
	})

	describe("deriveModeFromPattern", () => {
		it("should return null for pattern with no tool names", () => {
			const pattern: LearnedPattern = {
				id: "test-1",
				patternType: "tool",
				state: "active",
				summary: "test pattern",
				confidenceScore: 0.5,
				frequency: 3,
				successRate: 0.8,
				firstSeenAt: Date.now(),
				lastSeenAt: Date.now(),
				sourceSignals: [],
				context: {},
			}
			expect(factory.deriveModeFromPattern(pattern)).toBeNull()
		})

		it("should create a mode config from a tool pattern", () => {
			const pattern: LearnedPattern = {
				id: "test-2",
				patternType: "tool",
				state: "active",
				summary: "read then edit pattern",
				confidenceScore: 0.7,
				frequency: 5,
				successRate: 0.9,
				firstSeenAt: Date.now(),
				lastSeenAt: Date.now(),
				sourceSignals: [],
				context: {
					toolNames: ["read_file", "apply_diff"],
				},
			}
			const config = factory.deriveModeFromPattern(pattern)
			expect(config).not.toBeNull()
			expect(config!.slug).toBe("read-file-apply-diff")
			expect(config!.name).toContain("Read File")
			expect(config!.groups.length).toBeGreaterThan(0)
			expect(config!.source).toBe("project")
		})

		it("should derive correct groups from tool names", () => {
			const pattern: LearnedPattern = {
				id: "test-3",
				patternType: "tool",
				state: "active",
				summary: "command pattern",
				confidenceScore: 0.6,
				frequency: 4,
				successRate: 0.7,
				firstSeenAt: Date.now(),
				lastSeenAt: Date.now(),
				sourceSignals: [],
				context: {
					toolNames: ["execute_command", "run_slash_command"],
				},
			}
			const config = factory.deriveModeFromPattern(pattern)
			expect(config).not.toBeNull()
			const commandGroups = config!.groups.filter((g) => g === "command")
			expect(commandGroups.length).toBeGreaterThan(0)
		})

		it("should include error keys in role definition for error patterns", () => {
			const pattern: LearnedPattern = {
				id: "test-4",
				patternType: "error",
				state: "active",
				summary: "api error pattern",
				confidenceScore: 0.4,
				frequency: 3,
				successRate: 0.3,
				firstSeenAt: Date.now(),
				lastSeenAt: Date.now(),
				sourceSignals: [],
				context: {
					toolNames: ["read_file"],
					errorKeys: ["streaming_failed", "api_timeout"],
				},
			}
			const config = factory.deriveModeFromPattern(pattern)
			expect(config).not.toBeNull()
			expect(config!.roleDefinition).toContain("streaming_failed")
			expect(config!.roleDefinition).toContain("api_timeout")
		})
	})

	describe("createModeFromPattern", () => {
		it("should return null if CustomModesManager not set", async () => {
			const pattern: LearnedPattern = {
				id: "test-5",
				patternType: "tool",
				state: "active",
				summary: "test",
				confidenceScore: 0.5,
				frequency: 3,
				successRate: 0.8,
				firstSeenAt: Date.now(),
				lastSeenAt: Date.now(),
				sourceSignals: [],
				context: {
					toolNames: ["read_file"],
				},
			}
			const result = await factory.createModeFromPattern(pattern)
			expect(result).toBeNull()
		})

		it("should call updateCustomMode when manager is set", async () => {
			const mockManager = {
				updateCustomMode: vi.fn().mockResolvedValue(undefined),
			}
			factory.setCustomModesManager(mockManager as any)

			const pattern: LearnedPattern = {
				id: "test-6",
				patternType: "tool",
				state: "active",
				summary: "test",
				confidenceScore: 0.5,
				frequency: 3,
				successRate: 0.8,
				firstSeenAt: Date.now(),
				lastSeenAt: Date.now(),
				sourceSignals: [],
				context: {
					toolNames: ["read_file"],
				},
			}
			const result = await factory.createModeFromPattern(pattern)
			expect(result).toBe("read-file")
			expect(mockManager.updateCustomMode).toHaveBeenCalledTimes(1)
		})
	})

	describe("createModesFromPatterns", () => {
		it("should create modes from multiple patterns", async () => {
			const mockManager = {
				updateCustomMode: vi.fn().mockResolvedValue(undefined),
			}
			factory.setCustomModesManager(mockManager as any)

			const patterns: LearnedPattern[] = [
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
			]
			const results = await factory.createModesFromPatterns(patterns)
			expect(results).toHaveLength(2)
			expect(results).toContain("read-file")
			expect(results).toContain("execute-command")
		})
	})
})
