// npx vitest run src/core/tools/__tests__/ToolRepetitionDetector.spec.ts

import type { ToolName } from "@roo-code/types"

import type { ToolUse } from "../../../shared/tools"

import { ToolRepetitionDetector } from "../ToolRepetitionDetector"

vitest.mock("../../../i18n", () => ({
	t: vitest.fn(function (key, options) {
		// For toolRepetitionLimitReached key, return a message with the tool name.
		if (key === "tools:toolRepetitionLimitReached" && options?.toolName) {
			return `Roo appears to be stuck in a loop, attempting the same action (${options.toolName}) repeatedly. This might indicate a problem with its current strategy.`
		}
		if (key === "tools:toolRepetitionSoftBlock" && options?.toolName) {
			return `The tool '${options.toolName}' was blocked because it was just called with identical parameters. Explain why the repeated call is necessary.`
		}
		return key
	}),
}))

function createToolUse(name: string, displayName?: string, params: Record<string, string> = {}): ToolUse {
	return {
		type: "tool_use",
		name: (displayName || name) as ToolName,
		params,
		partial: false,
	}
}

describe("ToolRepetitionDetector", () => {
	// ===== Initialization tests =====
	describe("initialization", () => {
		it("should default to soft limit 2 and hard limit 5 when no arguments provided", () => {
			const detector = new ToolRepetitionDetector()
			const tool = createToolUse("test", "test-tool")

			// Call 1 (count = 0) -> allow
			expect(detector.check(tool).action).toBe("allow")
			// Call 2 (count = 1) -> allow
			expect(detector.check(tool).action).toBe("allow")
			// Call 3 (count = 2) -> soft_block (reaches soft limit 2)
			expect(detector.check(tool).action).toBe("soft_block")
			// Call 4 (count = 3) -> soft_block
			expect(detector.check(tool).action).toBe("soft_block")
			// Call 5 (count = 4) -> soft_block
			expect(detector.check(tool).action).toBe("soft_block")
			// Call 6 (count = 5) -> hard_block (reaches hard limit 5)
			expect(detector.check(tool).action).toBe("hard_block")
		})

		it("should use the custom limits when provided", () => {
			const detector = new ToolRepetitionDetector(1, 3)
			const tool = createToolUse("test", "test-tool")

			// Call 1 (count = 0) -> allow
			expect(detector.check(tool).action).toBe("allow")
			// Call 2 (count = 1) -> soft_block (reaches soft limit 1)
			expect(detector.check(tool).action).toBe("soft_block")
			// Call 3 (count = 2) -> soft_block
			expect(detector.check(tool).action).toBe("soft_block")
			// Call 4 (count = 3) -> hard_block (reaches hard limit 3)
			expect(detector.check(tool).action).toBe("hard_block")
		})

		it("should clamp the soft limit below the hard limit so the soft warning fires first", () => {
			// A soft limit equal to the hard limit (as imported/migrated profiles
			// may configure) would otherwise never soft block because the hard
			// stop check runs first.
			const detector = new ToolRepetitionDetector(3, 3)
			const tool = createToolUse("test", "test-tool")

			// Call 1 (count = 0) -> allow
			expect(detector.check(tool).action).toBe("allow")
			// Call 2 (count = 1) -> allow
			expect(detector.check(tool).action).toBe("allow")
			// Call 3 (count = 2) -> soft_block (soft limit clamped to hard - 1 = 2)
			expect(detector.check(tool).action).toBe("soft_block")
			// Call 4 (count = 3) -> hard_block (reaches hard limit 3)
			expect(detector.check(tool).action).toBe("hard_block")
		})

		it("should clamp a soft limit greater than the hard limit", () => {
			const detector = new ToolRepetitionDetector(10, 2)
			const tool = createToolUse("test", "test-tool")

			// Call 1 (count = 0) -> allow
			expect(detector.check(tool).action).toBe("allow")
			// Call 2 (count = 1) -> soft_block (soft limit clamped to hard - 1 = 1)
			expect(detector.check(tool).action).toBe("soft_block")
			// Call 3 (count = 2) -> hard_block (reaches hard limit 2)
			expect(detector.check(tool).action).toBe("hard_block")
		})
	})

	// ===== No Repetition tests =====
	describe("no repetition", () => {
		it("should allow execution for different tool calls", () => {
			const detector = new ToolRepetitionDetector()

			expect(detector.check(createToolUse("first", "first-tool")).action).toBe("allow")
			expect(detector.check(createToolUse("second", "second-tool")).action).toBe("allow")
			expect(detector.check(createToolUse("third", "third-tool")).action).toBe("allow")
		})

		it("should reset the counter when different tool calls are made", () => {
			const detector = new ToolRepetitionDetector(1, 2)

			// First call to "same" (count = 0) -> allow
			expect(detector.check(createToolUse("same", "same-tool")).action).toBe("allow")

			// Different tool resets the counter (count = 0) -> allow
			expect(detector.check(createToolUse("different", "different-tool")).action).toBe("allow")

			// Back to first tool - counter was reset (count = 0) -> allow
			expect(detector.check(createToolUse("same", "same-tool")).action).toBe("allow")
		})
	})

	// ===== Soft block tests =====
	describe("soft block behavior", () => {
		it("should soft block at the soft limit and include a message with the tool name", () => {
			const detector = new ToolRepetitionDetector(2, 5)
			const tool = createToolUse("repeat", "repeat-tool")

			expect(detector.check(tool).action).toBe("allow")
			expect(detector.check(tool).action).toBe("allow")

			const result = detector.check(tool)
			expect(result.action).toBe("soft_block")
			if (result.action === "soft_block") {
				expect(result.message).toContain("repeat-tool")
			}
		})

		it("should keep counting through soft blocks toward the hard limit (does not reset)", () => {
			const detector = new ToolRepetitionDetector(2, 4)
			const tool = createToolUse("repeat", "repeat-tool")

			expect(detector.check(tool).action).toBe("allow") // count 0
			expect(detector.check(tool).action).toBe("allow") // count 1
			expect(detector.check(tool).action).toBe("soft_block") // count 2
			expect(detector.check(tool).action).toBe("soft_block") // count 3
			expect(detector.check(tool).action).toBe("hard_block") // count 4 -> hard
		})

		it("should not soft block when soft limit is 0 (disabled) but still hard block", () => {
			const detector = new ToolRepetitionDetector(0, 3)
			const tool = createToolUse("repeat", "repeat-tool")

			expect(detector.check(tool).action).toBe("allow") // count 0
			expect(detector.check(tool).action).toBe("allow") // count 1
			expect(detector.check(tool).action).toBe("allow") // count 2
			expect(detector.check(tool).action).toBe("hard_block") // count 3
		})
	})

	// ===== Hard block tests =====
	describe("hard block behavior", () => {
		it("should hard block at the hard limit with askUser details", () => {
			const detector = new ToolRepetitionDetector(2, 3)
			const tool = createToolUse("repeat", "repeat-tool")

			detector.check(tool) // count 0
			detector.check(tool) // count 1 (soft)
			detector.check(tool) // count 2 (soft)
			const result = detector.check(tool) // count 3 -> hard

			expect(result.action).toBe("hard_block")
			if (result.action === "hard_block") {
				expect(result.askUser.messageKey).toBe("mistake_limit_reached")
				expect(result.askUser.messageDetail).toContain("repeat-tool")
			}
		})

		it("should reset internal state after a hard block", () => {
			const detector = new ToolRepetitionDetector(2, 2)
			const tool = createToolUse("repeat", "repeat-tool")

			detector.check(tool) // count 0
			// With soft=2 hard=2, the soft limit is clamped to hard - 1 = 1, so the
			// second identical call soft blocks before the hard stop.
			const limitResult = detector.check(tool) // count 1 -> soft
			expect(limitResult.action).toBe("soft_block")
			const hard = detector.check(tool) // count 2 -> hard
			expect(hard.action).toBe("hard_block")

			// After hard block, state resets - a new identical call is allowed again
			expect(detector.check(tool).action).toBe("allow")
		})

		it("should never block when hard limit is 0 (disabled), even with a soft limit set", () => {
			const detector = new ToolRepetitionDetector(2, 0)
			const tool = createToolUse("repeat", "repeat-tool")

			for (let i = 0; i < 12; i++) {
				expect(detector.check(tool).action).toBe("allow")
			}
		})

		it("should disable soft blocking when updated to a hard limit of 0", () => {
			const detector = new ToolRepetitionDetector(2, 5)
			const tool = createToolUse("repeat", "repeat-tool")

			detector.updateLimits(2, 0)

			for (let i = 0; i < 12; i++) {
				expect(detector.check(tool).action).toBe("allow")
			}
		})
	})

	// ===== Unlimited (both 0) =====
	describe("unlimited mode", () => {
		it("should never block when both limits are 0", () => {
			const detector = new ToolRepetitionDetector(0, 0)
			const tool = createToolUse("tool", "tool-name")

			for (let i = 0; i < 20; i++) {
				expect(detector.check(tool).action).toBe("allow")
			}
		})

		it("should treat negative limits as 0 (unlimited)", () => {
			const detector = new ToolRepetitionDetector(-1, -5)
			const tool = createToolUse("tool", "tool-name")

			for (let i = 0; i < 10; i++) {
				expect(detector.check(tool).action).toBe("allow")
			}
		})
	})

	// ===== updateLimits (provider profile change) =====
	describe("updateLimits", () => {
		it("should enforce the new limits after they are updated", () => {
			const detector = new ToolRepetitionDetector(2, 5)
			const tool = createToolUse("repeat", "repeat-tool")

			// Tighten the limits, as would happen when switching to a stricter
			// provider profile during an active task.
			detector.updateLimits(1, 2)

			// Call 1 (count = 0) -> allow
			expect(detector.check(tool).action).toBe("allow")
			// Call 2 (count = 1) -> soft_block (reaches new soft limit 1)
			expect(detector.check(tool).action).toBe("soft_block")
			// Call 3 (count = 2) -> hard_block (reaches new hard limit 2)
			expect(detector.check(tool).action).toBe("hard_block")
		})

		it("should preserve the in-progress repetition count when limits change", () => {
			const detector = new ToolRepetitionDetector(5, 10)
			const tool = createToolUse("repeat", "repeat-tool")

			// Build up a streak under the original loose limits.
			expect(detector.check(tool).action).toBe("allow") // count 0
			expect(detector.check(tool).action).toBe("allow") // count 1

			// Tighten the soft limit to 2. The preserved count (currently 1)
			// means the very next identical call reaches the new soft limit.
			detector.updateLimits(2, 5)

			// Call (count = 2) -> soft_block under the new soft limit.
			expect(detector.check(tool).action).toBe("soft_block")
		})

		it("should clamp the soft limit below the hard limit after updating", () => {
			const detector = new ToolRepetitionDetector(2, 5)
			const tool = createToolUse("repeat", "repeat-tool")

			// Update to an equal soft/hard combination, as an imported profile may
			// configure. The soft limit should be clamped to hard - 1 = 2.
			detector.updateLimits(3, 3)

			// Call 1 (count = 0) -> allow
			expect(detector.check(tool).action).toBe("allow")
			// Call 2 (count = 1) -> allow
			expect(detector.check(tool).action).toBe("allow")
			// Call 3 (count = 2) -> soft_block (clamped soft limit 2)
			expect(detector.check(tool).action).toBe("soft_block")
			// Call 4 (count = 3) -> hard_block (reaches hard limit 3)
			expect(detector.check(tool).action).toBe("hard_block")
		})

		it("should treat negative updated limits as 0 (disabled)", () => {
			const detector = new ToolRepetitionDetector(2, 5)
			const tool = createToolUse("repeat", "repeat-tool")

			detector.updateLimits(-1, -1)

			for (let i = 0; i < 10; i++) {
				expect(detector.check(tool).action).toBe("allow")
			}
		})
	})

	// ===== Edge Cases =====
	describe("edge cases", () => {
		it("should treat tools with same parameters in different order as identical", () => {
			const detector = new ToolRepetitionDetector(2, 5)

			detector.check(createToolUse("same-tool", "same-tool", { a: "1", b: "2", c: "3" }))
			detector.check(createToolUse("same-tool", "same-tool", { c: "3", a: "1", b: "2" }))
			const result = detector.check(createToolUse("same-tool", "same-tool", { b: "2", c: "3", a: "1" }))

			// Sorted keys mean these are identical, reaching the soft limit (2)
			expect(result.action).toBe("soft_block")
		})
	})

	// ===== Native Protocol (nativeArgs) tests =====
	describe("native protocol with nativeArgs", () => {
		it("should differentiate read_file calls with different files in nativeArgs", () => {
			const detector = new ToolRepetitionDetector(2, 5)

			// Create read_file tool use with nativeArgs (like native protocol does)
			const readFile1: ToolUse = {
				type: "tool_use",
				name: "read_file" as ToolName,
				params: {}, // Empty for native protocol
				partial: false,
				nativeArgs: {
					path: "file1.ts",
				},
			}

			const readFile2: ToolUse = {
				type: "tool_use",
				name: "read_file" as ToolName,
				params: {}, // Empty for native protocol
				partial: false,
				nativeArgs: {
					path: "file2.ts",
				},
			}

			expect(detector.check(readFile1).action).toBe("allow")
			expect(detector.check(readFile2).action).toBe("allow")
			expect(detector.check(readFile1).action).toBe("allow")
		})

		it("should detect repetition when same files are read multiple times with nativeArgs", () => {
			const detector = new ToolRepetitionDetector(2, 5)

			// Create identical read_file tool uses
			const readFile: ToolUse = {
				type: "tool_use",
				name: "read_file" as ToolName,
				params: {}, // Empty for native protocol
				partial: false,
				nativeArgs: {
					path: "same-file.ts",
				},
			}

			expect(detector.check(readFile).action).toBe("allow")
			expect(detector.check(readFile).action).toBe("allow")
			expect(detector.check(readFile).action).toBe("soft_block")
		})

		it("should treat different slice offsets as distinct read_file calls", () => {
			const detector = new ToolRepetitionDetector(2, 5)

			const readFile1: ToolUse = {
				type: "tool_use",
				name: "read_file" as ToolName,
				params: {},
				partial: false,
				nativeArgs: {
					path: "a.ts",
					offset: 1,
					limit: 2000,
				},
			}

			const readFile2: ToolUse = {
				type: "tool_use",
				name: "read_file" as ToolName,
				params: {},
				partial: false,
				nativeArgs: {
					path: "a.ts",
					offset: 2001,
					limit: 2000,
				},
			}

			expect(detector.check(readFile1).action).toBe("allow")
			expect(detector.check(readFile2).action).toBe("allow")
		})

		it("should handle tools with both params and nativeArgs", () => {
			const detector = new ToolRepetitionDetector(2, 5)

			const tool1: ToolUse = {
				type: "tool_use",
				name: "execute_command" as ToolName,
				params: { command: "ls" },
				partial: false,
				nativeArgs: {
					command: "ls",
					cwd: "/home/user",
				},
			}

			const tool2: ToolUse = {
				type: "tool_use",
				name: "execute_command" as ToolName,
				params: { command: "ls" },
				partial: false,
				nativeArgs: {
					command: "ls",
					cwd: "/home/admin",
				},
			}

			// Different cwd in nativeArgs should make these different
			expect(detector.check(tool1).action).toBe("allow")
			expect(detector.check(tool2).action).toBe("allow")
		})

		it("should handle tools with only params (no nativeArgs)", () => {
			const detector = new ToolRepetitionDetector(2, 5)

			const legacyTool = createToolUse("read_file", "read_file", { path: "test.txt" })

			// Should work the same as before
			expect(detector.check(legacyTool).action).toBe("allow")
			expect(detector.check(legacyTool).action).toBe("allow")
			expect(detector.check(legacyTool).action).toBe("soft_block")
		})
	})
})
