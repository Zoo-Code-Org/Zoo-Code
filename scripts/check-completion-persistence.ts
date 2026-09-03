type TaskKind = "standalone" | "delegated"
type HistoryPhase = "idle" | "writing" | "failed" | "durable" | "exhausted"
type RetryPhase = "idle" | "waiting" | "ready"
type WriteStarts = 0 | 1 | 2

interface ModelState {
	kind: TaskKind
	history: HistoryPhase
	retry: RetryPhase
	writeStarts: WriteStarts
	completionAccepted: boolean
	completionEmitted: boolean
	cancelled: boolean
	waitSettled: boolean
	cancelledAtRetryBoundary: boolean
}

interface Transition {
	name: string
	next: ModelState
}

interface TraceStep {
	action: string
	state: ModelState
}

const MAX_DEPTH = 10
const MAX_STATES = 1_000
const taskKinds = ["standalone", "delegated"] as const
const expectedActions = [
	"start-initial-write",
	"accept-completion",
	"finish-write",
	"fail-write",
	"schedule-retry",
	"finish-retry-delay",
	"start-retry-write",
	"exhaust-retries",
	"cancel",
	"emit-completion",
] as const
const invariantNames = [
	"completion requires restart-visible history",
	"delayed and failed persistence keep completion pending",
	"cancellation settles waits without later writes or completion",
] as const
const semanticLandmarks = {
	"delayed-completion-pending": (state: ModelState) =>
		state.completionAccepted && state.history === "writing" && !state.completionEmitted,
	"failed-completion-pending": (state: ModelState) =>
		state.completionAccepted && state.history === "failed" && !state.completionEmitted,
	"exhausted-completion-pending": (state: ModelState) =>
		state.completionAccepted && state.history === "exhausted" && state.waitSettled && !state.completionEmitted,
	"cancelled-retry-boundary": (state: ModelState) =>
		state.cancelledAtRetryBoundary && state.waitSettled && state.retry === "idle" && !state.completionEmitted,
	"standalone-durable-completion": (state: ModelState) =>
		state.kind === "standalone" && state.history === "durable" && state.completionEmitted,
	"delegated-durable-completion": (state: ModelState) =>
		state.kind === "delegated" && state.history === "durable" && state.completionEmitted,
} satisfies Record<string, (state: ModelState) => boolean>

function initialState(kind: TaskKind): ModelState {
	return {
		kind,
		history: "idle",
		retry: "idle",
		writeStarts: 0,
		completionAccepted: false,
		completionEmitted: false,
		cancelled: false,
		waitSettled: false,
		cancelledAtRetryBoundary: false,
	}
}

function transitions(state: ModelState): Transition[] {
	const result: Transition[] = []

	if (state.history === "idle" && !state.cancelled) {
		result.push({
			name: "start-initial-write",
			next: { ...state, history: "writing", writeStarts: 1 },
		})
	}
	if (!state.completionAccepted && !state.cancelled) {
		result.push({ name: "accept-completion", next: { ...state, completionAccepted: true } })
	}
	if (state.history === "writing") {
		result.push({
			name: "finish-write",
			next: { ...state, history: "durable", waitSettled: true },
		})
		result.push({ name: "fail-write", next: { ...state, history: "failed" } })
	}
	if (state.history === "failed" && state.retry === "idle" && !state.cancelled) {
		if (state.writeStarts < 2) {
			result.push({ name: "schedule-retry", next: { ...state, retry: "waiting" } })
		} else {
			result.push({
				name: "exhaust-retries",
				next: { ...state, history: "exhausted", waitSettled: true },
			})
		}
	}
	if (state.retry === "waiting" && !state.cancelled) {
		result.push({ name: "finish-retry-delay", next: { ...state, retry: "ready" } })
	}
	if (state.retry === "ready" && !state.cancelled && state.writeStarts < 2) {
		result.push({
			name: "start-retry-write",
			next: {
				...state,
				history: "writing",
				retry: "idle",
				writeStarts: (state.writeStarts + 1) as WriteStarts,
			},
		})
	}
	if (!state.cancelled && !state.completionEmitted) {
		result.push({
			name: "cancel",
			next: {
				...state,
				retry: "idle",
				cancelled: true,
				waitSettled: true,
				cancelledAtRetryBoundary: state.retry === "ready",
			},
		})
	}
	if (
		state.completionAccepted &&
		state.history === "durable" &&
		state.waitSettled &&
		!state.completionEmitted &&
		!state.cancelled
	) {
		result.push({
			name: "emit-completion",
			next: { ...state, completionEmitted: true, waitSettled: true },
		})
	}

	return result
}

