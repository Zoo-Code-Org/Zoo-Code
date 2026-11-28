import { Task } from "../task/Task"
import { formatResponse } from "../prompts/responses"
import { BaseTool, ToolCallbacks } from "./BaseTool"
import type { ToolUse } from "../../shared/tools"
import { TodoItem } from "@roo-code/types"
import { parseMarkdownChecklist, parseTodoListInput } from "../../shared/todoChecklist"
import { getLatestTodo } from "../../shared/todo"

export { parseMarkdownChecklist } from "../../shared/todoChecklist"

interface UpdateTodoListParams {
	todos: unknown
}

interface PendingTodoApproval {
	todos: TodoItem[]
}
const pendingTodoLists = new WeakMap<Task, PendingTodoApproval>()

export class UpdateTodoListTool extends BaseTool<"update_todo_list"> {
	readonly name = "update_todo_list" as const

	async execute(params: UpdateTodoListParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { pushToolResult, handleError, askApproval } = callbacks
		let pending: PendingTodoApproval | undefined

		try {
			let normalizedTodos: TodoItem[]
			try {
				normalizedTodos = parseTodoListInput(params?.todos)
			} catch (error) {
				task.consecutiveMistakeCount++
				task.recordToolError("update_todo_list")
				task.didToolFailInCurrentTurn = true
				pushToolResult(formatResponse.toolError(error instanceof Error ? error.message : String(error)))
				return
			}

			const approvalMsg = JSON.stringify({
				tool: "updateTodoList",
				todos: normalizedTodos,
			})

			pending = { todos: normalizedTodos.map((todo) => ({ ...todo })) }
			pendingTodoLists.set(task, pending)
			const didApprove = await askApproval("tool", approvalMsg)
			if (!didApprove) {
				pushToolResult("User declined to update the todoList.")
				return
			}

			const isTodoListChanged = JSON.stringify(normalizedTodos) !== JSON.stringify(pending.todos)
			if (isTodoListChanged) {
				normalizedTodos = pending.todos
				// Non-blocking: a failed notification must not abort persisting the edited list.
				void task
					.say(
						"user_edit_todos",
						JSON.stringify({
							tool: "updateTodoList",
							todos: normalizedTodos,
						}),
					)
					.catch((error) => {
						console.error("[UpdateTodoListTool] Failed to post user_edit_todos:", error)
					})
			}

			await setTodoListForTask(task, normalizedTodos)
			task.consecutiveMistakeCount = 0

			if (isTodoListChanged) {
				const md = todoListToMarkdown(normalizedTodos)
				pushToolResult(formatResponse.toolResult("User edits todo:\n\n" + md))
			} else {
				pushToolResult(formatResponse.toolResult("Todo list updated successfully."))
			}
		} catch (error) {
			await handleError("update todo list", error instanceof Error ? error : new Error(String(error)))
		} finally {
			if (pending && pendingTodoLists.get(task) === pending) pendingTodoLists.delete(task)
		}
	}

	override async handlePartial(task: Task, block: ToolUse<"update_todo_list">): Promise<void> {
		const todosRaw = block.nativeArgs?.todos ?? block.params.todos

		// Parse the markdown checklist to maintain consistent format with execute()
		let todos: TodoItem[]
		try {
			todos = parseTodoListInput(todosRaw)
		} catch {
			// An incomplete streamed checklist may still contain completed lines.
			todos = parseMarkdownChecklist(todosRaw)
		}

		const approvalMsg = JSON.stringify({
			tool: "updateTodoList",
			todos: todos,
		})
		await task.ask("tool", approvalMsg, block.partial).catch(() => {})
	}
}

export async function setTodoListForTask(cline?: Task, todos?: TodoItem[]) {
	if (cline === undefined) return
	cline.todoList = Array.isArray(todos) ? todos : []
}

export function restoreTodoListForTask(cline: Task, todoList?: TodoItem[]) {
	if (todoList) {
		cline.todoList = Array.isArray(todoList) ? todoList : []
		return
	}
	cline.todoList = getLatestTodo(cline.clineMessages)
}

function todoListToMarkdown(todos: TodoItem[]): string {
	return todos
		.map((t) => {
			let box = "[ ]"
			if (t.status === "completed") box = "[x]"
			else if (t.status === "in_progress") box = "[-]"
			return `${box} ${t.content}`
		})
		.join("\n")
}

/** Apply edits only to this Task's currently pending approval. */
export function setPendingTodoList(task: Task, todos: unknown): boolean {
	const pending = pendingTodoLists.get(task)
	if (!pending || !Array.isArray(todos)) return false
	try {
		pending.todos = parseTodoListInput(todos)
		return true
	} catch {
		return false
	}
}

export const updateTodoListTool = new UpdateTodoListTool()
