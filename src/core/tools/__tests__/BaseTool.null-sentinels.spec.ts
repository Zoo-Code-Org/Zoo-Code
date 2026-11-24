import { describe, expect, it, vi } from "vitest"

import type { AskApproval, HandleError, PushToolResult, ToolUse } from "../../../shared/tools"
import type { Task } from "../../task/Task"
import { BaseTool, type ToolCallbacks } from "../BaseTool"

type TestParams = { required_value: string; optional_limit?: number; mode?: unknown }

class TestTool extends BaseTool<"apply_diff"> {
	name = "apply_diff" as const

	lastParams: TestParams | undefined

	async execute(params: unknown): Promise<void> {
		this.lastParams = params as TestParams
	}
}

describe("BaseTool null-sentinel normalization (#2653 review 4674816417)", () => {
	// A complete typed fixture: every ToolCallbacks member supplied so an
	// interface change surfaces as a type error, not a runtime hole
	// (review 4675158961).
	const pushToolResult = vi.fn() as unknown as PushToolResult
	const handleError = vi.fn() as unknown as HandleError
	const askApproval = vi.fn() as unknown as AskApproval
	const callbacks = {
		pushToolResult,
		handleError,
		askApproval,
		toolCallId: "test-tool-call-id",
	} satisfies ToolCallbacks
	const task = { taskId: "t" } as unknown as Task

	const run = async (nativeArgs: Record<string, unknown>) => {
		const tool = new TestTool()
		const block = { partial: false, nativeArgs } as unknown as ToolUse<"apply_diff">
		await tool.handle(task, block, callbacks)
		return tool
	}

	it("omits null sentinels so optional defaults apply at execution", async () => {
		const tool = await run({ required_value: "a", optional_limit: null, mode: null })

		// A model may send the null sentinel the strict schema advertises for
		// originally-optional parameters; execution must see them omitted so
		// tool defaults apply instead of a null slipping into arithmetic.
		// toStrictEqual: keys carrying undefined must be ABSENT, not merely
		// undefined-valued (review 4675158965).
		expect(tool.lastParams).toStrictEqual({ required_value: "a" })
	})

	it("preserves explicit values and nested content", async () => {
		const tool = await run({
			required_value: "a",
			optional_limit: 1024,
			mode: { nested: null },
		})

		expect(tool.lastParams).toEqual({
			required_value: "a",
			optional_limit: 1024,
			// Nested nulls are untouched: only top-level sentinels are
			// omission artifacts of the strict schema.
			mode: { nested: null },
		})
	})
})
