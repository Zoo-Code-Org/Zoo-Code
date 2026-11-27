/**
 * Add non-empty user content on the first attempt. Retries keep the saved turn.
 * Empty initial content resumes a turn that is already in history.
 */
export function shouldAddUserMessageToHistory(params: {
	retryAttempt: number | undefined
	isEmptyUserContent: boolean
}): boolean {
	return (params.retryAttempt ?? 0) === 0 && !params.isEmptyUserContent
}