function invariantViolations(state: ModelState): string[] {
	const violations: string[] = []
	if (state.completionEmitted && state.history !== "durable") {
		violations.push("completion emitted before assistant history became restart-visible")
	}
	if (
		state.completionAccepted &&
		(state.history === "writing" || state.history === "failed" || state.history === "exhausted") &&
		state.completionEmitted
	) {
		violations.push("delayed or failed persistence allowed completion")
	}
	if (state.cancelled && (!state.waitSettled || state.retry !== "idle" || state.completionEmitted)) {
		violations.push("cancellation did not settle the wait and suppress retry/completion")
	}
	return violations
}

function transitionViolations(previous: ModelState, transition: Transition): string[] {
	const violations: string[] = []
	if (previous.cancelled && transition.next.writeStarts > previous.writeStarts) {
		violations.push(`cancelled task started a stale history write after ${transition.name}`)
	}
	if (previous.cancelled && !previous.completionEmitted && transition.next.completionEmitted) {
		violations.push(`cancelled task emitted completion after ${transition.name}`)
	}
	return violations
}

function canonical(state: ModelState): string {
	return JSON.stringify(state)
}

function formatCounterexample(message: string, trace: TraceStep[]): string {
	return [
		`Completion persistence invariant failed: ${message}`,
		`Bounds: depth=${MAX_DEPTH}, states=${MAX_STATES}, writes<=2`,
		...trace.map((step, index) => `${index}. ${step.action}\n${JSON.stringify(step.state, null, 2)}`),
	].join("\n")
}

function runModelCheck(): number {
	const queue: Array<{ state: ModelState; trace: TraceStep[] }> = taskKinds.map((kind) => {
		const state = initialState(kind)
		return { state, trace: [{ action: `initial(${kind})`, state }] }
	})
	const visited = new Set(queue.map(({ state }) => canonical(state)))
	const reachedActions = new Set<string>()
	const reachedLandmarks = new Set<string>()
	const frontier: ModelState[] = []

	for (let index = 0; index < queue.length; index++) {
		const node = queue[index]!
		for (const [name, predicate] of Object.entries(semanticLandmarks)) {
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
			const trace = [...node.trace, { action: transition.name, state: transition.next }]
			const violations = transitionViolations(node.state, transition)
			if (violations.length) throw new Error(formatCounterexample(violations.join("; "), trace))
			const key = canonical(transition.next)
			if (visited.has(key)) continue
			visited.add(key)
			queue.push({ state: transition.next, trace })
			if (visited.size > MAX_STATES) {
				throw new Error(`Completion persistence exploration exceeded its ${MAX_STATES}-state budget`)
			}
		}
	}

	const unreachableActions = expectedActions.filter((action) => !reachedActions.has(action))
	if (unreachableActions.length) {
		throw new Error(`Completion persistence model has unreachable actions: ${unreachableActions.join(", ")}`)
	}
	const missingLandmarks = Object.keys(semanticLandmarks).filter((name) => !reachedLandmarks.has(name))
	if (missingLandmarks.length) {
		throw new Error(`Completion persistence model has unreachable landmarks: ${missingLandmarks.join(", ")}`)
	}
	const unexploredSuccessor = frontier
		.flatMap((state) => transitions(state))
		.find((transition) => !visited.has(canonical(transition.next)))
	if (unexploredSuccessor) {
		throw new Error(
			`Completion persistence exploration reached depth ${MAX_DEPTH} with an unseen successor (${unexploredSuccessor.name})`,
		)
	}
	return visited.size
}

const checkedStates = runModelCheck()
console.log(
	`Completion persistence model check passed: ${checkedStates} states, ${expectedActions.length}/${expectedActions.length} actions reachable, ${invariantNames.length} invariants, ${Object.keys(semanticLandmarks).length}/${Object.keys(semanticLandmarks).length} landmarks reached, depth <= ${MAX_DEPTH}, writes <= 2`,
)
