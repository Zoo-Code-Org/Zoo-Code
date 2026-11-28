import type OpenAI from "openai"
import { TODO_ARGUMENT_EXAMPLE } from "../../../../shared/todoChecklist"

const UPDATE_TODO_LIST_DESCRIPTION = `Replace the entire task TODO list. Include all unfinished tasks and any completed tasks you want to retain; this is a replacement, not an append.

Call this native tool with JSON arguments. The todos field is a STRING containing a single-level Markdown checklist. Escape line breaks as \\n inside the JSON string.
- [ ] means pending, [-] means in progress, [x] means completed.
- Put tasks in execution order. Mark completed only when fully accomplished.
- Add newly discovered work and update several statuses in one call when useful.
- Use an empty string only to intentionally clear the entire list.

Example JSON arguments:
${TODO_ARGUMENT_EXAMPLE}

Use this for multi-step work that needs progress tracking; skip it for trivial tasks or purely conversational replies.`

const TODOS_PARAMETER_DESCRIPTION = `String containing the full checklist in execution order, using [ ] for pending, [x] for completed, and [-] for in progress. JSON arguments example: ${TODO_ARGUMENT_EXAMPLE}`

export default {
	type: "function",
	function: {
		name: "update_todo_list",
		description: UPDATE_TODO_LIST_DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				todos: {
					type: "string",
					description: TODOS_PARAMETER_DESCRIPTION,
				},
			},
			required: ["todos"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
