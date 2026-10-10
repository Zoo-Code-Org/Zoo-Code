import type { Task } from "../../task/Task"

/** Observe existing task cancellation flags; never change lifecycle state. */
export function isReadFileCancelled(task: Task): boolean {
	return task.abort || task.abandoned
}

export function throwIfReadFileCancelled(task: Task): void {
	if (isReadFileCancelled(task)) throw new Error("File read cancelled")
}
