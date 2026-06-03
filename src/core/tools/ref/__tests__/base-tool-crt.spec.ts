/**
 * Tests for BaseTool CRT integration — src/core/tools/BaseTool.ts
 *
 * Covers:
 * - injectRefContent: parameter injection for all CRT-enabled tools
 * - handle(): CRT resolution flow, graceful fallback, missing nativeArgs
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

// ---------------------------------------------------------------------------
// Mock resolveRef before importing BaseTool, keeping other exports actual
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
 * Minimal subclass of BaseTool for testing purposes.
 * Exposes the private handle() and injectRefContent() for direct testing.
 */
class TestTool extends BaseTool<"execute_command"> {
	readonly name = "execute_command" as const

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
			startAnchor: "hello",
		},
		...overrides,
	}
}

function createResolveRefResult(overrides: Partial<ResolveRefResult> = {}): ResolveRefResult {
	return {
		content: "resolved content",
		resolved: [],
		confidence: 1.0,
		...overrides,
	}
}

function createToolUseBlock(
	name: "execute_command",
	nativeArgs: any,
	refMeta?: ContentRefParams,
): ToolUse<"execute_command"> {
	return {
		type: "tool_use",
		name,
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
// injectRefContent — Parameter Injection
// ===========================================================================

describe("BaseTool.injectRefContent", () => {
	let tool: TestTool

	beforeEach(() => {
		tool = new TestTool()
	})

	/**
	 * Access the private injectRefContent method via type assertion.
	 */
	function callInjectRefContent(params: any, toolName: string, refResults: ResolveRefResult): any {
		return (tool as any).injectRefContent(params, toolName, refResults)
	}

	it("injects content into 'command' for execute_command", () => {
		const params = { command: "original", cwd: "/tmp" }
		const result = createResolveRefResult({ content: "new command" })

		const updated = callInjectRefContent(params, "execute_command", result)

		expect(updated.command).toBe("new command")
		expect(updated.cwd).toBe("/tmp") // other fields preserved
	})

	it("injects content into 'content' for write_to_file", () => {
		const params = { path: "file.ts", content: "original" }
		const result = createResolveRefResult({ content: "new content" })

		const updated = callInjectRefContent(params, "write_to_file", result)

		expect(updated.content).toBe("new content")
		expect(updated.path).toBe("file.ts")
	})

	it("injects content into 'diff' for apply_diff", () => {
		const params = { path: "file.ts", diff: "original diff" }
		const result = createResolveRefResult({ content: "new diff" })

		const updated = callInjectRefContent(params, "apply_diff", result)

		expect(updated.diff).toBe("new diff")
		expect(updated.path).toBe("file.ts")
	})

	it("injects content into 'patch' for apply_patch", () => {
		const params = { patch: "original patch" }
		const result = createResolveRefResult({ content: "new patch" })

		const updated = callInjectRefContent(params, "apply_patch", result)

		expect(updated.patch).toBe("new patch")
	})

	it("injects content into 'new_string' for edit", () => {
		const params = { file_path: "f.ts", old_string: "old", new_string: "original" }
		const result = createResolveRefResult({ content: "replacement" })

		const updated = callInjectRefContent(params, "edit", result)

		expect(updated.new_string).toBe("replacement")
		expect(updated.old_string).toBe("old") // old_string preserved
	})

	it("injects content into 'new_string' for search_and_replace", () => {
		const params = { file_path: "f.ts", old_string: "old", new_string: "original" }
		const result = createResolveRefResult({ content: "replacement" })

		const updated = callInjectRefContent(params, "search_and_replace", result)

		expect(updated.new_string).toBe("replacement")
	})

	it("injects content into 'new_string' for search_replace", () => {
		const params = { file_path: "f.ts", old_string: "old", new_string: "original" }
		const result = createResolveRefResult({ content: "replacement" })

		const updated = callInjectRefContent(params, "search_replace", result)

		expect(updated.new_string).toBe("replacement")
	})

	it("injects content into 'new_string' for edit_file", () => {
		const params = { file_path: "f.ts", old_string: "old", new_string: "original" }
		const result = createResolveRefResult({ content: "replacement" })

		const updated = callInjectRefContent(params, "edit_file", result)

		expect(updated.new_string).toBe("replacement")
	})

	it("prefers 'joined' over 'content' when both are present", () => {
		const params = { command: "original" }
		const result = createResolveRefResult({
			content: "single content",
			joined: "joined content",
		})

		const updated = callInjectRefContent(params, "execute_command", result)

		expect(updated.command).toBe("joined content")
	})

	it("returns params unchanged for unknown tool name", () => {
		const params = { command: "original" }
		const result = createResolveRefResult({ content: "resolved" })

		const updated = callInjectRefContent(params, "unknown_tool", result)

		expect(updated.command).toBe("original")
	})

	it("does not mutate the original params object", () => {
		const params = { command: "original", cwd: "/tmp" }
		const result = createResolveRefResult({ content: "new command" })

		callInjectRefContent(params, "execute_command", result)

		// Original must remain unchanged
		expect(params.command).toBe("original")
	})
})

// ===========================================================================
// handle() — CRT Integration
// ===========================================================================

describe("BaseTool.handle() CRT integration", () => {
	let tool: TestTool
	let task: any
	let callbacks: ToolCallbacks

	beforeEach(() => {
		vi.clearAllMocks()
		tool = new TestTool()
		task = createMockTask()
		callbacks = createCallbacks()
	})

	it("resolves ref and updates params when block.refMeta is set and resolveRef succeeds", async () => {
		const refMeta = createRefMeta()
		const block = createToolUseBlock("execute_command", { command: "original" }, refMeta)

		vi.mocked(resolveRef).mockResolvedValue(createResolveRefResult({ content: "resolved command" }))

		await tool.handle(task, block, callbacks)

		expect(resolveRef).toHaveBeenCalledWith(refMeta, task)
		expect(tool.execute).toHaveBeenCalled()
		// The params passed to execute should have the resolved command
		const executedParams = tool.execute.mock.calls[0][0]
		expect(executedParams.command).toBe("resolved command")
	})

	it("appends CRT log to pushToolResult on success", async () => {
		const refMeta = {
			ref: {
				source: "chat" as const,
				ref: "-1",
				startAnchor: "start",
				endAnchor: "end",
			},
		}
		const block = createToolUseBlock("execute_command", { command: "original" }, refMeta)

		const resolvedResult = createResolveRefResult({
			content: "resolved command",
			resolved: [
				{
					sourceId: "chat:-1",
					content: "resolved command",
					startOffset: 0,
					endOffset: 16,
					confidence: 1.0,
					method: "anchor",
				},
			],
			confidence: 1.0,
		})
		vi.mocked(resolveRef).mockResolvedValue(resolvedResult)

		await tool.handle(task, block, callbacks)

		// Get the wrapped callbacks passed to execute
		const executedCallbacks = tool.execute.mock.calls[0][2]

		// Call the wrapped pushToolResult
		executedCallbacks.pushToolResult("original result")

		expect(callbacks.pushToolResult).toHaveBeenCalledWith(
			"original result\n\n[CRT] ref resolved: source=chat:-1, method=anchor, confidence=1.00",
		)
	})

	it("appends CRT log to pushToolResult on fallback", async () => {
		const refMeta = {
			ref: {
				source: "chat" as const,
				ref: "-1",
				focus: "myFunction",
			},
		}
		const block = createToolUseBlock("execute_command", { command: "original" }, refMeta)

		vi.mocked(resolveRef).mockRejectedValue(new Error("AST parse failed"))

		await tool.handle(task, block, callbacks)

		// Get the wrapped callbacks passed to execute
		const executedCallbacks = tool.execute.mock.calls[0][2]

		// Call the wrapped pushToolResult
		executedCallbacks.pushToolResult("original result")

		expect(callbacks.pushToolResult).toHaveBeenCalledWith(
			'original result\n\n[CRT] ref not found: source=chat:-1, focus="myFunction" — resolution failed, falling back to original params',
		)
	})

	it("falls back to original params when resolveRef throws", async () => {
		const refMeta = createRefMeta()
		const block = createToolUseBlock("execute_command", { command: "original" }, refMeta)

		vi.mocked(resolveRef).mockRejectedValue(new Error("ref not found"))

		await tool.handle(task, block, callbacks)

		// Should still execute with original params (graceful fallback)
		expect(tool.execute).toHaveBeenCalled()
		const executedParams = tool.execute.mock.calls[0][0]
		expect(executedParams.command).toBe("original")
		// Error should be logged but NOT propagated
		expect(callbacks.handleError).not.toHaveBeenCalled()
	})

	it("skips CRT when block.refMeta is not set", async () => {
		const block = createToolUseBlock("execute_command", { command: "original" })

		await tool.handle(task, block, callbacks)

		expect(resolveRef).not.toHaveBeenCalled()
		expect(tool.execute).toHaveBeenCalled()
		const executedParams = tool.execute.mock.calls[0][0]
		expect(executedParams.command).toBe("original")
	})

	it("returns error when block.nativeArgs is not set", async () => {
		const block: ToolUse<"execute_command"> = {
			type: "tool_use",
			name: "execute_command",
			params: { command: "<some>xml</some>" },
			partial: false,
			// nativeArgs is undefined
		}

		await tool.handle(task, block, callbacks)

		expect(callbacks.handleError).toHaveBeenCalled()
		expect(tool.execute).not.toHaveBeenCalled()
	})

	it("handles partial messages without CRT", async () => {
		const block: ToolUse<"execute_command"> = {
			type: "tool_use",
			name: "execute_command",
			params: {},
			partial: true,
		}

		await tool.handle(task, block, callbacks)

		// Partial messages should not trigger execute or CRT
		expect(tool.execute).not.toHaveBeenCalled()
		expect(resolveRef).not.toHaveBeenCalled()
	})

	it("does not inject when resolveRef returns empty content", async () => {
		const refMeta = createRefMeta()
		const block = createToolUseBlock("execute_command", { command: "original" }, refMeta)

		// resolveRef returns content that is falsy (empty string)
		vi.mocked(resolveRef).mockResolvedValue(createResolveRefResult({ content: "" }))

		await tool.handle(task, block, callbacks)

		// Empty content is falsy, so injectRefContent should NOT be called
		// Original params should be used
		expect(tool.execute).toHaveBeenCalled()
		const executedParams = tool.execute.mock.calls[0][0]
		expect(executedParams.command).toBe("original")
	})
})
