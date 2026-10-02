import assert from "node:assert/strict"

const taskIds = ["A", "B"] as const
type TaskId = (typeof taskIds)[number]
type PendingResult = "idle" | "pending" | "resolved" | "rejected"

interface TaskState {
	abort: PendingResult
	abortHandle?: 1
	abortStarts: number
	disposal: PendingResult
	disposalHandle?: 1
	disposalStarts: number
	reversion: PendingResult
	cleanup: PendingResult
	finalization: "idle" | "attempted" | "skipped"
}

interface ModelState {
	tasks: Record<TaskId, TaskState>
	shutdown: "idle" | "call-abort" | "wait-abort" | "wait-disposal" | "done"
	shutdownIndex: number
	drained: Record<TaskId, boolean>
}

interface Step {
	action: string
	state: ModelState
}

const MAX_DEPTH = 20
const MAX_STATES = 100_000
const expectedActions = [
	"abort",
	"dispose",
	"abort-starts-disposal",
	"reject-disposal-start",
	"settle-reversion",
	"reject-reversion",
	"settle-cleanup",
	"reject-cleanup",
	"reject-abort",
	"complete-abort",
	"skip-final-save",
	"complete-disposal",
	"start-shutdown",
	"shutdown-abort",
	"shutdown-dispose",
	"advance-shutdown",
] as const

function task(): TaskState {
	return {
		abort: "idle",
		abortStarts: 0,
		disposal: "idle",
		disposalStarts: 0,
		reversion: "idle",
		cleanup: "idle",
		finalization: "idle",
	}
}

function initialState(): ModelState {
	return {
		tasks: { A: task(), B: task() },
		shutdown: "idle",
		shutdownIndex: 0,
		drained: { A: false, B: false },
	}
}

function clone(state: ModelState): ModelState {
	return structuredClone(state)
}

function isTerminal(result: PendingResult): boolean {
	return result === "resolved" || result === "rejected"
}

function callAbort(state: ModelState, taskId: TaskId): ModelState {
	const next = clone(state)
	const current = next.tasks[taskId]
	if (current.abort === "idle") {
		current.abort = "pending"
		current.abortHandle = 1
		current.abortStarts += 1
	}
	return next
}

function callDispose(state: ModelState, taskId: TaskId): ModelState {
	const next = clone(state)
	const current = next.tasks[taskId]
	if (current.disposal === "idle") {
		current.disposal = "pending"
		current.disposalHandle = 1
		current.disposalStarts += 1
		current.reversion = "pending"
		current.cleanup = "pending"
	}
	return next
}

