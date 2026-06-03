/**
 * Tests for CRT Chat Source Resolver — src/core/tools/ref/sources/chat.ts
 *
 * Covers:
 * - resolveChatSource with negative index refs ("-1", "-2")
 * - selector search inside chat message
 * - focus (AST expansion) inside chat message
 * - Error handling: empty history, no assistant messages, invalid index
 * - Explicit history parameter (testing without Task)
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import type { ContentRef } from "../../../../shared/tools"
import type { SelectorResult } from "../selector"
import type { ApiMessage } from "../../../task-persistence/apiMessages"
import type { Task } from "../../../task/Task"

// ---------------------------------------------------------------------------
// Mock getEffectiveApiHistory — identity function (returns input as-is)
// ---------------------------------------------------------------------------
vi.mock("../../../condense/index", () => ({
	getEffectiveApiHistory: (messages: ApiMessage[]) => messages,
}))

// ---------------------------------------------------------------------------
// Mock superDebug (noise suppression)
// ---------------------------------------------------------------------------
vi.mock("../superDebug", () => ({
	info: vi.fn(),
	successCrt: vi.fn(),
	error: vi.fn(),
}))

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------
import { resolveChatSource } from "../sources/chat"

// ===========================================================================
// Helpers
// ===========================================================================

/**
 * Create a mock ApiMessage with assistant role.
 */
function makeAssistantMessage(text: string, overrides: Partial<ApiMessage> = {}): ApiMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		ts: Date.now(),
		...overrides,
	} as ApiMessage
}

/**
 * Create a mock ApiMessage with tool_use content.
 */
function makeToolUseMessage(toolName: string, args: Record<string, unknown>): ApiMessage {
	return {
		role: "assistant",
		content: [
			{ type: "text", text: `I'll use the ${toolName} tool.` },
			{ type: "tool_use", name: toolName, id: `call-${toolName}`, nativeArgs: args },
		],
		ts: Date.now(),
	} as unknown as ApiMessage
}

/**
 * Create a minimal mock Task with apiConversationHistory.
 */
function createMockTask(history: ApiMessage[]): Task {
	return {
		taskId: "test-task-001",
		cwd: "/tmp/test",
		apiConversationHistory: history,
	} as unknown as Task
}

function makeRef(source: "chat", ref: string, extras?: Partial<ContentRef>): ContentRef {
	return { source, ref, ...extras } as ContentRef
}

// ===========================================================================
// Tests
// ===========================================================================

