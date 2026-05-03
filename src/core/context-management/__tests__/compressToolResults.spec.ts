import { Anthropic } from "@anthropic-ai/sdk"
import {
	compressOldToolResults,
	generatePlaceholder,
	TOOL_RESULT_MIN_CHARS,
	TOOL_RESULT_STALE_TURN_THRESHOLD,
	COMPRESSIBLE_TOOLS,
} from "../compressToolResults"

// Helper to build a minimal assistant message with a tool_use block
function assistantMsgWithToolUse(toolName: string, toolUseId: string): Anthropic.Messages.MessageParam {
	return {
		role: "assistant",
		content: [
			{
				type: "tool_use",
				id: toolUseId,
				name: toolName,
				input: {},
			},
		],
	}
}

// Helper to build a user message with a tool_result block
function userMsgWithToolResult(toolUseId: string, content: string): Anthropic.Messages.MessageParam {
	return {
		role: "user",
		content: [
			{
				type: "tool_result",
				tool_use_id: toolUseId,
				content,
			},
		],
	}
}

// Helper to build a user message with a plain text block (no tool_result)
function userTextMsg(text: string): Anthropic.Messages.MessageParam {
	return {
		role: "user",
		content: [{ type: "text", text }],
	}
}

// Helper to build a simple assistant text message
function assistantTextMsg(text: string): Anthropic.Messages.MessageParam {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
	}
}

// A string that is longer than TOOL_RESULT_MIN_CHARS
const LARGE_CONTENT = "x".repeat(TOOL_RESULT_MIN_CHARS + 1)

// A string that is shorter than TOOL_RESULT_MIN_CHARS
const SMALL_CONTENT = "x".repeat(TOOL_RESULT_MIN_CHARS - 1)

// Build N turn pairs (assistant + user tool_result) to ensure staleness
// With TOOL_RESULT_STALE_TURN_THRESHOLD = 3, we need > 3 assistant messages to have stale ones
function buildTurnPairs(count: number, toolName: string = "read_file"): Anthropic.Messages.MessageParam[] {
	const history: Anthropic.Messages.MessageParam[] = []
	for (let i = 0; i < count; i++) {
		const toolUseId = `tool-${i}`
		history.push(assistantMsgWithToolUse(toolName, toolUseId))
		history.push(userMsgWithToolResult(toolUseId, LARGE_CONTENT))
	}
	return history
}

describe("generatePlaceholder", () => {
	test("read_file placeholder includes char count and line count", () => {
		const content = "line1\nline2\nline3"
		const result = generatePlaceholder("read_file", content)
		expect(result).toContain("read_file")
		expect(result).toContain("chars")
		expect(result).toContain("lines")
		expect(result).toContain("Re-read the file")
	})

	test("search_files placeholder includes char count and matches", () => {
		const content = "match1\nmatch2\nmatch3"
		const result = generatePlaceholder("search_files", content)
		expect(result).toContain("search_files")
		expect(result).toContain("matches")
		expect(result).toContain("Re-run the search")
	})

	test("codebase_search placeholder includes matches", () => {
		const content = "result1\nresult2"
		const result = generatePlaceholder("codebase_search", content)
		expect(result).toContain("codebase_search")
		expect(result).toContain("matches")
	})

	test("list_files placeholder includes path count", () => {
		const content = "src/a.ts\nsrc/b.ts\nsrc/c.ts"
		const result = generatePlaceholder("list_files", content)
		expect(result).toContain("list_files")
		expect(result).toContain("paths")
		expect(result).toContain("Re-list the directory")
	})

	test("execute_command placeholder references re-run", () => {
		const content = "some command output"
		const result = generatePlaceholder("execute_command", content)
		expect(result).toContain("execute_command")
		expect(result).toContain("Re-run the command")
	})

	test("read_command_output placeholder references re-run", () => {
		const content = "command output"
		const result = generatePlaceholder("read_command_output", content)
		expect(result).toContain("Re-run the command")
	})

	test("unknown tool produces generic placeholder", () => {
		const content = "some content"
		const result = generatePlaceholder("unknown_tool", content)
		expect(result).toContain("tool result")
		expect(result).toContain("chars")
		expect(result).toContain("Call the tool again")
	})

	test("placeholder includes approximate original char count", () => {
		const content = "a".repeat(1523)
		const result = generatePlaceholder("read_file", content)
		// Should contain 1,523 (localized) somewhere
		expect(result).toMatch(/1[,.]?523/)
	})
})

