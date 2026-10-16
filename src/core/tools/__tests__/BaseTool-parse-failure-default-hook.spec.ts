// npx vitest run core/tools/__tests__/BaseTool-parse-failure-default-hook.spec.ts

import { describe, it, expect, vi } from "vitest"

import { BaseTool, type ToolCallbacks } from "../BaseTool"
import type { Task } from "../../task/Task"
import type { ToolUse } from "../../../shared/tools"

/**
 * A tool that keeps no per-task stream state: it inherits BaseTool's default
 * releaseStreamStateOnParseFailure(), which reports nothing and returns false. Every tool
 * except write_to_file runs through that default, so the generic parse error is the only
 * thing a user would ever see for a malformed call - if the default ever started
 * swallowing it, parse errors would vanish for the whole tool set at once.
 */
class DefaultHookTool extends BaseTool<"execute_command"> {
	readonly name = "execute_command" as const
	execute = vi.fn().mockResolvedValue(undefined)
}

const buildTask = (): Task => ({ taskId: "parse-failure-task", instanceId: "inst-1" }) as unknown as Task

const buildCallbacks = (): ToolCallbacks => ({
	askApproval: vi.fn().mockResolvedValue({ response: "yesButtonClicked" }),
	handleError: vi.fn().mockResolvedValue(undefined),
	pushToolResult: vi.fn(),
})

describe("BaseTool parse-failure path with the default stream-release hook", () => {
	it("skips execute() and reports the generic parse error exactly once", async () => {
		const tool = new DefaultHookTool()
		const task = buildTask()
		const callbacks = buildCallbacks()
		// A non-native block: no nativeArgs, and params carry no XML markup, so the parse step
		// fails on the missing native arguments rather than on the legacy-format message.
		const block = {
			type: "tool_use",
			id: "call-parse-1",
			name: "execute_command",
			params: { command: "ls" },
			partial: false,
		} as unknown as ToolUse<"execute_command">

		await tool.handle(task, block, callbacks)

		expect(tool.execute).not.toHaveBeenCalled()
		expect(callbacks.handleError).toHaveBeenCalledTimes(1)
		expect(callbacks.handleError).toHaveBeenCalledWith(
			"parsing execute_command args",
			expect.objectContaining({ message: expect.stringContaining("missing native arguments") }),
		)
		// The hook consulted here is BaseTool's own, not an override: this is the path every
		// tool other than write_to_file takes.
		expect(DefaultHookTool.prototype["releaseStreamStateOnParseFailure"]).toBe(
			BaseTool.prototype["releaseStreamStateOnParseFailure"],
		)
		expect(callbacks.pushToolResult).not.toHaveBeenCalled()
	})
})
