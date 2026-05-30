import * as vscode from "vscode"

import { RooCodeEventName, type HistoryItem } from "@roo-code/types"
import { TelemetryService } from "@roo-code/telemetry"

import { Task } from "../task/Task"
import { formatResponse } from "../prompts/responses"
import { Package } from "../../shared/package"
import type { ToolUse } from "../../shared/tools"
import { t } from "../../i18n"

import { BaseTool, ToolCallbacks } from "./BaseTool"
import { RequirementsVerifier } from "../../services/self-improving/RequirementsVerifier"
import { VerificationEngine } from "../../services/self-improving/VerificationEngine"

interface AttemptCompletionParams {
	result: string
	command?: string
}

export interface AttemptCompletionCallbacks extends ToolCallbacks {
	askFinishSubTaskApproval: () => Promise<boolean>
	toolDescription: () => string
}

/**
 * Interface for provider methods needed by AttemptCompletionTool for delegation handling.
 */
interface DelegationProvider {
	getTaskWithId(id: string): Promise<{ historyItem: HistoryItem }>
	reopenParentFromDelegation(params: {
		parentTaskId: string
		childTaskId: string
		completionResultSummary: string
	}): Promise<void>
}

export class AttemptCompletionTool extends BaseTool<"attempt_completion"> {
	readonly name = "attempt_completion" as const

	/**
	 * Tracks the last result text per task to guard against duplicate completions.
	 * Unlike a permanent boolean flag, this allows new attempt_completion calls
	 * with different result content (e.g., after user feedback or a new task cycle).
	 * Only exact duplicate result text is blocked.
	 */
	private static lastResults = new Map<string, string>()

	/** Optional requirements verifier for checking user intent fulfillment */
	private requirementsVerifier?: RequirementsVerifier
	/** Optional verification engine for code quality checks */
	private verificationEngine?: VerificationEngine

	/**
	 * Set the verifiers used to guard completion.
	 */
	setVerifiers(requirementsVerifier?: RequirementsVerifier, verificationEngine?: VerificationEngine): void {
		this.requirementsVerifier = requirementsVerifier
		this.verificationEngine = verificationEngine
	}

	/**
	 * Resets the completion tracking state. Used in tests to prevent
	 * cross-test contamination from the static Map.
	 */
	static reset(): void {
		AttemptCompletionTool.lastResults.clear()
	}

