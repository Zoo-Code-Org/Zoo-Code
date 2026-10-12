import type { ClineApiReqCancelReason } from "@roo-code/types"

export type AbortReason = ClineApiReqCancelReason

export type Phase = "uninitialized" | "running" | "completed"

export type Stream = { tag: "none" } | { tag: "live"; generation: number; cleanupFinished: boolean }

export type Ask =
	| { tag: "none" }
	| { tag: "approval"; askTs: number; toolCallId?: string; approvalId?: string }
	| { tag: "completion"; askTs: number }
	| { tag: "other"; askTs: number }

export type Latches = {
	abort: boolean
	abandoned: boolean
	disposed: boolean
	reason?: AbortReason
}

export type RunState = {
	phase: Phase
	generation: number
	stream: Stream
	ask: Ask
	latches: Latches
	lastCompletionAskTs?: number
}

export type RunEvent =
	| { tag: "initialized" }
	| { tag: "streamStarted" }
	| { tag: "streamCleanupFinished" }
	| { tag: "streamEnded" }
	| { tag: "askStarted"; ask: Exclude<Ask, { tag: "none" }> }
	| { tag: "askSettled"; askTs: number }
	| { tag: "completionAccepted"; askTs: number }
	| { tag: "reasonSet"; reason: AbortReason }
	| { tag: "abortRequested"; abandoned: boolean }
	| { tag: "abandonRequested" }
	| { tag: "disposeRequested" }

export type Transition = { ok: RunState } | { rejected: RunState }

export const initialRunState: Readonly<RunState> = Object.freeze({
	phase: "uninitialized",
	generation: 0,
	stream: Object.freeze({ tag: "none" }),
	ask: Object.freeze({ tag: "none" }),
	latches: Object.freeze({ abort: false, abandoned: false, disposed: false }),
})

export function nextRunState(state: RunState, event: RunEvent): Transition {
	switch (event.tag) {
		case "initialized":
			if (state.phase !== "uninitialized") {
				return { rejected: state }
			}
			return { ok: { ...state, phase: "running" } }

		case "streamStarted": {
			if (state.phase !== "running" || state.stream.tag !== "none") {
				return { rejected: state }
			}
			const generation = state.generation + 1
			return {
				ok: {
					...state,
					generation,
					stream: { tag: "live", generation, cleanupFinished: false },
					lastCompletionAskTs: undefined,
				},
			}
		}

		case "streamCleanupFinished":
			if (state.stream.tag !== "live") {
				return { rejected: state }
			}
			return { ok: { ...state, stream: { ...state.stream, cleanupFinished: true } } }

		case "streamEnded":
			if (state.stream.tag !== "live") {
				return { rejected: state }
			}
			return { ok: { ...state, stream: { tag: "none" } } }

		case "askStarted":
			if (state.phase !== "running" || state.latches.abort) {
				return { rejected: state }
			}
			return {
				ok: {
					...state,
					ask: event.ask,
					lastCompletionAskTs: event.ask.tag === "completion" ? event.ask.askTs : undefined,
				},
			}

		case "askSettled":
			if (state.ask.tag === "none" || state.ask.askTs !== event.askTs) {
				return { ok: state }
			}
			return { ok: { ...state, ask: { tag: "none" } } }

		case "completionAccepted":
			if (state.phase !== "running" || state.latches.abort || state.lastCompletionAskTs !== event.askTs) {
				return { rejected: state }
			}
			return { ok: { ...state, phase: "completed", ask: { tag: "none" } } }

		case "reasonSet":
			if (state.latches.reason !== undefined) {
				return { ok: state }
			}
			return { ok: { ...state, latches: { ...state.latches, reason: event.reason } } }

		case "abortRequested":
			return {
				ok: {
					...state,
					latches: {
						...state.latches,
						abort: true,
						abandoned: state.latches.abandoned || event.abandoned,
					},
				},
			}

		case "abandonRequested":
			if (!state.latches.abort) {
				return { rejected: state }
			}
			return { ok: { ...state, latches: { ...state.latches, abandoned: true } } }

		case "disposeRequested":
			return { ok: { ...state, latches: { ...state.latches, abort: true, disposed: true } } }
	}
}

export const abort = (state: RunState): boolean => state.latches.abort

export const abandoned = (state: RunState): boolean => state.latches.abandoned

export const abortReason = (state: RunState): AbortReason | undefined => state.latches.reason

export const didFinishAbortingStream = (state: RunState): boolean =>
	state.stream.tag === "live" && state.stream.cleanupFinished

export const isStreaming = (state: RunState): boolean => state.stream.tag === "live"

export const isInitialized = (state: RunState): boolean => state.phase !== "uninitialized"
