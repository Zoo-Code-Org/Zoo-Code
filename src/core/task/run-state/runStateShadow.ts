import {
	abandoned,
	abort,
	abortReason,
	didFinishAbortingStream,
	isInitialized,
	isStreaming,
	nextRunState,
	type AbortReason,
	type RunEvent,
	type RunState,
} from "./runState"

export type RunStateFields = {
	abort: boolean
	abandoned: boolean
	abortReason?: AbortReason
	isInitialized: boolean
	isStreaming: boolean
	didFinishAbortingStream: boolean
}

export type RunRejection = { event: RunEvent; state: RunState }

export const MAX_RUN_REJECTIONS = 100

export const readRunStateFields = (state: RunState): RunStateFields => ({
	abort: abort(state),
	abandoned: abandoned(state),
	abortReason: abortReason(state),
	isInitialized: isInitialized(state),
	isStreaming: isStreaming(state),
	didFinishAbortingStream: didFinishAbortingStream(state),
})

// The kernel reports didFinishAbortingStream only for a live stream, so a leftover field (race R-1) projects false.
export function projectRunState(fields: RunStateFields): RunStateFields {
	return { ...fields, didFinishAbortingStream: fields.isStreaming && fields.didFinishAbortingStream }
}

export function applyRunEvent(state: RunState, event: RunEvent, rejections: RunRejection[]): RunState {
	const result = nextRunState(state, event)
	if ("ok" in result) {
		return result.ok
	}
	rejections.push({ event, state })
	if (rejections.length > MAX_RUN_REJECTIONS) {
		rejections.shift()
	}
	return state
}
