import stringify from "safe-stable-stringify"
import { ToolUse } from "../../shared/tools"
import { t } from "../../i18n"

/**
 * Class for detecting consecutive identical tool calls
 * to prevent the AI from getting stuck in a loop.
 */
export class ToolRepetitionDetector {
	private previousToolCallJson: string | null = null
	private consecutiveIdenticalToolCallCount: number = 0
	private readonly consecutiveIdenticalToolCallLimit: number

	/**
	 * Sliding window of recent tool call signatures (last 5).
	 * Tracks the serialized form of each tool call to catch intermittent
	 * retry patterns where the same tool is called repeatedly with slight
	 * variations (e.g., different file paths in read_file, different
	 * regex patterns in search_files).
	 *
	 * The window detects patterns like: A, B, A, B, A (interleaved retries)
	 * which the simple consecutive checker would miss.
	 */
	private readonly slidingWindow: string[] = []
	private static readonly SLIDING_WINDOW_SIZE = 5

	/**
	 * Creates a new ToolRepetitionDetector
	 * @param limit The maximum number of identical consecutive tool calls allowed
	 */
	constructor(limit: number = 3) {
		this.consecutiveIdenticalToolCallLimit = limit
	}

	/**
	 * Checks if the current tool call is identical to the previous one
	 * and determines if execution should be allowed
	 *
	 * @param currentToolCallBlock ToolUse object representing the current tool call
	 * @returns Object indicating if execution is allowed and a message to show if not
	 */
	public check(currentToolCallBlock: ToolUse): {
		allowExecution: boolean
		askUser?: {
			messageKey: string
			messageDetail: string
		}
	} {
		// Serialize the block to a canonical JSON string for comparison
		const currentToolCallJson = this.serializeToolUse(currentToolCallBlock)

		// Compare with previous tool call (exact consecutive match)
		if (this.previousToolCallJson === currentToolCallJson) {
			this.consecutiveIdenticalToolCallCount++
		} else {
			this.consecutiveIdenticalToolCallCount = 0 // Reset to 0 for a new tool
			this.previousToolCallJson = currentToolCallJson
		}

		// Check if limit is reached (0 means unlimited)
		if (
			this.consecutiveIdenticalToolCallLimit > 0 &&
			this.consecutiveIdenticalToolCallCount >= this.consecutiveIdenticalToolCallLimit
		) {
			// Reset counters to allow recovery if user guides the AI past this point
			this.consecutiveIdenticalToolCallCount = 0
			this.previousToolCallJson = null

			// Return result indicating execution should not be allowed
			return {
				allowExecution: false,
				askUser: {
					messageKey: "mistake_limit_reached",
					messageDetail: t("tools:toolRepetitionLimitReached", { toolName: currentToolCallBlock.name }),
				},
			}
		}

		// Sliding window check: detect intermittent retry patterns where the same
		// tool (possibly with slight variations) appears multiple times within the
		// last N calls. This catches patterns like: A, B, A, B, A (interleaved
		// retries) or A, C, A, D, A (same tool name, different params).
		this.slidingWindow.push(currentToolCallJson)
		if (this.slidingWindow.length > ToolRepetitionDetector.SLIDING_WINDOW_SIZE) {
			this.slidingWindow.shift()
		}

		// Count how many times this exact tool call appears in the window
		const exactMatchCount = this.slidingWindow.filter((entry) => entry === currentToolCallJson).length

		// Count how many times this tool name appears in the window (with any params)
		const toolNameCount = this.slidingWindow.filter((entry) => {
			try {
				const parsed = JSON.parse(entry)
				return parsed.name === currentToolCallBlock.name
			} catch {
				return false
			}
		}).length

		// If the same exact tool call appears 3+ times in the last 5, or
		// the same tool name (with different params) appears 4+ times, it's a retry storm.
		const isRetryStorm =
			(exactMatchCount >= 3) ||
			(toolNameCount >= 4 && this.consecutiveIdenticalToolCallLimit > 0)

		if (isRetryStorm) {
			console.warn(
				`[ToolRepetitionDetector] Retry storm detected for tool "${currentToolCallBlock.name}": ` +
					`${exactMatchCount}x exact matches, ${toolNameCount}x name matches in last ` +
					`${this.slidingWindow.length} calls.`,
			)

			// Clear the window to prevent cascading detections
			this.slidingWindow.length = 0

			return {
				allowExecution: false,
				askUser: {
					messageKey: "mistake_limit_reached",
					messageDetail: t("tools:toolRepetitionLimitReached", { toolName: currentToolCallBlock.name }),
				},
			}
		}

		// Execution is allowed
		return { allowExecution: true }
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
