import crypto from "crypto"
import { todoStatusSchema, type TodoItem, type TodoStatus } from "@roo-code/types"

export const TODO_ARGUMENT_EXAMPLE = '{"todos":"[x] Finished task\\n[-] Current task\\n[ ] Next task"}'
export const TODO_FORMAT_HELP = `Call the tool with JSON arguments, for example ${TODO_ARGUMENT_EXAMPLE}. The todos field should be a string containing the full checklist. Use [ ], [-], or [x] for each item. Use an empty string only to intentionally clear the list.`

const checklistLine = /^(?:[-*+]\s*)?\[\s*([ xX\-~])\s*\]\s+(.+)$/

function todoItem(content: string, status: TodoStatus, id?: string): TodoItem {
	return {
		id:
			id ??
			crypto
				.createHash("md5")
				.update(content + status)
				.digest("hex"),
		content,
		status,
	}
}

/** Lenient preview/legacy reader; completed tool calls use parseTodoListInput instead. */
export function parseMarkdownChecklist(md: unknown): TodoItem[] {
	if (typeof md !== "string") return []
	return md.split(/\r?\n/).flatMap((line) => {
		const match = line.trim().match(checklistLine)
		if (!match) return []
		const status = /[xX]/.test(match[1]) ? "completed" : /[-~]/.test(match[1]) ? "in_progress" : "pending"
		return [todoItem(match[2], status)]
	})
}

/** Validate the entire replacement before touching the saved list. */
export function parseTodoListInput(value: unknown): TodoItem[] {
	if (typeof value === "string") {
		const text = value.trim()
		if (!text) return []
		// Some local providers do not enforce the native schema, and models also
		// serialize JSON task arrays inside the string field. Accept either without
		// requiring a different tool schema on strict providers.
		if (text.startsWith("[")) {
			let decoded: unknown
			try {
				decoded = JSON.parse(text)
			} catch {
				/* A Markdown checkbox also starts with [. */
			}
			if (Array.isArray(decoded)) return parseTodoListInput(decoded)
		}
		const lines = text.split(/\r?\n/).filter((line) => line.trim())
		const todos = parseMarkdownChecklist(text)
		const invalidLine = lines.findIndex((line) => !checklistLine.test(line.trim()))
		if (invalidLine !== -1)
			throw new Error(`Checklist line ${invalidLine + 1} must start with [ ], [-], or [x]. ${TODO_FORMAT_HELP}`)
		return todos
	}
	if (!Array.isArray(value)) throw new Error(`The todos field is missing or has the wrong type. ${TODO_FORMAT_HELP}`)
	if (value.every((item) => typeof item === "string")) {
		if (value.some((item) => !item.trim()))
			throw new Error(`Checklist entries must not be empty. ${TODO_FORMAT_HELP}`)
		return parseTodoListInput(value.join("\n"))
	}
	return value.map((item: unknown, index) => {
		const fail = (detail: string): never => {
			throw new Error(`Todo item ${index + 1}: ${detail}. ${TODO_FORMAT_HELP}`)
		}
		if (!item || typeof item !== "object" || Array.isArray(item))
			return fail("expected an object with content and status")
		if (!("content" in item) || typeof item.content !== "string" || !item.content.trim())
			return fail("content must be nonempty text")
		if (/[\r\n]/.test(item.content)) return fail("content must fit on one line")
		const status = todoStatusSchema.safeParse("status" in item ? item.status : "pending")
		if (!status.success) return fail("status must be pending, in_progress, or completed")
		if ("id" in item && (typeof item.id !== "string" || !item.id.trim()))
			return fail("id must be nonempty text when provided")
		return todoItem(
			item.content.trim(),
			status.data,
			"id" in item && typeof item.id === "string" ? item.id : undefined,
		)
	})
}