function transitions(state: ModelState): Step[] {
	const result: Step[] = []
	for (const taskId of taskIds) {
		const current = state.tasks[taskId]
		if (current.abort === "idle") {
			result.push({ action: `abort(${taskId})`, state: callAbort(state, taskId) })
		}
		if (current.disposal === "idle") {
			result.push({ action: `dispose(${taskId})`, state: callDispose(state, taskId) })
			const next = clone(state)
			const failed = next.tasks[taskId]
			failed.disposal = "rejected"
			failed.disposalHandle = 1
			failed.disposalStarts = 1
			failed.reversion = "rejected"
			failed.cleanup = "rejected"
			result.push({ action: `reject-disposal-start(${taskId})`, state: next })
		}
		if (current.abort === "pending" && current.disposal === "idle") {
			result.push({ action: `abort-starts-disposal(${taskId})`, state: callDispose(state, taskId) })
		}
		if (current.reversion === "pending") {
			for (const outcome of ["resolved", "rejected"] as const) {
				const next = clone(state)
				next.tasks[taskId].reversion = outcome
				result.push({
					action: `${outcome === "resolved" ? "settle" : "reject"}-reversion(${taskId})`,
					state: next,
				})
			}
		}
		if (current.cleanup === "pending") {
			for (const outcome of ["resolved", "rejected"] as const) {
				const next = clone(state)
				next.tasks[taskId].cleanup = outcome
				result.push({
					action: `${outcome === "resolved" ? "settle" : "reject"}-cleanup(${taskId})`,
					state: next,
				})
			}
		}
		if (current.abort === "pending") {
			const next = clone(state)
			next.tasks[taskId].abort = "rejected"
			result.push({ action: `reject-abort(${taskId})`, state: next })
		}
		if (
			current.abort === "pending" &&
			current.disposal !== "idle" &&
			isTerminal(current.reversion) &&
			current.finalization === "idle"
		) {
			for (const finalization of ["attempted", "skipped"] as const) {
				const next = clone(state)
				next.tasks[taskId].finalization = finalization
				next.tasks[taskId].abort = "resolved"
				result.push({
					action: `${finalization === "attempted" ? "complete-abort" : "skip-final-save"}(${taskId})`,
					state: next,
				})
			}
		}
		if (current.disposal === "pending" && isTerminal(current.reversion) && isTerminal(current.cleanup)) {
			const next = clone(state)
			next.tasks[taskId].disposal = "resolved"
			result.push({ action: `complete-disposal(${taskId})`, state: next })
		}
	}

	if (state.shutdown === "idle") {
		const next = clone(state)
		next.shutdown = "call-abort"
		result.push({ action: "start-shutdown()", state: next })
	} else if (state.shutdown !== "done") {
		const taskId = taskIds[state.shutdownIndex]
		if (taskId) {
			const current = state.tasks[taskId]
			if (state.shutdown === "call-abort") {
				const next = callAbort(state, taskId)
				next.shutdown = "wait-abort"
				result.push({ action: `shutdown-abort(${taskId})`, state: next })
			} else if (state.shutdown === "wait-abort" && isTerminal(current.abort)) {
				const next = callDispose(state, taskId)
				next.shutdown = "wait-disposal"
				result.push({ action: `shutdown-dispose(${taskId})`, state: next })
			} else if (state.shutdown === "wait-disposal" && isTerminal(current.disposal)) {
				const next = clone(state)
				next.drained[taskId] = true
				next.shutdownIndex += 1
				next.shutdown = next.shutdownIndex === taskIds.length ? "done" : "call-abort"
				result.push({ action: `advance-shutdown(${taskId})`, state: next })
			}
		}
	}
	return result
}

function invariantViolations(state: ModelState): string[] {
	const violations: string[] = []
	for (const taskId of taskIds) {
		const current = state.tasks[taskId]
		if (current.abortStarts > 1 || current.disposalStarts > 1) {
			violations.push(`${taskId}: abort and disposal may each start at most once`)
		}
		if ((current.abort === "idle") === Boolean(current.abortHandle)) {
			violations.push(`${taskId}: abort handle must exist exactly when abort has started`)
		}
		if ((current.disposal === "idle") === Boolean(current.disposalHandle)) {
			violations.push(`${taskId}: disposal handle must exist exactly when disposal has started`)
		}
		if (current.finalization !== "idle" && !isTerminal(current.reversion)) {
			violations.push(`${taskId}: abort finalization occurred before editor reversion settled`)
		}
		if (current.abort === "resolved" && current.finalization === "idle") {
			violations.push(`${taskId}: abort resolved before its final save attempt or history-task skip`)
		}
		if (current.finalization !== "idle" && current.abort !== "resolved") {
			violations.push(`${taskId}: abort finalization exists without a resolved abort`)
		}
		if (current.disposal === "resolved" && (!isTerminal(current.cleanup) || !isTerminal(current.reversion))) {
			violations.push(`${taskId}: disposal resolved before all cleanup branches settled`)
		}
		if (state.drained[taskId] && (!isTerminal(current.abort) || !isTerminal(current.disposal))) {
			violations.push(`${taskId}: provider advanced before abort and disposal completed`)
		}
	}
	if (state.shutdownIndex !== taskIds.filter((taskId) => state.drained[taskId]).length) {
		violations.push("shutdown cursor must match the drained task prefix")
	}
	if (state.drained.B && !state.drained.A) violations.push("provider drained tasks out of order")
	if (state.shutdownIndex === 1 && !state.drained.A) {
		violations.push("provider advanced to the second task before draining the first")
	}
	if ((state.shutdown === "done") !== taskIds.every((taskId) => state.drained[taskId])) {
		violations.push("shutdown is done exactly when every modeled task is drained")
	}
	return violations
}

function canonical(state: ModelState): string {
	return JSON.stringify(state)
}

function runRepresentativeMemoizationChecks(): void {
	const start = initialState()
	const firstAbort = callAbort(start, "A")
	assert.deepEqual(callAbort(firstAbort, "A"), firstAbort, "repeated abort must reuse the first handle")
	const firstDisposal = callDispose(start, "A")
	assert.deepEqual(callDispose(firstDisposal, "A"), firstDisposal, "repeated disposal must reuse the first handle")
}

