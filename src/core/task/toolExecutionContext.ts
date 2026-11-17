import type { Task } from "./Task"

export function markToolRejected(task: Task, toolCallId: string): void {
	task.didRejectTool = true
	const context = task.activeToolContexts.get(toolCallId)
	if (context) context.didReject = true
}
