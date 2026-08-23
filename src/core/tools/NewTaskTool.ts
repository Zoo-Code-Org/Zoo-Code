import * as vscode from "vscode"

import { TodoItem, type ReasoningEffortExtended } from "@roo-code/types"

import { Task } from "../task/Task"
import { getModeBySlug } from "../../shared/modes"
import { formatResponse } from "../prompts/responses"
import { t } from "../../i18n"
import { parseMarkdownChecklist } from "./UpdateTodoListTool"
import { Package } from "../../shared/package"
import { BaseTool, ToolCallbacks } from "./BaseTool"
import type { ToolUse } from "../../shared/tools"

interface NewTaskParams {
	mode: string
	message: string
	todos?: string
	// DTE series 5/5: optional subtask start effort (validated against the target model).
	thinking_effort?: string
}

// DTE series 5/5: the effort levels a new task can start with. "disable" is a settings
// off-switch, not a start level, so it is excluded from this list.
const NEW_TASK_EFFORT_LEVELS: readonly ReasoningEffortExtended[] = [
	"none",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
]

// Narrows a raw tool argument to a reasoning-effort level (single documented cast:
// the literal list above is exactly the value set of ReasoningEffortExtended).
const isNewTaskEffortLevel = (value: string): value is ReasoningEffortExtended =>
	(NEW_TASK_EFFORT_LEVELS as readonly string[]).includes(value)

export class NewTaskTool extends BaseTool<"new_task"> {
	readonly name = "new_task" as const