function runModelCheck(): { states: number; actions: number; landmarks: number } {
	const start = initialState()
	const queue: Array<{ state: ModelState; trace: Step[] }> = [{ state: start, trace: [] }]
	const visited = new Set([canonical(start)])
	const reachedActions = new Set<string>()
	const reachedLandmarks = new Set<string>()
	const frontier: ModelState[] = []

	for (let index = 0; index < queue.length; index++) {
		const node = queue[index]!
		const violations = invariantViolations(node.state)
		if (violations.length) {
			throw new Error(
				`Task cleanup protocol invariant failed: ${violations.join("; ")}\n${node.trace.map((step, i) => `${i + 1}. ${step.action}`).join("\n")}`,
			)
		}
		if (node.state.tasks.A.abort === "resolved" && node.state.tasks.A.cleanup === "pending") {
			reachedLandmarks.add("abort-completes-before-ancillary-cleanup")
		}
		if (node.state.tasks.A.disposal === "resolved" && node.state.tasks.A.cleanup === "rejected") {
			reachedLandmarks.add("cleanup-rejection-is-observed-and-contained")
		}
		if (
			node.state.tasks.A.abort === "resolved" &&
			node.state.tasks.A.reversion === "rejected" &&
			node.state.tasks.A.finalization === "attempted"
		) {
			reachedLandmarks.add("reversion-rejection-does-not-block-final-save")
		}
		if (node.state.drained.A && node.state.tasks.A.cleanup === "rejected" && node.state.drained.B) {
			reachedLandmarks.add("shutdown-continues-after-cleanup-rejection")
		}
		if (node.state.drained.A && node.state.tasks.A.disposal === "rejected" && node.state.drained.B) {
			reachedLandmarks.add("shutdown-continues-after-disposal-rejection")
		}
		if (node.state.drained.A && node.state.tasks.A.abort === "rejected" && node.state.drained.B) {
			reachedLandmarks.add("shutdown-continues-after-abort-rejection")
		}
		if (node.state.tasks.A.abort === "resolved" && node.state.tasks.A.finalization === "skipped") {
			reachedLandmarks.add("history-task-final-save-skip")
		}
		if (node.state.shutdown === "done") reachedLandmarks.add("multi-task-shutdown-drained")

		if (node.trace.length === MAX_DEPTH) {
			frontier.push(node.state)
			continue
		}
		for (const step of transitions(node.state)) {
			reachedActions.add(step.action.slice(0, step.action.indexOf("(")))
			const key = canonical(step.state)
			if (visited.has(key)) continue
			visited.add(key)
			queue.push({ state: step.state, trace: [...node.trace, step] })
			if (visited.size > MAX_STATES) throw new Error(`Cleanup protocol exceeded ${MAX_STATES} states`)
		}
	}

	const unseen = frontier.flatMap(transitions).find((step) => !visited.has(canonical(step.state)))
	if (unseen) throw new Error(`Cleanup protocol truncated before unseen action ${unseen.action}`)
	const missingActions = expectedActions.filter((action) => !reachedActions.has(action))
	assert.deepEqual(missingActions, [], `Cleanup protocol has unreachable actions: ${missingActions.join(", ")}`)
	const expectedLandmarks = [
		"abort-completes-before-ancillary-cleanup",
		"cleanup-rejection-is-observed-and-contained",
		"reversion-rejection-does-not-block-final-save",
		"shutdown-continues-after-cleanup-rejection",
		"shutdown-continues-after-disposal-rejection",
		"shutdown-continues-after-abort-rejection",
		"history-task-final-save-skip",
		"multi-task-shutdown-drained",
	]
	const missingLandmarks = expectedLandmarks.filter((landmark) => !reachedLandmarks.has(landmark))
	assert.deepEqual(missingLandmarks, [], `Cleanup protocol has unreachable landmarks: ${missingLandmarks.join(", ")}`)
	return { states: visited.size, actions: reachedActions.size, landmarks: reachedLandmarks.size }
}

runRepresentativeMemoizationChecks()
const result = runModelCheck()
console.log(
	`Task cleanup protocol model check passed: ${result.states} reachable states, ${result.actions}/${expectedActions.length} actions reachable, ${result.landmarks}/8 landmarks reached, depth <= ${MAX_DEPTH}, tasks=${taskIds.length}`,
)
