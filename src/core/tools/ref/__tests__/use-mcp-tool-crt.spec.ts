/**
 * Tests for UseMcpToolTool CRT integration — src/core/tools/UseMcpToolTool.ts
 *
 * Covers:
 * - resolveInlineRefs: {{ref:...}} marker replacement
 * - injectRefsIntoArgs: recursive argument injection for MCP tools
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

// ---------------------------------------------------------------------------
// Mock resolveRef before importing UseMcpToolTool
// ---------------------------------------------------------------------------
vi.mock("../index", () => ({
	resolveRef: vi.fn(),
}))

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------
import { resolveRef } from "../index"
import type { ResolveRefResult } from "../index"
import { useMcpToolTool } from "../../UseMcpToolTool"
import { Task } from "../../../task/Task"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockTask(overrides: Partial<any> = {}): any {
	return {
		taskId: "test-task-001",
		cwd: "/workspace/project",
		providerRef: { deref: () => ({}) },
		assistantMessageContent: [],
		...overrides,
	}
}

function makeResolveRefResult(content: string, overrides: Partial<ResolveRefResult> = {}): ResolveRefResult {
	return {
		content,
		resolved: [],
		confidence: 1.0,
		...overrides,
	}
}

// ===========================================================================
// resolveInlineRefs — {{ref:...}} Marker Replacement
// ===========================================================================

describe("UseMcpToolTool.resolveInlineRefs", () => {
	let task: any

	beforeEach(() => {
		vi.clearAllMocks()
		task = createMockTask()
	})

	it("returns text unchanged when no ref markers are present", async () => {
		const text = "plain text without any markers"

		const result = await (useMcpToolTool as any).resolveInlineRefs(text, task)

		expect(result).toBe("plain text without any markers")
		expect(resolveRef).not.toHaveBeenCalled()
	})

	it("replaces a single ref marker with resolved content", async () => {
		const text = 'prefix {{ref:source=chat,ref=-1,startAnchor="hello"}} suffix'

		vi.mocked(resolveRef).mockResolvedValue(makeResolveRefResult("world"))

		const result = await (useMcpToolTool as any).resolveInlineRefs(text, task)

		expect(result).toBe("prefix world suffix")
		expect(resolveRef).toHaveBeenCalledTimes(1)
		expect(resolveRef).toHaveBeenCalledWith(
			{
				ref: {
					source: "chat",
					ref: "-1",
					startAnchor: '"hello"',
					endAnchor: undefined,
					selector: undefined,
				},
			},
			task,
		)
	})

	it("replaces multiple ref markers in the same string", async () => {
		const text = "a {{ref:source=chat,ref=-1}} b {{ref:source=chat,ref=0}} c"

		// RTL processing: rightmost marker resolved first, then leftmost
		vi.mocked(resolveRef)
			.mockResolvedValueOnce(makeResolveRefResult("second")) // rightmost {{ref:source=chat,ref=0}} first
			.mockResolvedValueOnce(makeResolveRefResult("first")) // leftmost {{ref:source=chat,ref=-1}} second

		const result = await (useMcpToolTool as any).resolveInlineRefs(text, task)

		expect(result).toBe("a first b second c")
		expect(resolveRef).toHaveBeenCalledTimes(2)
	})

	it("supports endAnchor parameter", async () => {
		const text = '{{ref:source=file,ref=src/main.ts,startAnchor="start",endAnchor="end"}}'

		vi.mocked(resolveRef).mockResolvedValue(makeResolveRefResult("file content snippet"))

		const result = await (useMcpToolTool as any).resolveInlineRefs(text, task)

		expect(result).toBe("file content snippet")
		expect(resolveRef).toHaveBeenCalledWith(
			{
				ref: {
					source: "file",
					ref: "src/main.ts",
					startAnchor: '"start"',
					endAnchor: '"end"',
					selector: undefined,
				},
			},
			task,
		)
	})

	it("supports selector parameter", async () => {
		const text = '{{ref:source=chat,ref=-1,selector="exact match"}}'

		vi.mocked(resolveRef).mockResolvedValue(makeResolveRefResult("selected text"))

		const result = await (useMcpToolTool as any).resolveInlineRefs(text, task)

		expect(result).toBe("selected text")
		expect(resolveRef).toHaveBeenCalledWith(
			{
				ref: {
					source: "chat",
					ref: "-1",
					startAnchor: undefined,
					endAnchor: undefined,
					selector: '"exact match"',
				},
			},
			task,
		)
	})

	it("keeps marker as-is when resolveRef throws (graceful fallback)", async () => {
		const text = "before {{ref:source=chat,ref=-1}} after"

		vi.mocked(resolveRef).mockRejectedValue(new Error("ref not found"))

		const result = await (useMcpToolTool as any).resolveInlineRefs(text, task)

		// Marker should remain untouched
		expect(result).toBe("before {{ref:source=chat,ref=-1}} after")
	})

	it("uses default source='chat' and ref='-1' when omitted", async () => {
		const text = '{{ref:startAnchor="fallback test"}}'

		vi.mocked(resolveRef).mockResolvedValue(makeResolveRefResult("fallback content"))

		const result = await (useMcpToolTool as any).resolveInlineRefs(text, task)

		expect(result).toBe("fallback content")
		expect(resolveRef).toHaveBeenCalledWith(
			{
				ref: {
					source: "chat",
					ref: "-1",
					startAnchor: '"fallback test"',
					endAnchor: undefined,
					selector: undefined,
				},
			},
			task,
		)
	})

	it("handles empty params string gracefully", async () => {
		const text = "{{ref:}}"

		vi.mocked(resolveRef).mockResolvedValue(makeResolveRefResult(""))

		const result = await (useMcpToolTool as any).resolveInlineRefs(text, task)

		// resolveRef is called with default source="chat" and ref="-1"
		expect(resolveRef).toHaveBeenCalled()
		// The replacement happens (empty string replaces the marker)
		expect(typeof result).toBe("string")
	})
})

// ===========================================================================
// injectRefsIntoArgs — Recursive Argument Injection
// ===========================================================================

describe("UseMcpToolTool.injectRefsIntoArgs", () => {
	let task: any

	beforeEach(() => {
		vi.clearAllMocks()
		task = createMockTask()
	})

	it("calls resolveInlineRefs for string values", async () => {
		const args = {
			query: "select {{ref:source=chat,ref=-1}} from table",
		}

		vi.mocked(resolveRef).mockResolvedValue(makeResolveRefResult("*"))

		const result = await (useMcpToolTool as any).injectRefsIntoArgs(args, task)

		expect(result).toEqual({ query: "select * from table" })
	})

	it("recursively processes nested objects", async () => {
		const args = {
			filter: {
				name: "user {{ref:source=chat,ref=-1}}",
			},
			options: {
				limit: 10,
				offset: 0,
			},
		}

		vi.mocked(resolveRef).mockResolvedValue(makeResolveRefResult("42"))

		const result = await (useMcpToolTool as any).injectRefsIntoArgs(args, task)

		expect(result).toEqual({
			filter: { name: "user 42" },
			options: { limit: 10, offset: 0 },
		})
	})

	it("skips non-string values (number, boolean, null)", async () => {
		const args = {
			count: 100,
			enabled: true,
			label: "{{ref:source=chat,ref=-1}}",
			data: null,
		}

		vi.mocked(resolveRef).mockResolvedValue(makeResolveRefResult("processed"))

		const result = await (useMcpToolTool as any).injectRefsIntoArgs(args, task)

		expect(result).toEqual({
			count: 100,
			enabled: true,
			label: "processed",
			data: null,
		})
		// Should only call resolveRef once (for the string "label")
		expect(resolveRef).toHaveBeenCalledTimes(1)
	})

	it("returns empty object for empty args", async () => {
		const result = await (useMcpToolTool as any).injectRefsIntoArgs({}, task)

		expect(result).toEqual({})
		expect(resolveRef).not.toHaveBeenCalled()
	})

	it("handles mixed types correctly", async () => {
		const args = {
			url: "https://api.example.com/{{ref:source=chat,ref=0}}",
			page: 1,
			tags: ["a", "b", "c"],
			config: {
				timeout: 5000,
				header: "Bearer {{ref:source=chat,ref=-1}}",
			},
		}

		vi.mocked(resolveRef)
			.mockResolvedValueOnce(makeResolveRefResult("users"))
			.mockResolvedValueOnce(makeResolveRefResult("token123"))

		const result = await (useMcpToolTool as any).injectRefsIntoArgs(args, task)

		expect(result).toEqual({
			url: "https://api.example.com/users",
			page: 1,
			tags: ["a", "b", "c"],
			config: {
				timeout: 5000,
				header: "Bearer token123",
			},
		})
		expect(resolveRef).toHaveBeenCalledTimes(2)
	})

	it("does not mutate the original args object", async () => {
		const args = {
			query: "original {{ref:source=chat,ref=-1}}",
		}

		vi.mocked(resolveRef).mockResolvedValue(makeResolveRefResult("modified"))

		await (useMcpToolTool as any).injectRefsIntoArgs(args, task)

		expect(args.query).toBe("original {{ref:source=chat,ref=-1}}")
	})
})
