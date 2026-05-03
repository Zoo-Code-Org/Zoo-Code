import type { ApiHandler } from "../../api/index"

/**
 * Post-processes attempt_completion result text into a user-friendly summary.
 *
 * This is optional and display-only:
 * - The full technical result stays in conversation history
 * - The post-processed version is shown in the chat UI
 * - Only runs for subscribers (requires LLM call)
 */
export class CompletionPostProcessor {
	constructor(private readonly apiHandler: ApiHandler | null) {}

	/**
	 * Whether post-processing is available (requires an API handler).
	 */
	get isAvailable(): boolean {
		return this.apiHandler !== null
	}

	/**
	 * Post-process the completion result text.
	 * Returns the reformatted text, or the original if post-processing
	 * is unavailable or fails.
	 */
	async postProcess(resultText: string): Promise<string> {
		if (!this.apiHandler || resultText.length < 200) {
			return resultText
		}

		try {
			const systemPrompt = this.getPostProcessingPrompt()
			// Build a single-turn conversation
			const messages = [{ role: "user" as const, content: [{ type: "text" as const, text: resultText }] }]

			let output = ""
			let hadError = false
			const stream = this.apiHandler.createMessage(systemPrompt, messages as any)
			for await (const chunk of stream) {
				if (chunk.type === "text") {
					output += chunk.text
				} else if (chunk.type === "error") {
					hadError = true
				}
			}

			if (hadError) {
				return resultText
			}

			return output.trim() || resultText
		} catch {
			// Graceful degradation — return original on any error
			return resultText
		}
	}

	private getPostProcessingPrompt(): string {
		return `You are a concise technical writer. Reformat the following task completion summary into a clean, scannable format:
- Use bullet points for multiple items
- Bold key file names and actions
- Remove redundant phrasing
- Keep it under 200 words
- Preserve all technical details (file paths, function names, etc.)
- Do NOT add information that wasn't in the original
Output the reformatted summary only, with no preamble.`
	}
}
