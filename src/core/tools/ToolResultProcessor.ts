import type { ApiHandler } from "../../api"
import type { ApiStreamTextChunk } from "../../api/transform/stream"
import type { ToolResultProcessorConfig } from "./ToolResultProcessorConfig"

/**
 * Set of tool names that support LLM-assisted compression.
 */
const COMPRESSIBLE_TOOLS = new Set(["read_file", "search_files", "list_files", "codebase_search", "execute_command"])

/**
 * ToolResultProcessor intercepts raw tool output before it is stored in
 * conversation history, decides whether LLM-assisted compression is warranted,
 * and (when an API handler is provided) runs a cheap secondary API call to
 * produce a focused result instead of a giant blob.
 *
 * LLM-assisted compression is subscription-only — free users receive only the
 * Phase 1 hard truncation path.
 *
 * @example
 * ```typescript
 * const processor = new ToolResultProcessor(compressionHandler)
 * if (processor.shouldCompress("read_file", rawResult, config)) {
 *   const compressed = await processor.compress("read_file", rawResult, taskContext, config)
 * }
 * ```
 */
export class ToolResultProcessor {
	private readonly compressionApiHandler: ApiHandler | null

	constructor(compressionApiHandler: ApiHandler | null = null) {
		this.compressionApiHandler = compressionApiHandler
	}

	/**
	 * Determines whether the given tool result should be compressed via LLM.
	 *
	 * Returns `true` only when ALL of the following hold:
	 * - `config.enabled` is `true`
	 * - `config.isSubscriber` is `true` (LLM compression is subscription-only)
	 * - `toolName` is in the supported set
	 * - The result exceeds the relevant threshold for that tool type
	 */
	shouldCompress(toolName: string, rawResult: string, config: ToolResultProcessorConfig): boolean {
		if (!config.enabled) {
			return false
		}

		if (!config.isSubscriber) {
			return false
		}

		if (!COMPRESSIBLE_TOOLS.has(toolName)) {
			return false
		}

		return this._exceedsThreshold(toolName, rawResult, config)
	}

	/**
	 * Compresses the raw tool result using a cheap LLM call.
	 *
	 * - If no API handler was provided at construction time, returns `rawResult` unchanged.
	 * - If the API call fails for any reason, gracefully degrades and returns `rawResult`.
	 *
	 * @param toolName    - Name of the tool that produced the result
	 * @param rawResult   - The full raw output from the tool
	 * @param context     - Natural-language description of what the user is trying to do
	 * @param config      - Processor configuration (thresholds, flags)
	 */
	async compress(
		toolName: string,
		rawResult: string,
		context: string,
		config: ToolResultProcessorConfig,
	): Promise<string> {
		if (!this.compressionApiHandler) {
			return rawResult
		}

		if (!this.shouldCompress(toolName, rawResult, config)) {
			return rawResult
		}

		try {
			const systemPrompt = this.getCompressionPrompt(toolName, rawResult, context)
			const stream = this.compressionApiHandler.createMessage(
				systemPrompt,
				[
					{
						role: "user",
						content: rawResult,
					},
				],
				{ toolName },
			)

			let compressed = ""
			for await (const chunk of stream) {
				if (chunk.type === "text") {
					compressed += (chunk as ApiStreamTextChunk).text
				}
			}

			return compressed.trim() || rawResult
		} catch {
			// Graceful degradation: return the original result on any error
			return rawResult
		}
	}

	/**
	 * Returns a tool-specific system prompt for the compression LLM call.
	 *
	 * Each supported tool type gets a prompt tuned to its output structure.
	 * Unknown tool types receive a generic summarisation prompt.
	 *
	 * @param toolName  - Name of the tool that produced the result
	 * @param rawResult - The full raw output (available for future prompt-tuning)
	 * @param context   - Natural-language description of what the user is trying to do
	 */
	getCompressionPrompt(toolName: string, rawResult: string, context: string): string {
		switch (toolName) {
			case "read_file":
				return `Extract the section of this file most relevant to: ${context}. Preserve exact code, line numbers, and structure.`

			case "search_files":
			case "codebase_search":
				return `From these search results, extract the top 5 most relevant matches with 2 lines of context each for: ${context}`

			case "list_files":
				return `Summarize this directory listing into a structural overview, highlighting the most important files for: ${context}`

			case "execute_command":
				return `Summarize this command output, preserving errors, warnings, and key information for: ${context}`

			default:
				return `Summarize the following tool output, preserving the most important information for: ${context}`
		}
	}

	// ── private helpers ────────────────────────────────────────────────────────

	/**
	 * Checks whether `rawResult` exceeds the threshold configured for `toolName`.
	 */
	private _exceedsThreshold(toolName: string, rawResult: string, config: ToolResultProcessorConfig): boolean {
		const { thresholds } = config

		switch (toolName) {
			case "read_file":
				return rawResult.length > thresholds.readFileCharsAbove

			case "search_files":
			case "codebase_search":
				return this._countMatches(rawResult) > thresholds.searchMatchesAbove

			case "list_files":
				return this._countPaths(rawResult) > thresholds.listFilesCountAbove

			case "execute_command":
				return rawResult.length > thresholds.readFileCharsAbove

			default:
				return false
		}
	}

	/**
	 * Heuristically counts the number of search matches in a raw result block.
	 * Each non-empty line is treated as contributing to a match count.
	 */
	private _countMatches(rawResult: string): number {
		return rawResult.split("\n").filter((line) => line.trim().length > 0).length
	}

	/**
	 * Heuristically counts the number of file paths in a directory listing.
	 * Each non-empty line is treated as one path entry.
	 */
	private _countPaths(rawResult: string): number {
		return rawResult.split("\n").filter((line) => line.trim().length > 0).length
	}
}
