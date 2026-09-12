export const MAX_MID_STREAM_RETRIES = 3

export type MidStreamFailureDecision = "retry" | "ask"

export function decideMidStreamFailure(retryAttempt: number): MidStreamFailureDecision {
	return retryAttempt < MAX_MID_STREAM_RETRIES ? "retry" : "ask"
}

export function findRetryRequestMessageIndex(
	messages: Array<{ messageId?: string; role?: string }>,
	requestMessageId: string,
): number {
	return messages.findIndex((message) => message.messageId === requestMessageId && message.role === "user")
}
