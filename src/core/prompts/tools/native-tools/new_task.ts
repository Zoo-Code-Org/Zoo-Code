import type OpenAI from "openai"

const NEW_TASK_DESCRIPTION = `Create a new task instance in the chosen mode using your provided message and initial todo list (if required).

CRITICAL: This tool MUST be called alone. Do NOT call this tool alongside other tools in the same message turn. If you need to gather information before delegating, use other tools in a separate turn first, then call new_task by itself in the next turn.`

const MODE_PARAMETER_DESCRIPTION = `Slug of the mode to begin the new task in (e.g., code, debug, architect)`

const MESSAGE_PARAMETER_DESCRIPTION = `Initial user instructions or context for the new task`

const TODOS_PARAMETER_DESCRIPTION = `Optional initial todo list written as a markdown checklist; required when the workspace mandates todos`

const THINKING_EFFORT_PARAMETER_DESCRIPTION = `Optional thinking effort the new task starts with (e.g., "low", "medium", "high"). Must be a level the target model supports. When omitted, the new task starts with the current task's effective effort. The user can still change it before entering the new task.`

export default {
	type: "function",
	function: {
		name: "new_task",
		description: NEW_TASK_DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				mode: {
					type: "string",
					description: MODE_PARAMETER_DESCRIPTION,
				},
				message: {
					type: "string",
					description: MESSAGE_PARAMETER_DESCRIPTION,
				},
				todos: {
					type: ["string", "null"],
					description: TODOS_PARAMETER_DESCRIPTION,
				},
				thinking_effort: {
					// strict: true + additionalProperties: false requires every property to be
					// listed in `required` (the Anthropic API rejects the tool definition
					// otherwise), so the optional parameter uses the same ["string", "null"]
					// pattern as `todos`: the model sends null to omit it.
					type: ["string", "null"],
					description: THINKING_EFFORT_PARAMETER_DESCRIPTION,
				},
			},
			required: ["mode", "message", "todos", "thinking_effort"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
