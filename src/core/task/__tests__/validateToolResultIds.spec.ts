import { Anthropic } from "@anthropic-ai/sdk"
import { TelemetryService } from "@roo-code/telemetry"
import {
	validateAndFixToolResultIds,
	hoistToolResultsToFront,
	ToolResultIdMismatchError,
	MissingToolResultError,
} from "../validateToolResultIds"

// Mock TelemetryService
vi.mock("@roo-code/telemetry", () => ({
	TelemetryService: {
		hasInstance: vi.fn(() => true),
		instance: {
			captureException: vi.fn(),
		},
	},
}))

describe("validateAndFixToolResultIds", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	describe("when there is no previous assistant message", () => {
		it("should return the user message unchanged", () => {
			const userMessage: Anthropic.MessageParam = {
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "tool-123",
						content: "Result",
					},
				],
			}

			const result = validateAndFixToolResultIds(userMessage, [])

			expect(result).toEqual(userMessage)
		})
	})

	describe("when tool_result IDs match tool_use IDs", () => {
		it("should return the user message unchanged for single tool", () => {
			const assistantMessage: Anthropic.MessageParam = {
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: "tool-123",
						name: "read_file",
						input: { path: "test.txt" },
					},
				],
			}

			const userMessage: Anthropic.MessageParam = {
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "tool-123",
						content: "File content",
					},
				],
			}

			const result = validateAndFixToolResultIds(userMessage, [assistantMessage])

			expect(result).toEqual(userMessage)
		})

		it("should return the user message unchanged for multiple tools", () => {
			const assistantMessage: Anthropic.MessageParam = {
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: "tool-1",
						name: "read_file",
						input: { path: "a.txt" },
					},
					{
						type: "tool_use",
						id: "tool-2",
						name: "read_file",
						input: { path: "b.txt" },
					},
				],
			}

			const userMessage: Anthropic.MessageParam = {
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "tool-1",
						content: "Content A",
					},
					{
						type: "tool_result",
						tool_use_id: "tool-2",
						content: "Content B",
					},
				],
			}

			const result = validateAndFixToolResultIds(userMessage, [assistantMessage])

			expect(result).toEqual(userMessage)
		})
	})

	describe("when tool_result IDs do not match tool_use IDs", () => {
		it("should fix single mismatched tool_use_id by position", () => {
			const assistantMessage: Anthropic.MessageParam = {
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: "correct-id-123",
						name: "read_file",
						input: { path: "test.txt" },
					},
				],
			}

			const userMessage: Anthropic.MessageParam = {
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "wrong-id-456",
						content: "File content",
					},
				],
			}

			const result = validateAndFixToolResultIds(userMessage, [assistantMessage])

			expect(Array.isArray(result.content)).toBe(true)
			const resultContent = result.content as Anthropic.ToolResultBlockParam[]
			expect(resultContent[0].tool_use_id).toBe("correct-id-123")
			expect(resultContent[0].content).toBe("File content")
		})

		it("should fix multiple mismatched tool_use_ids by position", () => {
			const assistantMessage: Anthropic.MessageParam = {
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: "correct-1",
						name: "read_file",
						input: { path: "a.txt" },
					},
					{
						type: "tool_use",
						id: "correct-2",
						name: "read_file",
						input: { path: "b.txt" },
					},
				],
			}

			const userMessage: Anthropic.MessageParam = {
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "wrong-1",
						content: "Content A",
					},
					{
						type: "tool_result",
						tool_use_id: "wrong-2",
						content: "Content B",
					},
				],
			}

			const result = validateAndFixToolResultIds(userMessage, [assistantMessage])

			expect(Array.isArray(result.content)).toBe(true)
			const resultContent = result.content as Anthropic.ToolResultBlockParam[]
			expect(resultContent[0].tool_use_id).toBe("correct-1")
			expect(resultContent[1].tool_use_id).toBe("correct-2")
		})

		it("should partially fix when some IDs match and some don't", () => {
			const assistantMessage: Anthropic.MessageParam = {
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: "id-1",
						name: "read_file",
						input: { path: "a.txt" },
					},
					{
						type: "tool_use",
						id: "id-2",
						name: "read_file",
						input: { path: "b.txt" },
					},
				],
			}

			const userMessage: Anthropic.MessageParam = {
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "id-1", // Correct
						content: "Content A",
					},
					{
						type: "tool_result",
						tool_use_id: "wrong-id", // Wrong
						content: "Content B",
					},
				],
			}

			const result = validateAndFixToolResultIds(userMessage, [assistantMessage])

			expect(Array.isArray(result.content)).toBe(true)
			const resultContent = result.content as Anthropic.ToolResultBlockParam[]
			expect(resultContent[0].tool_use_id).toBe("id-1")
			expect(resultContent[1].tool_use_id).toBe("id-2")
		})
	})

	describe("when user message has non-tool_result content", () => {
		it("should preserve text blocks alongside tool_result blocks", () => {
			const assistantMessage: Anthropic.MessageParam = {
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: "tool-123",
						name: "read_file",
						input: { path: "test.txt" },
					},
				],
			}

			const userMessage: Anthropic.MessageParam = {
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "wrong-id",
						content: "File content",
					},
					{
						type: "text",
						text: "Additional context",
					},
				],
			}

			const result = validateAndFixToolResultIds(userMessage, [assistantMessage])

			expect(Array.isArray(result.content)).toBe(true)
			const resultContent = result.content as Array<Anthropic.ToolResultBlockParam | Anthropic.TextBlockParam>
			expect(resultContent[0].type).toBe("tool_result")
			expect((resultContent[0] as Anthropic.ToolResultBlockParam).tool_use_id).toBe("tool-123")
			expect(resultContent[1].type).toBe("text")
			expect((resultContent[1] as Anthropic.TextBlockParam).text).toBe("Additional context")
		})
	})

	describe("when assistant message has non-tool_use content", () => {
		it("should only consider tool_use blocks for matching", () => {
			const assistantMessage: Anthropic.MessageParam = {
				role: "assistant",
				content: [
					{
						type: "text",
						text: "Let me read that file for you.",
					},
					{
						type: "tool_use",
						id: "tool-123",
						name: "read_file",
						input: { path: "test.txt" },
					},
				],
			}

			const userMessage: Anthropic.MessageParam = {
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "wrong-id",
						content: "File content",
					},
				],
			}

			const result = validateAndFixToolResultIds(userMessage, [assistantMessage])

			expect(Array.isArray(result.content)).toBe(true)
			const resultContent = result.content as Anthropic.ToolResultBlockParam[]
			expect(resultContent[0].tool_use_id).toBe("tool-123")
		})
	})

	describe("when user message content is a string", () => {
		it("should return the message unchanged", () => {
			const assistantMessage: Anthropic.MessageParam = {
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: "tool-123",
						name: "read_file",
						input: { path: "test.txt" },
					},
				],
			}

			const userMessage: Anthropic.MessageParam = {
				role: "user",
				content: "Just a plain text message",
			}

			const result = validateAndFixToolResultIds(userMessage, [assistantMessage])

			expect(result).toEqual(userMessage)
		})
	})

	describe("when assistant message content is a string", () => {
		it("should return the user message unchanged", () => {
			const assistantMessage: Anthropic.MessageParam = {
				role: "assistant",
				content: "Just some text, no tool use",
			}

			const userMessage: Anthropic.MessageParam = {
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "tool-123",
						content: "Result",
					},
				],
			}

			const result = validateAndFixToolResultIds(userMessage, [assistantMessage])

			expect(result).toEqual(userMessage)
		})
	})

	describe("when there are more tool_results than tool_uses", () => {
		it("should filter out orphaned tool_results with invalid IDs", () => {
			const assistantMessage: Anthropic.MessageParam = {
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: "tool-1",
						name: "read_file",
						input: { path: "test.txt" },
					},
				],
			}

			const userMessage: Anthropic.MessageParam = {
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "wrong-1",
						content: "Content 1",
					},
					{
						type: "tool_result",
						tool_use_id: "extra-id",
						content: "Content 2",
					},
				],
			}

			const result = validateAndFixToolResultIds(userMessage, [assistantMessage])

			expect(Array.isArray(result.content)).toBe(true)
			const resultContent = result.content as Anthropic.ToolResultBlockParam[]
			// Only one tool_result should remain - the first one gets fixed to tool-1
			expect(resultContent.length).toBe(1)
			expect(resultContent[0].tool_use_id).toBe("tool-1")
		})

		it("should filter out duplicate tool_results when one already has a valid ID", () => {
			// This is the exact scenario from the PostHog error:
			// 2 tool_results (call_08230257, call_55577629), 1 tool_use (call_55577629)
			const assistantMessage: Anthropic.MessageParam = {
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: "call_55577629",
						name: "read_file",
						input: { path: "test.txt" },
					},
				],
			}

			const userMessage: Anthropic.MessageParam = {
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "call_08230257", // Invalid ID
						content: "Content from first result",
					},
					{
						type: "tool_result",
						tool_use_id: "call_55577629", // Valid ID
						content: "Content from second result",
					},
				],
			}

			const result = validateAndFixToolResultIds(userMessage, [assistantMessage])

			expect(Array.isArray(result.content)).toBe(true)
			const resultContent = result.content as Anthropic.ToolResultBlockParam[]
			// Should only keep one tool_result since there's only one tool_use
			// The first invalid one gets fixed to the valid ID, then the second one
			// (which already has that ID) becomes a duplicate and is filtered out
			expect(resultContent.length).toBe(1)
			expect(resultContent[0].tool_use_id).toBe("call_55577629")
		})

		it("should preserve text blocks while filtering orphaned tool_results", () => {
			const assistantMessage: Anthropic.MessageParam = {
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: "tool-1",
						name: "read_file",
						input: { path: "test.txt" },
					},
				],
			}

			const userMessage: Anthropic.MessageParam = {
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "wrong-1",
						content: "Content 1",
					},
					{
						type: "text",
						text: "Some additional context",
					},
					{
						type: "tool_result",
						tool_use_id: "extra-id",
						content: "Content 2",
					},
				],
			}

			const result = validateAndFixToolResultIds(userMessage, [assistantMessage])

			expect(Array.isArray(result.content)).toBe(true)
			const resultContent = result.content as Array<Anthropic.ToolResultBlockParam | Anthropic.TextBlockParam>
			// Should have tool_result + text block, orphaned tool_result filtered out
			expect(resultContent.length).toBe(2)
			expect(resultContent[0].type).toBe("tool_result")
			expect((resultContent[0] as Anthropic.ToolResultBlockParam).tool_use_id).toBe("tool-1")
			expect(resultContent[1].type).toBe("text")
			expect((resultContent[1] as Anthropic.TextBlockParam).text).toBe("Some additional context")
		})

		// Verifies fix for GitHub #10465: Terminal fallback race condition can generate
		// duplicate tool_results with the same valid tool_use_id, causing API protocol violations.
		it("should filter out duplicate tool_results with identical valid tool_use_ids (terminal fallback scenario)", () => {
			const assistantMessage: Anthropic.MessageParam = {
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: "tooluse_QZ-pU8v2QKO8L8fHoJRI2g",
						name: "execute_command",
						input: { command: "ps aux | grep test", cwd: "/path/to/project" },
					},
				],
			}

			// Two tool_results with the SAME valid tool_use_id from terminal fallback race condition
			const userMessage: Anthropic.MessageParam = {
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "tooluse_QZ-pU8v2QKO8L8fHoJRI2g", // First result from command execution
						content: "No test processes found",
					},
					{
						type: "tool_result",
						tool_use_id: "tooluse_QZ-pU8v2QKO8L8fHoJRI2g", // Duplicate from user approval during fallback
						content: '{"status":"approved","message":"The user approved this operation"}',
					},
				],
			}

			const result = validateAndFixToolResultIds(userMessage, [assistantMessage])

			expect(Array.isArray(result.content)).toBe(true)
			const resultContent = result.content as Anthropic.ToolResultBlockParam[]

			// Only ONE tool_result should remain to prevent API protocol violation
			expect(resultContent.length).toBe(1)
			expect(resultContent[0].tool_use_id).toBe("tooluse_QZ-pU8v2QKO8L8fHoJRI2g")
			expect(resultContent[0].content).toBe("No test processes found")
		})

		it("should preserve text blocks while deduplicating tool_results with same valid ID", () => {
			const assistantMessage: Anthropic.MessageParam = {
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: "tool-123",
						name: "read_file",
						input: { path: "test.txt" },
					},
				],
			}

			const userMessage: Anthropic.MessageParam = {
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "tool-123",
						content: "First result",
					},
					{
						type: "text",
						text: "Environment details here",
					},
					{
						type: "tool_result",
						tool_use_id: "tool-123", // Duplicate with same valid ID
						content: "Duplicate result from fallback",
					},
				],
			}

			const result = validateAndFixToolResultIds(userMessage, [assistantMessage])

			expect(Array.isArray(result.content)).toBe(true)
			const resultContent = result.content as Array<Anthropic.ToolResultBlockParam | Anthropic.TextBlockParam>

			// Should have: 1 tool_result + 1 text block (duplicate filtered out)
			expect(resultContent.length).toBe(2)
			expect(resultContent[0].type).toBe("tool_result")
			expect((resultContent[0] as Anthropic.ToolResultBlockParam).tool_use_id).toBe("tool-123")
			expect((resultContent[0] as Anthropic.ToolResultBlockParam).content).toBe("First result")
			expect(resultContent[1].type).toBe("text")
			expect((resultContent[1] as Anthropic.TextBlockParam).text).toBe("Environment details here")
		})
	})

	describe("when there are more tool_uses than tool_results", () => {
		it("should fix the available tool_results and add missing ones", () => {
			const assistantMessage: Anthropic.MessageParam = {
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: "tool-1",
						name: "read_file",
						input: { path: "a.txt" },
					},
					{
						type: "tool_use",
						id: "tool-2",
						name: "read_file",
						input: { path: "b.txt" },
					},
				],
			}

			const userMessage: Anthropic.MessageParam = {
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "wrong-1",
						content: "Content 1",
					},
				],
			}

			const result = validateAndFixToolResultIds(userMessage, [assistantMessage])

			expect(Array.isArray(result.content)).toBe(true)
			const resultContent = result.content as Anthropic.ToolResultBlockParam[]
			// Should now have 2 tool_results: one fixed and one added for the missing tool_use
			expect(resultContent.length).toBe(2)
			// The missing tool_result is prepended
			expect(resultContent[0].tool_use_id).toBe("tool-2")
			expect(resultContent[0].content).toBe("Tool execution was interrupted before completion.")
			// The original is fixed
			expect(resultContent[1].tool_use_id).toBe("tool-1")
		})
	})

	describe("when tool_results are completely missing", () => {
		it("should add missing tool_result for single tool_use", () => {
			const assistantMessage: Anthropic.MessageParam = {
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: "tool-123",
						name: "read_file",
						input: { path: "test.txt" },
					},
				],
			}

			const userMessage: Anthropic.MessageParam = {
				role: "user",
				content: [
					{
						type: "text",
						text: "Some user message without tool results",
					},
				],
			}

			const result = validateAndFixToolResultIds(userMessage, [assistantMessage])

			expect(Array.isArray(result.content)).toBe(true)
			const resultContent = result.content as Array<Anthropic.ToolResultBlockParam | Anthropic.TextBlockParam>
			expect(resultContent.length).toBe(2)
			// Missing tool_result should be prepended
			expect(resultContent[0].type).toBe("tool_result")
			expect((resultContent[0] as Anthropic.ToolResultBlockParam).tool_use_id).toBe("tool-123")
			expect((resultContent[0] as Anthropic.ToolResultBlockParam).content).toBe(
				"Tool execution was interrupted before completion.",
			)
			// Original text block should be preserved
			expect(resultContent[1].type).toBe("text")
		})

		it("should add missing tool_results for multiple tool_uses", () => {
			const assistantMessage: Anthropic.MessageParam = {
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: "tool-1",
						name: "read_file",
						input: { path: "a.txt" },
					},
					{
						type: "tool_use",
						id: "tool-2",
						name: "write_to_file",
						input: { path: "b.txt", content: "test" },
					},
				],
			}

			const userMessage: Anthropic.MessageParam = {
				role: "user",
				content: [
					{
						type: "text",
						text: "User message",
					},
				],
			}

			const result = validateAndFixToolResultIds(userMessage, [assistantMessage])

			expect(Array.isArray(result.content)).toBe(true)
			const resultContent = result.content as Array<Anthropic.ToolResultBlockParam | Anthropic.TextBlockParam>
			expect(resultContent.length).toBe(3)
			// Both missing tool_results should be prepended
			expect(resultContent[0].type).toBe("tool_result")
			expect((resultContent[0] as Anthropic.ToolResultBlockParam).tool_use_id).toBe("tool-1")
			expect(resultContent[1].type).toBe("tool_result")
			expect((resultContent[1] as Anthropic.ToolResultBlockParam).tool_use_id).toBe("tool-2")
			// Original text should be preserved
			expect(resultContent[2].type).toBe("text")
		})

		it("should add only the missing tool_results when some exist", () => {
			const assistantMessage: Anthropic.MessageParam = {
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: "tool-1",
						name: "read_file",
						input: { path: "a.txt" },
					},
					{
						type: "tool_use",
						id: "tool-2",
						name: "write_to_file",
						input: { path: "b.txt", content: "test" },
					},
				],
			}

			const userMessage: Anthropic.MessageParam = {
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "tool-1",
						content: "Content for tool 1",
					},
				],
			}

			const result = validateAndFixToolResultIds(userMessage, [assistantMessage])

			expect(Array.isArray(result.content)).toBe(true)
			const resultContent = result.content as Anthropic.ToolResultBlockParam[]
			expect(resultContent.length).toBe(2)
			// Missing tool_result for tool-2 should be prepended
			expect(resultContent[0].tool_use_id).toBe("tool-2")
			expect(resultContent[0].content).toBe("Tool execution was interrupted before completion.")
			// Existing tool_result should be preserved
			expect(resultContent[1].tool_use_id).toBe("tool-1")
			expect(resultContent[1].content).toBe("Content for tool 1")
		})

		it("should handle empty user content array by adding all missing tool_results", () => {
			const assistantMessage: Anthropic.MessageParam = {
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: "tool-1",
						name: "read_file",
						input: { path: "test.txt" },
					},
				],
			}

			const userMessage: Anthropic.MessageParam = {
				role: "user",
				content: [],
			}

			const result = validateAndFixToolResultIds(userMessage, [assistantMessage])

			expect(Array.isArray(result.content)).toBe(true)
			const resultContent = result.content as Anthropic.ToolResultBlockParam[]
			expect(resultContent.length).toBe(1)
			expect(resultContent[0].type).toBe("tool_result")
			expect(resultContent[0].tool_use_id).toBe("tool-1")
			expect(resultContent[0].content).toBe("Tool execution was interrupted before completion.")
		})
	})

	describe("telemetry", () => {
		it("should call captureException for both missing and mismatch when there is a mismatch", () => {
			const assistantMessage: Anthropic.MessageParam = {
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: "correct-id",
						name: "read_file",
						input: { path: "test.txt" },
					},
				],
			}

			const userMessage: Anthropic.MessageParam = {
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "wrong-id",
						content: "Content",
					},
				],
			}

			validateAndFixToolResultIds(userMessage, [assistantMessage])

			// A mismatch also triggers missing detection since the wrong-id doesn't match any tool_use
			expect(TelemetryService.instance.captureException).toHaveBeenCalledTimes(2)
			expect(TelemetryService.instance.captureException).toHaveBeenCalledWith(
				expect.any(MissingToolResultError),
				expect.objectContaining({
					missingToolUseIds: ["correct-id"],
					existingToolResultIds: ["wrong-id"],
					toolUseCount: 1,
					toolResultCount: 1,
				}),
			)
			expect(TelemetryService.instance.captureException).toHaveBeenCalledWith(
				expect.any(ToolResultIdMismatchError),
				expect.objectContaining({
					toolResultIds: ["wrong-id"],
					toolUseIds: ["correct-id"],
					toolResultCount: 1,
					toolUseCount: 1,
				}),
			)
		})

		it("should not call captureException when IDs match", () => {
			const assistantMessage: Anthropic.MessageParam = {
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: "tool-123",
						name: "read_file",
						input: { path: "test.txt" },
					},
				],
			}

			const userMessage: Anthropic.MessageParam = {
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "tool-123",
						content: "Content",
					},
				],
			}

			validateAndFixToolResultIds(userMessage, [assistantMessage])

			expect(TelemetryService.instance.captureException).not.toHaveBeenCalled()
		})
	})

	describe("ToolResultIdMismatchError", () => {
		it("should create error with correct properties", () => {
			const error = new ToolResultIdMismatchError(
				"Mismatch detected",
				["result-1", "result-2"],
				["use-1", "use-2"],
			)

			expect(error.name).toBe("ToolResultIdMismatchError")
			expect(error.message).toBe("Mismatch detected")
			expect(error.toolResultIds).toEqual(["result-1", "result-2"])
			expect(error.toolUseIds).toEqual(["use-1", "use-2"])
		})
	})

	describe("MissingToolResultError", () => {
		it("should create error with correct properties", () => {
			const error = new MissingToolResultError(
				"Missing tool results detected",
				["tool-1", "tool-2"],
				["existing-result-1"],
			)

			expect(error.name).toBe("MissingToolResultError")
			expect(error.message).toBe("Missing tool results detected")
			expect(error.missingToolUseIds).toEqual(["tool-1", "tool-2"])
			expect(error.existingToolResultIds).toEqual(["existing-result-1"])
		})
	})

	describe("telemetry for missing tool_results", () => {
		it("should call captureException when tool_results are missing", () => {
			const assistantMessage: Anthropic.MessageParam = {
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: "tool-123",
						name: "read_file",
						input: { path: "test.txt" },
					},
				],
			}

			const userMessage: Anthropic.MessageParam = {
				role: "user",
				content: [
					{
						type: "text",
						text: "No tool results here",
					},
				],
			}

			validateAndFixToolResultIds(userMessage, [assistantMessage])

			expect(TelemetryService.instance.captureException).toHaveBeenCalledTimes(1)
			expect(TelemetryService.instance.captureException).toHaveBeenCalledWith(
				expect.any(MissingToolResultError),
				expect.objectContaining({
					missingToolUseIds: ["tool-123"],
					existingToolResultIds: [],
					toolUseCount: 1,
					toolResultCount: 0,
				}),
			)
		})

		it("should call captureException twice when both mismatch and missing occur", () => {
			const assistantMessage: Anthropic.MessageParam = {
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: "tool-1",
						name: "read_file",
						input: { path: "a.txt" },
					},
					{
						type: "tool_use",
						id: "tool-2",
						name: "read_file",
						input: { path: "b.txt" },
					},
				],
			}

			const userMessage: Anthropic.MessageParam = {
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "wrong-id", // Wrong ID (mismatch)
						content: "Content",
					},
					// Missing tool_result for tool-2
				],
			}

			validateAndFixToolResultIds(userMessage, [assistantMessage])

			// Should be called twice: once for missing, once for mismatch
			expect(TelemetryService.instance.captureException).toHaveBeenCalledTimes(2)
			expect(TelemetryService.instance.captureException).toHaveBeenCalledWith(
				expect.any(MissingToolResultError),
				expect.any(Object),
			)
			expect(TelemetryService.instance.captureException).toHaveBeenCalledWith(
				expect.any(ToolResultIdMismatchError),
				expect.any(Object),
			)
		})

		it("should not call captureException for missing when all tool_results exist", () => {
			const assistantMessage: Anthropic.MessageParam = {
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: "tool-123",
						name: "read_file",
						input: { path: "test.txt" },
					},
				],
			}

			const userMessage: Anthropic.MessageParam = {
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "tool-123",
						content: "Content",
					},
				],
			}

			validateAndFixToolResultIds(userMessage, [assistantMessage])

			expect(TelemetryService.instance.captureException).not.toHaveBeenCalled()
		})
	})

	// Anthropic requires that tool_result blocks come FIRST in the user message content array;
	// see the doc comment on `hoistToolResultsToFront()`.
	describe("when tool_results are interleaved with other block types", () => {
		it("should hoist a tool_result that follows an image block from a parallel tool call", () => {
			const assistantMessage: Anthropic.MessageParam = {
				role: "assistant",
				content: [
					{ type: "text", text: "The visual confirms it: ..." },
					{
						type: "tool_use",
						id: "tooluse_UDLZ6mSXfpiIeVAHk5NnIR",
						name: "execute_command",
						input: { command: "WS=/..." },
					},
					{
						type: "tool_use",
						id: "tooluse_NudlJpcjeQemU5wudkIYMA",
						name: "execute_command",
						input: { command: "git diff --stat -- python/" },
					},
				],
			}

			const userMessage: Anthropic.MessageParam = {
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "tooluse_UDLZ6mSXfpiIeVAHk5NnIR",
						content: "Exit code: 0",
					},
					{
						type: "image",
						source: { type: "base64", media_type: "image/png", data: "iVBOR" },
					},
					{
						type: "tool_result",
						tool_use_id: "tooluse_NudlJpcjeQemU5wudkIYMA",
						content: "Exit code: 0",
					},
					{ type: "text", text: "<user_message>Something wrong with the tool use?</user_message>" },
					{ type: "text", text: "<environment_details>...</environment_details>" },
				],
			}

			const result = validateAndFixToolResultIds(userMessage, [assistantMessage])
			const content = result.content as Anthropic.Messages.ContentBlockParam[]

			// Both tool_results must form one contiguous leading run.
			expect(content.map((block) => block.type)).toEqual(["tool_result", "tool_result", "image", "text", "text"])
			// IDs and content are preserved, and no synthetic "interrupted" result is invented.
			expect((content[0] as Anthropic.ToolResultBlockParam).tool_use_id).toBe("tooluse_UDLZ6mSXfpiIeVAHk5NnIR")
			expect((content[1] as Anthropic.ToolResultBlockParam).tool_use_id).toBe("tooluse_NudlJpcjeQemU5wudkIYMA")
			expect((content[1] as Anthropic.ToolResultBlockParam).content).toBe("Exit code: 0")
			// Telemetry should not fire: nothing is missing or mismatched, only misordered.
			expect(TelemetryService.instance.captureException).not.toHaveBeenCalled()
		})

		it("should hoist tool_results that follow a text block", () => {
			const assistantMessage: Anthropic.MessageParam = {
				role: "assistant",
				content: [
					{ type: "tool_use", id: "tool-1", name: "read_file", input: {} },
					{ type: "tool_use", id: "tool-2", name: "read_file", input: {} },
				],
			}

			const userMessage: Anthropic.MessageParam = {
				role: "user",
				content: [
					{ type: "text", text: "Here are the results:" },
					{ type: "tool_result", tool_use_id: "tool-1", content: "A" },
					{ type: "tool_result", tool_use_id: "tool-2", content: "B" },
				],
			}

			const result = validateAndFixToolResultIds(userMessage, [assistantMessage])
			const content = result.content as Anthropic.Messages.ContentBlockParam[]

			expect(content.map((block) => block.type)).toEqual(["tool_result", "tool_result", "text"])
			expect((content[0] as Anthropic.ToolResultBlockParam).tool_use_id).toBe("tool-1")
			expect((content[1] as Anthropic.ToolResultBlockParam).tool_use_id).toBe("tool-2")
		})

		it("should deduplicate and hoist without mismatching IDs by position", () => {
			// The duplicate must be dropped BEFORE positional ID correction, otherwise the
			// interleaved ordering could cause a valid result to be reassigned the wrong ID.
			const assistantMessage: Anthropic.MessageParam = {
				role: "assistant",
				content: [
					{ type: "tool_use", id: "tool-1", name: "read_file", input: {} },
					{ type: "tool_use", id: "tool-2", name: "read_file", input: {} },
				],
			}

			const userMessage: Anthropic.MessageParam = {
				role: "user",
				content: [
					{ type: "tool_result", tool_use_id: "tool-1", content: "A" },
					{ type: "image", source: { type: "base64", media_type: "image/png", data: "x" } },
					{ type: "tool_result", tool_use_id: "tool-1", content: "duplicate" },
					{ type: "tool_result", tool_use_id: "tool-2", content: "B" },
				],
			}

			const result = validateAndFixToolResultIds(userMessage, [assistantMessage])
			const content = result.content as Anthropic.Messages.ContentBlockParam[]

			expect(content.map((block) => block.type)).toEqual(["tool_result", "tool_result", "image"])
			expect((content[0] as Anthropic.ToolResultBlockParam).content).toBe("A")
			expect((content[1] as Anthropic.ToolResultBlockParam).tool_use_id).toBe("tool-2")
			expect((content[1] as Anthropic.ToolResultBlockParam).content).toBe("B")
		})
	})
})

