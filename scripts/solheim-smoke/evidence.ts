import { RooCodeEventName, taskEventSchema, type TaskEvent } from "@roo-code/types"

export type SmokeEvidence = {
	providerResponseSeen: boolean
	completionSeen: boolean
	unexpectedTool: boolean
	aborted: boolean
}

// Only schema-valid events for the accepted root task can satisfy smoke gates.
// No model text, credentials, tool arguments, or task IDs are persisted.
export function collectEvidence(state: SmokeEvidence, raw: unknown, rootTaskId: string | undefined): void {
	if (!rootTaskId) return
	const parsed = taskEventSchema.safeParse(raw)
	if (!parsed.success) return
	const event: TaskEvent = parsed.data
	if (event.eventName === RooCodeEventName.Message) {
		const entry = event.payload[0]
		if (entry.taskId !== rootTaskId || entry.message.partial === true) return
		const message = entry.message
		if (message.type === "say" && message.say === "completion_result" && message.text?.trim())
			state.completionSeen = true
		if (message.type === "ask" && message.ask !== "completion_result") state.unexpectedTool = true
	} else if (event.payload[0] === rootTaskId) {
		if (
			event.eventName === RooCodeEventName.TaskTokenUsageUpdated ||
			event.eventName === RooCodeEventName.TaskCompleted
		) {
			if (
				Object.entries(event.payload[2]).some(
					([tool, usage]) => tool !== "attempt_completion" && usage.attempts > 0,
				)
			)
				state.unexpectedTool = true
		}
		if (event.eventName === RooCodeEventName.TaskTokenUsageUpdated && event.payload[1].totalTokensOut > 0)
			state.providerResponseSeen = true
		if (event.eventName === RooCodeEventName.TaskCompleted && event.payload[1].totalTokensOut > 0)
			state.providerResponseSeen = true
		if (event.eventName === RooCodeEventName.TaskAborted) state.aborted = true
		if (event.eventName === RooCodeEventName.TaskDelegated || event.eventName === RooCodeEventName.TaskSpawned)
			state.unexpectedTool = true
	}
}

export type SmokeCode =
	| "OK"
	| "SETUP_FAILED"
	| "ACTIVATION_FAILED"
	| "TASK_START_FAILED"
	| "SESSION_LOST"
	| "UNEXPECTED_TOOL"
	| "PROVIDER_TIMEOUT"
	| "COMPLETION_MISSING"
	| "TEARDOWN_FAILED"
export function smokeCode(state: SmokeEvidence, sessionLost: boolean): SmokeCode {
	if (sessionLost || state.aborted) return "SESSION_LOST"
	if (state.unexpectedTool) return "UNEXPECTED_TOOL"
	if (!state.providerResponseSeen) return "PROVIDER_TIMEOUT"
	if (!state.completionSeen) return "COMPLETION_MISSING"
	return "OK"
}