describe("resolveChatSource", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	// ─── Basic index resolution ────────────────────────────────────────────

	describe("index resolution", () => {
		it('resolves ref: "-1" — returns the last assistant message', async () => {
			const history: ApiMessage[] = [
				makeAssistantMessage("first message"),
				makeAssistantMessage("second message"),
				makeAssistantMessage("third message"),
			]
			const task = createMockTask(history)

			const result = await resolveChatSource(makeRef("chat", "-1"), task)

			expect(result.sourceId).toBe("chat:-1")
			expect(result.content).toContain("third message")
			expect(result.confidence).toBeGreaterThanOrEqual(0.5)
		})

		it('resolves ref: "-2" — returns the second-to-last assistant message', async () => {
			const history: ApiMessage[] = [
				makeAssistantMessage("first message"),
				makeAssistantMessage("second message"),
				makeAssistantMessage("third message"),
			]
			const task = createMockTask(history)

			const result = await resolveChatSource(makeRef("chat", "-2"), task)

			expect(result.sourceId).toBe("chat:-2")
			expect(result.content).toContain("second message")
		})

		it('resolves ref: "-3" — returns the third-to-last message', async () => {
			const history: ApiMessage[] = [
				makeAssistantMessage("alpha"),
				makeAssistantMessage("beta"),
				makeAssistantMessage("gamma"),
			]
			const task = createMockTask(history)

			const result = await resolveChatSource(makeRef("chat", "-3"), task)

			expect(result.content).toContain("alpha")
		})

		it("filters out non-assistant messages and indexes correctly", async () => {
			const history: ApiMessage[] = [
				{ role: "user", content: "user question" } as ApiMessage,
				makeAssistantMessage("assistant reply 1"),
				{ role: "user", content: "follow up" } as ApiMessage,
				makeAssistantMessage("assistant reply 2"),
			]
			const task = createMockTask(history)

			// -1 → last assistant message (assistant reply 2)
			const result1 = await resolveChatSource(makeRef("chat", "-1"), task)
			expect(result1.content).toContain("assistant reply 2")

			// -2 → second-to-last assistant message (assistant reply 1)
			const result2 = await resolveChatSource(makeRef("chat", "-2"), task)
			expect(result2.content).toContain("assistant reply 1")
		})
	})

	// ─── Selector inside chat message ──────────────────────────────────────

	describe("selector inside chat message", () => {
		it("resolves selector within the found message", async () => {
			const history: ApiMessage[] = [
				makeAssistantMessage("line 1\nline 2\ntarget line\nline 4"),
				makeAssistantMessage("other message"),
			]
			const task = createMockTask(history)

			const result = await resolveChatSource(makeRef("chat", "-2", { selector: "target line" }), task)

			expect(result.sourceId).toBe("chat:-2")
			expect(result.content).toContain("target line")
			expect(result.confidence).toBe(1.0)
			expect(result.method).toBe("exact")
		})

		it("resolves fuzzy selector inside a message", async () => {
			const history: ApiMessage[] = [makeAssistantMessage("The quick brown fox\njumps over the lazy dog")]
			const task = createMockTask(history)

			const result = await resolveChatSource(makeRef("chat", "-1", { selector: "quick brown fox" }), task)

			expect(result.content).toContain("quick brown fox")
		})
	})

	// ─── Focus (AST expansion) inside chat message ─────────────────────────

	describe("focus (AST expansion) inside chat message", () => {
		it("resolves focus keyword via AST expansion", async () => {
			const code = `
function hello() {
	console.log("Hello, world!")
}

function goodbye() {
	console.log("Goodbye!")
}
`
			const history: ApiMessage[] = [makeAssistantMessage(code)]
			const task = createMockTask(history)

			const result = await resolveChatSource(makeRef("chat", "-1", { focus: "hello" }), task)

			expect(result.sourceId).toBe("chat:-1")
			expect(result.content).toContain("function hello")
			expect(result.content).toContain('console.log("Hello, world!")')
			expect(result.method).toBe("focus")
			expect(result.confidence).toBe(1.0)
			// Должен найти блок функции целиком
			expect(result.content).toContain("}")
			// Не должен включать goodbye
			expect(result.content).not.toContain("function goodbye")
		})

		it("falls back to selector when focus is not found via AST", async () => {
			const history: ApiMessage[] = [makeAssistantMessage("some text with focus_word inside")]
			const task = createMockTask(history)

			const result = await resolveChatSource(makeRef("chat", "-1", { focus: "focus_word" }), task)

			expect(result.content).toContain("focus_word")
			// Fallback to selector matching
			expect(result.method).toBe("exact")
		})
	})

	// ─── Error handling ────────────────────────────────────────────────────

	describe("error handling", () => {
		it("throws when history is undefined", async () => {
			const task = createMockTask(undefined as unknown as ApiMessage[])

			await expect(resolveChatSource(makeRef("chat", "-1"), task)).rejects.toThrow(
				"conversation history is empty or not available",
			)
		})

		it("throws when history is empty array", async () => {
			const task = createMockTask([])

			await expect(resolveChatSource(makeRef("chat", "-1"), task)).rejects.toThrow(
				"conversation history is empty or not available",
			)
		})

		it("throws when no assistant messages exist", async () => {
			const history: ApiMessage[] = [
				{ role: "user", content: "hello" } as ApiMessage,
				{ role: "user", content: "world" } as ApiMessage,
			]
			const task = createMockTask(history)

			await expect(resolveChatSource(makeRef("chat", "-1"), task)).rejects.toThrow(
				"no assistant messages found in history",
			)
		})

		it("throws on positive index", async () => {
			const task = createMockTask([makeAssistantMessage("msg")])

			await expect(resolveChatSource(makeRef("chat", "0"), task)).rejects.toThrow("Invalid chat ref index: 0")
		})

		it("throws on NaN index", async () => {
			const task = createMockTask([makeAssistantMessage("msg")])

			await expect(resolveChatSource(makeRef("chat", "abc"), task)).rejects.toThrow("Invalid chat ref index: abc")
		})

		it("throws when index is out of bounds", async () => {
			const history: ApiMessage[] = [makeAssistantMessage("only one message")]
			const task = createMockTask(history)

			await expect(resolveChatSource(makeRef("chat", "-5"), task)).rejects.toThrow("out of bounds")
		})

		it("throws when message content is empty", async () => {
			const history: ApiMessage[] = [makeAssistantMessage("")]
			const task = createMockTask(history)

			await expect(resolveChatSource(makeRef("chat", "-1"), task)).rejects.toThrow("empty or not text")
		})
	})

	// ─── Explicit history parameter (testing without Task) ─────────────────

	describe("explicit history parameter", () => {
		it("uses provided history when passed as third parameter", async () => {
			const history: ApiMessage[] = [makeAssistantMessage("from explicit history")]
			// Task с пустой историей — должен игнорироваться
			const task = createMockTask([])

			const result = await resolveChatSource(makeRef("chat", "-1"), task, history)

			expect(result.content).toContain("from explicit history")
		})

		it("ignores task history when explicit history is provided (even if task has data)", async () => {
			const taskHistory: ApiMessage[] = [makeAssistantMessage("from task")]
			const explicitHistory: ApiMessage[] = [makeAssistantMessage("from explicit")]
			const task = createMockTask(taskHistory)

			const result = await resolveChatSource(makeRef("chat", "-1"), task, explicitHistory)

			expect(result.content).toContain("from explicit")
			expect(result.content).not.toContain("from task")
		})
	})

	// ─── Tool use content extraction ───────────────────────────────────────

	describe("tool_use content extraction", () => {
		it("extracts text from tool_use messages", async () => {
			const history: ApiMessage[] = [makeToolUseMessage("read_file", { path: "/test/file.ts" })]
			const task = createMockTask(history)

			const result = await resolveChatSource(makeRef("chat", "-1"), task)

			// Должен содержать и текст, и сериализованные аргументы tool_use
			expect(result.content).toContain("read_file")
			expect(result.content).toContain("/test/file.ts")
		})
	})
})
