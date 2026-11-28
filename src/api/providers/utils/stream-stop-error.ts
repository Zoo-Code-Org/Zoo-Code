import type { ApiStreamUsageChunk } from "../../transform/stream"

/**
 * Error thrown when a provider stops a response with a content filter or a
 * refusal stop reason.
 *
 * The same request stops again on a resend, so the task loop must not retry it
 * automatically: the user decides once. The stopped response's usage rides on
 * the error (`usage`), because the task loop reads the next chunk before it
 * processes the current one, so a usage chunk yielded before the throw would
 * never be counted.
 */
export class StreamStopError extends Error {
	readonly stopReason: string
	/** Usage of the stopped response, so the task loop can still record it. */
	usage?: ApiStreamUsageChunk

	constructor(stopReason: string, message?: string) {
		super(message ?? describeStreamStop(stopReason))
		this.name = "StreamStopError"
		this.stopReason = stopReason
		// Maintains proper prototype chain for instanceof checks
		Object.setPrototypeOf(this, StreamStopError.prototype)
	}
}

function describeStreamStop(stopReason: string): string {
	const reason = stopReason === "content_filter" ? "content filter" : stopReason
	return `The provider stopped this response (${reason}). The response may be incomplete.`
}

/**
 * The one shared check for Chat Completions stop reasons that end a response
 * without completing it. Returns a StreamStopError for a filter or refusal
 * stop, or undefined for every other finish reason. Wire it where the provider
 * reads `finish_reason`; OpenRouter is the first wired provider (#2769).
 */
export function matchChatCompletionsStreamStop(finishReason: string | null | undefined): StreamStopError | undefined {
	if (finishReason === "content_filter" || finishReason === "refusal") {
		return new StreamStopError(finishReason)
	}
	return undefined
}
