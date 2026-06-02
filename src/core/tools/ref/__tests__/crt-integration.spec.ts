/**
 * CRT Integration Tests — src/core/tools/ref/__tests__/crt-integration.spec.ts
 *
 * End-to-end integration tests for the Content Reference Tool (CRT).
 * Tests the full pipeline: refMeta → resolveRef → source resolvers →
 * selector engine → transform engine → final result.
 *
 * Mocking strategy:
 *   - fs/promises: mocked (external dependency for file/terminal sources)
 *   - storage utils: mocked (external dependency for terminal source)
 *   - selector.ts: REAL (tested directly, no mocks)
 *   - transform.ts: REAL (tested directly, no mocks)
 *   - Task: mock object (not a real Task instance)
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

// ---------------------------------------------------------------------------
// Mock fs/promises (external I/O)
// ---------------------------------------------------------------------------
vi.mock("fs/promises", () => ({
	readFile: vi.fn(),
	readdir: vi.fn(),
}))

// ---------------------------------------------------------------------------
// Mock storage utility (external path resolution)
// ---------------------------------------------------------------------------
vi.mock("../../../../utils/storage", () => ({
	getTaskDirectoryPath: vi.fn(),
}))

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------
import * as fs from "fs/promises"
import { getTaskDirectoryPath } from "../../../../utils/storage"
import { resolveRef } from "../index"
import type { ContentRefParams, ContentRef } from "../../../../shared/tools"
import { BaseTool, type ToolCallbacks } from "../../BaseTool"
import type { ToolUse } from "../../../../shared/tools"

// ===========================================================================
// Shared Test Fixtures
// ===========================================================================

/**
 * Realistic assistant message content used across all chat-source tests.
 * Messages: [0]=greet function, [1]=farewell function, [2]=tool_use
 */
const MESSAGE_GREET =
	"function greet(name: string): string {\n  const greeting = `Hello, ${name}!`\n  return greeting\n}"

const MESSAGE_FAREWELL =
	"function farewell(name: string): void {\n  const message = `Goodbye, ${name}!`\n  console.log(message)\n}"

const ASSISTANT_MESSAGES = [
	{
		type: "text" as const,
		content: MESSAGE_GREET,
		partial: false,
	},
	{
		type: "text" as const,
		content: MESSAGE_FAREWELL,
		partial: false,
	},
	{
		type: "tool_use" as const,
		name: "read_file",
		id: "tool1",
		params: { path: "test.ts" },
		nativeArgs: { path: "test.ts" },
		partial: false,
	},
]

/**
 * User message content with tool results for tool-source tests.
 */
const USER_MESSAGES = [
	{
		type: "tool_result" as const,
		tool_use_id: "tool1",
		content: "// File: test.ts\nconst x = 1\nconst y = 2",
	},
]

/**
 * Shared mock Task object used across all tests.
 */
function createTaskMock(overrides: Record<string, any> = {}): any {
	return {
		cwd: "/test/project",
		taskId: "test-task-id",
		providerRef: {
			deref: () => ({
				context: {
					globalStorageUri: { fsPath: "/test/storage" },
				},
			}),
		},
		assistantMessageContent: [...ASSISTANT_MESSAGES],
		userMessageContent: [...USER_MESSAGES],
		apiConversationHistory: [
			{
				role: "assistant",
				content: [{ type: "text", text: MESSAGE_GREET }],
			},
			{
				role: "assistant",
				content: [{ type: "text", text: MESSAGE_FAREWELL }],
			},
			{
				role: "assistant",
				content: [
					{
						type: "tool_use" as const,
						id: "tool1",
						name: "read_file",
						nativeArgs: { path: "test.ts" },
					} as any,
				],
			},
		],
		...overrides,
	}
}

/**
 * Helper to build a ContentRef with sensible defaults.
 */
function makeRef(
	source: "chat" | "file" | "terminal" | "tool",
	ref: string,
	extra: Partial<ContentRef> = {},
): ContentRef {
	return { source, ref, ...extra }
}

/**
 * Minimal BaseTool subclass for testing graceful fallback.
 */
class TestCrtTool extends BaseTool<"execute_command"> {
	readonly name = "execute_command" as const
	execute = vi.fn().mockResolvedValue(undefined)
}

function createCallbacks(): ToolCallbacks {
	return {
		askApproval: vi.fn().mockResolvedValue(true),
		handleError: vi.fn().mockResolvedValue(undefined),
		pushToolResult: vi.fn(),
	}
}

