import { describe, it, expect, vi, beforeEach } from "vitest"

import type { Task } from "../../task/Task"
import type { ToolUse } from "../../../shared/tools"
import type { ToolCallbacks } from "../BaseTool"
import { AskFollowupQuestionTool, askFollowupQuestionTool } from "../AskFollowupQuestionTool"
import { formatResponse } from "../../prompts/responses"
import { NativeToolCallParser } from "../../assistant-message/NativeToolCallParser"

describe("AskFollowupQuestionTool", () => {
	let tool: AskFollowupQuestionTool
	let mockTask: Task
	let mockCallbacks: ToolCallbacks

	beforeEach(() => {
		vi.clearAllMocks()

		tool = new AskFollowupQuestionTool()

		mockTask = {
			consecutiveMistakeCount: 0,
			recordToolError: vi.fn(),
			didToolFailInCurrentTurn: false,
			sayAndCreateMissingParamError: vi.fn().mockResolvedValue("Missing parameter error"),
			ask: vi.fn().mockResolvedValue({ text: "User answer", images: [] }),
			say: vi.fn().mockResolvedValue(undefined),
		} as unknown as Task

		mockCallbacks = {
			askApproval: vi.fn().mockResolvedValue(true),
			handleError: vi.fn(),
			pushToolResult: vi.fn(),
		}
	})

	function createBlock(
		params: { question?: string; follow_up?: Array<{ text: string; mode?: string }> },
		partial = false,
	): ToolUse<"ask_followup_question"> {
		return {
			type: "tool_use" as const,
			name: "ask_followup_question" as const,
			params: params as any,
			partial,
			nativeArgs: {
				question: params.question ?? "",
				follow_up: params.follow_up ?? [],
			},
		} as unknown as ToolUse<"ask_followup_question">
	}

	// ===== Parameter validation tests =====

	it("should handle missing question parameter", async () => {
		const params = { question: "", follow_up: [{ text: "Yes" }] }

		await tool.execute(params, mockTask, mockCallbacks)

		expect(mockTask.consecutiveMistakeCount).toBe(1)
		expect(mockTask.recordToolError).toHaveBeenCalledWith("ask_followup_question")
		expect(mockTask.didToolFailInCurrentTurn).toBe(true)
		expect(mockTask.sayAndCreateMissingParamError).toHaveBeenCalledWith("ask_followup_question", "question")
		expect(mockCallbacks.pushToolResult).toHaveBeenCalledWith("Missing parameter error")
	})

	it("should handle missing follow_up parameter (null)", async () => {
		const params = { question: "What?", follow_up: null as any }

		await tool.execute(params, mockTask, mockCallbacks)

		expect(mockTask.consecutiveMistakeCount).toBe(1)
		expect(mockTask.recordToolError).toHaveBeenCalledWith("ask_followup_question")
		expect(mockTask.didToolFailInCurrentTurn).toBe(true)
		expect(mockTask.sayAndCreateMissingParamError).toHaveBeenCalledWith("ask_followup_question", "follow_up")
		expect(mockCallbacks.pushToolResult).toHaveBeenCalledWith("Missing parameter error")
	})

	it("should handle missing follow_up parameter (undefined)", async () => {
		const params = { question: "What?", follow_up: undefined as any }

		await tool.execute(params, mockTask, mockCallbacks)

		expect(mockTask.sayAndCreateMissingParamError).toHaveBeenCalledWith("ask_followup_question", "follow_up")
	})

	it("should report a type error when follow_up is a string", async () => {
		const params = { question: "What?", follow_up: "not-an-array" as any }

		await tool.execute(params, mockTask, mockCallbacks)

		expect(mockTask.consecutiveMistakeCount).toBe(1)
		expect(mockTask.recordToolError).toHaveBeenCalledWith("ask_followup_question")
		expect(mockTask.didToolFailInCurrentTurn).toBe(true)
		// A present-but-non-array value is a type error.
		expect(mockTask.sayAndCreateMissingParamError).not.toHaveBeenCalled()
		const pushed = (mockCallbacks.pushToolResult as any).mock.calls[0][0]
		expect(pushed).toContain("must be an array")
		expect(pushed).not.toContain("Missing value")
	})

	it("should report a type error when follow_up is an object", async () => {
		// Reproduces the issue: follow_up arrives as a keyed object instead of an array.
		const params = {
			question: "How should I proceed?",
			follow_up: {
				"0": { mode: null, text: "Keep the guard" },
				"1": { mode: null, text: "Remove the guard" },
			} as any,
		}

		await tool.execute(params, mockTask, mockCallbacks)

		expect(mockTask.consecutiveMistakeCount).toBe(1)
		expect(mockTask.recordToolError).toHaveBeenCalledWith("ask_followup_question")
		expect(mockTask.didToolFailInCurrentTurn).toBe(true)
		expect(mockTask.sayAndCreateMissingParamError).not.toHaveBeenCalled()
		expect(mockTask.say).toHaveBeenCalledWith("error", expect.stringContaining("must be an array"))
		const pushed = (mockCallbacks.pushToolResult as any).mock.calls[0][0]
		expect(pushed).toContain("must be an array")
		expect(pushed).not.toContain("Missing value")
		// The tool must not proceed to ask the user with an invalid payload.
		expect(mockTask.ask).not.toHaveBeenCalled()
	})

	// ===== Happy path tests =====

	it("should ask the user a followup question with suggestions", async () => {
		const params = {
			question: "What would you like to do?",
			follow_up: [{ text: "Option A" }, { text: "Option B" }],
		}

		await tool.execute(params, mockTask, mockCallbacks)

		const expectedJson = JSON.stringify({
			question: "What would you like to do?",
			suggest: [
				{ answer: "Option A", mode: undefined },
				{ answer: "Option B", mode: undefined },
			],
		})

		expect(mockTask.ask).toHaveBeenCalledWith("followup", expectedJson, false)
	})

	it("should include mode in suggestions when provided", async () => {
		const params = {
			question: "Switch mode?",
			follow_up: [
				{ text: "Use code mode", mode: "code" },
				{ text: "Use architect mode", mode: "architect" },
			],
		}

		await tool.execute(params, mockTask, mockCallbacks)

		const expectedJson = JSON.stringify({
			question: "Switch mode?",
			suggest: [
				{ answer: "Use code mode", mode: "code" },
				{ answer: "Use architect mode", mode: "architect" },
			],
		})

		expect(mockTask.ask).toHaveBeenCalledWith("followup", expectedJson, false)
	})

	it("should normalize malformed object mode values", async () => {
		const params = {
			question: "Switch mode?",
			follow_up: [{ text: "Use code mode", mode: { mode_slug: "code" } }],
		} as any

		await tool.execute(params, mockTask, mockCallbacks)

		const expectedJson = JSON.stringify({
			question: "Switch mode?",
			suggest: [{ answer: "Use code mode", mode: "code" }],
		})

		expect(mockTask.ask).toHaveBeenCalledWith("followup", expectedJson, false)
	})

	it("should say user_feedback and push tool result after user answers", async () => {
		const params = {
			question: "Which approach?",
			follow_up: [{ text: "Approach 1" }],
		}
		;(mockTask.ask as any).mockResolvedValue({ text: "I'll go with Approach 1", images: [] })

		await tool.execute(params, mockTask, mockCallbacks)

		expect(mockTask.say).toHaveBeenCalledWith("user_feedback", "I'll go with Approach 1", [])
		expect(mockCallbacks.pushToolResult).toHaveBeenCalledWith(
			formatResponse.toolResult(`<user_message>\nI'll go with Approach 1\n</user_message>`, []),
		)
	})

	it("should pass images from user response to toolResult", async () => {
		const params = {
			question: "Look at this?",
			follow_up: [{ text: "Yes" }],
		}
		const validDataUrl = "data:image/png;base64,iVBORw0KGgo="
		;(mockTask.ask as any).mockResolvedValue({ text: "See image", images: [validDataUrl] })

		await tool.execute(params, mockTask, mockCallbacks)

		expect(mockTask.say).toHaveBeenCalledWith("user_feedback", "See image", [validDataUrl])
		expect(mockCallbacks.pushToolResult).toHaveBeenCalledWith(
			formatResponse.toolResult("<user_message>\nSee image\n</user_message>", [validDataUrl]),
		)
	})

	it("should reset consecutiveMistakeCount to 0 on success", async () => {
		mockTask.consecutiveMistakeCount = 3
		const params = { question: "What?", follow_up: [{ text: "A" }] }

		await tool.execute(params, mockTask, mockCallbacks)

		expect(mockTask.consecutiveMistakeCount).toBe(0)
	})

	it("should handle user providing empty text response", async () => {
		const params = { question: "What?", follow_up: [{ text: "A" }] }
		;(mockTask.ask as any).mockResolvedValue({ text: "", images: [] })

		await tool.execute(params, mockTask, mockCallbacks)

		expect(mockTask.say).toHaveBeenCalledWith("user_feedback", "", [])
	})

	// ===== Error handling tests =====

	it("should call handleError when task.ask throws", async () => {
		const params = { question: "What?", follow_up: [{ text: "A" }] }
		const error = new Error("ask failed")
		;(mockTask.ask as any).mockRejectedValue(error)

		await tool.execute(params, mockTask, mockCallbacks)

		expect(mockCallbacks.handleError).toHaveBeenCalledWith("asking question", error)
	})

	it("should not call pushToolResult when task.ask throws", async () => {
		const params = { question: "What?", follow_up: [{ text: "A" }] }
		;(mockTask.ask as any).mockRejectedValue(new Error("fail"))

		await tool.execute(params, mockTask, mockCallbacks)

		expect(mockCallbacks.pushToolResult).not.toHaveBeenCalled()
	})

	it("should call handleError when task.say throws", async () => {
		const params = { question: "What?", follow_up: [{ text: "A" }] }
		const error = new Error("say failed")
		;(mockTask.say as any).mockRejectedValue(error)

		await tool.execute(params, mockTask, mockCallbacks)

		expect(mockCallbacks.handleError).toHaveBeenCalledWith("asking question", error)
	})

	// ===== handlePartial tests =====

	it("should show question during partial streaming via handlePartial", async () => {
		const block = createBlock({ question: "What is your preference?", follow_up: [{ text: "A" }] }, true)

		await tool.handlePartial(mockTask, block)

		expect(mockTask.ask).toHaveBeenCalledWith("followup", "What is your preference?", true)
	})

	it("should prefer nativeArgs.question over params.question in handlePartial", async () => {
		const block = {
			type: "tool_use" as const,
			name: "ask_followup_question" as const,
			params: { question: "old question" },
			partial: true,
			nativeArgs: { question: "new question from nativeArgs" },
		} as unknown as ToolUse<"ask_followup_question">

		await tool.handlePartial(mockTask, block)

		expect(mockTask.ask).toHaveBeenCalledWith("followup", "new question from nativeArgs", true)
	})

	it("should fall back to params.question when nativeArgs is undefined in handlePartial", async () => {
		const block = {
			type: "tool_use" as const,
			name: "ask_followup_question" as const,
			params: { question: "fallback question" },
			partial: true,
			nativeArgs: undefined,
		} as unknown as ToolUse<"ask_followup_question">

		await tool.handlePartial(mockTask, block)

		expect(mockTask.ask).toHaveBeenCalledWith("followup", "fallback question", true)
	})

	it("should use empty string when question is undefined in handlePartial", async () => {
		const block = {
			type: "tool_use" as const,
			name: "ask_followup_question" as const,
			params: {},
			partial: true,
			nativeArgs: undefined,
		} as unknown as ToolUse<"ask_followup_question">

		await tool.handlePartial(mockTask, block)

		expect(mockTask.ask).toHaveBeenCalledWith("followup", "", true)
	})

	it("should silently catch errors during handlePartial", async () => {
		const block = createBlock({ question: "What?", follow_up: [{ text: "A" }] }, true)
		;(mockTask.ask as any).mockRejectedValue(new Error("partial failed"))

		// Should not throw
		await expect(tool.handlePartial(mockTask, block)).resolves.toBeUndefined()
	})

	it("should pass block.partial flag to task.ask in handlePartial", async () => {
		const blockPartial = createBlock({ question: "Q?", follow_up: [] }, true)
		await tool.handlePartial(mockTask, blockPartial)
		expect(mockTask.ask).toHaveBeenCalledWith("followup", "Q?", true)
	})

	// ===== Edge case tests =====

	it("should handle empty follow_up array", async () => {
		const params = { question: "What?", follow_up: [] }

		await tool.execute(params, mockTask, mockCallbacks)

		const expectedJson = JSON.stringify({
			question: "What?",
			suggest: [],
		})

		expect(mockTask.ask).toHaveBeenCalledWith("followup", expectedJson, false)
	})

	it("should not call askApproval", async () => {
		const params = { question: "What?", follow_up: [{ text: "A" }] }

		await tool.execute(params, mockTask, mockCallbacks)

		expect(mockCallbacks.askApproval).not.toHaveBeenCalled()
	})

	it("should have correct tool name", () => {
		expect(tool.name).toBe("ask_followup_question")
	})

	// ===== Additional coverage tests =====

	it("should pass multiple images from user response", async () => {
		const params = { question: "Look at these?", follow_up: [{ text: "Yes" }] }
		const img1 = "data:image/png;base64,iVBORw0KGgo="
		const img2 = "data:image/jpeg;base64,/9j/4AAQSkZJRg=="
		;(mockTask.ask as any).mockResolvedValue({ text: "See images", images: [img1, img2] })

		await tool.execute(params, mockTask, mockCallbacks)

		expect(mockTask.say).toHaveBeenCalledWith("user_feedback", "See images", [img1, img2])
		expect(mockCallbacks.pushToolResult).toHaveBeenCalledWith(
			formatResponse.toolResult("<user_message>\nSee images\n</user_message>", [img1, img2]),
		)
	})

	it("should pass empty images array when user provides no images", async () => {
		const params = { question: "What?", follow_up: [{ text: "A" }] }
		;(mockTask.ask as any).mockResolvedValue({ text: "answer", images: [] })

		await tool.execute(params, mockTask, mockCallbacks)

		expect(mockTask.say).toHaveBeenCalledWith("user_feedback", "answer", [])
		expect(mockCallbacks.pushToolResult).toHaveBeenCalledWith(
			formatResponse.toolResult("<user_message>\nanswer\n</user_message>", []),
		)
	})

	it("should handle null text in user response by using empty string", async () => {
		const params = { question: "What?", follow_up: [{ text: "A" }] }
		;(mockTask.ask as any).mockResolvedValue({ text: null, images: [] })

		await tool.execute(params, mockTask, mockCallbacks)

		expect(mockTask.say).toHaveBeenCalledWith("user_feedback", "", [])
	})

	it("should increment consecutiveMistakeCount from existing value", async () => {
		mockTask.consecutiveMistakeCount = 2
		const params = { question: "", follow_up: [{ text: "A" }] }

		await tool.execute(params, mockTask, mockCallbacks)

		expect(mockTask.consecutiveMistakeCount).toBe(3)
	})

	it("should not set didToolFailInCurrentTurn on success", async () => {
		mockTask.didToolFailInCurrentTurn = false
		const params = { question: "What?", follow_up: [{ text: "A" }] }

		await tool.execute(params, mockTask, mockCallbacks)

		expect(mockTask.didToolFailInCurrentTurn).toBe(false)
	})

	it("should not call recordToolError on success", async () => {
		const params = { question: "What?", follow_up: [{ text: "A" }] }

		await tool.execute(params, mockTask, mockCallbacks)

		expect(mockTask.recordToolError).not.toHaveBeenCalled()
	})

	it("should handle question with only whitespace (truthy)", async () => {
		const params = { question: "   ", follow_up: [{ text: "A" }] }

		await tool.execute(params, mockTask, mockCallbacks)

		// Whitespace-only question is truthy, so it should proceed normally
		expect(mockTask.ask).toHaveBeenCalledWith("followup", expect.stringContaining("   "), false)
		expect(mockTask.recordToolError).not.toHaveBeenCalled()
	})

	it("should handle follow_up with mixed mode and undefined mode suggestions", async () => {
		const params = {
			question: "Choose?",
			follow_up: [
				{ text: "With mode", mode: "code" },
				{ text: "Without mode" },
				{ text: "Another with mode", mode: "architect" },
			],
		}

		await tool.execute(params, mockTask, mockCallbacks)

		const expectedJson = JSON.stringify({
			question: "Choose?",
			suggest: [
				{ answer: "With mode", mode: "code" },
				{ answer: "Without mode", mode: undefined },
				{ answer: "Another with mode", mode: "architect" },
			],
		})

		expect(mockTask.ask).toHaveBeenCalledWith("followup", expectedJson, false)
	})

	it("should handle handlePartial with nativeArgs containing empty string question", async () => {
		const block = {
			type: "tool_use" as const,
			name: "ask_followup_question" as const,
			params: { question: "should not use this" },
			partial: true,
			nativeArgs: { question: "" },
		} as unknown as ToolUse<"ask_followup_question">

		await tool.handlePartial(mockTask, block)

		// nativeArgs.question is "" which is used directly (not a fallback since ?? only falls back for null/undefined)
		expect(mockTask.ask).toHaveBeenCalledWith("followup", "", true)
	})

	it("should handle execute when task.ask resolves with undefined text", async () => {
		const params = { question: "What?", follow_up: [{ text: "A" }] }
		;(mockTask.ask as any).mockResolvedValue({ text: undefined, images: [] })

		await tool.execute(params, mockTask, mockCallbacks)

		expect(mockTask.say).toHaveBeenCalledWith("user_feedback", "", [])
		// pushToolResult should receive normalized empty string, NOT "undefined"
		const toolResultArg = (mockCallbacks.pushToolResult as any).mock.calls[0][0]
		expect(toolResultArg).not.toContain("undefined")
		expect(mockCallbacks.pushToolResult).toHaveBeenCalledWith(
			formatResponse.toolResult("<user_message>\n\n</user_message>", []),
		)
	})

	it("should export a singleton askFollowupQuestionTool instance", () => {
		expect(askFollowupQuestionTool).toBeInstanceOf(AskFollowupQuestionTool)
		expect(askFollowupQuestionTool.name).toBe("ask_followup_question")
	})

	// ===== NativeToolCallParser integration tests for ask_followup_question =====

	describe("NativeToolCallParser.createPartialToolUse for ask_followup_question", () => {
		beforeEach(() => {
			NativeToolCallParser.clearAllStreamingToolCalls()
			NativeToolCallParser.clearRawChunkState()
		})

		it("should build nativeArgs with question and follow_up during streaming", () => {
			// Start a streaming tool call
			NativeToolCallParser.startStreamingToolCall("call_123", "ask_followup_question")

			// Simulate streaming JSON chunks
			const chunk1 = '{"question":"What would you like?","follow_up":[{"text":"Option 1","mode":"code"}'
			const result1 = NativeToolCallParser.processStreamingChunk("call_123", chunk1)

			expect(result1).not.toBeNull()
			expect(result1?.name).toBe("ask_followup_question")
			expect(result1?.params.question).toBe("What would you like?")
			expect(result1?.nativeArgs).toBeDefined()
			// Use type assertion to access the specific fields
			const nativeArgs = result1?.nativeArgs as {
				question: string
				follow_up?: Array<{ text: string; mode?: string }>
			}
			expect(nativeArgs?.question).toBe("What would you like?")
			// partial-json should parse the incomplete array
			expect(nativeArgs?.follow_up).toBeDefined()
		})

		it("should finalize with complete nativeArgs", () => {
			NativeToolCallParser.startStreamingToolCall("call_456", "ask_followup_question")

			// Add complete JSON
			const completeJson =
				'{"question":"Choose an option","follow_up":[{"text":"Yes","mode":"code"},{"text":"No","mode":null}]}'
			NativeToolCallParser.processStreamingChunk("call_456", completeJson)

			const result = NativeToolCallParser.finalizeStreamingToolCall("call_456")

			expect(result).not.toBeNull()
			expect(result?.type).toBe("tool_use")
			expect(result?.name).toBe("ask_followup_question")
			expect(result?.partial).toBe(false)
			// Type guard: regular tools have type 'tool_use', MCP tools have type 'mcp_tool_use'
			if (result?.type === "tool_use") {
				expect(result.nativeArgs).toEqual({
					question: "Choose an option",
					follow_up: [
						{ text: "Yes", mode: "code" },
						{ text: "No", mode: null },
					],
				})
			}
		})

		it("should finalize and forward a non-array follow_up so the tool can report it", () => {
			NativeToolCallParser.startStreamingToolCall("call_789", "ask_followup_question")

			// follow_up arrives as a keyed object instead of an array (the bug repro).
			const completeJson =
				'{"question":"How should I proceed?","follow_up":{"0":{"mode":null,"text":"Keep"},"1":{"mode":null,"text":"Remove"}}}'
			NativeToolCallParser.processStreamingChunk("call_789", completeJson)

			const result = NativeToolCallParser.finalizeStreamingToolCall("call_789")

			// The call must NOT be dropped (null) - it should reach the tool with the raw
			// value so the tool can emit a precise "must be an array" error.
			expect(result).not.toBeNull()
			expect(result?.type).toBe("tool_use")
			expect(result?.name).toBe("ask_followup_question")
			if (result?.type === "tool_use") {
				const nativeArgs = result.nativeArgs as { question: string; follow_up: unknown }
				expect(nativeArgs.question).toBe("How should I proceed?")
				expect(Array.isArray(nativeArgs.follow_up)).toBe(false)
				expect(nativeArgs.follow_up).toEqual({
					"0": { mode: null, text: "Keep" },
					"1": { mode: null, text: "Remove" },
				})
			}
		})
	})
})
