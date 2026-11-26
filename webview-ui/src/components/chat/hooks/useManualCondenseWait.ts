import { useCallback, useEffect, useState } from "react"

// Started/response messages carry task ids in `text`, so other tasks' messages are ignored.
export function isMessageForCurrentTask(messageTaskId: string | undefined, currentTaskId: string | undefined): boolean {
	return !!messageTaskId && messageTaskId === currentTaskId
}

/**
 * 1. Start: input waits for the task named in the manual request.
 * 2. Finish: only that task's response ends the wait.
 * 3. Task change: a different selected id ends the wait, so late responses cannot affect another task.
 *    No selection also clears it; only then is `currentTaskId` undefined.
 */
export function useManualCondenseWait(currentTaskId: string | undefined) {
	const [waitingTaskId, setWaitingTaskId] = useState<string | undefined>()

	useEffect(() => {
		if (waitingTaskId !== undefined && currentTaskId !== waitingTaskId) {
			setWaitingTaskId(undefined)
		}
	}, [currentTaskId, waitingTaskId])

	const startWait = useCallback((taskId: string) => setWaitingTaskId(taskId), [])
	const finishWait = useCallback(
		(taskId: string) => setWaitingTaskId((waiting) => (waiting === taskId ? undefined : waiting)),
		[],
	)

	return { waitingTaskId, startWait, finishWait }
}