// ===========================================================================
// Scenario 1: Single ref — chat source + exact selector
// ===========================================================================

describe("Scenario 1: Single ref — chat source + exact selector", () => {
	beforeEach(() => vi.clearAllMocks())

	it("resolves 'function greet' from the first assistant message (index -3)", async () => {
		// Messages: [0]=greet, [1]=farewell, [2]=tool_use
		// "-3" → index 0 (greet function text)
		const task = createTaskMock()
		const refMeta: ContentRefParams = {
			ref: makeRef("chat", "-3", { selector: "function greet" }),
		}

		const result = await resolveRef(refMeta, task)

		expect(result.content).toContain("function greet")
		expect(result.resolved).toHaveLength(1)
		expect(result.resolved[0].method).toBe("exact")
		expect(result.resolved[0].confidence).toBe(1.0)
	})

	it("resolves tool_use nativeArgs from the last message (index -1)", async () => {
		// "-1" → index 2 (tool_use with nativeArgs: { path: "test.ts" })
		const task = createTaskMock()
		const refMeta: ContentRefParams = {
			ref: makeRef("chat", "-1", { selector: "test.ts" }),
		}

		const result = await resolveRef(refMeta, task)

		expect(result.content).toContain("test.ts")
		expect(result.resolved).toHaveLength(1)
		expect(result.resolved[0].method).toBe("exact")
	})
})

// ===========================================================================
// Scenario 2: Single ref — chat source + anchor pair
// ===========================================================================

describe("Scenario 2: Single ref — chat source + anchor pair", () => {
	beforeEach(() => vi.clearAllMocks())

	it("resolves content between startAnchor and endAnchor", async () => {
		const task = createTaskMock()
		const refMeta: ContentRefParams = {
			ref: makeRef("chat", "-3", {
				startAnchor: "function greet",
				endAnchor: "return greeting",
			}),
		}

		const result = await resolveRef(refMeta, task)

		expect(result.content).toContain("function greet")
		expect(result.content).toContain("return greeting")
		expect(result.content).toContain("Hello")
		expect(result.resolved[0].method).toBe("anchor")
	})

	it("resolves from startAnchor to end of line when endAnchor is omitted", async () => {
		const task = createTaskMock()
		const refMeta: ContentRefParams = {
			ref: makeRef("chat", "-3", {
				startAnchor: "function greet",
			}),
		}

		const result = await resolveRef(refMeta, task)

		expect(result.content).toContain("function greet")
		expect(result.content).toContain("): string {")
		expect(result.resolved[0].method).toBe("anchor")
	})
})

// ===========================================================================
// Scenario 3: Single ref — chat source + normalized match
// ===========================================================================

describe("Scenario 3: Single ref — chat source + normalized match", () => {
	beforeEach(() => vi.clearAllMocks())

	it("matches with extra whitespace and different case (confidence 0.9)", async () => {
		const task = createTaskMock()
		// "Function   Greet" → normalized to "function greet" → matches
		const refMeta: ContentRefParams = {
			ref: makeRef("chat", "-3", { selector: "Function   Greet" }),
		}

		const result = await resolveRef(refMeta, task)

		expect(result.content).toContain("function greet")
		expect(result.resolved[0].method).toBe("normalized")
		expect(result.resolved[0].confidence).toBe(0.9)
	})
})

// ===========================================================================
// Scenario 4: Single ref — chat source + fuzzy match (typo tolerance)
// ===========================================================================

describe("Scenario 4: Single ref — chat source + fuzzy match (typo tolerance)", () => {
	beforeEach(() => vi.clearAllMocks())

	it("matches with a typo using LCS fuzzy matching (confidence 0.7)", async () => {
		const task = createTaskMock()
		// Replace first char 'f' with 'x' in the full greet message.
		// LCS of "xunction greet(name: ...)" vs "function greet(name: ...)"
		// finds "unction greet(name: string):..." — a long common substring.
		// Default tolerance 0.1 → minMatchLen = ceil(len(selector) * 0.9).
		// Since the tail after the typo is very long, the LCS exceeds minMatchLen.
		const longTypo = "x" + MESSAGE_GREET.slice(1)
		const refMeta: ContentRefParams = {
			ref: makeRef("chat", "-3", { selector: longTypo }),
		}

		const result = await resolveRef(refMeta, task)

		expect(result.content).toContain("function greet")
		expect(result.resolved[0].method).toBe("fuzzy")
		expect(result.resolved[0].confidence).toBe(0.7)
	})
})

