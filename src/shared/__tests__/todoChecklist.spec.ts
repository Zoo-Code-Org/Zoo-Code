import { parseMarkdownChecklist, parseTodoListInput, TODO_ARGUMENT_EXAMPLE } from "../todoChecklist"
import updateTodoTool from "../../core/prompts/tools/native-tools/update_todo_list"

describe("TODO input contract", () => {
	it("accepts the exact JSON example advertised in the native schema", () => {
		const args: unknown = JSON.parse(TODO_ARGUMENT_EXAMPLE)
		if (!args || typeof args !== "object" || !("todos" in args)) throw new Error("invalid example")
		expect(parseTodoListInput(args.todos).map((todo) => todo.status)).toEqual([
			"completed",
			"in_progress",
			"pending",
		])
		expect(updateTodoTool.function.parameters.properties.todos.type).toBe("string")
		expect(updateTodoTool.function.description).toContain(TODO_ARGUMENT_EXAMPLE)
	})

	it("accepts long checklist text, issue numbers, URLs, Unicode and standard bullet prefixes", () => {
		const content = "#17: clickable Apply/Listing URLs https://example.com/?a=1&b=2 — 日本語 ".repeat(1_000)
		const todos = parseTodoListInput(`- [x] Prior work\n* [-] ${content}\n+ [ ] Run tests`)
		expect(todos).toHaveLength(3)
		expect(todos[1]?.content).toBe(content.trim())
		expect(todos.map((todo) => todo.status)).toEqual(["completed", "in_progress", "pending"])
	})

	it.each([false, true])(
		"accepts JSON task objects (serialized=%s) without requiring model-generated IDs",
		(serialized) => {
			const list = [
				{ content: "#17: add link", status: "in_progress" },
				{ id: "done", content: "Tests", status: "completed" },
			]
			const todos = parseTodoListInput(serialized ? JSON.stringify(list) : list)
			expect(todos[0]).toMatchObject({ content: "#17: add link", status: "in_progress", id: expect.any(String) })
			expect(todos[1]?.id).toBe("done")
			expect(todos[0]?.id).toBe(parseMarkdownChecklist("[-] #17: add link")[0]?.id)
		},
	)

	it("accepts JSON arrays of checklist lines and explicit empty replacements", () => {
		expect(parseTodoListInput(JSON.stringify(["[ ] One", "[x] Two"]))).toHaveLength(2)
		for (const value of ["", "  ", [], "[]"]) expect(parseTodoListInput(value)).toEqual([])
	})

	it.each([
		undefined,
		null,
		0,
		{},
		{ todos: "[ ] One" },
		[null],
		[""],
		'[{"content":"One","status":"done"}]',
		"[ ] Good\nnot a checklist",
		[{ content: " " }],
	])("rejects malformed input without returning a partial or empty replacement (%j)", (value) => {
		expect(() => parseTodoListInput(value)).toThrow(/todos|Todo|Checklist/)
	})
})
