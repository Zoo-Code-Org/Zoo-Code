import type { ClineMessage, TodoItem } from "@roo-code/types"
import type { Task } from "../../task/Task"
import type { ToolCallbacks } from "../BaseTool"
import { NativeToolCallParser } from "../../assistant-message/NativeToolCallParser"
import { restoreTodoListForTask, setPendingTodoList, updateTodoListTool } from "../UpdateTodoListTool"
import { newTaskTool } from "../NewTaskTool"
import { webviewMessageHandler } from "../../webview/webviewMessageHandler"
import type { ClineProvider } from "../../webview/ClineProvider"

function fixture(taskId = "task") {
	const state = {
		taskId,
		consecutiveMistakeCount: 0,
		didToolFailInCurrentTurn: false,
		recordToolError: vi.fn<Task["recordToolError"]>(),
		todoList: [{ id: "existing", content: "Keep working", status: "in_progress" }] as TodoItem[],
		clineMessages: [] as ClineMessage[],
		say: vi.fn<Task["say"]>().mockResolvedValue(undefined),
		ask: vi.fn<Task["ask"]>().mockResolvedValue({ response: "yesButtonClicked" }),
	}
	// The tools under test use only these in-memory fields, notifications and error counters.
	const task = state as unknown as Task
	const callbacks = {
		toolCallId: "call",
		pushToolResult: vi.fn<ToolCallbacks["pushToolResult"]>(),
		handleError: vi.fn<ToolCallbacks["handleError"]>().mockResolvedValue(undefined),
		askApproval: vi.fn<ToolCallbacks["askApproval"]>().mockResolvedValue(true),
	}
	return { state, task, callbacks }
}