describe("hoistToolResultsToFront", () => {
	it("returns the same array reference when tool_results are already contiguous at the front", () => {
		const content: Anthropic.Messages.ContentBlockParam[] = [
			{ type: "tool_result", tool_use_id: "tool-1", content: "A" },
			{ type: "tool_result", tool_use_id: "tool-2", content: "B" },
			{ type: "image", source: { type: "base64", media_type: "image/png", data: "x" } },
			{ type: "text", text: "env" },
		]

		expect(hoistToolResultsToFront(content)).toBe(content)
	})

	it("returns the same array reference when there are no tool_result blocks", () => {
		const content: Anthropic.Messages.ContentBlockParam[] = [
			{ type: "text", text: "hello" },
			{ type: "image", source: { type: "base64", media_type: "image/png", data: "x" } },
		]

		expect(hoistToolResultsToFront(content)).toBe(content)
	})

	it("returns the same array reference for an empty array", () => {
		const content: Anthropic.Messages.ContentBlockParam[] = []
		expect(hoistToolResultsToFront(content)).toBe(content)
	})

	it("returns the same array reference when every block is a tool_result", () => {
		const content: Anthropic.Messages.ContentBlockParam[] = [
			{ type: "tool_result", tool_use_id: "tool-1", content: "A" },
			{ type: "tool_result", tool_use_id: "tool-2", content: "B" },
		]

		expect(hoistToolResultsToFront(content)).toBe(content)
	})

	it("preserves the relative order of both tool_results and other blocks", () => {
		const content: Anthropic.Messages.ContentBlockParam[] = [
			{ type: "text", text: "first" },
			{ type: "tool_result", tool_use_id: "tool-1", content: "A" },
			{ type: "text", text: "second" },
			{ type: "tool_result", tool_use_id: "tool-2", content: "B" },
			{ type: "text", text: "third" },
		]

		const result = hoistToolResultsToFront(content)

		expect(result).toEqual([
			{ type: "tool_result", tool_use_id: "tool-1", content: "A" },
			{ type: "tool_result", tool_use_id: "tool-2", content: "B" },
			{ type: "text", text: "first" },
			{ type: "text", text: "second" },
			{ type: "text", text: "third" },
		])
	})

	it("does not mutate the input array", () => {
		const content: Anthropic.Messages.ContentBlockParam[] = [
			{ type: "text", text: "first" },
			{ type: "tool_result", tool_use_id: "tool-1", content: "A" },
		]
		const snapshot = [...content]

		hoistToolResultsToFront(content)

		expect(content).toEqual(snapshot)
	})
})
