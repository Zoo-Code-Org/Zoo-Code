import * as vscode from "vscode"

import { TodoItem } from "@roo-code/types"

import { DEFAULT_AUTO_FLATTEN_ON_LIMIT, DEFAULT_MAX_NESTING_DEPTH } from "@roo-code/types"

import { Task } from "../task/Task"
import { decideInlineFlatten } from "./inlineSubtask"
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
}

export class NewTaskTool extends BaseTool<"new_task"> {
	readonly name = "new_task" as const

	async execute(params: NewTaskParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { mode, message, todos } = params
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

			// Auto-flatten inline decision (depth check BEFORE any approval prompt).
			// When the subtask would exceed maxNestingDepth and autoFlattenOnLimit is set,
			// it runs inline in this task's own conversation instead of opening a child tab.
			const maxNestingDepth = state?.maxNestingDepth ?? DEFAULT_MAX_NESTING_DEPTH
			const autoFlattenOnLimit = state?.autoFlattenOnLimit ?? DEFAULT_AUTO_FLATTEN_ON_LIMIT
			const decision = decideInlineFlatten({
				childDepth: task.depth + 1,
				maxNestingDepth,
				autoFlattenOnLimit,
				inlineActive: task.inlineSubtask !== undefined,
				message: unescapedMessage,
				todos: todoItems,
			})

			if (decision.action === "reject-nested") {
				// Surface the rejection in the UI as well — tool results are not rendered.
				// Structured payload so the webview can localize the detail text.
				await task.say("inline_subtask_rejected", JSON.stringify({ reason: "nested" }))
				pushToolResult(formatResponse.toolError(decision.message))
				return
			}

			if (decision.action === "flatten") {
				// Set the phase marker and let the tool_result double as the inline prompt.
				task.inlineSubtask = { message: unescapedMessage, todos: todoItems }
				// Surface the auto-flatten in the UI — the model sees it via the tool result,
				// but without this the user has no indication that a subtask now runs inline.
				// Structured payload so the webview can localize the detail text.
				await task.say("inline_subtask_started", JSON.stringify({ maxDepth: maxNestingDepth }))
				pushToolResult(decision.directive)
				return
			}

			if (decision.action === "reject-limit") {
				// Surface the rejection in the UI as well — tool results are not rendered.
				// Structured payload so the webview can localize the detail text.
				await task.say(
					"inline_subtask_rejected",
					JSON.stringify({ reason: "limit", maxDepth: maxNestingDepth }),
				)
				pushToolResult(formatResponse.toolError(decision.message))
				return
			}

			// decision.action === "delegate" — normal flow unchanged.
			const toolMessage = JSON.stringify({
				tool: "newTask",
				mode: targetMode.name,
				content: message,
				todos: todoItems,
			})

			const didApprove = await askApproval("tool", toolMessage)

			if (!didApprove) {
				return
			}

			// Delegate parent and open child as sole active task.
			// `provider` is already narrowed to ClineProvider above (WeakRef deref + null check),
			// so this is a typed method call — no cast needed.
			const child = await provider.delegateParentAndOpenChild({
				parentTaskId: task.taskId,
				message: unescapedMessage,
				initialTodos: todoItems,
				mode,
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
