/**
 * One queue per task id for each stage of a save, shared by every `Task` instance of that task in the extension host
 * (a task that is reopened or recreated while an older instance still has saves in flight would otherwise have two
 * queues, and the older instance's metadata could land after the newer one's and replace it).
 *
 * `work` runs when everything queued before it for the same task has settled, whether that succeeded or failed, so a
 * failed save never holds up the next. The queue of a task is dropped as soon as it is idle.
 */
export type TaskSaveQueues = Map<string, Promise<void>>

export const createTaskSaveQueues = (): TaskSaveQueues => new Map()

export function enqueueTaskSave<T>(queues: TaskSaveQueues, taskId: string, work: () => Promise<T>): Promise<T> {
	const previous = queues.get(taskId) ?? Promise.resolve()
	// `previous` never rejects: only settled tails are stored.
	const run = previous.then(work)
	const tail = run.then(
		() => undefined,
		() => undefined,
	)
	queues.set(taskId, tail)
	void tail.then(() => {
		if (queues.get(taskId) === tail) queues.delete(taskId)
	})
	return run
}
