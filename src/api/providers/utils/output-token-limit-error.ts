/**
 * Error thrown when a provider stops generating because the response hit the
 * configured output token limit.
 *
 * Re-sending the same request with the same limit truncates again, so the task
 * loop must not auto-retry it; the user has to raise the limit or change course.
 */
export class OutputTokenLimitError extends Error {
	constructor(message = "Output token limit reached. Consider increasing Max Output Tokens in the model settings.") {
		super(message)
		this.name = "OutputTokenLimitError"
		// Maintains proper prototype chain for instanceof checks
		Object.setPrototypeOf(this, OutputTokenLimitError.prototype)
	}
}
