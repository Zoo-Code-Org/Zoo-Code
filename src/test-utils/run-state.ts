import { initialRunState } from "../core/task/run-state/runState"
import type { Task } from "../core/task/Task"

export function setAbortLatch(task: Partial<Pick<Task, "runState">>, aborted: boolean): void {
	const state = task.runState ?? initialRunState
	task.runState = { ...state, latches: { ...state.latches, abort: aborted } }
}
