export const MAX_MID_STREAM_RETRIES = 3

export type MidStreamFailureDecision = "retry" | "ask"

export function decideMidStreamFailure(retryAttempt: number): MidStreamFailureDecision {
	return retryAttempt < MAX_MID_STREAM_RETRIES ? "retry" : "ask"
}

export function shouldRemoveMidStreamRetryMessage(userMessageWasAdded: boolean, lastRole?: string): boolean {
	return userMessageWasAdded && lastRole === "user"
}

export function wasMidStreamRetryMessageAdded(value?: boolean): boolean {
	return value === true
}