describe("native TODO calls", () => {
	it.each([
		"[-] #17: add https://example.com/link\n[ ] Tests",
		[{ content: "#17: add https://example.com/link", status: "in_progress" }, { content: "Tests" }],
		JSON.stringify([{ content: "#17: add https://example.com/link", status: "in_progress" }, { content: "Tests" }]),
	])("passes supported JSON arguments through the real parser and tool (%j)", async (todos) => {
		const { state, task, callbacks } = fixture()
		state.consecutiveMistakeCount = 2
		const block = NativeToolCallParser.parseToolCall({
			name: "update_todo_list",
			id: "call",
			arguments: JSON.stringify({ todos }),
		})
		if (!block || block.type !== "tool_use") throw new Error("native JSON arguments did not parse")
		await updateTodoListTool.handle(task, block, callbacks)
		expect(state.todoList.map(({ content, status }) => ({ content, status }))).toEqual([
			{ content: "#17: add https://example.com/link", status: "in_progress" },
			{ content: "Tests", status: "pending" },
		])
		expect(callbacks.handleError).not.toHaveBeenCalled()
		expect(state.consecutiveMistakeCount).toBe(0)
		expect(callbacks.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("updated successfully"))
	})

	it.each([
		null,
		undefined,
		{},
		"[ ] Valid\ninvalid item",
		[{ content: "Valid" }, { content: "Bad status", status: "done" }],
	])("preserves the existing list and gives actionable feedback for invalid input (%j)", async (todos) => {
		const { state, task, callbacks } = fixture()
		const previous = state.todoList
		await updateTodoListTool.execute({ todos }, task, callbacks)
		expect(state.todoList).toBe(previous)
		expect(callbacks.askApproval).not.toHaveBeenCalled()
		expect(callbacks.pushToolResult).toHaveBeenCalledWith(
			expect.stringContaining("Call the tool with JSON arguments"),
		)
		expect(state.didToolFailInCurrentTurn).toBe(true)
	})

	it("isolates pending approval edits across concurrent tasks and releases them afterwards", async () => {
		const a = fixture("a"),
			b = fixture("b")
		let approveA!: (approved: boolean) => void
		let approveB!: (approved: boolean) => void
		a.callbacks.askApproval.mockReturnValueOnce(
			new Promise((resolve) => {
				approveA = resolve
			}),
		)
		b.callbacks.askApproval.mockReturnValueOnce(
			new Promise((resolve) => {
				approveB = resolve
			}),
		)
		const first = updateTodoListTool.execute({ todos: "[ ] Task A" }, a.task, a.callbacks)
		const second = updateTodoListTool.execute({ todos: "[ ] Task B" }, b.task, b.callbacks)
		expect(setPendingTodoList(a.task, [{ id: "edit", content: "Edited A", status: "in_progress" }])).toBe(true)
		approveB(true)
		await second
		approveA(true)
		await first
		expect(a.state.todoList[0]?.content).toBe("Edited A")
		expect(b.state.todoList[0]?.content).toBe("Task B")
		expect(setPendingTodoList(a.task, [])).toBe(false)
		expect(setPendingTodoList(b.task, [])).toBe(false)
	})

	it("keeps the list when approval is declined or throws, and rejects invalid approval edits", async () => {
		const { state, task, callbacks } = fixture()
		callbacks.askApproval.mockImplementationOnce(async () => {
			expect(setPendingTodoList(task, [{ content: "bad", status: "done" }])).toBe(false)
			return false
		})
		await updateTodoListTool.execute({ todos: "[ ] Replacement" }, task, callbacks)
		expect(state.todoList[0]?.id).toBe("existing")
		expect(setPendingTodoList(task, [])).toBe(false)
		callbacks.askApproval.mockRejectedValueOnce(new Error("approval failed"))
		await updateTodoListTool.execute({ todos: "[ ] Replacement" }, task, callbacks)
		expect(state.todoList[0]?.id).toBe("existing")
		expect(setPendingTodoList(task, [])).toBe(false)
	})

	it.each([
		{ taskId: "old-task", expected: "Original" },
		{ taskId: "active", expected: "Edited" },
	])("routes approval edits for $taskId without applying them to another task", async ({ taskId, expected }) => {
		const { task, state, callbacks } = fixture("active")
		let approve!: (accepted: boolean) => void
		callbacks.askApproval.mockReturnValueOnce(
			new Promise((resolve) => {
				approve = resolve
			}),
		)
		const update = updateTodoListTool.execute({ todos: "[ ] Original" }, task, callbacks)
		// This handler branch only reads the current Task; it needs no VS Code surface.
		const host = { getCurrentTask: () => task } as unknown as ClineProvider
		await webviewMessageHandler(host, {
			type: "updateTodoList",
			taskId,
			payload: { todos: [{ content: "Edited", status: "pending" }] },
		})
		approve(true)
		await update
		expect(state.todoList[0]?.content).toBe(expected)
	})

	it("previews native arguments without changing accepted state", async () => {
		const { state, task } = fixture()
		await updateTodoListTool.handlePartial(task, {
			type: "tool_use",
			name: "update_todo_list",
			params: {},
			nativeArgs: { todos: "[ ] Preview" },
			partial: true,
		})
		expect(state.ask).toHaveBeenCalledWith("tool", expect.stringContaining("Preview"), true)
		expect(state.todoList[0]?.id).toBe("existing")
	})

	it("restores the accepted JSON-format update from saved UI history", async () => {
		const { state, task, callbacks } = fixture()
		callbacks.askApproval.mockImplementationOnce(async (_type, text) => {
			state.clineMessages.push({ ts: 1, type: "ask", ask: "tool", text, isAnswered: true })
			return true
		})
		await updateTodoListTool.execute(
			{ todos: [{ content: "Saved JSON task", status: "in_progress" }] },
			task,
			callbacks,
		)
		const accepted = state.todoList
		state.clineMessages = JSON.parse(JSON.stringify(state.clineMessages))
		state.todoList = []
		restoreTodoListForTask(task)
		expect(state.todoList).toEqual(accepted)
	})

	it("requires approval before an intentional empty replacement", async () => {
		const { state, task, callbacks } = fixture()
		await updateTodoListTool.execute({ todos: "" }, task, callbacks)
		expect(callbacks.askApproval).toHaveBeenCalledOnce()
		expect(state.todoList).toEqual([])
	})

	it("rejects invalid initial todos before delegating a new task", async () => {
		const { task, callbacks } = fixture()
		const delegate = vi.fn()
		// NewTask validation additionally reads this provider state before delegation.
		task.providerRef = new WeakRef({
			getState: vi.fn().mockResolvedValue({}),
			delegateParentAndOpenChild: delegate,
		} as unknown as import("../../webview/ClineProvider").ClineProvider)
		await newTaskTool.execute(
			{ mode: "code", message: "Work", todos: '[{"content":"Task","status":"done"}]' },
			task,
			callbacks,
		)
		expect(delegate).not.toHaveBeenCalled()
		expect(callbacks.pushToolResult).toHaveBeenCalledWith(
			expect.stringContaining("status must be pending, in_progress, or completed"),
		)
	})
})