// ===========================================================================
// Scenario 5: multi_ref with 2 fragments + join_with
// ===========================================================================

describe("Scenario 5: multi_ref with 2 fragments + join_with", () => {
	beforeEach(() => vi.clearAllMocks())

	it("joins two chat fragments with separator", async () => {
		const task = createTaskMock()
		const refMeta: ContentRefParams = {
			multi_ref: [
				makeRef("chat", "-3", { selector: "function greet" }),
				makeRef("chat", "-2", { selector: "function farewell" }),
			],
			transform: { join_with: "\n---\n" },
		}

		const result = await resolveRef(refMeta, task)

		expect(result.joined).toBe("function greet\n---\nfunction farewell")
		expect(result.content).toBe("function greet\n---\nfunction farewell")
		expect(result.resolved).toHaveLength(2)
	})
})

// ===========================================================================
// Scenario 6: multi_ref + full transform pipeline
// ===========================================================================

describe("Scenario 6: multi_ref + transform pipeline (replace + prepend + wrap + append)", () => {
	beforeEach(() => vi.clearAllMocks())

	it("applies full transform pipeline to each fragment before join", async () => {
		const task = createTaskMock()
		const refMeta: ContentRefParams = {
			multi_ref: [makeRef("chat", "-3", { selector: "function greet" })],
			transform: {
				replace: { from: "greet", to: "GREET" },
				prepend: "// START\n",
				wrap_with: "```ts\n{content}\n```",
				append: "\n// END",
			},
		}

		const result = await resolveRef(refMeta, task)

		// Verify pipeline order: replace → prepend → wrap_with → append
		expect(result.content).toContain("// START")
		expect(result.content).toContain("function GREET")
		expect(result.content).toContain("```ts")
		expect(result.content).toContain("// END")
	})
})

// ===========================================================================
// Scenario 7: multi_ref + mixed fragment transforms
// ===========================================================================

describe("Scenario 7: multi_ref + mixed fragment transforms", () => {
	beforeEach(() => vi.clearAllMocks())

	it("transforms each fragment independently before joining", async () => {
		const task = createTaskMock()
		const refMeta: ContentRefParams = {
			multi_ref: [
				makeRef("chat", "-3", { selector: "function greet" }),
				makeRef("chat", "-2", { selector: "function farewell" }),
			],
			transform: {
				prepend: "> ",
				join_with: "\n",
			},
		}

		const result = await resolveRef(refMeta, task)

		// Each fragment gets prepended independently, then joined
		expect(result.joined).toBe("> function greet\n> function farewell")
		expect(result.resolved).toHaveLength(2)
	})
})

// ===========================================================================
// Scenario 8: Confidence aggregation (minimum across fragments)
// ===========================================================================

describe("Scenario 8: Confidence aggregation", () => {
	beforeEach(() => vi.clearAllMocks())

	it("returns minimum confidence across all fragments", async () => {
		const task = createTaskMock()
		const refMeta: ContentRefParams = {
			multi_ref: [
				// Exact match → confidence 1.0
				makeRef("chat", "-3", { selector: "function greet" }),
				// Normalized match (extra whitespace) → confidence 0.9
				makeRef("chat", "-2", { selector: "function  farewell" }),
			],
		}

		const result = await resolveRef(refMeta, task)

		// First fragment: exact match → 1.0
		expect(result.resolved[0].confidence).toBe(1.0)
		// Second fragment: normalized match → 0.9
		expect(result.resolved[1].confidence).toBe(0.9)
		// Aggregated: minimum = 0.9
		expect(result.confidence).toBe(0.9)
	})
})

// ===========================================================================
// Scenario 9: File source (mocked fs)
// ===========================================================================

