import type { ZooRunResult, ZooStreamEvent } from "@roo-code/zoo-protocol"

export type ProjectedMessage = { role: "assistant" | "user" | "reasoning"; content: string; complete: boolean }
export type SessionProjection = {
	rootTaskId?: string
	currentTaskId?: string
	tasks: ReadonlyMap<string, { state?: string; parentTaskId?: string }>
	messages: ReadonlyMap<string, ProjectedMessage>
	pendingAsks: ReadonlyMap<string, { taskId: string; category: string; subject: string }>
	tools: ReadonlyMap<string, { name: string; state: "active" | "completed" | "failed"; output?: string }>
	usage?: { inputTokens?: number; outputTokens?: number; cacheReads?: number; cacheWrites?: number }
	cost?: number
	result?: ZooRunResult
}

export const initialProjection = (): SessionProjection => ({
	tasks: new Map(),
	messages: new Map(),
	pendingAsks: new Map(),
	tools: new Map(),
})

export function reduceSession(state: SessionProjection, event: ZooStreamEvent): SessionProjection {
	const task = "taskId" in event ? { rootTaskId: event.rootTaskId, currentTaskId: event.taskId } : {}
	switch (event.type) {
		case "task.created":
		case "task.delegated":
		case "task.lifecycle": {
			const tasks = new Map(state.tasks)
			const current = tasks.get(event.taskId) ?? {}
			tasks.set(event.taskId, {
				...current,
				...(event.type === "task.delegated" ? { parentTaskId: event.parentTaskId } : {}),
				...(event.type === "task.lifecycle" ? { state: event.state } : {}),
			})
			return { ...state, ...task, tasks }
		}
		case "message.upsert": {
			const messages = new Map(state.messages)
			messages.set(event.messageId, { role: event.role, content: event.content, complete: event.complete })
			return { ...state, ...task, messages }
		}
		case "ask.required": {
			const pendingAsks = new Map(state.pendingAsks)
			pendingAsks.set(event.askId, { taskId: event.taskId, category: event.category, subject: event.subject })
			return { ...state, ...task, pendingAsks }
		}
		case "ask.resolved":
		case "ask.abandoned": {
			const pendingAsks = new Map(state.pendingAsks)
			pendingAsks.delete(event.askId)
			return { ...state, ...task, pendingAsks }
		}
		case "tool.started":
		case "tool.updated":
		case "tool.completed":
		case "tool.failed": {
			const tools = new Map(state.tools)
			tools.set(event.toolCallId, {
				name: event.name,
				state:
					event.type === "tool.failed" ? "failed" : event.type === "tool.completed" ? "completed" : "active",
				output: event.output,
			})
			return { ...state, ...task, tools }
		}
		case "usage.updated":
			return { ...state, ...task, usage: event.usage, cost: event.cost }
		case "task.result":
			return { ...state, ...task, result: event.result }
		default:
			return { ...state, ...task }
	}
}
