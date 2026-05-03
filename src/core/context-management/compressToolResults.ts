import { Anthropic } from "@anthropic-ai/sdk"

/**
 * Minimum character length for a tool_result to be eligible for compression.
 * Results shorter than this are left untouched.
 */
export const TOOL_RESULT_MIN_CHARS = 500

/**
 * Number of conversation turns (assistant+user pairs) after which a tool_result
 * becomes eligible for compression. A value of 3 means the result must be at
 * least 3 full turns old.
 */
export const TOOL_RESULT_STALE_TURN_THRESHOLD = 3

/**
 * Tool names whose results contain file/search content that benefits from compression.
 * Other tools (e.g., attempt_completion, ask_followup_question) are left untouched.
 */
export const COMPRESSIBLE_TOOLS = new Set([
	"read_file",
	"search_files",
	"list_files",
	"codebase_search",
	"execute_command",
	"read_command_output",
])

/**
 * Counts approximate number of lines/matches in a result string.
 * Used to enrich placeholders with useful metadata.
 */
function countApproxLines(content: string): number {
	return content.split("\n").length
}

/**
 * Generates a compact placeholder for a compressed tool result.
 * Preserves the tool name, key parameters, and approximate size.
 */
export function generatePlaceholder(toolName: string, originalContent: string): string {
	const charCount = originalContent.length
	const formattedCount = charCount.toLocaleString("en-US")

	switch (toolName) {
		case "read_file": {
			const lineCount = countApproxLines(originalContent)
			return `[Compressed: read_file result — originally ~${formattedCount} chars, ~${lineCount} lines. Re-read the file if you need its contents.]`
		}
		case "search_files":
		case "codebase_search": {
			// Estimate matches by counting lines that look like match results
			const lineCount = countApproxLines(originalContent)
			return `[Compressed: ${toolName} result — originally ~${formattedCount} chars, ~${lineCount} matches. Re-run the search if needed.]`
		}
		case "list_files": {
			// Count approximate number of paths (non-empty lines)
			const pathCount = originalContent.split("\n").filter((l) => l.trim().length > 0).length
			return `[Compressed: list_files result — originally ~${formattedCount} chars, ~${pathCount} paths. Re-list the directory if needed.]`
		}
		case "execute_command":
		case "read_command_output": {
			return `[Compressed: execute_command output — originally ~${formattedCount} chars. Re-run the command if needed.]`
		}
		default: {
			return `[Compressed: tool result — originally ~${formattedCount} chars. Call the tool again if needed.]`
		}
	}
}

/**
 * Extracts the tool name from a tool_use block in the preceding assistant message,
 * matching by tool_use_id.
 */
function extractToolNameFromHistory(
	history: Anthropic.Messages.MessageParam[],
	messageIndex: number,
	toolUseId: string,
): string | null {
	// Look backwards through history for an assistant message that has this tool_use_id
	for (let i = messageIndex - 1; i >= 0; i--) {
		const msg = history[i]
		if (msg.role === "assistant" && Array.isArray(msg.content)) {
			for (const block of msg.content) {
				if (block.type === "tool_use" && block.id === toolUseId) {
					return block.name
				}
			}
		}
	}
	return null
}

/**
 * Compresses old, large tool_result blocks in conversation history.
 *
 * Walks the history backwards from the most recent message. Messages within
 * the STALE_TURN_THRESHOLD of the current turn are left untouched.
 *
 * For eligible messages:
 * - tool_result blocks with content > TOOL_RESULT_MIN_CHARS are replaced
 *   with a compact placeholder
 * - The original content is NOT preserved (this is a hard truncation)
 *
 * Returns a new array (does not mutate the input).
 */
export function compressOldToolResults(
	history: Anthropic.Messages.MessageParam[],
	currentTurnIndex?: number,
): Anthropic.Messages.MessageParam[] {
	if (history.length === 0) {
		return []
	}

	// Count assistant messages to determine turn boundaries.
	// Walk from the END of history backwards, counting turns.
	// We protect the last TOOL_RESULT_STALE_TURN_THRESHOLD assistant turns.

	// First, find the indices of assistant messages (turns), from end to start
	const assistantIndices: number[] = []
	for (let i = history.length - 1; i >= 0; i--) {
		if (history[i].role === "assistant") {
			assistantIndices.push(i)
		}
	}

	// The "stale boundary" is the array index of the THRESHOLD-th-from-last assistant message.
	// Everything strictly before that index is stale.
	// Example: THRESHOLD=3, 5 assistant turns at [0,2,4,6,8]
	//   assistantIndices (backwards) = [8,6,4,2,0]
	//   THRESHOLD-1 = 2 → assistantIndices[2] = 4 → messages at idx < 4 are stale
	// If we have fewer than THRESHOLD assistant turns, nothing is stale.
	let staleBoundaryIndex: number
	if (assistantIndices.length < TOOL_RESULT_STALE_TURN_THRESHOLD) {
		// Not enough turns to have anything stale
		return history.slice()
	} else {
		// assistantIndices[THRESHOLD - 1] is the index of the THRESHOLD-th message from the end.
		// Everything strictly before that assistant message's index is stale.
		staleBoundaryIndex = assistantIndices[TOOL_RESULT_STALE_TURN_THRESHOLD - 1]
	}

	// Build a new array, compressing eligible tool_result blocks
	return history.map((message, msgIndex) => {
		// Only compress user messages strictly before the stale boundary
		if (msgIndex >= staleBoundaryIndex) {
			return message
		}

		if (message.role !== "user" || !Array.isArray(message.content)) {
			return message
		}

		let modified = false
		const newContent = message.content.map((block) => {
			if (block.type !== "tool_result") {
				return block
			}

			// tool_result content may be string or array of content blocks
			const rawContent = block.content
			let contentStr: string | null = null

			if (typeof rawContent === "string") {
				contentStr = rawContent
			} else if (Array.isArray(rawContent)) {
				// Find the first text block
				const textBlock = rawContent.find((b) => b.type === "text")
				if (textBlock && textBlock.type === "text") {
					contentStr = textBlock.text
				}
			}

			if (contentStr === null || contentStr.length <= TOOL_RESULT_MIN_CHARS) {
				return block
			}

			// Try to determine the tool name from the preceding assistant message
			const toolName = extractToolNameFromHistory(history, msgIndex, block.tool_use_id) ?? "unknown"

			// Only compress tools in our compressible set (or unknown tools that are large)
			if (toolName !== "unknown" && !COMPRESSIBLE_TOOLS.has(toolName)) {
				return block
			}

			const placeholder = generatePlaceholder(toolName === "unknown" ? "unknown" : toolName, contentStr)
			modified = true

			return {
				...block,
				content: placeholder,
			}
		})

		if (!modified) {
			return message
		}

		return {
			...message,
			content: newContent,
		}
	})
}
