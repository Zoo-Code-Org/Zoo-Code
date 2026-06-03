/**
 * Integration tests: ApplyDiffTool + CRT (ref/multi_ref/transform)
 *
 * Tests the full pipeline:
 *   BaseTool.handle() → resolveRef() → injectRefContent() → execute()
 *
 * Covers all CRT-enabled scenarios for apply_diff:
 * 1. Single ref: diff replaced by ref content
 * 2. Multi-ref: multiple fragments joined into diff
 * 3. Transform: replace/prepend/append applied to diff
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

// ---------------------------------------------------------------------------
// Mock resolveRef before importing, keeping other exports actual
// ---------------------------------------------------------------------------
vi.mock("../index", async (importActual) => {
	const actual = await importActual<typeof import("../index")>()
	return {
		...actual,
		resolveRef: vi.fn(),
	}
})

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------
import { resolveRef } from "../index"
import type { ResolveRefResult } from "../index"
import type { ToolUse, ContentRefParams } from "../../../../shared/tools"
import { Task } from "../../../task/Task"
import { BaseTool, ToolCallbacks } from "../../BaseTool"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Minimal subclass of BaseTool for apply_diff testing.
 */
class TestApplyDiffTool extends BaseTool<"apply_diff"> {
	readonly name = "apply_diff" as const
	execute = vi.fn().mockResolvedValue(undefined)
}

function createMockTask(overrides: Partial<any> = {}): any {
	return {
		taskId: "test-task-001",
		cwd: "/workspace/project",
		providerRef: { deref: () => ({}) },
		assistantMessageContent: [],
		...overrides,
	}
}

function createRefMeta(overrides: Partial<ContentRefParams> = {}): ContentRefParams {
	return {
		ref: {
			source: "chat",
			ref: "-1",
			selector: "myFunction",
		},
		...overrides,
	}
}

function createResolveRefResult(overrides: Partial<ResolveRefResult> = {}): ResolveRefResult {
	return {
		content: "diff content from ref",
		resolved: [
			{
				sourceId: "chat:-1",
				content: "diff content from ref",
				startOffset: 0,
				endOffset: 20,
				confidence: 1.0,
				method: "exact",
			},
		],
		confidence: 1.0,
		...overrides,
	}
}

function createToolUseBlock(nativeArgs: any, refMeta?: ContentRefParams): ToolUse<"apply_diff"> {
	return {
		type: "tool_use",
		name: "apply_diff",
		params: {},
		partial: false,
		nativeArgs,
		refMeta,
	}
}

function createCallbacks(): ToolCallbacks {
	return {
		askApproval: vi.fn().mockResolvedValue(true),
		handleError: vi.fn().mockResolvedValue(undefined),
		pushToolResult: vi.fn(),
	}
}

// ===========================================================================
// Tests
// ===========================================================================