	async execute(params: NewTaskParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { mode, message, todos, thinking_effort } = params
		const { askApproval, handleError, pushToolResult } = callbacks

		try {
			// Validate required parameters.
			if (!mode) {
				task.consecutiveMistakeCount++
				task.recordToolError("new_task")
				task.didToolFailInCurrentTurn = true
				pushToolResult(await task.sayAndCreateMissingParamError("new_task", "mode"))
				return
			}

			if (!message) {
				task.consecutiveMistakeCount++
				task.recordToolError("new_task")
				task.didToolFailInCurrentTurn = true
				pushToolResult(await task.sayAndCreateMissingParamError("new_task", "message"))
				return
			}

			// DTE series 5/5: the child task is created with the parent's API configuration,
			// so the child model is the parent's current model. Validate the optional start
			// effort against that model's capability before asking for approval.
			//
			// ModelInfo.supportsReasoningEffort is `boolean | string[] | undefined`: the bare
			// `true` means the model supports reasoning effort without an explicit allow-list,
			// so normalize it to the full level set. `false`/`undefined` stay unsupported
			// (argument rejected below). The normalized array is the single source of truth
			// for the argument validation, the ask payload, and the ask-selection check.
			const modelCapabilities = task.api.getModel().info.supportsReasoningEffort
			// "disable" stays in the element type: capability arrays may carry it (it is a
			// settings off-switch, not a start level) and is filtered where levels are listed.
			const supportedLevels: readonly (ReasoningEffortExtended | "disable")[] =
				modelCapabilities === true
					? NEW_TASK_EFFORT_LEVELS
					: Array.isArray(modelCapabilities)
						? modelCapabilities
						: []
			let validatedEffort: ReasoningEffortExtended | undefined
			if (thinking_effort !== undefined && thinking_effort !== "") {
				if (!isNewTaskEffortLevel(thinking_effort) || !supportedLevels.includes(thinking_effort)) {
					const reason = !isNewTaskEffortLevel(thinking_effort)
						? `must be one of: ${NEW_TASK_EFFORT_LEVELS.join(", ")}`
						: supportedLevels.length > 0
							? `the target model only supports: ${
									supportedLevels.filter((level) => level !== "disable").join(", ") || "none"
								}`
							: "the target model does not support thinking_effort"
					pushToolResult(formatResponse.toolError(`Invalid thinking_effort '${thinking_effort}'. ${reason}`))
					return
				}
				validatedEffort = thinking_effort
			}

			// Get the VSCode setting for requiring todos.
			const provider = task.providerRef.deref()

			if (!provider) {
				pushToolResult(formatResponse.toolError("Provider reference lost"))
				return
			}

			const state = await provider.getState()

			// Use Package.name (dynamic at build time) as the VSCode configuration namespace.
			// Supports multiple extension variants (e.g., stable/nightly) without hardcoded strings.
			const requireTodos = vscode.workspace
				.getConfiguration(Package.name)
				.get<boolean>("newTaskRequireTodos", false)

			// Check if todos are required based on VSCode setting.
			// Note: `undefined` means not provided, empty string is valid.
			if (requireTodos && todos === undefined) {
				task.consecutiveMistakeCount++
				task.recordToolError("new_task")
				task.didToolFailInCurrentTurn = true
				pushToolResult(await task.sayAndCreateMissingParamError("new_task", "todos"))
				return
			}

			// Parse todos if provided, otherwise use empty array
			let todoItems: TodoItem[] = []
			if (todos) {
				try {
					todoItems = parseMarkdownChecklist(todos)
				} catch (error) {
					task.consecutiveMistakeCount++
					task.recordToolError("new_task")
					task.didToolFailInCurrentTurn = true
					pushToolResult(formatResponse.toolError("Invalid todos format: must be a markdown checklist"))
					return
				}
			}

			task.consecutiveMistakeCount = 0

			// Un-escape one level of backslashes before '@' for hierarchical subtasks
			// Un-escape one level: \\@ -> \@ (removes one backslash for hierarchical subtasks)
			const unescapedMessage = message.replace(/\\\\@/g, "\\@")

			// Verify the mode exists
			const targetMode = getModeBySlug(mode, state?.customModes)

			if (!targetMode) {
				pushToolResult(formatResponse.toolError(`Invalid mode: ${mode}`))
				return
			}

			// DTE series 5/5: the ask payload pre-fills the webview effort selector with
			// the validated model effort (falling back to the parent's current effective
			// effort) and lists the levels the target model supports ("disable" is a
			// settings off-switch, not a level a child task can start with).
			const toolMessage = JSON.stringify({
				tool: "newTask",
				mode: targetMode.name,
				content: message,
				todos: todoItems,
				thinkingEffort: validatedEffort ?? task.resolveNewTaskEffectiveEffort(),
				supportedThinkingEfforts:
					supportedLevels.length > 0
						? supportedLevels.filter((level): level is ReasoningEffortExtended => level !== "disable")
						: undefined,
			})

			const didApprove = await askApproval("tool", toolMessage)

			if (!didApprove) {
				return
			}

			// DTE series 5/5: the user may have switched the effort in the ask block —
			// the ask response carries it (consumed once from Task) and wins over the
			// model-specified value, which wins over the parent's effective effort. An
			// ask selection the target model does not support falls back the same way.
			const askEffort = task.takeNewTaskAskThinkingEffort()
			const askEffortSupported = askEffort !== undefined && supportedLevels.includes(askEffort)
			const childThinkingEffort = askEffortSupported
				? askEffort
				: (validatedEffort ?? task.resolveNewTaskEffectiveEffort())

			// Delegate parent and open child as sole active task
			const child = await (provider as any).delegateParentAndOpenChild({
				parentTaskId: task.taskId,
				message: unescapedMessage,
				initialTodos: todoItems,
				mode,
				thinkingEffort: childThinkingEffort,
			})

			// Reflect delegation in tool result (no pause/unpause, no wait)
			pushToolResult(`Delegated to child task ${child.taskId}`)
			return
		} catch (error) {
			await handleError("creating new task", error)
			return
		}
	}

	override async handlePartial(task: Task, block: ToolUse<"new_task">): Promise<void> {
		const mode: string | undefined = block.params.mode
		const message: string | undefined = block.params.message
		const todos: string | undefined = block.params.todos

		const partialMessage = JSON.stringify({
			tool: "newTask",
			mode: mode ?? "",
			content: message ?? "",
			todos: todos,
		})

		await task.ask("tool", partialMessage, block.partial).catch(() => {})
	}
}

export const newTaskTool = new NewTaskTool()
