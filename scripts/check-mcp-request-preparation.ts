import assert from "node:assert/strict"
import { initialRunState, nextRunState, type RunState } from "../src/core/task/run-state/runState"

// Independent bounded protocol for Task's request/condensation await boundaries.
// Cancellation uses the production run-state kernel. Stage order and guards are
// abstractions, tied to the parameterized Task.spec.ts production regressions.
// Provider streams, scheduler permits and filesystem writes are outside this model.
const paths = {
	manual: ["prompt", "tools", "environment", "summary", "apply"],
	recovery: ["tools", "environment", "prompt", "summary", "apply"],
	automatic: ["prompt", "tools", "environment", "summary", "apply", "request"],
	normal: ["prompt", "tools", "request"],
} as const
const MAX_DEPTH = 8
const MAX_STATES = 100
interface State {
	step: number
	runState: RunState
}
interface Policy {
	startGuard: boolean
	commitGuard: boolean
}
interface Node {
	state: State
	trace: string[]
}
type Violation = "late-start" | "late-commit"

function explore(stages: readonly string[], policy: Policy) {
	const started = nextRunState(initialRunState, { tag: "initialized" })
	assert.ok("ok" in started)
	const queue: Node[] = [{ state: { step: 0, runState: started.ok }, trace: [] }]
	const seen = new Set<string>()
	const reached = new Set<string>()
	for (let index = 0; index < queue.length; index++) {
		const { state, trace } = queue[index]
		const key = JSON.stringify(state)
		if (seen.has(key)) continue
		seen.add(key)
		assert.ok(seen.size <= MAX_STATES, "Request preparation state budget exceeded")
		if (state.step === stages.length) continue
		assert.ok(trace.length < MAX_DEPTH, `Request preparation depth truncated: ${trace.join(" -> ")}`)
		const stage = stages[state.step]
		const canceled = state.runState.latches.abort || state.runState.latches.abandoned
		const guarded = stage === "apply" ? policy.commitGuard : policy.startGuard
		if (canceled && !guarded && ["summary", "request", "apply"].includes(stage)) {
			const violation: Violation = stage === "apply" ? "late-commit" : "late-start"
			return { states: seen.size, reached, violation, trace: [...trace, stage] }
		}
		queue.push({
			state: { ...state, step: canceled && guarded ? stages.length : state.step + 1 },
			trace: [...trace, canceled && guarded ? "stop-canceled" : stage],
		})
		if (!canceled) {
			reached.add(`uncanceled-${stage}`)
			for (const tag of ["abort", "abandon"] as const) {
				const transition = nextRunState(state.runState, { tag: "abortRequested", abandoned: tag === "abandon" })
				assert.ok("ok" in transition, `${tag} must set the cancellation latch`)
				reached.add(`${tag}-at-${stage}`)
				queue.push({ state: { ...state, runState: transition.ok }, trace: [...trace, tag] })
			}
		}
	}
	return { states: seen.size, reached, violation: undefined, trace: [] }
}

let states = 0
for (const [name, stages] of Object.entries(paths)) {
	const result = explore(stages, { startGuard: true, commitGuard: true })
	assert.equal(result.violation, undefined, `${name}: ${result.violation}; ${result.trace.join(" -> ")}`)
	for (const stage of stages) {
		for (const action of ["uncanceled", "abort-at", "abandon-at"]) {
			assert.ok(result.reached.has(`${action}-${stage}`), `${name}: unreachable ${action}-${stage}`)
		}
	}
	states += result.states
}
for (const [fault, policy, expected] of [
	["missing-start-guard", { startGuard: false, commitGuard: true }, "late-start"],
	["missing-commit-guard", { startGuard: true, commitGuard: false }, "late-commit"],
] as const) {
	const result = explore(paths.manual, policy)
	assert.equal(result.violation, expected, `${fault} injection was not detected`)
	console.log(`MCP request injection ${fault}: ${result.trace.join(" -> ")}`)
}
console.log(
	`MCP request preparation model passed: ${states} states, 4 paths, all stage/cancellation landmarks, 2/2 fault injections`,
)
