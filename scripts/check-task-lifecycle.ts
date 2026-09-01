import assert from "node:assert/strict"

import type { HistoryItem } from "../packages/types/src/history"

import {
	abandonDelegatedChild,
	completeDelegatedChild,
	delegateTaskToChild,
	interruptDelegatedChild,
} from "../src/core/task-persistence/taskLifecycle"

const taskIds = ["parent", "child-a", "child-b"] as const
type TaskId = (typeof taskIds)[number]
type ModelState = Record<TaskId, HistoryItem | undefined>

interface Transition {
	name: string
	next: ModelState
}

interface TraceStep {
	action: string
	state: ModelState
}

const MAX_DEPTH = 12
const MAX_STATES = 10_000
const expectedActions = ["delegate", "interrupt", "complete", "abandon"] as const
const semanticLandmarks = {
	"interrupted-child-redelegation": (state: ModelState) =>
		state.parent?.status === "delegated" &&
		state.parent.awaitingChildId === "child-b" &&
		state["child-a"]?.status === "interrupted",
	"nested-delegation": (state: ModelState) =>
		state.parent?.status === "delegated" &&
		state.parent.awaitingChildId === "child-a" &&
		state["child-a"]?.status === "delegated" &&
		state["child-a"].awaitingChildId === "child-b",
} satisfies Record<string, (state: ModelState) => boolean>

function task(id: TaskId, parentTaskId?: TaskId): HistoryItem {
	return {
		id,
		number: taskIds.indexOf(id),
		ts: taskIds.indexOf(id),
		task: id,
		tokensIn: 0,
		tokensOut: 0,
		totalCost: 0,
		status: "active",
		parentTaskId,
		rootTaskId: parentTaskId ? "parent" : undefined,
		childIds: [],
	}
}

function initialState(): ModelState {
	return { parent: task("parent"), "child-a": undefined, "child-b": undefined }
}

function replace(state: ModelState, ...updates: HistoryItem[]): ModelState {
	const next = { ...state }
	for (const update of updates) next[update.id as TaskId] = update
	return next
}

function transitions(state: ModelState): Transition[] {
	const result: Transition[] = []
	for (const parentId of taskIds) {
		const parent = state[parentId]
		if (!parent) continue

		for (const childId of taskIds) {
			if (childId === parentId || state[childId]) continue
			const awaitedStatus = parent.awaitingChildId ? state[parent.awaitingChildId as TaskId]?.status : undefined
			if (parent.status !== "active" && !(parent.status === "delegated" && awaitedStatus === "interrupted")) {
				continue
			}
			const delegated = delegateTaskToChild(parent, childId, awaitedStatus)
			result.push({
				name: `delegate(${parentId}, ${childId})`,
				next: replace(state, delegated, task(childId, parentId)),
			})
		}
	}

	for (const childId of taskIds) {
		const child = state[childId]
		if (!child?.parentTaskId) continue
		const parent = state[child.parentTaskId as TaskId]
		if (!parent) continue

		if (parent.status === "delegated" && parent.awaitingChildId === child.id && child.status === "active") {
			const interrupted = interruptDelegatedChild(parent, child)
			result.push({ name: `interrupt(${childId})`, next: replace(state, interrupted) })
		}

		if (
			(parent.status === "delegated" || parent.status === "active") &&
			parent.awaitingChildId === child.id &&
			(child.status === "active" || child.status === "interrupted")
		) {
			const completed = completeDelegatedChild(parent, child, `${childId} result`)
			result.push({
				name: `complete(${childId})`,
				next: replace(state, completed.parent, completed.child),
			})
		}

		if (parent.status === "delegated" && parent.awaitingChildId === child.id && child.status === "interrupted") {
			const abandoned = abandonDelegatedChild(parent, child)
			result.push({
				name: `abandon(${childId})`,
				next: replace(state, abandoned.parent, abandoned.child),
			})
		}
	}
	return result
}

function invariantViolations(state: ModelState): string[] {
	const violations: string[] = []
	for (const id of taskIds) {
		const current = state[id]
		if (!current) continue

		if (current.status === "delegated") {
			if (!current.awaitingChildId || current.delegatedToId !== current.awaitingChildId) {
				violations.push(`${id}: delegated task must point to exactly one awaited child`)
				continue
			}
			const child = state[current.awaitingChildId as TaskId]
			if (!child || child.parentTaskId !== id || child.status === "completed") {
				violations.push(`${id}: awaited child must exist, link back, and not be completed`)
			}
			if (!current.childIds?.includes(current.awaitingChildId)) {
				violations.push(`${id}: awaited child must be retained in childIds`)
			}
		} else if (current.awaitingChildId || current.delegatedToId) {
			violations.push(`${id}: only delegated tasks may retain an awaited-child pointer`)
		}

		if (current.parentTaskId && current.status !== "interrupted") {
			const parent = state[current.parentTaskId as TaskId]
			if (current.status !== "completed" && parent?.awaitingChildId !== id) {
				violations.push(`${id}: active or delegated linked child must be the child its parent awaits`)
			}
		}

		const ancestors = new Set<string>([id])
		let cursor = current.parentTaskId
		while (cursor) {
			if (ancestors.has(cursor)) {
				violations.push(`${id}: parentTaskId lineage must be acyclic`)
				break
			}
			ancestors.add(cursor)
			cursor = state[cursor as TaskId]?.parentTaskId
		}
	}
	return violations
}

