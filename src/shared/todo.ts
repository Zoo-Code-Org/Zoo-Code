import { todoItemSchema, type ClineMessage, type TodoItem } from "@roo-code/types"

export function getLatestTodo(clineMessages: ClineMessage[]): TodoItem[] {
	let legacyList: TodoItem[] | undefined
	for (let i = clineMessages.length - 1; i >= 0; i--) {
		const msg = clineMessages[i]
		if (msg.initialTodos !== undefined) {
			const seed = todoItemSchema.array().safeParse(msg.initialTodos)
			if (seed.success) return legacyList ?? seed.data
		}
		const isEdit = msg.type === "say" && msg.say === "user_edit_todos"
		const isAsk = msg.type === "ask" && msg.ask === "tool"
		if (!isEdit && !isAsk) continue
		if (msg.partial === true || msg.autoApprovalDecision === "deny" || (isAsk && msg.isAnswered === false)) {
			continue
		}
		try {
			const item = JSON.parse(msg.text ?? "{}") as { tool?: unknown; todos?: unknown }
			if (item.tool !== "updateTodoList" || !Array.isArray(item.todos)) continue
			if (isEdit || msg.isAnswered === true) return item.todos as TodoItem[]
			// Older saved tasks did not always stamp isAnswered. Use one only if
			// no accepted list can be found, so a new pending ask cannot clear it.
			legacyList ??= item.todos as TodoItem[]
		} catch {
			// Ignore malformed tool text and continue to the previous accepted list.
		}
	}
	return legacyList ?? []
}