describe("Scenario 9: File source (mocked fs)", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		// Mock fs.readFile to return test file content
		vi.mocked(fs.readFile).mockResolvedValue("// File: test.ts\nconst x = 1\nconst y = 2\nconst z = 3\n")
	})

	it("extracts lines 1-3 from a file", async () => {
		const task = createTaskMock()
		const refMeta: ContentRefParams = {
			ref: makeRef("file", "test.ts", { startLine: 1, endLine: 3 }),
		}

		const result = await resolveRef(refMeta, task)

		expect(fs.readFile).toHaveBeenCalledWith(expect.stringContaining("test.ts"), "utf-8")
		// Lines 1-3: "// File: test.ts\nconst x = 1\nconst y = 2"
		expect(result.content).toContain("// File: test.ts")
		expect(result.content).toContain("const x = 1")
		expect(result.content).toContain("const y = 2")
		expect(result.resolved[0].confidence).toBe(1.0)
	})

	it("extracts a single line when only startLine is specified", async () => {
		const task = createTaskMock()
		const refMeta: ContentRefParams = {
			ref: makeRef("file", "test.ts", { startLine: 2 }),
		}

		const result = await resolveRef(refMeta, task)

		expect(result.content).toContain("const x = 1")
		expect(result.resolved[0].confidence).toBe(1.0)
	})
})

// ===========================================================================
// Scenario 10: Terminal source (mocked fs + storage)
// ===========================================================================

describe("Scenario 10: Terminal source (mocked fs + storage)", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.mocked(getTaskDirectoryPath).mockResolvedValue("/test/storage/tasks/test-task-id")
		vi.mocked(fs.readFile).mockResolvedValue("npm test output\nAll tests passed\n")
	})

	it("reads terminal artifact by direct path", async () => {
		const task = createTaskMock()
		const refMeta: ContentRefParams = {
			ref: makeRef("terminal", "cmd-output.txt", { selector: "npm test output" }),
		}

		const result = await resolveRef(refMeta, task)

		expect(getTaskDirectoryPath).toHaveBeenCalledWith("/test/storage", "test-task-id")
		expect(fs.readFile).toHaveBeenCalledWith(
			"/test/storage/tasks/test-task-id/command-output/cmd-output.txt",
			"utf-8",
		)
		expect(result.content).toContain("npm test output")
		expect(result.resolved[0].sourceId).toBe("terminal://cmd-output.txt")
	})
})

// ===========================================================================
// Scenario 11: Error handling — graceful fallback via BaseTool
// ===========================================================================

describe("Scenario 11: Error handling — graceful fallback via BaseTool", () => {
	let tool: TestCrtTool
	let task: any
	let callbacks: ToolCallbacks

	beforeEach(() => {
		vi.clearAllMocks()
		tool = new TestCrtTool()
		task = createTaskMock()
		callbacks = createCallbacks()
	})

	it("BaseTool.handle() catches resolveRef errors and uses original params", async () => {
		// Create a block with refMeta that will cause an error
		// (invalid chat index that is out of bounds)
		const block: ToolUse<"execute_command"> = {
			type: "tool_use",
			name: "execute_command",
			params: {},
			partial: false,
			nativeArgs: { command: "echo hello" },
			refMeta: {
				ref: makeRef("chat", "-99", { selector: "nonexistent" }),
			},
		}

		await tool.handle(task, block, callbacks)

		// BaseTool should catch the error and fall back to original params
		expect(tool.execute).toHaveBeenCalled()
		const executedParams = tool.execute.mock.calls[0][0]
		expect(executedParams.command).toBe("echo hello")
		// handleError should NOT be called (graceful fallback, not a parameter error)
		expect(callbacks.handleError).not.toHaveBeenCalled()
	})

	it("resolveRef throws on invalid selector with no match", async () => {
		const task = createTaskMock()
		const refMeta: ContentRefParams = {
			ref: makeRef("chat", "-3", { selector: "this_does_not_exist_in_source" }),
		}

		await expect(resolveRef(refMeta, task)).rejects.toThrow()
	})
})

// ===========================================================================
// Scenario 12: Edge case — empty multi_ref
// ===========================================================================

describe("Scenario 12: Edge case — empty multi_ref", () => {
	beforeEach(() => vi.clearAllMocks())

	it("throws 'No ref or multi_ref specified' for empty multi_ref array", async () => {
		const task = createTaskMock()
		const refMeta: ContentRefParams = {
			multi_ref: [],
		}

		await expect(resolveRef(refMeta, task)).rejects.toThrow("No ref or multi_ref specified in refMeta.")
	})

	it("throws when neither ref nor multi_ref is provided", async () => {
		const task = createTaskMock()
		const refMeta: ContentRefParams = {}

		await expect(resolveRef(refMeta, task)).rejects.toThrow("No ref or multi_ref specified in refMeta.")
	})
})

// ===========================================================================
// Scenario 13: Edge case — transform on single ref
// ===========================================================================