function canonical(state: ModelState): string {
	return JSON.stringify(taskIds.map((id) => state[id] ?? null))
}

function formatCounterexample(message: string, trace: TraceStep[]): string {
	const steps = trace.map(
		(step, index) =>
			`${index}. ${step.action}\n${JSON.stringify(step.state, null, 2)
				.split("\n")
				.map((line) => `   ${line}`)
				.join("\n")}`,
	)
	return [
		`Task lifecycle invariant failed: ${message}`,
		`Bounds: depth=${MAX_DEPTH}, states=${MAX_STATES}`,
		...steps,
	].join("\n")
}

function checkTransitionInvariants(previous: ModelState, transition: Transition): string[] {
	const violations: string[] = []
	for (const id of taskIds) {
		const before = previous[id]
		const after = transition.next[id]
		if (before?.status === "completed" && canonicalTask(before) !== canonicalTask(after)) {
			violations.push(`${id}: completed task changed after ${transition.name}`)
		}
	}
	return violations
}

function canonicalTask(value: HistoryItem | undefined): string {
	return JSON.stringify(value ?? null)
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
			reachedActions.add(transition.name.slice(0, transition.name.indexOf("(")))
			const transitionViolations = checkTransitionInvariants(node.state, transition)
			const trace = [...node.trace, { action: transition.name, state: transition.next }]
			if (transitionViolations.length) {
				throw new Error(formatCounterexample(transitionViolations.join("; "), trace))
			}
			const key = canonical(transition.next)
			if (visited.has(key)) continue
			visited.add(key)
			queue.push({ state: transition.next, trace })
			if (visited.size > MAX_STATES) {
				throw new Error(
					`Task lifecycle exploration exceeded its ${MAX_STATES}-state budget; increase or reduce bounds`,
				)
			}
		}
	}
	const unreachableActions = expectedActions.filter((action) => !reachedActions.has(action))
	if (unreachableActions.length) {
		throw new Error(`Task lifecycle model has unreachable actions: ${unreachableActions.join(", ")}`)
	}
	const missingLandmarks = Object.keys(semanticLandmarks).filter((name) => !reachedLandmarks.has(name))
	if (missingLandmarks.length) {
		throw new Error(`Task lifecycle model has unreachable semantic landmarks: ${missingLandmarks.join(", ")}`)
	}
	const unexploredSuccessor = frontier
		.flatMap((state) => transitions(state))
		.find((transition) => !visited.has(canonical(transition.next)))
	if (unexploredSuccessor) {
		throw new Error(
			`Task lifecycle exploration reached depth ${MAX_DEPTH} with an unseen successor (${unexploredSuccessor.name}); increase the depth bound`,
		)
	}
	return visited.size
}

function runRepresentativeScenarios(): void {
	const parent = task("parent")
	const childA = task("child-a", "parent")
	const delegated = delegateTaskToChild(parent, childA.id)

	assert.throws(() => delegateTaskToChild(delegated, "child-b", "active"), /not interrupted/)

	const interruptedA = interruptDelegatedChild(delegated, childA)
	const redelegated = delegateTaskToChild(delegated, "child-b", interruptedA.status)
	assert.throws(() => completeDelegatedChild(redelegated, interruptedA, "stale"), /not delegated to child/)

	const abandoned = abandonDelegatedChild(delegated, interruptedA)
	assert.throws(() => completeDelegatedChild(abandoned.parent, abandoned.child, "late"), /not delegated to child/)

	const childB = task("child-b", "child-a")
	const nestedParent = delegateTaskToChild(childA, childB.id)
	const nestedCompletion = completeDelegatedChild(nestedParent, childB, "nested result")
	assert.equal(nestedCompletion.parent.status, "active")
	assert.equal(nestedCompletion.parent.completedByChildId, childB.id)

	const interruptedCompletion = completeDelegatedChild(delegated, interruptedA, "resumed result")
	assert.equal(interruptedCompletion.child.status, "completed")
	assert.equal(interruptedCompletion.parent.status, "active")
}

runRepresentativeScenarios()
const checkedStates = runModelCheck()
console.log(
	`Task lifecycle model check passed: ${checkedStates} reachable states, ${expectedActions.length}/${expectedActions.length} actions reachable, ${Object.keys(semanticLandmarks).length}/${Object.keys(semanticLandmarks).length} landmarks reached, depth <= ${MAX_DEPTH}, ${taskIds.length} task slots`,
)
