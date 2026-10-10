import type { Task } from "../../task/Task"
import type { ReadEntryOptions } from "./types"

/** Cancellation belongs to the task, not to the requested response format. */
export function isReadFileCancelled(task: Task, _options: ReadEntryOptions): boolean {
	return task.abort || task.abandoned
}

/** For metadata/descriptor boundaries; the reader catches this using the task flags. */
export function throwIfReadFileCancelled(task: Task, options: ReadEntryOptions): void {
	if (isReadFileCancelled(task, options)) throw new Error("File read cancelled")
}
