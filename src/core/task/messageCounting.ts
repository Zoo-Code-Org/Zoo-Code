/**
 * Whether the current turn's user message should be added to API conversation
 * history (and counted towards the per-task message-count telemetry summary).
 *
 * Only added when:
 * 1. This is the first attempt (retryAttempt === 0) AND the content is non-empty, OR
 * 2. The message was removed in a previous iteration (userMessageWasRemoved === true)
 *
 * Empty content on a first attempt signals a delegation resume, where the user message
 * with tool_result and env details is already in history -- adding it again would create
 * a duplicate (and inflate the message count).
 */
export function shouldAddUserMessageToHistory(params: {
	retryAttempt: number | undefined
	isEmptyUserContent: boolean
	userMessageWasRemoved: boolean | undefined
}): boolean {
	const { retryAttempt, isEmptyUserContent, userMessageWasRemoved } = params
	return ((retryAttempt ?? 0) === 0 && !isEmptyUserContent) || Boolean(userMessageWasRemoved)
}
