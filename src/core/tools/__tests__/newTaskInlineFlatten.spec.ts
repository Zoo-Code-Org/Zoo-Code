// npx vitest run core/tools/__tests__/newTaskInlineFlatten.spec.ts

import { describe, it, expect, vi } from "vitest"
import type { TodoItem } from "@roo-code/types"
import { Task } from "../../task/Task"
import type { InlineSubtask } from "../../task/Task"
import { newTaskTool } from "../NewTaskTool"
import { attemptCompletionTool } from "../AttemptCompletionTool"
import type { ToolCallbacks } from "../BaseTool"

/**
 * Minimal provider double. `getState` returns the taskTree settings; the delegate case
 * additionally needs `delegateParentAndOpenChild`. Cast once to ClineProvider so the
 * tool's `(provider as any).delegateParentAndOpenChild` call resolves.
 */
function makeProvider(overrides: { maxNestingDepth?: number; autoFlattenOnLimit?: boolean } = {}) {
	const delegateParentAndOpenChild = vi.fn().mockResolvedValue({ taskId: "child-1" })
	return {
		getState: vi.fn().mockResolvedValue({
			maxNestingDepth: overrides.maxNestingDepth ?? 2,
			autoFlattenOnLimit: overrides.autoFlattenOnLimit ?? true,
		}),
		delegateParentAndOpenChild,
	}
}

/** Precise Task double carrying only the fields NewTaskTool/AttemptCompletionTool touch. */
function makeTask(opts: { depth?: number; inlineSubtask?: InlineSubtask; provider: unknown }) {
	// Build a plain double carrying only the fields NewTaskTool/AttemptCompletionTool touch,
	// then cast once to Task (same pattern as new-task-delegation.spec.ts). A single
	// `as unknown as Task` avoids per-field intersection-type conflicts with Task's real members.
	const task = {
		taskId: "parent-1",
		depth: opts.depth ?? 0,
		inlineSubtask: opts.inlineSubtask,
		consecutiveMistakeCount: 0,
		didToolFailInCurrentTurn: false,
		recordToolError: vi.fn(),
		sayAndCreateMissingParamError: vi.fn().mockResolvedValue("missing param"),
		providerRef: { deref: () => opts.provider },
	}
	return task as unknown as Task
}

function makeCallbacks() {
	const askApproval = vi.fn().mockResolvedValue(true)
	const pushToolResult = vi.fn()
	const handleError = vi.fn()
	const callbacks: ToolCallbacks = { askApproval, handleError, pushToolResult }
	return { askApproval, pushToolResult, handleError, callbacks }
}

describe("NewTaskTool auto-flatten inline", () => {
	it("delegates normally when within the limit (approval + child opened)", async () => {
		const provider = makeProvider({ maxNestingDepth: 2 })
		const task = makeTask({ depth: 0, provider }) // child would be depth 1 <= 2
		const { askApproval, pushToolResult } = makeCallbacks()

		await newTaskTool.execute({ mode: "code", message: "do X" }, task, {
			askApproval,
			handleError: vi.fn(),
			pushToolResult,
		})

		expect(askApproval).toHaveBeenCalledTimes(1)
		expect(provider.delegateParentAndOpenChild).toHaveBeenCalledWith(
			expect.objectContaining({ parentTaskId: expect.anything() }),
		)
		expect(task.inlineSubtask).toBeUndefined()
		// Delegation reflected in the tool result, not an inline directive.
		expect(pushToolResult).toHaveBeenCalledWith("Delegated to child task child-1")
	})

	it("flattens inline when over the limit (no approval, no child, marker set)", async () => {
		const provider = makeProvider({ maxNestingDepth: 2 })
		const task = makeTask({ depth: 2, provider }) // child would be depth 3 > 2
		const { askApproval, pushToolResult } = makeCallbacks()

		await newTaskTool.execute({ mode: "code", message: "do X" }, task, {
			askApproval,
			handleError: vi.fn(),
			pushToolResult,
		})

		// No approval prompt and no child opened.
		expect(askApproval).not.toHaveBeenCalled()
		expect(provider.delegateParentAndOpenChild).not.toHaveBeenCalled()
		// Phase marker set with the instruction.
		expect(task.inlineSubtask).toEqual({ message: "do X", todos: [] })
		// tool_result doubles as the inline directive.
		const pushed = pushToolResult.mock.calls[0][0] as string
		expect(pushed).toContain("auto-flattened")
		expect(pushed).toContain("do X")
	})

	it("rejects when over the limit and autoFlattenOnLimit is false (error result, no marker)", async () => {
		const provider = makeProvider({ maxNestingDepth: 2, autoFlattenOnLimit: false })
		const task = makeTask({ depth: 2, provider }) // child would be depth 3 > 2
		const { askApproval, pushToolResult } = makeCallbacks()

		await newTaskTool.execute({ mode: "code", message: "do X" }, task, {
			askApproval,
			handleError: vi.fn(),
			pushToolResult,
		})

		expect(askApproval).not.toHaveBeenCalled()
		expect(provider.delegateParentAndOpenChild).not.toHaveBeenCalled()
		expect(task.inlineSubtask).toBeUndefined()
		const pushed = pushToolResult.mock.calls[0][0] as string
		expect(pushed.toLowerCase()).toContain("error")
	})

	it("rejects a nested new_task while an inline phase is already active", async () => {
		const provider = makeProvider({ maxNestingDepth: 5 })
		const task = makeTask({ depth: 1, provider, inlineSubtask: { message: "outer", todos: [] } })
		const { askApproval, pushToolResult } = makeCallbacks()

		await newTaskTool.execute({ mode: "code", message: "inner" }, task, {
			askApproval,
			handleError: vi.fn(),
			pushToolResult,
		})

		expect(askApproval).not.toHaveBeenCalled()
		expect(provider.delegateParentAndOpenChild).not.toHaveBeenCalled()
		// Existing marker preserved (not overwritten by the rejected nested call).
		expect(task.inlineSubtask?.message).toBe("outer")
		const pushed = pushToolResult.mock.calls[0][0] as string
		expect(pushed.toLowerCase()).toContain("error")
	})
})

