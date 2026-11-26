import type { ClineMessage, TodoItem } from "@roo-code/types"

import { getLatestTodo } from "../todo"

const original: TodoItem[] = [{ id: "a", content: "Keep this task", status: "in_progress" }]

function todoAsk(ts: number, todos: TodoItem[], overrides: Partial<ClineMessage> = {}): ClineMessage {
	return {
		ts,
		type: "ask",
		ask: "tool",
		text: JSON.stringify({ tool: "updateTodoList", todos }),
		...overrides,
	}
}

describe("getLatestTodo", () => {
	it("restores initial todos while allowing later accepted updates and clears to take precedence", () => {
		const seed: ClineMessage = { ts: 1, type: "say", say: "text", text: "Task", initialTodos: original }
		expect(getLatestTodo([seed, todoAsk(2, [], { partial: true })])).toEqual(original)
		expect(getLatestTodo([seed, todoAsk(2, [], { isAnswered: true })])).toEqual([])
		const restored = getLatestTodo([seed])
		restored[0].content = "Modified in memory"
		expect(seed.initialTodos?.[0]?.content).toBe("Keep this task")
	})
	it("restores the last accepted list instead of a later partial or unanswered request", () => {
		expect(
			getLatestTodo([
				todoAsk(1, original, { isAnswered: true }),
				todoAsk(2, [], { partial: true }),
				todoAsk(3, [], { isAnswered: false }),
			]),
		).toEqual(original)
	})

	it("ignores an automatically denied list but accepts an intentional empty approved list", () => {
		expect(
			getLatestTodo([
				todoAsk(1, original, { isAnswered: true }),
				todoAsk(2, [], { isAnswered: true, autoApprovalDecision: "deny" }),
			]),
		).toEqual(original)
		expect(
			getLatestTodo([todoAsk(1, original, { isAnswered: true }), todoAsk(2, [], { isAnswered: true })]),
		).toEqual([])
	})

	it("retains a legacy saved list when no answered list is available", () => {
		expect(getLatestTodo([todoAsk(1, original), todoAsk(2, [], { partial: true })])).toEqual(original)
	})
})
