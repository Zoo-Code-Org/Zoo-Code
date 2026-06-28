import stringify from "safe-stable-stringify"
import { ToolUse } from "../../shared/tools"
import { t } from "../../i18n"

/**
 * Result of a repetition check.
 *
 * - `allow`: the tool may be executed normally.
 * - `soft_block`: the tool is NOT executed; an error message is returned to the
 *   model asking it to justify repeating the call. The user is NOT involved.
 *   The internal counter keeps incrementing so continued repetition eventually
 *   escalates to a `hard_block`.
 * - `hard_block`: execution is stopped and the user is asked for guidance.
 */
export type RepetitionCheckResult =
	| { action: "allow" }
	| { action: "soft_block"; message: string }
	| {
			action: "hard_block"
			askUser: {
				messageKey: string
				messageDetail: string
			}
	  }

/**
 * Class for detecting consecutive identical tool calls
 * to prevent the AI from getting stuck in a loop.
 *
 * Uses a two-tier system:
 * 1. Soft warning: after `softWarningLimit` identical consecutive calls, the
 *    tool is blocked and the model is asked to justify the repeat (no user
 *    involvement).
 * 2. Hard stop: after `hardStopLimit` identical consecutive calls, execution
 *    stops and the user is asked for guidance. This limit is supplied by the
 *    caller from `consecutiveMistakeLimit`, so the existing consecutive mistake
 *    limit also governs repeated identical tool calls.
 */
export class ToolRepetitionDetector {
	private previousToolCallJson: string | null = null
	private consecutiveIdenticalToolCallCount: number = 0
	private readonly softWarningLimit: number
	private readonly hardStopLimit: number

	/**
	 * Creates a new ToolRepetitionDetector.
	 *
	 * @param softLimit The number of identical consecutive tool calls allowed
	 *   before soft-blocking (asking the model to justify). 0 disables soft
	 *   blocking.
	 * @param hardLimit The hard stop limit, supplied by the caller from
	 *   `consecutiveMistakeLimit`. The number of identical consecutive tool calls
	 *   allowed before hard-stopping (asking the user). 0 disables hard stopping.
	 */
	constructor(softLimit: number = 2, hardLimit: number = 5) {
		// Treat negative values as 0 (unlimited / disabled).
		this.softWarningLimit = Math.max(0, softLimit)
		this.hardStopLimit = Math.max(0, hardLimit)
	}

	/**
	 * Checks if the current tool call is identical to the previous one
	 * and determines if execution should be allowed, soft-blocked, or
	 * hard-blocked.
	 *
	 * @param currentToolCallBlock ToolUse object representing the current tool call
	 * @returns A RepetitionCheckResult describing how the caller should proceed.
	 */
	public check(currentToolCallBlock: ToolUse): RepetitionCheckResult {
		// Serialize the block to a canonical JSON string for comparison
		const currentToolCallJson = this.serializeToolUse(currentToolCallBlock)

		// Compare with previous tool call
		if (this.previousToolCallJson === currentToolCallJson) {
			this.consecutiveIdenticalToolCallCount++
		} else {
			this.consecutiveIdenticalToolCallCount = 0 // Reset to 0 for a new tool
			this.previousToolCallJson = currentToolCallJson
		}

		// Hard stop check (0 means unlimited / disabled).
		// Checked first so it always takes precedence over the soft warning.
		if (this.hardStopLimit > 0 && this.consecutiveIdenticalToolCallCount >= this.hardStopLimit) {
			// Reset counters to allow recovery if user guides the AI past this point
			this.reset()

			return {
				action: "hard_block",
				askUser: {
					messageKey: "mistake_limit_reached",
					messageDetail: t("tools:toolRepetitionLimitReached", { toolName: currentToolCallBlock.name }),
				},
			}
		}

		// Soft warning check (0 means unlimited / disabled).
		// Do NOT reset the counter here so continued repetition escalates to a
		// hard stop.
		if (this.softWarningLimit > 0 && this.consecutiveIdenticalToolCallCount >= this.softWarningLimit) {
			return {
				action: "soft_block",
				message: t("tools:toolRepetitionSoftBlock", { toolName: currentToolCallBlock.name }),
			}
		}

		// Execution is allowed
		return { action: "allow" }
	}

	/**
	 * Resets the internal repetition tracking state.
	 */
	private reset(): void {
		this.consecutiveIdenticalToolCallCount = 0
		this.previousToolCallJson = null
	}

	/**
	 * Serializes a ToolUse object into a canonical JSON string for comparison
	 *
	 * @param toolUse The ToolUse object to serialize
	 * @returns JSON string representation of the tool use with sorted parameter keys
	 */
	private serializeToolUse(toolUse: ToolUse): string {
		const toolObject: Record<string, any> = {
			name: toolUse.name,
			params: toolUse.params,
		}

		// Only include nativeArgs if it has content
		if (toolUse.nativeArgs && Object.keys(toolUse.nativeArgs).length > 0) {
			toolObject.nativeArgs = toolUse.nativeArgs
		}

		return stringify(toolObject)
	}
}