	async execute(params: AttemptCompletionParams, task: Task, callbacks: AttemptCompletionCallbacks): Promise<void> {
		const { result } = params
		const { handleError, pushToolResult, askFinishSubTaskApproval } = callbacks

		// Guard: block only duplicate result text, not ALL future completions
		const lastResult = AttemptCompletionTool.lastResults.get(task.taskId)
		if (lastResult !== undefined && lastResult === result) {
			pushToolResult(
				formatResponse.toolResult("Task already completed with the same result. No further action needed."),
			)
			return
		}

		// Prevent attempt_completion if any tool failed in the current turn
		if (task.didToolFailInCurrentTurn) {
			const errorMsg = t("common:errors.attempt_completion_tool_failed")

			await task.say("error", errorMsg)
			pushToolResult(formatResponse.toolError(errorMsg))
			return
		}

		const preventCompletionWithOpenTodos = vscode.workspace
			.getConfiguration(Package.name)
			.get<boolean>("preventCompletionWithOpenTodos", false)

		const hasIncompleteTodos = task.todoList && task.todoList.some((todo) => todo.status !== "completed")

		if (preventCompletionWithOpenTodos && hasIncompleteTodos) {
			task.consecutiveMistakeCount++
			task.recordToolError("attempt_completion")

			pushToolResult(
				formatResponse.toolError(
					"Cannot complete task while there are incomplete todos. Please finish all todos before attempting completion.",
				),
			)

			return
		}

		try {
			if (!result) {
				task.consecutiveMistakeCount++
				task.recordToolError("attempt_completion")
				pushToolResult(await task.sayAndCreateMissingParamError("attempt_completion", "result"))
				return
			}

			// Accumulate requirements from ALL user messages before verification
			if (this.requirementsVerifier) {
				const userMessages = this.getAllUserMessages(task)
				this.requirementsVerifier.processUserMessages(userMessages)
			}

			// Guard 5: Requirements verification — check user intent is fulfilled
			if (this.requirementsVerifier) {
				const reqResult = await this.requirementsVerifier.verify()
				if (!reqResult.passed && this.requirementsVerifier.getConfig().mandatory) {
					const errorMsg = `Requirements verification failed:\n${reqResult.summary}\n\nFailed requirements:\n${reqResult.failed.map((r) => `  ❌ ${r.text}`).join("\n")}\n\nPending requirements:\n${reqResult.pending.map((r) => `  ⏳ ${r.text}`).join("\n")}\n\nPlease address these requirements before completing the task.`
					task.consecutiveMistakeCount++
					task.recordToolError("attempt_completion")
					pushToolResult(formatResponse.toolError(errorMsg))
					return
				}
			}

			// Guard 6: Code quality verification (VerificationEngine)
			// Skip verification for lenient modes — research tasks and other user-configured modes
			// don't need build/lint/types/tests. Default: ["research"]
			const currentMode = await task.getTaskMode()
			const experiments = task.experiments
			const lenientModes = experiments?.lenientModes ?? ["research"]
			const isLenientMode = lenientModes.includes(currentMode)
			if (this.verificationEngine && !isLenientMode) {
				const verResult = await this.verificationEngine.verify()
				if (!verResult.passed && this.verificationEngine.getConfig().mandatory) {
					const errorMsg = `Code quality verification failed:\n${verResult.summary}\n\nFailed gates:\n${verResult.gates.filter((g) => !g.passed).map((g) => `  ❌ ${g.name}: ${g.error || "failed"}`).join("\n")}\n\nPlease fix these issues before completing the task.`
					task.consecutiveMistakeCount++
					task.recordToolError("attempt_completion")
					pushToolResult(formatResponse.toolError(errorMsg))
					return
				}
			}

			task.consecutiveMistakeCount = 0

			await task.say("completion_result", result, undefined, false)

			// Check for subtask using parentTaskId (metadata-driven delegation)
			if (task.parentTaskId) {
				// Check if this subtask has already completed and returned to parent
				// to prevent duplicate tool_results when user revisits from history
				const provider = task.providerRef.deref() as DelegationProvider | undefined
				if (provider) {
					try {
						const { historyItem } = await provider.getTaskWithId(task.taskId)
						const status = historyItem?.status

						if (status === "completed") {
							// Subtask already completed - skip delegation flow entirely
							// Fall through to normal completion ask flow below (outside this if block)
							// This shows the user the completion result and waits for acceptance
							// without injecting another tool_result to the parent
						} else if (status === "active") {
							// Normal subtask completion - do delegation
							const delegation = await this.delegateToParent(
								task,
								result,
								provider,
								askFinishSubTaskApproval,
								pushToolResult,
							)
							if (delegation === "delegated") {
								this.emitTaskCompleted(task, result)
							}
							if (delegation !== "continue") return
						} else {
							// Unexpected status (undefined or "delegated") - log error and skip delegation
							// undefined indicates a bug in status persistence during child creation
							// "delegated" would mean this child has its own grandchild pending (shouldn't reach attempt_completion)
							console.error(
								`[AttemptCompletionTool] Unexpected child task status "${status}" for task ${task.taskId}. ` +
									`Expected "active" or "completed". Skipping delegation to prevent data corruption.`,
							)
							// Fall through to normal completion ask flow
						}
					} catch (err) {
						// If we can't get the history, log error and skip delegation
						console.error(
							`[AttemptCompletionTool] Failed to get history for task ${task.taskId}: ${(err as Error)?.message ?? String(err)}. ` +
								`Skipping delegation.`,
						)
						// Fall through to normal completion ask flow
					}
				}
			}

			const { response, text, images } = await task.ask("completion_result", "", false)

			if (response === "yesButtonClicked") {
				this.emitTaskCompleted(task, result)
				return
			}

			// User provided feedback - reset completion tracking so subsequent
			// attempt_completion calls are not blocked by stale guard state.
			AttemptCompletionTool.lastResults.delete(task.taskId)
			const provider = task.providerRef.deref()
			if (provider?.trustService) {
				provider.trustService.taskCompleted = false
			}

			// User provided feedback - push tool result to continue the conversation
			await task.say("user_feedback", text ?? "", images)

			const feedbackText = `<user_message>\n${text}\n</user_message>`
			pushToolResult(formatResponse.toolResult(feedbackText, images))
		} catch (error) {
			await handleError("inspecting site", error as Error)
		}
	}

