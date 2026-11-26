import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as os from "node:os"
import type { ClineMessage } from "@roo-code/types"

import { readTaskMessages, saveTaskMessages } from "../taskMessages"
import { getLatestTodo } from "../../../shared/todo"
import { parseTodoListInput } from "../../../shared/todoChecklist"

describe("TODO disk history round trip", () => {
	let storage: string
	beforeEach(async () => {
		storage = await fs.mkdtemp(path.join(os.tmpdir(), "zoo-todo-history-"))
	})
	afterEach(async () => {
		await fs.rm(storage, { recursive: true, force: true })
	})
	it("preserves initial seeds and later approved JSON updates through actual file writes", async () => {
		const seed = parseTodoListInput("[ ] Initial delegated task")
		const messages: ClineMessage[] = [{ ts: 1, type: "say", say: "text", text: "Task", initialTodos: seed }]
		await saveTaskMessages({ taskId: "todo", globalStoragePath: storage, messages })
		expect(getLatestTodo(await readTaskMessages({ taskId: "todo", globalStoragePath: storage }))).toEqual(seed)
		const edited = parseTodoListInput([{ content: "#17: clickable https://example.com/link", status: "completed" }])
		messages.push({
			ts: 2,
			type: "ask",
			ask: "tool",
			isAnswered: true,
			text: JSON.stringify({ tool: "updateTodoList", todos: edited }),
		})
		await saveTaskMessages({ taskId: "todo", globalStoragePath: storage, messages, merge: true })
		expect(getLatestTodo(await readTaskMessages({ taskId: "todo", globalStoragePath: storage }))).toEqual(edited)
	})
})