describe("ApplyDiffTool + CRT ref injection", () => {
	let tool: TestApplyDiffTool
	let task: any
	let callbacks: ToolCallbacks

	beforeEach(() => {
		vi.clearAllMocks()
		tool = new TestApplyDiffTool()
		task = createMockTask()
		callbacks = createCallbacks()
	})

	// -----------------------------------------------------------------------
	// Test 1: Single ref — diff replaced by ref content
	// -----------------------------------------------------------------------
	it("replaces diff with content from single ref", async () => {
		const refMeta = createRefMeta()
		const nativeArgs = {
			path: "src/file.ts",
			// diff is NOT provided by the model when using ref
			ref: refMeta.ref,
		}
		const block = createToolUseBlock(nativeArgs, refMeta)

		vi.mocked(resolveRef).mockResolvedValue(
			createResolveRefResult({ content: "<<<<<<< SEARCH\nold code\n=======\nnew code\n>>>>>>> REPLACE" }),
		)

		await tool.handle(task, block, callbacks)

		// resolveRef should have been called with refMeta
		expect(resolveRef).toHaveBeenCalledWith(refMeta, task)

		// execute should be called with the resolved diff
		expect(tool.execute).toHaveBeenCalled()
		const executedParams = tool.execute.mock.calls[0][0]
		expect(executedParams.path).toBe("src/file.ts")
		expect(executedParams.diff).toBe("<<<<<<< SEARCH\nold code\n=======\nnew code\n>>>>>>> REPLACE")
	})

	// -----------------------------------------------------------------------
	// Test 2: Multi-ref — content joined into diff
	// -----------------------------------------------------------------------
	it("joins multi_ref contents into diff using default join", async () => {
		const refMeta: ContentRefParams = {
			multi_ref: [
				{ source: "chat", ref: "-2", selector: "part1" },
				{ source: "chat", ref: "-3", selector: "part2" },
			],
		}
		const nativeArgs = {
			path: "src/file.ts",
			multi_ref: refMeta.multi_ref,
		}
		const block = createToolUseBlock(nativeArgs, refMeta)

		vi.mocked(resolveRef).mockResolvedValue(
			createResolveRefResult({
				content:
					"<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE\n<<<<<<< SEARCH\nold2\n=======\nnew2\n>>>>>>> REPLACE",
				joined: "<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE\n<<<<<<< SEARCH\nold2\n=======\nnew2\n>>>>>>> REPLACE",
				resolved: [
					{
						sourceId: "chat:-2",
						content: "<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE",
						startOffset: 0,
						endOffset: 10,
						confidence: 1.0,
						method: "exact",
					},
					{
						sourceId: "chat:-3",
						content: "<<<<<<< SEARCH\nold2\n=======\nnew2\n>>>>>>> REPLACE",
						startOffset: 0,
						endOffset: 10,
						confidence: 1.0,
						method: "exact",
					},
				],
				confidence: 1.0,
			}),
		)

		await tool.handle(task, block, callbacks)

		expect(resolveRef).toHaveBeenCalledWith(refMeta, task)
		expect(tool.execute).toHaveBeenCalled()
		const executedParams = tool.execute.mock.calls[0][0]
		expect(executedParams.path).toBe("src/file.ts")
		// Should contain both diff blocks joined
		expect(executedParams.diff).toContain("<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE")
		expect(executedParams.diff).toContain("<<<<<<< SEARCH\nold2\n=======\nnew2\n>>>>>>> REPLACE")
	})

	// -----------------------------------------------------------------------
	// Test 3: Transform applied to diff
	// -----------------------------------------------------------------------
	it("applies replace transform to the resolved diff content", async () => {
		const refMeta: ContentRefParams = {
			ref: {
				source: "chat",
				ref: "-1",
				selector: "myDiff",
			},
			transform: {
				replace: { from: "old value", to: "new value" },
			},
		}
		const nativeArgs = {
			path: "src/file.ts",
			ref: refMeta.ref,
			transform: refMeta.transform,
		}
		const block = createToolUseBlock(nativeArgs, refMeta)

		vi.mocked(resolveRef).mockResolvedValue(
			createResolveRefResult({
				content: "<<<<<<< SEARCH\nold value\n=======\nnew value\n>>>>>>> REPLACE",
				// resolveRef applies transform already — so the result already has the transform applied
				// In practice, transform is applied inside resolveRef, not injectRefContent
			}),
		)

		await tool.handle(task, block, callbacks)

		expect(tool.execute).toHaveBeenCalled()
		const executedParams = tool.execute.mock.calls[0][0]
		expect(executedParams.path).toBe("src/file.ts")
		// The diff should contain "new value" (transform was applied by resolveRef)
		expect(executedParams.diff).toContain("new value")
	})

	// -----------------------------------------------------------------------
	// Test 4: Graceful fallback when resolveRef throws
	// -----------------------------------------------------------------------
	it("falls back to original params when resolveRef fails", async () => {
		const refMeta = createRefMeta()
		const nativeArgs = {
			path: "src/file.ts",
			diff: "original diff content", // model also provided diff as fallback
			ref: refMeta.ref,
		}
		const block = createToolUseBlock(nativeArgs, refMeta)

		vi.mocked(resolveRef).mockRejectedValue(new Error("ref not found"))

		await tool.handle(task, block, callbacks)

		// Should execute with original params (graceful fallback)
		expect(tool.execute).toHaveBeenCalled()
		const executedParams = tool.execute.mock.calls[0][0]
		expect(executedParams.path).toBe("src/file.ts")
		expect(executedParams.diff).toBe("original diff content")
		// Error should NOT be propagated to handleError
		expect(callbacks.handleError).not.toHaveBeenCalled()
	})

	// -----------------------------------------------------------------------
	// Test 5: Skips CRT when refMeta is not set
	// -----------------------------------------------------------------------
	it("skips CRT when block.refMeta is not set", async () => {
		const nativeArgs = {
			path: "src/file.ts",
			diff: "normal diff",
		}
		const block = createToolUseBlock(nativeArgs)

		await tool.handle(task, block, callbacks)

		expect(resolveRef).not.toHaveBeenCalled()
		expect(tool.execute).toHaveBeenCalled()
		const executedParams = tool.execute.mock.calls[0][0]
		expect(executedParams.diff).toBe("normal diff")
		expect(executedParams.path).toBe("src/file.ts")
	})

	// -----------------------------------------------------------------------
	// Test 6: Prefers joined over content for multi_ref
	// -----------------------------------------------------------------------
	it("prefers joined content over single content for multi_ref", async () => {
		const refMeta: ContentRefParams = {
			multi_ref: [{ source: "chat", ref: "-2", selector: "block1" }],
		}
		const nativeArgs = {
			path: "src/file.ts",
			multi_ref: refMeta.multi_ref,
		}
		const block = createToolUseBlock(nativeArgs, refMeta)

		vi.mocked(resolveRef).mockResolvedValue(
			createResolveRefResult({
				content: "content fallback",
				joined: "joined content (preferred)",
			}),
		)

		await tool.handle(task, block, callbacks)

		expect(tool.execute).toHaveBeenCalled()
		const executedParams = tool.execute.mock.calls[0][0]
		// joined should be preferred over content
		expect(executedParams.diff).toBe("joined content (preferred)")
	})

	// -----------------------------------------------------------------------
	// Test 7: Full transform pipeline (replace + prepend + append)
	// -----------------------------------------------------------------------
	it("applies full transform pipeline to diff content", async () => {
		const refMeta: ContentRefParams = {
			ref: {
				source: "chat",
				ref: "-1",
				selector: "myBlock",
			},
			transform: {
				replace: { from: "SEARCH", to: "SEARCH_MODIFIED" },
				prepend: "// START\n",
				wrap_with: "```\n{content}\n```",
				append: "\n// END",
			},
		}
		const nativeArgs = {
			path: "src/file.ts",
			ref: refMeta.ref,
			transform: refMeta.transform,
		}
		const block = createToolUseBlock(nativeArgs, refMeta)

		vi.mocked(resolveRef).mockResolvedValue(
			createResolveRefResult({
				content: "// START\n```\n<<<<<<< SEARCH_MODIFIED\nold\n=======\nnew\n>>>>>>> REPLACE\n```\n// END",
			}),
		)

		await tool.handle(task, block, callbacks)

		expect(tool.execute).toHaveBeenCalled()
		const executedParams = tool.execute.mock.calls[0][0]
		expect(executedParams.diff).toContain("SEARCH_MODIFIED")
		expect(executedParams.diff).toContain("// START")
		expect(executedParams.diff).toContain("// END")
		expect(executedParams.diff).toContain("```")
	})

	// -----------------------------------------------------------------------
	// Test 8: CRT log appended to pushToolResult on success
	// -----------------------------------------------------------------------
	it("appends CRT log to pushToolResult on successful ref resolution", async () => {
		const refMeta = createRefMeta()
		const nativeArgs = {
			path: "src/file.ts",
			ref: refMeta.ref,
		}
		const block = createToolUseBlock(nativeArgs, refMeta)

		vi.mocked(resolveRef).mockResolvedValue(
			createResolveRefResult({
				content: "resolved diff",
				resolved: [
					{
						sourceId: "chat:-1",
						content: "resolved diff",
						startOffset: 0,
						endOffset: 13,
						confidence: 1.0,
						method: "exact",
					},
				],
			}),
		)

		await tool.handle(task, block, callbacks)

		// Get the wrapped callbacks passed to execute
		const executedCallbacks = tool.execute.mock.calls[0][2]

		// Call the wrapped pushToolResult
		executedCallbacks.pushToolResult("Tool executed successfully")

		expect(callbacks.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("[CRT] ref resolved"))
		expect(callbacks.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("source=chat:-1"))
	})
})
