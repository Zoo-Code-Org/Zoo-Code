import { Task } from "../task/Task"
import { formatResponse } from "../prompts/responses"
import type { ToolUse } from "../../shared/tools"
import { getSuggestionMode } from "@roo-code/types"

import { BaseTool, ToolCallbacks } from "./BaseTool"

interface Suggestion {
	text: string
	mode?: unknown
}

interface AskFollowupQuestionParams {
	question: string
	// follow_up is typed as an array, but at runtime the value may arrive as a
	// non-array (object/string/number) due to incremental JSON parsing, so the
	// runtime validation in execute() guards against that explicitly.
	follow_up: Suggestion[]
}

export class AskFollowupQuestionTool extends BaseTool<"ask_followup_question"> {
	readonly name = "ask_followup_question" as const

	async execute(params: AskFollowupQuestionParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { question, follow_up } = params
		const { handleError, pushToolResult } = callbacks

		const recordMissingParamError = async (paramName: string): Promise<void> => {
			task.consecutiveMistakeCount++
			task.recordToolError("ask_followup_question")
			task.didToolFailInCurrentTurn = true
			pushToolResult(await task.sayAndCreateMissingParamError("ask_followup_question", paramName))
		}

		const recordValidationError = async (message: string): Promise<void> => {
			task.consecutiveMistakeCount++
			task.recordToolError("ask_followup_question")
			task.didToolFailInCurrentTurn = true
			await task.say("error", message)
			pushToolResult(formatResponse.toolError(message))
		}

		try {
			if (!question) {
				await recordMissingParamError("question")
				return
			}

			// Truly missing follow_up (null/undefined) -> report as a missing parameter.
			if (follow_up === undefined || follow_up === null) {
				await recordMissingParamError("follow_up")
				return
			}

			// Present-but-wrong-type follow_up (object/string/number) -> report a clear
			// type/shape error rather than the misleading "Missing value" message, so the
			// model can correct it instead of looping with the same payload.
			if (!Array.isArray(follow_up)) {
				await recordValidationError(
					"The 'follow_up' parameter must be an array of suggestion objects, each shaped like { text: string, mode?: string }. " +
						"Retry with 'follow_up' as a JSON array.",
				)
				return
			}

			// Transform follow_up suggestions to the format expected by task.ask
			const follow_up_json = {
				question,
				suggest: follow_up.map((s) => ({ answer: s.text, mode: getSuggestionMode(s.mode) })),
			}

			task.consecutiveMistakeCount = 0
			const { text, images } = await task.ask("followup", JSON.stringify(follow_up_json), false)
			const safeText = text ?? ""
			await task.say("user_feedback", safeText, images)
			pushToolResult(formatResponse.toolResult(`<user_message>\n${safeText}\n</user_message>`, images))
		} catch (error) {
			await handleError("asking question", error as Error)
		}
	}

	override async handlePartial(task: Task, block: ToolUse<"ask_followup_question">): Promise<void> {
		const question: string | undefined = block.nativeArgs?.question ?? block.params.question

		// During partial streaming, only show the question to avoid displaying raw JSON
		// The full JSON with suggestions will be sent when the tool call is complete (!block.partial)
		await task.ask("followup", question ?? "", block.partial).catch(() => {})
	}
}

export const askFollowupQuestionTool = new AskFollowupQuestionTool()
