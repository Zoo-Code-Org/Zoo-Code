import { describe, expect, it, vi } from "vitest"

import type { ToolUse } from "../../../shared/tools"
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
	const callbacks = { pushToolResult: vi.fn(), handleError: vi.fn() } as unknown as ToolCallbacks
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
		expect(tool.lastParams).toEqual({ required_value: "a" })
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