describe("Scenario 13: Edge case — transform on single ref", () => {
	beforeEach(() => vi.clearAllMocks())

	it("applies prepend transform to single ref content", async () => {
		const task = createTaskMock()
		const refMeta: ContentRefParams = {
			ref: makeRef("chat", "-3", { selector: "function greet" }),
			transform: {
				prepend: "// RESULT:\n",
			},
		}

		const result = await resolveRef(refMeta, task)

		expect(result.content).toBe("// RESULT:\nfunction greet")
		expect(result.joined).toBeUndefined()
	})

	it("applies append transform to single ref content", async () => {
		const task = createTaskMock()
		const refMeta: ContentRefParams = {
			ref: makeRef("chat", "-3", { selector: "function greet" }),
			transform: {
				append: "\n// END",
			},
		}

		const result = await resolveRef(refMeta, task)

		expect(result.content).toBe("function greet\n// END")
	})

	it("applies wrap_with transform to single ref content", async () => {
		const task = createTaskMock()
		const refMeta: ContentRefParams = {
			ref: makeRef("chat", "-3", { selector: "function greet" }),
			transform: {
				wrap_with: "```ts\n{content}\n```",
			},
		}

		const result = await resolveRef(refMeta, task)

		expect(result.content).toBe("```ts\nfunction greet\n```")
	})
})

// ===========================================================================
// Scenario 14: Real content extraction — full pipeline
// ===========================================================================

describe("Scenario 14: Real content extraction — full pipeline", () => {
	beforeEach(() => vi.clearAllMocks())

	it("extracts code fragment and applies prepend + append transforms", async () => {
		const task = createTaskMock()
		// The first assistant message (index -3) contains:
		// "function greet(name: string): string {\n  const greeting = `Hello, ${name}!`\n  return greeting\n}"
		const refMeta: ContentRefParams = {
			ref: makeRef("chat", "-3", { selector: "const greeting" }),
			transform: {
				prepend: "// RESULT:\n",
				append: "\n// END",
			},
		}

		const result = await resolveRef(refMeta, task)

		// Verify the full pipeline: selector → transform → final output
		expect(result.content).toBe("// RESULT:\nconst greeting\n// END")
		expect(result.resolved).toHaveLength(1)
		expect(result.resolved[0].method).toBe("exact")
		expect(result.resolved[0].confidence).toBe(1.0)
		expect(result.confidence).toBe(1.0)
	})

	it("extracts anchor-based fragment and applies wrap_with", async () => {
		const task = createTaskMock()
		const refMeta: ContentRefParams = {
			ref: makeRef("chat", "-3", {
				startAnchor: "function greet",
				endAnchor: "return greeting",
			}),
			transform: {
				wrap_with: "```typescript\n{content}\n```",
			},
		}

		const result = await resolveRef(refMeta, task)

		expect(result.content).toContain("```typescript")
		expect(result.content).toContain("function greet")
		expect(result.content).toContain("return greeting")
		expect(result.content).toContain("```")
		expect(result.resolved[0].method).toBe("anchor")
	})

	it("combines multi_ref with full transform pipeline and join", async () => {
		const task = createTaskMock()
		const refMeta: ContentRefParams = {
			multi_ref: [
				makeRef("chat", "-3", { selector: "function greet" }),
				makeRef("chat", "-2", { selector: "function farewell" }),
			],
			transform: {
				prepend: "// ",
				append: " //",
				join_with: "\n===\n",
			},
		}

		const result = await resolveRef(refMeta, task)

		// Each fragment: prepend "// " + content + " //"
		// Then joined with "\n===\n"
		expect(result.joined).toBe("// function greet //\n===\n// function farewell //")
		expect(result.content).toBe("// function greet //\n===\n// function farewell //")
		expect(result.resolved).toHaveLength(2)
		expect(result.confidence).toBe(1.0) // both exact matches
	})
})

// ===========================================================================
// Bonus: Tool source integration
// ===========================================================================

describe("Bonus: Tool source integration", () => {
	beforeEach(() => vi.clearAllMocks())

	it("resolves tool result with selector", async () => {
		const task = createTaskMock()
		const refMeta: ContentRefParams = {
			ref: makeRef("tool", "read_file", { selector: "const x" }),
		}

		const result = await resolveRef(refMeta, task)

		expect(result.content).toContain("const x")
		expect(result.resolved[0].sourceId).toBe("tool:read_file:tool1")
	})
})