	/**
	 * Handles the common delegation flow when a subtask completes.
	 * Returns:
	 * - "delegated" when completion was approved and parent resumed
	 * - "denied" when user denied finishing the subtask
	 * - "continue" when caller should fall through to normal completion ask flow
	 */
	private async delegateToParent(
		task: Task,
		result: string,
		provider: DelegationProvider,
		askFinishSubTaskApproval: () => Promise<boolean>,
		pushToolResult: (result: string) => void,
	): Promise<"delegated" | "denied" | "continue"> {
		const didApprove = await askFinishSubTaskApproval()

		if (!didApprove) {
			pushToolResult(formatResponse.toolDenied())
			return "denied"
		}

		pushToolResult("")

		await provider.reopenParentFromDelegation({
			parentTaskId: task.parentTaskId!,
			childTaskId: task.taskId,
			completionResultSummary: result,
		})

		return "delegated"
	}

	override async handlePartial(task: Task, block: ToolUse<"attempt_completion">): Promise<void> {
		const result: string | undefined = block.params.result
		const command: string | undefined = block.params.command

		const lastMessage = task.clineMessages.at(-1)

		if (command) {
			if (lastMessage && lastMessage.ask === "command") {
				await task.ask("command", command ?? "", block.partial).catch(() => {})
			} else {
				await task.say("completion_result", result ?? "", undefined, false)
				await task.ask("command", command ?? "", block.partial).catch(() => {})
			}
		} else {
			await task.say("completion_result", result ?? "", undefined, block.partial)
		}
	}

	/**
	 * Extract all user messages from the task's conversation history.
	 * Includes the initial task prompt and all user_feedback messages.
	 */
	private getAllUserMessages(task: Task): string[] {
		const messages: string[] = []

		// Get the initial task prompt from metadata
		if (task.metadata?.task) {
			messages.push(task.metadata.task)
		}

		// Get user feedback messages from clineMessages
		const clineMessages = task.clineMessages || []
		for (const msg of clineMessages) {
			if (msg.type === "say" && msg.say === "user_feedback" && msg.text) {
				messages.push(msg.text)
			}
		}

		return messages
	}

	private emitTaskCompleted(task: Task, result: string): void {
		// Store the result text to guard against duplicate completions
		AttemptCompletionTool.lastResults.set(task.taskId, result)

		// Notify TrustService that task has completed to block auto-approval of subsequent attempt_completion
		const provider = task.providerRef.deref()
		if (provider?.trustService) {
			provider.trustService.taskCompleted = true
		}

		// Force final token usage update before emitting TaskCompleted.
		// This ensures the latest stats are captured regardless of throttle timer.
		task.emitFinalTokenUsageUpdate()

		TelemetryService.instance.captureTaskCompleted(task.taskId)
		task.emit(RooCodeEventName.TaskCompleted, task.taskId, task.getTokenUsage(), task.toolUsage)
	}
}

export const attemptCompletionTool = new AttemptCompletionTool()
