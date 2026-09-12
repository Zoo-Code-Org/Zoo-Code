import assert from "node:assert/strict"

import { decideMidStreamFailure, MAX_MID_STREAM_RETRIES } from "../src/core/task/midStreamRetry"

type Phase = "requesting" | "backoff" | "awaiting-user" | "stopped" | "succeeded"

interface ModelState {
	phase: Phase
	stopReason?: "decline" | "backoff-abort" | "prompt-abort"
	retryAttempt: number
	requests: number
	announcements: number
	roundsApproved: number
}

interface Transition {
	name: string
	next: ModelState
}

interface TraceStep {
	action: string
	state: ModelState
}

const MAX_APPROVED_ROUNDS = 1
const MAX_DEPTH = 16
const MAX_STATES = 100
const expectedActions = ["fail", "retry", "approve", "decline", "abort-backoff", "abort-prompt", "succeed"] as const
const landmarks = {
	"automatic-budget-exhausted": (state: ModelState) =>
		state.phase === "awaiting-user" && state.requests === MAX_MID_STREAM_RETRIES + 1,
	"approved-round-reset": (state: ModelState) =>
		state.roundsApproved === 1 && state.phase === "requesting" && state.retryAttempt === 0,
	"declined-after-approved-round": (state: ModelState) =>
		state.roundsApproved === 1 && state.stopReason === "decline",
	"backoff-cancelled": (state: ModelState) => state.stopReason === "backoff-abort",
	"prompt-cancelled": (state: ModelState) => state.stopReason === "prompt-abort",
} satisfies Record<string, (state: ModelState) => boolean>

function initialState(): ModelState {
	return { phase: "requesting", retryAttempt: 0, requests: 1, announcements: 0, roundsApproved: 0 }
}

function transitions(state: ModelState): Transition[] {
	if (state.phase === "requesting") {
		const decision = decideMidStreamFailure(state.retryAttempt)
		return [
			{ name: "fail", next: { ...state, phase: decision === "retry" ? "backoff" : "awaiting-user" } },
			{ name: "succeed", next: { ...state, phase: "succeeded" } },
		]
	}
	if (state.phase === "backoff") {
		return [
			{
				name: "retry",
				next: {
					...state,
					phase: "requesting",
					retryAttempt: state.retryAttempt + 1,
					requests: state.requests + 1,
					announcements: state.announcements + 1,
				},
			},
			{ name: "abort-backoff", next: { ...state, phase: "stopped", stopReason: "backoff-abort" } },
		]
	}
	if (state.phase === "awaiting-user") {
		const result: Transition[] = [
			{ name: "decline", next: { ...state, phase: "stopped", stopReason: "decline" } },
			{ name: "abort-prompt", next: { ...state, phase: "stopped", stopReason: "prompt-abort" } },
		]
		if (state.roundsApproved < MAX_APPROVED_ROUNDS) {
			result.push({
				name: "approve",
				next: {
					...state,
					phase: "requesting",
					retryAttempt: 0,
					requests: state.requests + 1,
					roundsApproved: state.roundsApproved + 1,
				},
			})
		}
		return result
	}
	return []
}

function invariantViolations(state: ModelState): string[] {
	const violations: string[] = []
	if (state.announcements !== state.requests - 1 - state.roundsApproved) {
		violations.push("every automatic retry must have exactly one user-visible announcement")
	}
	if (state.retryAttempt > MAX_MID_STREAM_RETRIES) {
		violations.push("an automatic retry exceeded the configured retry budget")
	}
	if (state.phase === "awaiting-user" && state.retryAttempt !== MAX_MID_STREAM_RETRIES) {
		violations.push("user input must be requested exactly when the automatic retry budget is exhausted")
	}
	return violations
}

function canonical(state: ModelState): string {
	return JSON.stringify(state)
}

function formatCounterexample(message: string, trace: TraceStep[]): string {
	return [
		`Mid-stream retry invariant failed: ${message}`,
		`Bounds: depth=${MAX_DEPTH}, states=${MAX_STATES}, approvedRounds=${MAX_APPROVED_ROUNDS}`,
		...trace.map((step, index) => `${index}. ${step.action} ${JSON.stringify(step.state)}`),
	].join("\n")
}

function runModelCheck(): number {
	const start = initialState()
	const queue: Array<{ state: ModelState; trace: TraceStep[] }> = [
		{ state: start, trace: [{ action: "initial", state: start }] },
	]
	const visited = new Set([canonical(start)])
	const reachedActions = new Set<string>()
	const reachedLandmarks = new Set<string>()
	const frontier: ModelState[] = []

	for (let index = 0; index < queue.length; index++) {
		const node = queue[index]!
		for (const [name, predicate] of Object.entries(landmarks)) {
			if (predicate(node.state)) reachedLandmarks.add(name)
		}
		const violations = invariantViolations(node.state)
		if (violations.length) throw new Error(formatCounterexample(violations.join("; "), node.trace))
		if (node.trace.length - 1 === MAX_DEPTH) {
			frontier.push(node.state)
			continue
		}
		for (const transition of transitions(node.state)) {
			reachedActions.add(transition.name)
			const key = canonical(transition.next)
			if (visited.has(key)) continue
			visited.add(key)
			queue.push({
				state: transition.next,
				trace: [...node.trace, { action: transition.name, state: transition.next }],
			})
			if (visited.size > MAX_STATES) throw new Error(`Mid-stream retry model exceeded ${MAX_STATES} states`)
		}
	}

	const unreachableActions = expectedActions.filter((action) => !reachedActions.has(action))
	assert.deepEqual(unreachableActions, [], `Unreachable actions: ${unreachableActions.join(", ")}`)
	const missingLandmarks = Object.keys(landmarks).filter((name) => !reachedLandmarks.has(name))
	assert.deepEqual(missingLandmarks, [], `Unreachable landmarks: ${missingLandmarks.join(", ")}`)
	const unexploredSuccessor = frontier.flatMap(transitions).find((next) => !visited.has(canonical(next.next)))
	assert.equal(unexploredSuccessor, undefined, "Increase MAX_DEPTH to cover unseen successors")
	return visited.size
}

const checkedStates = runModelCheck()
console.log(
	`Mid-stream retry model check passed: ${checkedStates} reachable states, ${expectedActions.length}/${expectedActions.length} actions reachable, ${Object.keys(landmarks).length}/${Object.keys(landmarks).length} landmarks reached, depth <= ${MAX_DEPTH}`,
)