describe("AttemptCompletionTool inline-phase completion", () => {
	it("clears the marker, pushes a continue result, and skips askFinishSubTaskApproval", async () => {
		const provider = makeProvider()
		const task = makeTask({ depth: 2, provider, inlineSubtask: { message: "do X", todos: [] } })
		// AttemptCompletionTool reads todoList; leave it undefined so the open-todos guard is skipped.
		;(task as unknown as { todoList?: TodoItem[] }).todoList = undefined

		const askFinishSubTaskApproval = vi.fn().mockResolvedValue(true)
		const pushToolResult = vi.fn()
		const say = vi.fn().mockResolvedValue({ response: "yesButtonClicked" })
		;(task as unknown as { say: typeof say }).say = say

		await attemptCompletionTool.execute({ result: "done with the subtask" }, task, {
			askApproval: vi.fn().mockResolvedValue(true),
			handleError: vi.fn(),
			pushToolResult,
			askFinishSubTaskApproval,
			toolDescription: () => "attempt_completion",
		})

		// Marker cleared.
		expect(task.inlineSubtask).toBeUndefined()
		// No subtask-finish approval popup (user is already in this conversation).
		expect(askFinishSubTaskApproval).not.toHaveBeenCalled()
		// The loop continues with a tool_result summarizing the inline completion.
		const pushed = pushToolResult.mock.calls[0][0] as string
		expect(pushed).toContain("[inline subtask completed]")
		expect(pushed).toContain("done with the subtask")
	})

	it("does NOT take the inline branch when no marker is set (falls through to normal flow)", async () => {
		const provider = makeProvider()
		const task = makeTask({ depth: 2, provider }) // no inlineSubtask
		;(task as unknown as { todoList?: TodoItem[] }).todoList = undefined

		const askFinishSubTaskApproval = vi.fn().mockResolvedValue(true)
		const pushToolResult = vi.fn()
		// Normal flow reaches task.ask("completion_result", ...); stub it to return a decline.
		;(task as unknown as { ask: ReturnType<typeof vi.fn> }).ask = vi
			.fn()
			.mockResolvedValue({ response: "noButtonClicked" })
		const say = vi.fn().mockResolvedValue(undefined)
		;(task as unknown as { say: typeof say }).say = say

		await attemptCompletionTool.execute({ result: "normal completion" }, task, {
			askApproval: vi.fn().mockResolvedValue(true),
			handleError: vi.fn(),
			pushToolResult,
			askFinishSubTaskApproval,
			toolDescription: () => "attempt_completion",
		})

		// No inline marker was set, so the inline branch must not have fired.
		expect(task.inlineSubtask).toBeUndefined()
		const pushed = pushToolResult.mock.calls.map((c) => c[0]).join("\n") as string
		expect(pushed).not.toContain("[inline subtask completed]")
	})
})