describe("compressOldToolResults", () => {
	test("empty history returns empty array", () => {
		const result = compressOldToolResults([])
		expect(result).toEqual([])
	})

	test("returns a new array, not the same reference", () => {
		const history = buildTurnPairs(TOOL_RESULT_STALE_TURN_THRESHOLD + 2)
		const result = compressOldToolResults(history)
		expect(result).not.toBe(history)
	})

	test("does not mutate the original array", () => {
		const history = buildTurnPairs(TOOL_RESULT_STALE_TURN_THRESHOLD + 2)
		const originalFirstUserContent = (history[1].content as any[])[0].content
		compressOldToolResults(history)
		expect((history[1].content as any[])[0].content).toBe(originalFirstUserContent)
	})

	test("history with only assistant messages (no tool results) is untouched", () => {
		const history = [
			assistantTextMsg("hello"),
			assistantTextMsg("world"),
			assistantTextMsg("foo"),
			assistantTextMsg("bar"),
		]
		const result = compressOldToolResults(history)
		expect(result).toEqual(history)
	})

	test("recent tool results within threshold are NOT compressed", () => {
		// Build exactly THRESHOLD turns — nothing should be stale
		const history = buildTurnPairs(TOOL_RESULT_STALE_TURN_THRESHOLD)
		const result = compressOldToolResults(history)
		// All tool_result blocks should still have the original LARGE_CONTENT
		for (let i = 1; i < result.length; i += 2) {
			const block = (result[i].content as any[])[0]
			expect(block.content).toBe(LARGE_CONTENT)
		}
	})

	test("old tool results exceeding min chars ARE compressed", () => {
		// Build THRESHOLD + 2 turns so the first turns are stale
		const count = TOOL_RESULT_STALE_TURN_THRESHOLD + 2
		const history = buildTurnPairs(count, "read_file")
		const result = compressOldToolResults(history)

		// The first (count - THRESHOLD) user messages should have compressed content
		const staleCount = count - TOOL_RESULT_STALE_TURN_THRESHOLD
		for (let turn = 0; turn < staleCount; turn++) {
			const userMsgIdx = turn * 2 + 1
			const block = (result[userMsgIdx].content as any[])[0]
			expect(block.content).not.toBe(LARGE_CONTENT)
			expect(block.content).toContain("[Compressed:")
		}
	})

	test("old tool results below min chars are left untouched", () => {
		// Build turns with small content so nothing should be compressed
		const history: Anthropic.Messages.MessageParam[] = []
		const count = TOOL_RESULT_STALE_TURN_THRESHOLD + 2
		for (let i = 0; i < count; i++) {
			const toolUseId = `tool-${i}`
			history.push(assistantMsgWithToolUse("read_file", toolUseId))
			history.push(userMsgWithToolResult(toolUseId, SMALL_CONTENT))
		}
		const result = compressOldToolResults(history)
		for (let i = 1; i < result.length; i += 2) {
			const block = (result[i].content as any[])[0]
			expect(block.content).toBe(SMALL_CONTENT)
		}
	})

	test("non-tool_result content blocks are never touched", () => {
		const history: Anthropic.Messages.MessageParam[] = []
		// Enough turns to ensure staleness
		for (let i = 0; i < TOOL_RESULT_STALE_TURN_THRESHOLD + 2; i++) {
			history.push(assistantTextMsg("assistant turn " + i))
			history.push(userTextMsg("user message " + i))
		}
		const result = compressOldToolResults(history)
		for (let i = 1; i < result.length; i += 2) {
			const block = (result[i].content as any[])[0]
			expect(block.type).toBe("text")
			// text should be unchanged
			expect(block.text).toContain("user message")
		}
	})

	test("placeholder includes approximate char count from original", () => {
		const content = "a".repeat(2000)
		const history: Anthropic.Messages.MessageParam[] = []
		const count = TOOL_RESULT_STALE_TURN_THRESHOLD + 1
		for (let i = 0; i < count; i++) {
			const toolUseId = `tool-${i}`
			history.push(assistantMsgWithToolUse("read_file", toolUseId))
			if (i === 0) {
				history.push(userMsgWithToolResult(toolUseId, content))
			} else {
				history.push(userMsgWithToolResult(toolUseId, LARGE_CONTENT))
			}
		}
		const result = compressOldToolResults(history)
		const firstBlock = (result[1].content as any[])[0]
		// Content was 2000 chars
		expect(firstBlock.content).toMatch(/2[,.]?000/)
	})

	test("multiple tool results in one user message — only large old ones compressed", () => {
		const toolUseId1 = "tool-1"
		const toolUseId2 = "tool-2"

		// Build THRESHOLD extra turns first to push earlier messages into stale zone
		const history: Anthropic.Messages.MessageParam[] = []
		// Add a stale turn with two tool results in one user message
		history.push({
			role: "assistant",
			content: [
				{ type: "tool_use", id: toolUseId1, name: "read_file", input: {} },
				{ type: "tool_use", id: toolUseId2, name: "read_file", input: {} },
			],
		})
		history.push({
			role: "user",
			content: [
				{ type: "tool_result", tool_use_id: toolUseId1, content: LARGE_CONTENT },
				{ type: "tool_result", tool_use_id: toolUseId2, content: SMALL_CONTENT },
			],
		})

		// Pad with enough turns to make the above stale
		for (let i = 0; i < TOOL_RESULT_STALE_TURN_THRESHOLD; i++) {
			const tid = `pad-${i}`
			history.push(assistantMsgWithToolUse("read_file", tid))
			history.push(userMsgWithToolResult(tid, LARGE_CONTENT))
		}

		const result = compressOldToolResults(history)
		const blocks = result[1].content as any[]

		// First block (large) should be compressed
		expect(blocks[0].content).toContain("[Compressed:")
		// Second block (small) should be untouched
		expect(blocks[1].content).toBe(SMALL_CONTENT)
	})

	test("tool results for non-compressible tools are not compressed", () => {
		const history: Anthropic.Messages.MessageParam[] = []
		const count = TOOL_RESULT_STALE_TURN_THRESHOLD + 1
		for (let i = 0; i < count; i++) {
			const toolUseId = `tool-${i}`
			// Use a tool NOT in COMPRESSIBLE_TOOLS
			history.push(assistantMsgWithToolUse("attempt_completion", toolUseId))
			history.push(userMsgWithToolResult(toolUseId, LARGE_CONTENT))
		}
		const result = compressOldToolResults(history)
		// None should be compressed since attempt_completion is not compressible
		for (let i = 1; i < result.length; i += 2) {
			const block = (result[i].content as any[])[0]
			expect(block.content).toBe(LARGE_CONTENT)
		}
	})

	test("tool_result with array content (ContentBlockParam[]) is compressed", () => {
		const toolUseId = "tool-arr"
		const history: Anthropic.Messages.MessageParam[] = []

		history.push(assistantMsgWithToolUse("read_file", toolUseId))
		history.push({
			role: "user",
			content: [
				{
					type: "tool_result",
					tool_use_id: toolUseId,
					content: [{ type: "text", text: LARGE_CONTENT }],
				},
			],
		})

		// Pad with enough turns to make the above stale
		for (let i = 0; i < TOOL_RESULT_STALE_TURN_THRESHOLD; i++) {
			const tid = `pad-${i}`
			history.push(assistantMsgWithToolUse("read_file", tid))
			history.push(userMsgWithToolResult(tid, LARGE_CONTENT))
		}

		const result = compressOldToolResults(history)
		const block = (result[1].content as any[])[0]
		// The block content should now be a compressed string placeholder
		expect(typeof block.content).toBe("string")
		expect(block.content).toContain("[Compressed:")
	})
})
