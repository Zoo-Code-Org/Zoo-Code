import { Task } from "../task/Task"
import type { PushToolResult } from "../../shared/tools"

/**
 * Wraps the pushToolResult callback to optionally compress tool results
 * before they enter conversation history.
 *
 * The raw result is pushed to the UI message (for display), but a compressed
 * version is pushed to the API conversation history (what the LLM sees).
 *
 * @param toolName - The tool that produced this result
 * @param rawResult - The full, uncompressed tool result
 * @param context - What the user's model was looking for (from tool params)
 * @param task - The Task instance (has toolResultProcessor and config)
 * @param pushToolResult - The original pushToolResult callback
 */
export async function compressAndPushToolResult(
	toolName: string,
	rawResult: string,
	context: string,
	task: Task,
	pushToolResult: PushToolResult,
): Promise<void> {
	const { toolResultProcessor, toolResultProcessorConfig } = task

	if (toolResultProcessor?.shouldCompress(toolName, rawResult, toolResultProcessorConfig)) {
		const compressed = await toolResultProcessor.compress(toolName, rawResult, context, toolResultProcessorConfig)
		// Push compressed result (which is what enters conversation history)
		await pushToolResult(compressed)
	} else {
		// Push raw result as-is
		await pushToolResult(rawResult)
	}
}
