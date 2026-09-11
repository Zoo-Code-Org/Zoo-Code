type Phase = "idle" | "waiting" | "running" | "completed" | "closed"
type Action = "run" | "wait" | "activate" | "output" | "end" | "close"

interface ModelState {
	phase: Phase
	processAttached: boolean
	commandSubmitted: boolean
	completionCount: number
	output: string
	deliveredOutput: string
	iteratorReleased: boolean
	waitsCreated: number
	pendingWaits: number
	settledWaits: number
}

interface TraceStep {
	action: Action | "initial"
	state: ModelState
}

const actions: Action[] = ["run", "wait", "activate", "output", "end", "close"]
const MAX_DEPTH = 7
const MAX_STATES = 100

function initialState(): ModelState {
	return {
		phase: "idle",
		processAttached: false,
		commandSubmitted: false,
		completionCount: 0,
		output: "",
		deliveredOutput: "",
		iteratorReleased: false,
		waitsCreated: 0,
		pendingWaits: 0,
		settledWaits: 0,
	}
}

function complete(state: ModelState, phase: "completed" | "closed"): ModelState {
	return {
		...state,
		phase,
		processAttached: false,
		completionCount: state.processAttached ? state.completionCount + 1 : state.completionCount,
		deliveredOutput: state.output,
		iteratorReleased: state.iteratorReleased || state.phase === "running",
	}
}

function transition(state: ModelState, action: Action): ModelState {
	switch (action) {
		case "run":
			return state.phase === "idle" ? { ...state, phase: "waiting", processAttached: true } : state
		case "wait":
			return state.phase !== "closed" && state.waitsCreated < 2
				? { ...state, waitsCreated: state.waitsCreated + 1, pendingWaits: state.pendingWaits + 1 }
				: state
		case "activate":
			return state.phase === "waiting"
				? {
						...state,
						phase: "running",
						commandSubmitted: true,
						pendingWaits: 0,
						settledWaits: state.settledWaits + state.pendingWaits,
					}
				: state
		case "output":
			return state.phase === "running" ? { ...state, output: `${state.output}chunk` } : state
		case "end":
			return state.phase === "waiting" || state.phase === "running" ? complete(state, "completed") : state
		case "close":
			return state.phase === "closed"
				? state
				: {
						...complete(state, "closed"),
						pendingWaits: 0,
						settledWaits: state.settledWaits + state.pendingWaits,
					}
	}
}

function violations(state: ModelState): string[] {
	const result: string[] = []
	if (state.completionCount > 1) result.push("a command completed more than once")
	if (state.phase === "closed" && state.processAttached) result.push("a closed terminal retained its process")
	if (state.phase === "closed" && state.pendingWaits !== 0) result.push("a closed terminal retained pending waits")
	if (state.settledWaits > state.waitsCreated) result.push("more waits settled than were created")
	if (state.phase === "closed" && state.commandSubmitted && !state.iteratorReleased) {
		result.push("closing a submitted command did not release its stream iterator")
	}
	if ((state.phase === "completed" || state.phase === "closed") && state.deliveredOutput !== state.output) {
		result.push("completion did not deliver all buffered output")
	}
	return result
}

function formatCounterexample(message: string, trace: TraceStep[]): string {
	return [
		`Terminal lifecycle invariant failed: ${message}`,
		`Bounds: depth=${MAX_DEPTH}, states=${MAX_STATES}`,
		...trace.map((step, index) => `${index}. ${step.action}: ${JSON.stringify(step.state)}`),
	].join("\n")
}

const landmarks = {
	"waiting-close-without-submit": (trace: TraceStep[]) =>
		trace.some((step) => step.action === "run") &&
		trace.at(-1)?.action === "close" &&
		trace.at(-1)?.state.commandSubmitted === false &&
		trace.at(-1)?.state.completionCount === 1,
	"running-close-after-output": (trace: TraceStep[]) =>
		trace.some((step) => step.action === "output") &&
		trace.at(-1)?.action === "close" &&
		trace.at(-1)?.state.deliveredOutput === "chunk" &&
		trace.at(-1)?.state.iteratorReleased === true,
	"end-then-close": (trace: TraceStep[]) =>
		trace.some((step) => step.action === "end") &&
		trace.at(-1)?.action === "close" &&
		trace.at(-1)?.state.completionCount === 1,
	"duplicate-close": (trace: TraceStep[]) => trace.filter((step) => step.action === "close").length >= 2,
	"concurrent-waits-close": (trace: TraceStep[]) =>
		trace.at(-1)?.action === "close" &&
		trace.at(-1)?.state.waitsCreated === 2 &&
		trace.at(-1)?.state.pendingWaits === 0 &&
		trace.at(-1)?.state.settledWaits === 2,
} satisfies Record<string, (trace: TraceStep[]) => boolean>

const start = initialState()
const queue: Array<{ state: ModelState; trace: TraceStep[] }> = [
	{ state: start, trace: [{ action: "initial", state: start }] },
]
const visited = new Set([JSON.stringify(start)])
const reachedActions = new Set<Action>()
const reachedLandmarks = new Set<string>()

for (let index = 0; index < queue.length; index++) {
	const node = queue[index]!
	const stateViolations = violations(node.state)
	if (stateViolations.length) throw new Error(formatCounterexample(stateViolations.join("; "), node.trace))
	for (const [name, predicate] of Object.entries(landmarks)) {
		if (predicate(node.trace)) reachedLandmarks.add(name)
	}
	if (node.trace.length - 1 === MAX_DEPTH) continue

	for (const action of actions) {
		const next = transition(node.state, action)
		const trace = [...node.trace, { action, state: next }]
		for (const [name, predicate] of Object.entries(landmarks)) {
			if (predicate(trace)) reachedLandmarks.add(name)
		}
		if (next === node.state) continue
		reachedActions.add(action)
		const key = JSON.stringify(next)
		if (visited.has(key)) continue
		visited.add(key)
		queue.push({ state: next, trace })
		if (visited.size > MAX_STATES) throw new Error(`Terminal lifecycle exceeded its ${MAX_STATES}-state budget`)
	}
}

const missingActions = actions.filter((action) => !reachedActions.has(action))
if (missingActions.length) throw new Error(`Terminal lifecycle has unreachable actions: ${missingActions.join(", ")}`)
const missingLandmarks = Object.keys(landmarks).filter((name) => !reachedLandmarks.has(name))
if (missingLandmarks.length)
	throw new Error(`Terminal lifecycle has unreachable landmarks: ${missingLandmarks.join(", ")}`)

console.log(
	`Terminal lifecycle model check passed: ${visited.size} reachable states, ${actions.length}/${actions.length} actions reachable, ${Object.keys(landmarks).length}/${Object.keys(landmarks).length} landmarks reached, depth <= ${MAX_DEPTH}`,
)
